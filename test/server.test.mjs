import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../server/index.mjs";

class FakeCodex extends EventEmitter {
  status() { return { available: true, running: false, ready: false, lastError: null }; }
  async ensureStarted() { this.emit("ready", { available: true, running: true, ready: true }); }
  async startIssue() { throw new Error("此测试不启动 Agent"); }
  stop() {}
}

test("project dialog cancel controls bypass required-field validation", async () => {
  const html = await fs.promises.readFile(path.resolve("web/index.html"), "utf8");
  assert.match(html, /aria-label="关闭"[^>]*formnovalidate/);
  assert.match(html, /value="cancel"[^>]*formnovalidate>取消<\/button>/);
});

test("serves the API CRUD loop", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "flowboard-http-test-"));
  const instance = await startServer({ port: 0, dataDirectory: base, codex: new FakeCodex(), logger: { error() {} } });
  t.after(async () => {
    await instance.close();
    const resolved = path.resolve(base);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("flowboard-http-test-")) {
      fs.rmSync(resolved, { recursive: true });
    }
  });
  const origin = `http://${instance.host}:${instance.port}`;

  const projectResponse = await fetch(`${origin}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "HTTP 项目", workspacePath: path.resolve("."), issuePrefix: "HTTP" }),
  });
  assert.equal(projectResponse.status, 201);
  const project = await projectResponse.json();

  const issueResponse = await fetch(`${origin}/api/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: project.id, title: "通过 API 创建" }),
  });
  assert.equal(issueResponse.status, 201);
  const issue = await issueResponse.json();

  const moveResponse = await fetch(`${origin}/api/issues/${issue.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ifVersion: issue.version, status: "in_progress" }),
  });
  assert.equal(moveResponse.status, 200);
  assert.equal((await moveResponse.json()).status, "in_progress");
});
