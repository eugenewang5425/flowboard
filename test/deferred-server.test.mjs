import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../server/index.mjs";

class FakeAgent extends EventEmitter {
  constructor() { super(); this.id = "codex"; this.name = "Fake Codex"; }
  status() { return { available: true, running: true, ready: true, lastError: null }; }
  async ensureStarted() {}
  async listModels() { return []; }
  async startIssue() { return { thread: { id: "thread-deferred" }, turn: { id: "turn-deferred" } }; }
  async interrupt() {}
  stop() {}
}

async function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "flowboard-deferred-http-"));
  const instance = await startServer({ port: 0, dataDirectory: base, codex: new FakeAgent(), logger: { error() {} } });
  t.after(async () => {
    await instance.close();
    const resolved = path.resolve(base);
    if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith("flowboard-deferred-http-")) {
      fs.rmSync(resolved, { recursive: true });
    }
  });
  const origin = `http://${instance.host}:${instance.port}`;
  const project = await api(origin, "/api/projects", { method: "POST", body: { name: "延后功能", issuePrefix: "DEF", workspacePath: path.resolve(".") }, expected: 201 });
  return { origin, project };
}

test("serves relation and controlled automation APIs with strict payloads", async (t) => {
  const { origin, project } = await setup(t);
  const first = await api(origin, "/api/issues", { method: "POST", body: { projectId: project.id, title: "前置", status: "backlog", priority: "urgent" }, expected: 201 });
  const second = await api(origin, "/api/issues", { method: "POST", body: { projectId: project.id, title: "后置", status: "todo" }, expected: 201 });

  const relation = await api(origin, `/api/issues/${first.id}/relations`, {
    method: "POST", body: { targetIdentifier: second.identifier, type: "blocks" }, expected: 201,
  });
  assert.equal(relation.type, "blocks");
  assert.equal((await api(origin, `/api/issues/${second.id}`)).relations[0].direction, "incoming");

  const initialPolicy = await api(origin, `/api/automation/policy?projectId=${encodeURIComponent(project.id)}`);
  assert.equal(initialPolicy.enabled, false);
  const policy = await api(origin, `/api/automation/policy/${encodeURIComponent(project.id)}`, {
    method: "PUT",
    body: { enabled: true, provider: "codex", workflowStage: "planning", sourceStatus: "backlog", dailyRunCap: 3, concurrencyLimit: 1, minimumIntervalMinutes: 5 },
  });
  assert.equal(policy.workflowStage, "planning");
  const preflight = await api(origin, `/api/automation/preflight?projectId=${encodeURIComponent(project.id)}`);
  assert.equal(preflight.canQueue, true);
  const queued = await api(origin, "/api/automation/queue-next", { method: "POST", body: { projectId: project.id }, expected: 201 });
  assert.equal(queued.issueId, first.id);
  assert.match(queued.reason, /未调用 Agent/);
  assert.equal((await api(origin, "/api/metrics")).runs.total, 0);
  assert.equal((await api(origin, `/api/automation/queue?projectId=${encodeURIComponent(project.id)}`)).length, 1);
  assert.equal((await api(origin, `/api/automation/queue/${queued.id}`, { method: "POST", body: {} })).ok, true);
  assert.equal((await api(origin, `/api/automation/queue?projectId=${encodeURIComponent(project.id)}`))[0].status, "dismissed");

  assert.equal((await fetch(`${origin}/api/automation/policy`)).status, 400);
  assert.equal((await fetch(`${origin}/api/relations/${relation.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await api(origin, `/api/issues/${second.id}`)).relations.length, 0);
});

async function api(origin, pathname, { method = "GET", body, expected = 200 } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, expected, JSON.stringify(payload));
  return payload;
}
