import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildIssuePrompt } from "../server/codex-app-server.mjs";
import { FlowboardDatabase } from "../server/database.mjs";

function withDatabase(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "flowboard-test-"));
  const database = new FlowboardDatabase(path.join(base, "test.sqlite"));
  t.after(() => {
    database.close();
    const resolved = path.resolve(base);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("flowboard-test-")) {
      fs.rmSync(resolved, { recursive: true });
    }
  });
  return database;
}

test("creates projects, issues and comments with stable identifiers", (t) => {
  const database = withDatabase(t);
  const project = database.createProject({
    id: "demo",
    name: "演示项目",
    issuePrefix: "DEMO",
    workspacePath: path.resolve("."),
  });
  assert.equal(project.id, "demo");

  const first = database.createIssue({ projectId: project.id, title: "第一个任务", priority: "high" });
  const second = database.createIssue({ projectId: project.id, title: "第二个任务" });
  assert.equal(first.identifier, "DEMO-1");
  assert.equal(second.identifier, "DEMO-2");

  database.addComment(first.id, { body: "补充验收条件" });
  const refreshed = database.getIssue(first.identifier);
  assert.equal(refreshed.comments.length, 1);
  assert.equal(refreshed.version, 2);
});

test("rejects stale optimistic updates", (t) => {
  const database = withDatabase(t);
  const project = database.createProject({ name: "并发测试", workspacePath: path.resolve(".") });
  const issue = database.createIssue({ projectId: project.id, title: "版本任务" });
  const updated = database.updateIssue(issue.id, { ifVersion: issue.version, status: "in_progress" });
  assert.equal(updated.version, 2);
  assert.throws(
    () => database.updateIssue(issue.id, { ifVersion: issue.version, status: "done" }),
    (error) => error.status === 409 && error.code === "VERSION_CONFLICT",
  );
});

test("builds a bounded issue prompt with current comments", () => {
  const prompt = buildIssuePrompt({
    identifier: "DEMO-3",
    title: "完成地图组件",
    description: "实现缩放与定位。",
    status: "in_progress",
    priority: "medium",
    branch: "feat/map",
    worktreePath: null,
    comments: [{ author: "用户", body: "不要修改数据格式。" }],
  }, "运行相关测试。 ");
  assert.match(prompt, /DEMO-3/);
  assert.match(prompt, /不要修改数据格式/);
  assert.match(prompt, /不要自动提交/);
});
