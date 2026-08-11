import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { buildIssuePrompt } from "./prompt.mjs";

const REQUEST_TIMEOUT_MS = 30_000;
const SANDBOXES = ["readOnly", "workspaceWrite", "dangerFullAccess"];

export class CodexAppServer extends EventEmitter {
  constructor({ rootDirectory, logger = console } = {}) {
    super();
    this.id = "codex";
    this.name = "OpenAI Codex";
    this.capabilities = { models: true, interrupt: true, resume: true, usage: true };
    this.rootDirectory = rootDirectory || process.cwd();
    this.logger = logger;
    this.child = null;
    this.ready = false;
    this.starting = null;
    this.lastError = null;
    this.requestId = 0;
    this.pending = new Map();
  }

  status() {
    return {
      available: Boolean(this.#resolveLaunch()),
      running: Boolean(this.child && !this.child.killed),
      ready: this.ready,
      lastError: this.lastError,
    };
  }

  async ensureStarted() {
    if (this.ready && this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    this.starting = this.#start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async #start() {
    const launch = this.#resolveLaunch();
    if (!launch) throw new Error("找不到可运行的 Codex CLI。请先运行 npm install。");

    this.lastError = null;
    const child = spawn(launch.command, launch.args, {
      cwd: this.rootDirectory,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (!text) return;
      this.lastError = text.slice(-4_000);
      this.emit("diagnostic", { type: "stderr", message: this.lastError });
    });
    child.on("error", (error) => this.#handleExit(error));
    child.on("exit", (code, signal) => {
      this.#handleExit(new Error(`Codex app-server 已退出（code=${code}, signal=${signal || "none"}）`));
    });

    await this.request("initialize", {
      clientInfo: { name: "codex_flowboard", title: "Codex Flowboard", version: "0.2.0" },
    });
    this.notify("initialized", {});
    this.ready = true;
    this.emit("ready", this.status());
  }

  #resolveLaunch() {
    const override = process.env.FLOWBOARD_CODEX_COMMAND;
    if (override) return { command: override, args: ["app-server"] };

    const wrapper = path.join(this.rootDirectory, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(wrapper)) return { command: process.execPath, args: [wrapper, "app-server"] };

    const pathEntries = String(process.env.PATH || "").split(path.delimiter);
    const names = process.platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"];
    for (const entry of pathEntries) {
      for (const name of names) {
        const candidate = path.join(entry, name);
        if (fs.existsSync(candidate)) return { command: candidate, args: ["app-server"] };
      }
    }
    return null;
  }

  async request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (method !== "initialize") await this.ensureStarted();
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server 当前不可用");
    const id = ++this.requestId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    return result;
  }

  notify(method, params = {}) {
    if (this.child?.stdin?.writable) this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async listModels() {
    await this.ensureStarted();
    const result = await this.request("model/list", {});
    return result?.data || result?.models || [];
  }

  async startIssue({ issue, project, message, prompt, model, effort, sandbox = "workspaceWrite", threadId = null }) {
    await this.ensureStarted();
    if (!SANDBOXES.includes(sandbox)) throw new Error(`不支持的沙箱策略：${sandbox}`);
    const workspace = issue.worktreePath || project.workspacePath;
    let thread;
    if (threadId) {
      const resumed = await this.request("thread/resume", { threadId });
      thread = resumed.thread;
    } else {
      const params = {
        cwd: workspace,
        sandbox: toCodexSandbox(sandbox),
        approvalPolicy: "never",
        serviceName: "codex_flowboard",
      };
      if (model) params.model = model;
      const started = await this.request("thread/start", params);
      thread = started.thread;
    }
    if (!thread?.id) throw new Error("Codex 没有返回有效的 thread id");

    const resolvedPrompt = prompt || buildIssuePrompt(issue, message);
    const turnParams = {
      threadId: thread.id,
      input: [{ type: "text", text: resolvedPrompt }],
      cwd: workspace,
      approvalPolicy: "never",
      sandboxPolicy: buildSandboxPolicy(sandbox, workspace),
    };
    if (model) turnParams.model = model;
    if (effort) turnParams.effort = effort;
    const turnResult = await this.request("turn/start", turnParams);
    return { thread, turn: turnResult.turn, prompt: resolvedPrompt };
  }

  async interrupt(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  stop() {
    if (!this.child) return;
    this.child.kill();
    this.child = null;
    this.ready = false;
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("diagnostic", { type: "invalid-json", message: line.slice(0, 2_000) });
      return;
    }
    if (Object.hasOwn(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || `Codex 请求失败：${pending.method}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  #handleExit(error) {
    if (this.child === null && !this.ready) return;
    this.ready = false;
    this.child = null;
    this.lastError = error.message;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("exit", this.status());
  }
}

function buildSandboxPolicy(sandbox, workspace) {
  if (sandbox === "readOnly") return { type: "readOnly", access: { type: "fullAccess" } };
  if (sandbox === "dangerFullAccess") return { type: "dangerFullAccess" };
  return { type: "workspaceWrite", writableRoots: [workspace], networkAccess: false };
}

export function toCodexSandbox(sandbox) {
  const values = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" };
  if (!values[sandbox]) throw new Error(`不支持的沙箱策略：${sandbox}`);
  return values[sandbox];
}

export { buildIssuePrompt } from "./prompt.mjs";
