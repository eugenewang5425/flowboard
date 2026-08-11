import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { FlowboardDatabase } from "../server/database.mjs";
import { createIssuePrompt } from "../server/prompt.mjs";

function temporaryDirectory(t, prefix = "flowboard-p0-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDatabase(database, base, prefix = "flowboard-p0-") {
  database.close();
  const resolved = path.resolve(base);
  if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith(prefix)) {
    fs.rmSync(resolved, { recursive: true, maxRetries: 3, retryDelay: 25 });
  }
}

test("migrates a 0.1 database without losing existing tasks", (t) => {
  const base = temporaryDirectory(t);
  const file = path.join(base, "legacy.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, issue_prefix TEXT NOT NULL, workspace_path TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#7c6cff', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE issues (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), issue_number INTEGER NOT NULL,
      identifier TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'none', labels_json TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1, codex_thread_id TEXT, branch TEXT, worktree_path TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, issue_number)
    );
  `);
  const timestamp = "2026-08-01T00:00:00.000Z";
  legacy.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?)").run("legacy", "旧项目", "OLD", path.resolve("."), "#123456", timestamp, timestamp);
  legacy.prepare(`INSERT INTO issues VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("issue-old", "legacy", 1, "OLD-1", "保留的任务", "历史说明", "todo", "high", "[]", 1, null, null, null, timestamp, timestamp);
  legacy.close();

  const database = new FlowboardDatabase(file);
  t.after(() => cleanupDatabase(database, base));
  const issue = database.getIssue("OLD-1");
  assert.equal(issue.title, "保留的任务");
  assert.equal(issue.acceptanceCriteria, "");
  assert.equal(issue.workflowStage, "implementation");
  assert.deepEqual(issue.agentThreads, {});
  assert.equal(database.listIssues({ projectId: "legacy" }).length, 1);
});

test("supports backlog, dates, archive, activity and attachment metadata", (t) => {
  const base = temporaryDirectory(t);
  const database = new FlowboardDatabase(path.join(base, "data.sqlite"));
  t.after(() => cleanupDatabase(database, base));
  const project = database.createProject({ name: "P1 数据", workspacePath: path.resolve(".") });
  const issue = database.createIssue({
    projectId: project.id,
    title: "带验收任务",
    status: "backlog",
    acceptanceCriteria: "- 可以验证",
    startDate: "2026-08-11",
    dueDate: "2026-08-15",
    workflowStage: "planning",
    branch: "feat/p1-data",
    worktreePath: path.resolve("."),
  });
  assert.equal(issue.status, "backlog");
  assert.equal(issue.workflowStage, "planning");
  assert.equal(issue.branch, "feat/p1-data");
  assert.equal(issue.worktreePath, path.resolve("."));
  assert.equal(issue.activities[0].type, "issue.created");

  const attachment = database.addAttachment(issue.id, {
    filename: "说明.txt", contentType: "text/plain", size: 3, storageName: "fixed-storage",
  });
  assert.equal(database.getIssue(issue.id).attachmentCount, 1);
  database.removeAttachment(attachment.id);
  const archived = database.archiveIssue(issue.id, database.getIssue(issue.id).version);
  assert.ok(archived.archivedAt);
  assert.equal(database.listIssues({ projectId: project.id }).length, 0);
  assert.equal(database.listIssues({ projectId: project.id, archived: "true" }).length, 1);
  const restored = database.restoreIssue(issue.id, archived.version);
  assert.equal(restored.archivedAt, null);
  assert.ok(restored.activities.some((activity) => activity.type === "issue.restored"));

  assert.throws(
    () => database.createIssue({ projectId: project.id, title: "坏日期", startDate: "2026-09-01", dueDate: "2026-08-01" }),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("converges abandoned runs and aggregates usage by provider", (t) => {
  const base = temporaryDirectory(t);
  const file = path.join(base, "runs.sqlite");
  let database = new FlowboardDatabase(file);
  const project = database.createProject({ name: "运行测试", workspacePath: path.resolve(".") });
  const issue = database.createIssue({ projectId: project.id, title: "运行任务" });
  database.createRun(issue.id, { status: "running", provider: "codex", workflowStage: "testing" });
  database.close();

  database = new FlowboardDatabase(file);
  t.after(() => cleanupDatabase(database, base));
  const interrupted = database.listRuns(issue.id)[0];
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.sessionMode, "stage");
  assert.match(interrupted.error, /服务重启/);
  const completed = database.createRun(issue.id, { status: "running", provider: "claude", workflowStage: "review" });
  database.updateRun(completed.id, { status: "completed", usage: {
    total: { totalTokens: 500 }, last: { inputTokens: 100, outputTokens: 25 }, modelContextWindow: 258_400,
  } });
  const metrics = database.metrics();
  assert.equal(metrics.runs.interrupted, 1);
  assert.equal(metrics.runs.totalTokens, 125);
  assert.deepEqual(metrics.runs.byProvider.claude, { total: 1, totalTokens: 125 });
});

test("builds a deterministic bounded prompt and reports omitted comments", () => {
  const issue = {
    identifier: "TOK-1", title: "控制上下文", description: "说明", acceptanceCriteria: "验收",
    workflowStage: "planning", status: "todo", priority: "medium",
    comments: Array.from({ length: 20 }, (_, index) => ({ author: "用户", body: `${index}-${"很长".repeat(100)}` })),
  };
  const result = createIssuePrompt(issue, "只做规划", { maxChars: 1_000 });
  assert.ok(result.charCount <= 1_000);
  assert.equal(result.estimatedInputTokens, Math.ceil(result.charCount / 4));
  assert.ok(result.omittedComments > 0);
  assert.match(result.prompt, /当前工作流阶段：planning/);
  assert.match(result.prompt, /不要自动提交/);
});
