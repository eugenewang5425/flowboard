import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentRegistry } from "./agent-registry.mjs";
import { CodexAppServer } from "./codex-app-server.mjs";
import { FlowboardDatabase, appError } from "./database.mjs";
import {
  assertAllowedKeys,
  assertAllowedQuery,
  assertLocalRequest,
  decodeRouteSegment,
  readJson,
} from "./http-security.mjs";
import { createIssuePrompt } from "./prompt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = path.join(ROOT, "web");
const DEFAULT_DATA_DIR = path.join(ROOT, ".data");
const ATTACHMENT_LIMIT = 10 * 1024 * 1024;
const ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain"]);
const SANDBOXES = new Set(["readOnly", "workspaceWrite", "dangerFullAccess"]);

export function createFlowboardApp({ dataDirectory, codex = null, agentRegistry = null, logger = console } = {}) {
  const resolvedDataDirectory = path.resolve(dataDirectory || process.env.FLOWBOARD_DATA_DIR || DEFAULT_DATA_DIR);
  const attachmentDirectory = path.join(resolvedDataDirectory, "attachments");
  fs.mkdirSync(attachmentDirectory, { recursive: true });
  const database = new FlowboardDatabase(path.join(resolvedDataDirectory, "flowboard.sqlite"));
  const codexProvider = codex || new CodexAppServer({ rootDirectory: ROOT, logger });
  if (!codexProvider.id) codexProvider.id = "codex";
  if (!codexProvider.name) codexProvider.name = "OpenAI Codex";
  const agents = agentRegistry || new AgentRegistry({ providers: [codexProvider] });
  const events = new EventEmitter();
  const sseClients = new Set();
  const activeRuns = new Map();

  const broadcast = (event, data) => {
    events.emit(event, data);
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const response of sseClients) response.write(payload);
  };

  agents.on("ready", ({ providerId, payload }) => broadcast("agent-status", { providerId, ...payload }));
  agents.on("diagnostic", ({ providerId, payload }) => broadcast("agent-diagnostic", { providerId, ...payload }));
  agents.on("exit", ({ providerId, payload }) => {
    const affected = uniqueActiveRuns(activeRuns).filter((run) => run.providerId === providerId);
    for (const active of affected) {
      database.updateRun(active.runId, { status: "failed", error: payload?.lastError || "Agent 进程意外退出" });
      removeActiveRun(activeRuns, active);
      broadcast("data-change", { type: "agent-run", issueId: active.issueId });
    }
    broadcast("agent-status", { providerId, ...payload });
  });
  agents.on("notification", ({ providerId, payload: message }) => {
    handleAgentNotification({ providerId, message, database, activeRuns, broadcast });
  });

  async function handler(request, response) {
    try {
      assertLocalRequest(request);
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname === "/api/events" && request.method === "GET") {
        assertAllowedQuery(url.searchParams, []);
        response.writeHead(200, securityHeaders({
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        }));
        response.write(`event: connected\ndata: ${JSON.stringify({ ok: true, revision: database.revision() })}\n\n`);
        sseClients.add(response);
        request.on("close", () => sseClients.delete(response));
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleApi({ request, response, url, database, agents, activeRuns, attachmentDirectory, broadcast });
      }
      return serveStatic(response, url.pathname);
    } catch (error) {
      logger.error?.(error);
      sendError(response, error);
    }
  }

  return {
    handler,
    database,
    codex: codexProvider,
    agents,
    events,
    close() {
      for (const response of sseClients) response.end();
      agents.stop();
      database.close();
    },
  };
}

async function handleApi(context) {
  const { request, response, url, database, agents, activeRuns, attachmentDirectory, broadcast } = context;
  const method = request.method;
  const parts = url.pathname.split("/").filter(Boolean);

  if (method === "GET" && url.pathname === "/api/health") {
    assertAllowedQuery(url.searchParams, []);
    return sendJson(response, 200, { ok: true, name: "Codex Flowboard", version: "0.2.0", agents: agents.list() });
  }
  if (method === "GET" && url.pathname === "/api/bootstrap") {
    assertAllowedQuery(url.searchParams, ["projectId", "archived", "status", "priority", "search"]);
    const projects = database.listProjects();
    const projectId = url.searchParams.get("projectId") || projects[0]?.id || null;
    return sendJson(response, 200, {
      projects,
      selectedProjectId: projectId,
      issues: projectId ? database.listIssues({
        projectId,
        archived: url.searchParams.get("archived") || "false",
        status: url.searchParams.get("status") || undefined,
        priority: url.searchParams.get("priority") || undefined,
        search: url.searchParams.get("search") || undefined,
      }) : [],
      agents: agents.list(),
      metrics: database.metrics(),
    });
  }

  if (parts[1] === "projects") {
    if (method === "GET" && parts.length === 2) {
      assertAllowedQuery(url.searchParams, []);
      return sendJson(response, 200, database.listProjects());
    }
    if (method === "POST" && parts.length === 2) {
      const input = assertAllowedKeys(await readJson(request), ["id", "name", "issuePrefix", "workspacePath", "color"], "新建项目");
      const project = database.createProject(input);
      broadcast("data-change", { type: "project", id: project.id });
      return sendJson(response, 201, project);
    }
  }

  if (parts[1] === "issues") {
    if (method === "GET" && parts.length === 2) {
      assertAllowedQuery(url.searchParams, ["projectId", "status", "priority", "archived", "search"]);
      return sendJson(response, 200, database.listIssues({
        projectId: url.searchParams.get("projectId") || undefined,
        status: url.searchParams.get("status") || undefined,
        priority: url.searchParams.get("priority") || undefined,
        archived: url.searchParams.get("archived") || "false",
        search: url.searchParams.get("search") || undefined,
      }));
    }
    if (method === "POST" && parts.length === 2) {
      const input = assertAllowedKeys(await readJson(request), [
        "projectId", "title", "description", "acceptanceCriteria", "status", "priority", "labels",
        "assignee", "startDate", "dueDate", "workflowStage", "branch", "worktreePath",
      ], "新建任务");
      const issue = database.createIssue(input);
      broadcast("data-change", { type: "issue", id: issue.id, projectId: issue.projectId });
      return sendJson(response, 201, issue);
    }
    if (parts.length >= 3) {
      const issueId = decodeRouteSegment(parts[2]);
      if (method === "GET" && parts.length === 3) {
        assertAllowedQuery(url.searchParams, []);
        return sendJson(response, 200, requireIssue(database, issueId));
      }
      if (method === "PATCH" && parts.length === 3) {
        const input = assertAllowedKeys(await readJson(request), [
          "ifVersion", "title", "description", "acceptanceCriteria", "status", "priority", "labels",
          "codexThreadId", "agentThreads", "branch", "worktreePath", "assignee", "startDate", "dueDate",
          "sortOrder", "workflowStage",
        ], "更新任务");
        const issue = database.updateIssue(issueId, input);
        broadcast("data-change", { type: "issue", id: issue.id, projectId: issue.projectId });
        return sendJson(response, 200, issue);
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "comments") {
        const input = assertAllowedKeys(await readJson(request), ["body", "author"], "新增评论");
        const comment = database.addComment(issueId, input);
        const issue = requireIssue(database, issueId);
        broadcast("data-change", { type: "comment", id: comment.id, issueId: issue.id, projectId: issue.projectId });
        return sendJson(response, 201, comment);
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "archive") {
        const input = assertAllowedKeys(await readJson(request), ["ifVersion"], "归档任务");
        const issue = database.archiveIssue(issueId, input.ifVersion);
        broadcast("data-change", { type: "issue", id: issue.id, projectId: issue.projectId });
        return sendJson(response, 200, issue);
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "restore") {
        const input = assertAllowedKeys(await readJson(request), ["ifVersion"], "恢复任务");
        const issue = database.restoreIssue(issueId, input.ifVersion);
        broadcast("data-change", { type: "issue", id: issue.id, projectId: issue.projectId });
        return sendJson(response, 200, issue);
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "attachments") {
        return uploadAttachment({ request, response, issueId, database, attachmentDirectory, broadcast });
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "relations") {
        const input = assertAllowedKeys(await readJson(request), ["targetIdentifier", "type"], "新增任务关系");
        const relation = database.createRelation(issueId, input);
        const issue = requireIssue(database, issueId);
        broadcast("data-change", { type: "relation", id: relation.id, issueId: issue.id, projectId: issue.projectId });
        return sendJson(response, 201, relation);
      }
      if (method === "POST" && parts.length === 5 && ["agent", "codex"].includes(parts[3]) && parts[4] === "preview") {
        return previewAgentRun({ request, response, issueId, database });
      }
      if (method === "POST" && parts.length === 5 && ["agent", "codex"].includes(parts[3]) && parts[4] === "start") {
        return startAgentRun({ request, response, issueId, database, agents, activeRuns, broadcast });
      }
      if (method === "POST" && parts.length === 5 && ["agent", "codex"].includes(parts[3]) && parts[4] === "interrupt") {
        return interruptAgentRun({ request, response, issueId, database, agents, activeRuns, broadcast });
      }
    }
  }

  if (parts[1] === "attachments" && parts.length >= 3) {
    const attachmentId = decodeRouteSegment(parts[2]);
    if (method === "GET" && parts.length === 4 && parts[3] === "content") {
      assertAllowedQuery(url.searchParams, []);
      return serveAttachment(response, database, attachmentDirectory, attachmentId);
    }
    if (method === "DELETE" && parts.length === 3) {
      return deleteAttachment(response, database, attachmentDirectory, attachmentId, broadcast);
    }
  }

  if (parts[1] === "relations" && parts.length === 3 && method === "DELETE") {
    assertAllowedQuery(url.searchParams, []);
    const result = database.removeRelation(decodeRouteSegment(parts[2]));
    broadcast("data-change", { type: "relation", id: result.id, issueId: result.sourceIssueId });
    return sendJson(response, 200, result);
  }

  if (parts[1] === "automation") {
    if (method === "GET" && parts.length === 3 && parts[2] === "policy") {
      assertAllowedQuery(url.searchParams, ["projectId"]);
      return sendJson(response, 200, database.getAutomationPolicy(requiredQuery(url, "projectId")));
    }
    if (method === "PUT" && parts.length === 4 && parts[2] === "policy") {
      const projectId = decodeRouteSegment(parts[3]);
      const input = assertAllowedKeys(await readJson(request), [
        "enabled", "provider", "workflowStage", "sourceStatus", "dailyRunCap",
        "concurrencyLimit", "minimumIntervalMinutes",
      ], "更新自动化策略");
      const policy = database.updateAutomationPolicy(projectId, input);
      broadcast("data-change", { type: "automation-policy", projectId });
      return sendJson(response, 200, policy);
    }
    if (method === "GET" && parts.length === 3 && parts[2] === "preflight") {
      assertAllowedQuery(url.searchParams, ["projectId"]);
      return sendJson(response, 200, database.automationPreflight(requiredQuery(url, "projectId")));
    }
    if (method === "GET" && parts.length === 3 && parts[2] === "queue") {
      assertAllowedQuery(url.searchParams, ["projectId"]);
      return sendJson(response, 200, database.listAutomationQueue(requiredQuery(url, "projectId")));
    }
    if (method === "POST" && parts.length === 3 && parts[2] === "queue-next") {
      const input = assertAllowedKeys(await readJson(request), ["projectId"], "生成自动化候选");
      const item = database.queueNextAutomation(String(input.projectId || ""));
      broadcast("data-change", { type: "automation-queue", id: item.id, issueId: item.issueId, projectId: item.projectId });
      return sendJson(response, 201, item);
    }
    if (method === "POST" && parts.length === 4 && parts[2] === "queue" && parts[3]) {
      const queueId = decodeRouteSegment(parts[3]);
      assertAllowedKeys(await readJson(request), [], "忽略自动化候选");
      const result = database.dismissAutomationQueue(queueId);
      broadcast("data-change", { type: "automation-queue", id: queueId, issueId: result.issueId, projectId: result.projectId });
      return sendJson(response, 200, result);
    }
  }

  if (method === "GET" && url.pathname === "/api/metrics") {
    assertAllowedQuery(url.searchParams, []);
    return sendJson(response, 200, database.metrics());
  }
  if (method === "GET" && url.pathname === "/api/agents") {
    assertAllowedQuery(url.searchParams, []);
    return sendJson(response, 200, agents.list());
  }
  if (parts[1] === "agents" && parts.length >= 3) {
    const providerId = decodeRouteSegment(parts[2]);
    if (method === "GET" && parts.length === 4 && parts[3] === "models") {
      assertAllowedQuery(url.searchParams, []);
      return sendJson(response, 200, await agents.listModels(providerId));
    }
    if (method === "POST" && parts.length === 4 && parts[3] === "connect") {
      assertAllowedKeys(await readJson(request), [], "连接 Agent");
      return sendJson(response, 200, await agents.connect(providerId));
    }
  }
  if (method === "GET" && url.pathname === "/api/codex/status") {
    assertAllowedQuery(url.searchParams, []);
    return sendJson(response, 200, agents.get("codex").status());
  }
  if (method === "GET" && url.pathname === "/api/codex/models") {
    assertAllowedQuery(url.searchParams, []);
    return sendJson(response, 200, await agents.listModels("codex"));
  }
  if (method === "POST" && url.pathname === "/api/codex/connect") {
    assertAllowedKeys(await readJson(request), [], "连接 Codex");
    return sendJson(response, 200, await agents.connect("codex"));
  }

  throw appError(404, "接口不存在", "NOT_FOUND");
}

function previewAgentRun({ request, response, issueId, database }) {
  return readJson(request).then((body) => {
    const input = assertAllowedKeys(body, ["message", "maxPromptChars", "workflowStage"], "提示词预览");
    const issue = requireIssue(database, issueId);
    const promptIssue = input.workflowStage ? { ...issue, workflowStage: input.workflowStage } : issue;
    return sendJson(response, 200, createIssuePrompt(promptIssue, input.message, { maxChars: input.maxPromptChars }));
  });
}

async function startAgentRun({ request, response, issueId, database, agents, activeRuns, broadcast }) {
  const input = assertAllowedKeys(await readJson(request), [
    "ifVersion", "message", "model", "effort", "sandbox", "provider", "workflowStage", "maxPromptChars",
    "confirmDangerFullAccess", "sessionMode",
  ], "启动 Agent");
  let issue = requireIssue(database, issueId);
  if (issue.archivedAt) throw appError(409, "归档任务不能启动 Agent", "ISSUE_ARCHIVED");
  if (["done", "canceled"].includes(issue.status)) throw appError(409, "已完成或已取消的任务不能直接启动", "ISSUE_NOT_RUNNABLE");
  if (!Number.isInteger(input.ifVersion) || input.ifVersion !== issue.version) {
    throw appError(409, "任务版本已变化，请刷新后重试", "VERSION_CONFLICT", { current: issue });
  }
  if (database.getActiveRun(issue.id)) throw appError(409, "该任务已有 Agent 正在运行", "RUN_ALREADY_ACTIVE");

  const project = database.getProject(issue.projectId);
  const workspace = issue.worktreePath || project.workspacePath;
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw appError(400, `项目目录不存在：${workspace}`, "WORKSPACE_NOT_FOUND");
  }
  const sandbox = input.sandbox || "workspaceWrite";
  if (!SANDBOXES.has(sandbox)) throw appError(400, "无效的沙箱策略", "INVALID_SANDBOX");
  if (sandbox === "dangerFullAccess" && input.confirmDangerFullAccess !== true) {
    throw appError(400, "完全访问模式必须显式确认", "DANGER_CONFIRMATION_REQUIRED");
  }
  const workflowStage = input.workflowStage || issue.workflowStage || "implementation";
  const provider = agents.resolve({ providerId: input.provider, workflowStage });
  const sessionMode = input.sessionMode || "stage";
  if (!["stage", "resume", "fresh"].includes(sessionMode)) throw appError(400, "无效的 Agent 会话策略", "INVALID_SESSION_MODE");
  const threadKey = sessionMode === "stage" ? `${provider.id}:${workflowStage}` : provider.id;
  const resumeThreadId = sessionMode === "fresh" ? null
    : issue.agentThreads?.[threadKey] || (sessionMode === "resume" ? issue.codexThreadId : null);
  const preview = createIssuePrompt({ ...issue, workflowStage }, input.message, { maxChars: input.maxPromptChars });
  const originalStatus = issue.status;
  const issueChanges = { ifVersion: issue.version };
  if (["backlog", "todo"].includes(issue.status)) issueChanges.status = "in_progress";
  if (workflowStage !== issue.workflowStage) issueChanges.workflowStage = workflowStage;
  if (Object.keys(issueChanges).length > 1) issue = database.updateIssue(issue.id, issueChanges);

  const run = database.createRun(issue.id, {
    status: "starting",
    promptChars: preview.charCount,
    estimatedInputTokens: preview.estimatedInputTokens,
    model: optionalScalar(input.model, 120),
    effort: optionalScalar(input.effort, 40),
    sandbox,
    provider: provider.id,
    workflowStage,
    sessionMode,
  });
  broadcast("data-change", { type: "agent-run", issueId: issue.id, projectId: issue.projectId });
  try {
    const started = await provider.startIssue({
      issue,
      project,
      message: input.message,
      prompt: preview.prompt,
      model: optionalScalar(input.model, 120),
      effort: optionalScalar(input.effort, 40),
      sandbox,
      workflowStage,
      threadId: resumeThreadId,
    });
    const threadId = started.thread?.id || started.session?.id;
    if (!threadId) throw new Error(`${provider.name || provider.id} 没有返回会话 ID`);
    const agentThreads = { ...(issue.agentThreads || {}), [threadKey]: threadId };
    const threadChanges = { ifVersion: database.getIssue(issue.id).version, agentThreads };
    if (provider.id === "codex") threadChanges.codexThreadId = threadId;
    issue = database.updateIssue(issue.id, threadChanges);
    const updatedRun = database.updateRun(run.id, {
      status: "running",
      threadId,
      turnId: started.turn?.id || started.run?.id || null,
    });
    database.markAutomationQueueStarted(issue.id, provider.id, workflowStage);
    const active = {
      runId: run.id,
      issueId: issue.id,
      providerId: provider.id,
      threadId,
      turnId: updatedRun.turnId,
      summary: "",
    };
    addActiveRun(activeRuns, active);
    broadcast("data-change", { type: "issue", id: issue.id, projectId: issue.projectId });
    return sendJson(response, 202, { issue, run: updatedRun, prompt: preview });
  } catch (error) {
    database.updateRun(run.id, { status: "failed", error: error.message, summary: error.message });
    database.addComment(issue.id, { author: "Flowboard", body: `Agent 启动失败：${error.message}` });
    if (["backlog", "todo"].includes(originalStatus)) {
      const latest = database.getIssue(issue.id);
      database.updateIssue(issue.id, { ifVersion: latest.version, status: originalStatus });
    }
    broadcast("data-change", { type: "agent-run", issueId: issue.id, projectId: issue.projectId });
    throw appError(502, error.message, "AGENT_START_FAILED");
  }
}

async function interruptAgentRun({ request, response, issueId, database, agents, activeRuns, broadcast }) {
  assertAllowedKeys(await readJson(request), [], "中断 Agent");
  const issue = requireIssue(database, issueId);
  const run = database.getActiveRun(issue.id);
  if (!run) throw appError(409, "该任务没有正在运行的 Agent", "NO_ACTIVE_RUN");
  const provider = agents.get(run.provider);
  if (typeof provider.interrupt !== "function") throw appError(409, "该 Agent 不支持中断", "INTERRUPT_UNSUPPORTED");
  await provider.interrupt(run.threadId, run.turnId);
  const updated = database.updateRun(run.id, { status: "interrupted", error: "由用户中断" });
  const active = findActiveRun(activeRuns, run.provider, run.turnId, run.threadId);
  if (active) removeActiveRun(activeRuns, active);
  broadcast("data-change", { type: "agent-run", issueId: issue.id, projectId: issue.projectId });
  return sendJson(response, 200, updated);
}

async function uploadAttachment({ request, response, issueId, database, attachmentDirectory, broadcast }) {
  const input = assertAllowedKeys(await readJson(request, { maxBytes: ATTACHMENT_LIMIT * 1.5 }), ["filename", "contentType", "base64"], "上传附件");
  const issue = requireIssue(database, issueId);
  const contentType = String(input.contentType || "").toLowerCase();
  if (!ATTACHMENT_TYPES.has(contentType)) throw appError(400, "仅支持图片、PDF 和纯文本附件", "UNSUPPORTED_ATTACHMENT_TYPE");
  const data = decodeBase64(input.base64);
  if (data.length > ATTACHMENT_LIMIT) throw appError(413, "附件不能超过 10 MB", "ATTACHMENT_TOO_LARGE");
  const filename = safeFilename(input.filename);
  const storageName = randomUUID();
  const finalPath = path.join(attachmentDirectory, storageName);
  const temporaryPath = `${finalPath}.uploading`;
  fs.writeFileSync(temporaryPath, data, { flag: "wx" });
  fs.renameSync(temporaryPath, finalPath);
  let attachment;
  try {
    attachment = database.addAttachment(issue.id, { filename, contentType, size: data.length, storageName });
  } catch (error) {
    fs.rmSync(finalPath);
    throw error;
  }
  broadcast("data-change", { type: "attachment", id: attachment.id, issueId: issue.id, projectId: issue.projectId });
  return sendJson(response, 201, attachment);
}

function serveAttachment(response, database, attachmentDirectory, id) {
  const attachment = database.getAttachment(id);
  if (!attachment) throw appError(404, "附件不存在", "NOT_FOUND");
  const filePath = path.join(attachmentDirectory, attachment.storageName);
  if (!fs.existsSync(filePath)) throw appError(404, "附件文件不存在", "ATTACHMENT_FILE_MISSING");
  const content = fs.readFileSync(filePath);
  response.writeHead(200, securityHeaders({
    "Content-Type": attachment.contentType,
    "Content-Length": content.length,
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
    "Cache-Control": "private, no-store",
  }));
  response.end(content);
}

function deleteAttachment(response, database, attachmentDirectory, id, broadcast) {
  const attachment = database.getAttachment(id);
  if (!attachment) throw appError(404, "附件不存在", "NOT_FOUND");
  const filePath = path.join(attachmentDirectory, attachment.storageName);
  const parkedPath = `${filePath}.deleting`;
  if (fs.existsSync(filePath)) fs.renameSync(filePath, parkedPath);
  try {
    database.removeAttachment(id);
  } catch (error) {
    if (fs.existsSync(parkedPath)) fs.renameSync(parkedPath, filePath);
    throw error;
  }
  if (fs.existsSync(parkedPath)) fs.rmSync(parkedPath);
  broadcast("data-change", { type: "attachment", id, issueId: attachment.issueId });
  return sendJson(response, 200, { ok: true });
}

function handleAgentNotification({ providerId, message, database, activeRuns, broadcast }) {
  const params = message.params || {};
  const threadId = params.threadId || params.thread?.id;
  const turnId = params.turnId || params.turn?.id;
  const active = findActiveRun(activeRuns, providerId, turnId, threadId);
  const persistedRun = active ? database.getRun(active.runId) : database.findRunByExternalId(providerId, { turnId, threadId });
  const issueId = active?.issueId || persistedRun?.issueId || null;
  const runId = active?.runId || persistedRun?.id || null;
  broadcast("agent-event", { providerId, method: message.method, params, issueId, runId });
  if (!runId) return;

  const agentText = extractAgentText(message);
  if (agentText) {
    if (active) active.summary = agentText;
    database.updateRun(runId, { summary: agentText });
  }
  if (message.method === "thread/tokenUsage/updated") {
    database.updateRun(runId, { usage: params.tokenUsage || params.usage || params });
    broadcast("data-change", { type: "agent-usage", issueId });
  }
  if (message.method === "turn/completed") {
    const status = normalizeTerminalStatus(params.turn?.status || params.status);
    const error = params.turn?.error?.message || params.error?.message || null;
    const changes = {
      status,
      summary: active?.summary || persistedRun?.summary || "",
      error,
    };
    const finalUsage = params.turn?.usage || params.usage;
    if (finalUsage) changes.usage = finalUsage;
    database.updateRun(runId, changes);
    if (active) removeActiveRun(activeRuns, active);
    broadcast("data-change", { type: "agent-run", issueId });
  }
}

function normalizeTerminalStatus(status) {
  if (status === "interrupted") return "interrupted";
  if (status === "failed") return "failed";
  return "completed";
}

function extractAgentText(message) {
  const item = message.params?.item;
  if (message.method !== "item/completed" || !item || !/agent.?message/i.test(item.type || "")) return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) return item.content.map((part) => part.text || "").join("").trim();
  return "";
}

function addActiveRun(map, active) {
  if (active.threadId) map.set(`${active.providerId}:thread:${active.threadId}`, active);
  if (active.turnId) map.set(`${active.providerId}:turn:${active.turnId}`, active);
}

function findActiveRun(map, providerId, turnId, threadId) {
  return (turnId && map.get(`${providerId}:turn:${turnId}`)) || (threadId && map.get(`${providerId}:thread:${threadId}`)) || null;
}

function removeActiveRun(map, active) {
  if (active.threadId) map.delete(`${active.providerId}:thread:${active.threadId}`);
  if (active.turnId) map.delete(`${active.providerId}:turn:${active.turnId}`);
}

function uniqueActiveRuns(map) {
  return [...new Set(map.values())];
}

function requireIssue(database, id) {
  const issue = database.getIssue(id);
  if (!issue) throw appError(404, "任务不存在", "NOT_FOUND");
  return issue;
}

function requiredQuery(url, name) {
  const value = String(url.searchParams.get(name) || "").trim();
  if (!value) throw appError(400, `缺少查询参数：${name}`, "VALIDATION_ERROR");
  return value;
}

function safeFilename(value) {
  const name = path.basename(String(value || "").trim()).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 240);
  if (!name) throw appError(400, "附件名称不能为空", "VALIDATION_ERROR");
  return name;
}

function decodeBase64(value) {
  const source = String(value || "").replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  if (!source || !/^[A-Za-z0-9+/]*={0,2}$/.test(source) || source.length % 4 === 1) {
    throw appError(400, "附件 base64 无效", "INVALID_BASE64");
  }
  return Buffer.from(source, "base64");
}

function optionalScalar(value, maxLength) {
  if (value === undefined || value === null || value === "") return undefined;
  const result = String(value).trim();
  if (!result || result.length > maxLength) throw appError(400, "参数文本无效", "VALIDATION_ERROR");
  return result;
}

function sendJson(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, securityHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  }));
  response.end(body);
}

function sendError(response, error) {
  if (response.headersSent) return response.end();
  sendJson(response, error.status || 500, {
    error: {
      code: error.code || "INTERNAL_ERROR",
      message: error.status ? error.message : "服务器内部错误",
      ...(error.details ? { details: error.details } : {}),
    },
  });
}

function serveStatic(response, requestPath) {
  let decoded;
  try { decoded = decodeURIComponent(requestPath); } catch { throw appError(400, "URL 编码无效", "INVALID_URL"); }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = path.resolve(WEB_ROOT, relative);
  if (!filePath.startsWith(`${WEB_ROOT}${path.sep}`) && filePath !== path.join(WEB_ROOT, "index.html")) {
    throw appError(403, "禁止访问", "FORBIDDEN");
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    if (path.extname(relative)) throw appError(404, "文件不存在", "NOT_FOUND");
    return serveStatic(response, "/index.html");
  }
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
  };
  const content = fs.readFileSync(filePath);
  response.writeHead(200, securityHeaders({
    "Content-Type": types[extension] || "application/octet-stream",
    "Content-Length": content.length,
    "Cache-Control": "no-cache",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  }));
  response.end(content);
}

function securityHeaders(headers) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    ...headers,
  };
}

export function startServer(options = {}) {
  const app = createFlowboardApp(options);
  const host = options.host || process.env.FLOWBOARD_HOST || "127.0.0.1";
  const port = Number(options.port ?? process.env.FLOWBOARD_PORT ?? 47823);
  const server = http.createServer(app.handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        app,
        server,
        host,
        port: typeof address === "object" ? address.port : port,
        async close() {
          app.close();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const instance = await startServer();
  console.log(`Codex Flowboard 已启动：http://${instance.host}:${instance.port}`);
  console.log(`数据目录：${path.resolve(process.env.FLOWBOARD_DATA_DIR || DEFAULT_DATA_DIR)}`);
  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
