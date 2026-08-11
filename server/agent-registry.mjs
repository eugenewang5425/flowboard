import { EventEmitter } from "node:events";

import { WORKFLOW_STAGES, appError } from "./database.mjs";

export class AgentRegistry extends EventEmitter {
  constructor({ providers = [], stageRoutes = {} } = {}) {
    super();
    this.providers = new Map();
    this.stageRoutes = Object.fromEntries(WORKFLOW_STAGES.map((stage) => [stage, stageRoutes[stage] || "codex"]));
    for (const provider of providers) this.register(provider);
  }

  register(provider) {
    const id = String(provider?.id || "").trim();
    if (!id || typeof provider.startIssue !== "function") throw new TypeError("Agent provider 必须提供 id 和 startIssue()。");
    if (this.providers.has(id)) throw new TypeError(`Agent provider 已存在：${id}`);
    this.providers.set(id, provider);
    for (const event of ["ready", "exit", "diagnostic", "notification"]) {
      provider.on?.(event, (payload) => this.emit(event, { providerId: id, payload }));
    }
    return provider;
  }

  get(id) {
    const provider = this.providers.get(id);
    if (!provider) throw appError(400, `Agent provider 不可用：${id}`, "AGENT_PROVIDER_UNAVAILABLE");
    return provider;
  }

  resolve({ providerId, workflowStage = "implementation" } = {}) {
    return this.get(providerId || this.stageRoutes[workflowStage] || "codex");
  }

  list() {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      name: provider.name || provider.id,
      capabilities: provider.capabilities || {},
      status: provider.status(),
    }));
  }

  async listModels(id) {
    const provider = this.get(id);
    return typeof provider.listModels === "function" ? provider.listModels() : [];
  }

  async connect(id) {
    const provider = this.get(id);
    await provider.ensureStarted?.();
    return provider.status();
  }

  stop() {
    for (const provider of this.providers.values()) provider.stop?.();
  }
}
