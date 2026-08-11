import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FlowboardDatabase } from "../server/database.mjs";

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "flowboard-deferred-db-"));
  const database = new FlowboardDatabase(path.join(base, "data.sqlite"));
  t.after(() => {
    database.close();
    const resolved = path.resolve(base);
    if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith("flowboard-deferred-db-")) {
      fs.rmSync(resolved, { recursive: true });
    }
  });
  return database;
}

test("tracks task relations and prevents a blocked task from being completed", (t) => {
  const database = setup(t);
  const project = database.createProject({ name: "任务关系", issuePrefix: "REL", workspacePath: path.resolve(".") });
  const blocker = database.createIssue({ projectId: project.id, title: "前置任务", status: "todo" });
  const blocked = database.createIssue({ projectId: project.id, title: "后置任务", status: "in_progress" });
  const relation = database.createRelation(blocker.id, { targetIdentifier: blocked.identifier, type: "blocks" });

  assert.equal(relation.type, "blocks");
  assert.equal(database.getIssue(blocked.id).relations[0].direction, "incoming");
  assert.throws(
    () => database.updateIssue(blocked.id, { ifVersion: blocked.version, status: "done" }),
    (error) => error.code === "VERSION_CONFLICT" && error.details.blockers[0].identifier === blocker.identifier,
  );

  const finishedBlocker = database.updateIssue(blocker.id, { ifVersion: blocker.version, status: "done" });
  assert.equal(finishedBlocker.status, "done");
  const finishedBlocked = database.updateIssue(blocked.id, { ifVersion: database.getIssue(blocked.id).version, status: "done" });
  assert.equal(finishedBlocked.status, "done");

  assert.throws(() => database.createRelation(blocker.id, { targetIdentifier: blocker.identifier, type: "related" }), /不能关联自身/);
  assert.throws(() => database.createRelation(blocker.id, { targetIdentifier: blocked.identifier, type: "blocks" }), /已存在/);
  database.removeRelation(relation.id);
  assert.equal(database.getIssue(blocker.id).relations.length, 0);
});

test("controlled automation only creates zero-token candidates and enforces guardrails", (t) => {
  const database = setup(t);
  const project = database.createProject({ name: "候选队列", issuePrefix: "AUTO", workspacePath: path.resolve(".") });
  database.createIssue({ projectId: project.id, title: "普通候选", status: "backlog", priority: "medium" });
  const urgent = database.createIssue({ projectId: project.id, title: "紧急候选", status: "backlog", priority: "urgent" });

  const disabled = database.automationPreflight(project.id);
  assert.equal(disabled.canQueue, false);
  assert.match(disabled.reasons.join(" "), /未启用/);
  assert.throws(() => database.queueNextAutomation(project.id), /未启用/);

  const policy = database.updateAutomationPolicy(project.id, {
    enabled: true, provider: "codex", workflowStage: "planning", sourceStatus: "backlog",
    dailyRunCap: 2, concurrencyLimit: 1, minimumIntervalMinutes: 5,
  });
  assert.equal(policy.enabled, true);
  const queued = database.queueNextAutomation(project.id);
  assert.equal(queued.issueId, urgent.id);
  assert.equal(queued.status, "pending");
  assert.match(queued.reason, /未调用 Agent/);
  assert.equal(database.metrics().runs.total, 0);

  assert.equal(database.markAutomationQueueStarted(urgent.id, "codex", "planning"), 1);
  assert.equal(database.listAutomationQueue(project.id)[0].status, "started");

  const run = database.createRun(urgent.id, { status: "completed", provider: "codex", workflowStage: "planning" });
  database.updateRun(run.id, { status: "completed" });
  const intervalBlocked = database.automationPreflight(project.id);
  assert.equal(intervalBlocked.canQueue, false);
  assert.ok(intervalBlocked.nextAllowedAt);
  assert.match(intervalBlocked.reasons.join(" "), /最小执行间隔/);

  assert.throws(() => database.updateAutomationPolicy(project.id, {
    enabled: true, provider: "codex", workflowStage: "planning", sourceStatus: "backlog",
    dailyRunCap: 0, concurrencyLimit: 1, minimumIntervalMinutes: 5,
  }), /每日上限/);
});
