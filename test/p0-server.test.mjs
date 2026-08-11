import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../server/index.mjs";

class LifecycleAgent extends EventEmitter {
  constructor() {
    super();
    this.id = "codex";
    this.name = "Fake Codex";
    this.counter = 0;
    this.interrupts = [];
  }
  status() { return { available: true, running: true, ready: true, lastError: null }; }
  async ensureStarted() {}
  async listModels() { return [{ id: "fake-model", supportedReasoningEfforts: ["low", "medium"] }]; }
  async startIssue({ prompt }) {
    if (this.failStart) throw new Error("模拟启动失败");
    this.counter += 1;
    this.lastPrompt = prompt;
    return { thread: { id: `thread-${this.counter}` }, turn: { id: `turn-${this.counter}` } };
  }
  async interrupt(threadId, turnId) { this.interrupts.push({ threadId, turnId }); }
  stop() {}
}

async function withServer(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "flowboard-p0-http-"));
  const agent = new LifecycleAgent();
  const instance = await startServer({ port: 0, dataDirectory: base, codex: agent, logger: { error() {} } });
  t.after(async () => {
    await instance.close();
    const resolved = path.resolve(base);
    if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith("flowboard-p0-http-")) {
      fs.rmSync(resolved, { recursive: true });
    }
  });
  const origin = `http://${instance.host}:${instance.port}`;
  const project = await api(origin, "/api/projects", { method: "POST", body: { name: "P0 HTTP", workspacePath: path.resolve("."), issuePrefix: "P0" }, expected: 201 });
  const issue = await api(origin, "/api/issues", { method: "POST", body: { projectId: project.id, title: "生命周期" }, expected: 201 });
  return { base, agent, instance, origin, project, issue };
}

test("rejects foreign Host, foreign Origin, unknown fields and unknown query", async (t) => {
  const { instance, origin } = await withServer(t);
  const unknownField = await fetch(`${origin}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x", workspacePath: path.resolve("."), surprise: true }),
  });
  assert.equal(unknownField.status, 400);
  assert.equal((await unknownField.json()).error.code, "UNKNOWN_FIELDS");

  const unknownQuery = await fetch(`${origin}/api/issues?typo=yes`);
  assert.equal(unknownQuery.status, 400);
  assert.equal((await unknownQuery.json()).error.code, "UNKNOWN_QUERY");

  const foreignOrigin = await fetch(`${origin}/api/health`, { headers: { Origin: "https://evil.example" } });
  assert.equal(foreignOrigin.status, 403);
  assert.equal((await foreignOrigin.json()).error.code, "INVALID_ORIGIN");

  const foreignHost = await rawRequest(instance.port, { Host: "evil.example" });
  assert.equal(foreignHost.status, 403);
  assert.equal(JSON.parse(foreignHost.body).error.code, "INVALID_HOST");
});

test("uploads, serves and deletes an allowed attachment", async (t) => {
  const { origin, issue } = await withServer(t);
  const content = Buffer.from("验收附件", "utf8");
  const attachment = await api(origin, `/api/issues/${issue.id}/attachments`, {
    method: "POST",
    body: { filename: "验收.txt", contentType: "text/plain", base64: content.toString("base64") },
    expected: 201,
  });
  const served = await fetch(`${origin}${attachment.url}`);
  assert.equal(served.status, 200);
  assert.equal(Buffer.from(await served.arrayBuffer()).toString("utf8"), "验收附件");
  const removed = await fetch(`${origin}/api/attachments/${attachment.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal((await fetch(`${origin}${attachment.url}`)).status, 404);

  const disallowed = await fetch(`${origin}/api/issues/${issue.id}/attachments`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "bad.exe", contentType: "application/x-msdownload", base64: "AA==" }),
  });
  assert.equal(disallowed.status, 400);
});

test("previews prompt, starts once, tracks usage and completes", async (t) => {
  const { origin, issue, agent } = await withServer(t);
  const preview = await api(origin, `/api/issues/${issue.id}/agent/preview`, {
    method: "POST", body: { message: "先实现", maxPromptChars: 2_000, workflowStage: "implementation" },
  });
  assert.ok(preview.estimatedInputTokens > 0);
  assert.ok(preview.charCount <= 2_000);

  const started = await api(origin, `/api/issues/${issue.id}/agent/start`, {
    method: "POST",
    body: { ifVersion: issue.version, message: "先实现", model: "fake-model", effort: "low", sandbox: "workspaceWrite", workflowStage: "implementation" },
    expected: 202,
  });
  assert.equal(started.run.provider, "codex");
  assert.equal(started.run.sessionMode, "stage");
  assert.equal(started.run.status, "running");
  assert.match(agent.lastPrompt, /生命周期/);

  const conflict = await fetch(`${origin}/api/issues/${issue.id}/agent/start`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ifVersion: started.issue.version }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "RUN_ALREADY_ACTIVE");

  agent.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: "thread-1", tokenUsage: { inputTokens: 40, outputTokens: 10 } } });
  agent.emit("notification", { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", text: "执行完成" } } });
  agent.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  const refreshed = await api(origin, `/api/issues/${issue.id}`);
  assert.equal(refreshed.runs[0].status, "completed");
  assert.equal(refreshed.runs[0].summary, "执行完成");
  assert.equal(refreshed.runs[0].usage.inputTokens, 40);
});

test("interrupts a running turn and marks an agent crash as failed", async (t) => {
  const { origin, issue, agent } = await withServer(t);
  let started = await api(origin, `/api/issues/${issue.id}/agent/start`, {
    method: "POST", body: { ifVersion: issue.version }, expected: 202,
  });
  const interrupted = await api(origin, `/api/issues/${issue.id}/agent/interrupt`, { method: "POST", body: {} });
  assert.equal(interrupted.status, "interrupted");
  assert.deepEqual(agent.interrupts[0], { threadId: "thread-1", turnId: "turn-1" });

  const latest = await api(origin, `/api/issues/${issue.id}`);
  started = await api(origin, `/api/issues/${issue.id}/agent/start`, {
    method: "POST", body: { ifVersion: latest.version }, expected: 202,
  });
  agent.emit("exit", { available: true, running: false, ready: false, lastError: "模拟崩溃" });
  const crashed = await api(origin, `/api/issues/${issue.id}`);
  assert.equal(crashed.runs[0].status, "failed");
  assert.equal(crashed.runs[0].error, "模拟崩溃");
  assert.equal(started.run.provider, "codex");
});

test("requires an explicit confirmation for dangerFullAccess", async (t) => {
  const { origin, issue } = await withServer(t);
  const response = await fetch(`${origin}/api/issues/${issue.id}/agent/start`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ifVersion: issue.version, sandbox: "dangerFullAccess" }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "DANGER_CONFIRMATION_REQUIRED");
});

test("rolls a todo task back after startup failure and records the evidence", async (t) => {
  const { origin, issue, agent } = await withServer(t);
  agent.failStart = true;
  const response = await fetch(`${origin}/api/issues/${issue.id}/agent/start`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ifVersion: issue.version }),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "AGENT_START_FAILED");
  const refreshed = await api(origin, `/api/issues/${issue.id}`);
  assert.equal(refreshed.status, "todo");
  assert.equal(refreshed.runs[0].status, "failed");
  assert.match(refreshed.comments.at(-1).body, /模拟启动失败/);
});

test("records a failed completion and exposes provider token metrics", async (t) => {
  const { origin, issue, agent } = await withServer(t);
  await api(origin, `/api/issues/${issue.id}/agent/start`, { method: "POST", body: { ifVersion: issue.version }, expected: 202 });
  agent.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed", error: { message: "工具失败" } } } });
  agent.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { totalTokens: 77 } } });
  const refreshed = await api(origin, `/api/issues/${issue.id}`);
  assert.equal(refreshed.runs[0].status, "failed");
  assert.equal(refreshed.runs[0].error, "工具失败");
  const metrics = await api(origin, "/api/metrics");
  assert.equal(metrics.runs.totalTokens, 77);
  assert.equal(metrics.runs.byProvider.codex.totalTokens, 77);
});

test("archives and restores through HTTP with date and activity evidence", async (t) => {
  const { origin, issue, project } = await withServer(t);
  const updated = await api(origin, `/api/issues/${issue.id}`, {
    method: "PATCH", body: { ifVersion: issue.version, startDate: "2026-08-11", dueDate: "2026-08-12", acceptanceCriteria: "- 可验证" },
  });
  const archived = await api(origin, `/api/issues/${issue.id}/archive`, { method: "POST", body: { ifVersion: updated.version } });
  assert.ok(archived.archivedAt);
  assert.equal((await api(origin, `/api/issues?projectId=${project.id}`)).length, 0);
  assert.equal((await api(origin, `/api/issues?projectId=${project.id}&archived=true`)).length, 1);
  const restored = await api(origin, `/api/issues/${issue.id}/restore`, { method: "POST", body: { ifVersion: archived.version } });
  assert.equal(restored.archivedAt, null);
  assert.ok(restored.activities.some((activity) => activity.type === "issue.restored"));
});

async function api(origin, route, { method = "GET", body, expected = 200 } = {}) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, expected, JSON.stringify(data));
  return data;
}

function rawRequest(port, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: "/api/health", headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}
