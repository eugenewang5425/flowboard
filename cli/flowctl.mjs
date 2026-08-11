#!/usr/bin/env node

const args = process.argv.slice(2);
const [resource, operation] = args;
const options = parseOptions(args.slice(2));
const baseUrl = process.env.FLOWBOARD_URL || "http://127.0.0.1:47823";

try {
  const result = await dispatch(resource, operation, options);
  if (result !== undefined) print(result, options.json);
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code || "CLI_ERROR", message: error.message } }, null, 2));
  process.exitCode = 1;
}

async function dispatch(resource, operation, input) {
  if (!resource || resource === "help" || input.help) return help();

  if (resource === "project" && operation === "list") return request("/api/projects");
  if (resource === "project" && operation === "create") {
    return request("/api/projects", {
      method: "POST",
      body: {
        id: input.id,
        name: required(input.name, "--name"),
        issuePrefix: input.prefix,
        workspacePath: required(input["workspace-path"], "--workspace-path"),
        color: input.color,
      },
    });
  }

  if (resource === "issue" && operation === "list") {
    const query = new URLSearchParams();
    if (input.project) query.set("projectId", input.project);
    if (input.status) query.set("status", input.status);
    if (input.search) query.set("search", input.search);
    return request(`/api/issues?${query}`);
  }
  if (resource === "issue" && operation === "get") {
    return request(`/api/issues/${encodeURIComponent(required(input.id || input._[0], "--id"))}`);
  }
  if (resource === "issue" && operation === "create") {
    return request("/api/issues", {
      method: "POST",
      body: {
        projectId: required(input.project, "--project"),
        title: required(input.title, "--title"),
        description: input.description || "",
        status: input.status || "todo",
        priority: input.priority || "none",
        labels: splitList(input.labels),
      },
    });
  }
  if (resource === "issue" && (operation === "move" || operation === "update")) {
    const id = required(input.id || input._[0], "--id");
    const current = await request(`/api/issues/${encodeURIComponent(id)}`);
    const body = { ifVersion: Number(input.version || current.version) };
    if (operation === "move") body.status = required(input.status, "--status");
    for (const field of ["title", "description", "status", "priority", "branch"]) {
      if (input[field] !== undefined) body[field] = input[field];
    }
    if (input.labels !== undefined) body.labels = splitList(input.labels);
    if (input["worktree-path"] !== undefined) body.worktreePath = input["worktree-path"];
    return request(`/api/issues/${encodeURIComponent(id)}`, { method: "PATCH", body });
  }

  if (resource === "comment" && operation === "list") {
    const issue = await request(`/api/issues/${encodeURIComponent(required(input.issue || input._[0], "--issue"))}`);
    return issue.comments;
  }
  if (resource === "comment" && operation === "add") {
    const id = required(input.issue || input._[0], "--issue");
    return request(`/api/issues/${encodeURIComponent(id)}/comments`, {
      method: "POST",
      body: { body: required(input.body, "--body"), author: input.author || "你" },
    });
  }

  if (resource === "codex" && operation === "status") return request("/api/codex/status");
  if (resource === "codex" && operation === "connect") {
    return request("/api/codex/connect", { method: "POST", body: {} });
  }
  if (resource === "codex" && operation === "start") {
    const id = required(input.issue || input._[0], "--issue");
    const issue = await request(`/api/issues/${encodeURIComponent(id)}`);
    return request(`/api/issues/${encodeURIComponent(id)}/codex/start`, {
      method: "POST",
      body: {
        ifVersion: Number(input.version || issue.version),
        message: input.message || "",
        model: input.model,
        effort: input.effort,
      },
    });
  }

  throw Object.assign(new Error(`未知命令：${resource || ""} ${operation || ""}`), { code: "UNKNOWN_COMMAND" });
}

async function request(pathname, options = {}) {
  const init = { ...options, headers: { ...(options.headers || {}) } };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, init);
  } catch {
    throw Object.assign(new Error(`无法连接 Flowboard：${baseUrl}。请先运行 npm start。`), { code: "SERVICE_UNAVAILABLE" });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error?.message || `HTTP ${response.status}`), {
      code: data.error?.code || "HTTP_ERROR",
    });
  }
  return data;
}

function parseOptions(tokens) {
  const parsed = { _: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue;
      continue;
    }
    const next = tokens[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      parsed[rawKey] = next;
      index += 1;
    } else {
      parsed[rawKey] = true;
    }
  }
  return parsed;
}

function required(value, flag) {
  if (value === undefined || value === null || value === "") {
    throw Object.assign(new Error(`缺少参数 ${flag}`), { code: "MISSING_ARGUMENT" });
  }
  return value;
}

function splitList(value) {
  return value ? String(value).split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function print(value, json) {
  if (json || typeof value !== "string") console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

function help() {
  return `Codex Flowboard CLI

项目：
  flowctl project list --json
  flowctl project create --name "项目名" --workspace-path "C:\\Workspace\\example" --prefix DEMO

任务：
  flowctl issue list --project demo --status todo --json
  flowctl issue get --id DEMO-1 --json
  flowctl issue create --project demo --title "实现功能" --priority high --labels code,mvp
  flowctl issue move --id DEMO-1 --status in_progress
  flowctl issue update --id DEMO-1 --description "新的任务说明"

评论：
  flowctl comment list --issue DEMO-1 --json
  flowctl comment add --issue DEMO-1 --body "已完成本地验证"

Codex：
  flowctl codex status --json
  flowctl codex connect --json
  flowctl codex start --issue DEMO-1 --message "完成并验证这个任务"

环境变量：FLOWBOARD_URL（默认 http://127.0.0.1:47823）`;
}
