import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { AgentRegistry } from "../server/agent-registry.mjs";

class FakeProvider extends EventEmitter {
  constructor(id) { super(); this.id = id; this.name = id.toUpperCase(); }
  status() { return { ready: true }; }
  async startIssue() { return { thread: { id: `${this.id}-thread` } }; }
  stop() { this.stopped = true; }
}

test("routes workflow stages to independently registered Agent providers", () => {
  const codex = new FakeProvider("codex");
  const claude = new FakeProvider("claude");
  const registry = new AgentRegistry({ providers: [codex, claude], stageRoutes: { planning: "claude", review: "claude" } });
  assert.equal(registry.resolve({ workflowStage: "planning" }).id, "claude");
  assert.equal(registry.resolve({ workflowStage: "implementation" }).id, "codex");
  assert.equal(registry.resolve({ providerId: "codex", workflowStage: "review" }).id, "codex");
  assert.deepEqual(registry.list().map((item) => item.id), ["codex", "claude"]);
  registry.stop();
  assert.equal(codex.stopped, true);
  assert.equal(claude.stopped, true);
});

test("annotates provider events and rejects unavailable providers", () => {
  const codex = new FakeProvider("codex");
  const registry = new AgentRegistry({ providers: [codex] });
  let received;
  registry.on("notification", (event) => { received = event; });
  codex.emit("notification", { method: "turn/completed" });
  assert.equal(received.providerId, "codex");
  assert.equal(received.payload.method, "turn/completed");
  assert.throws(() => registry.get("claude"), (error) => error.code === "AGENT_PROVIDER_UNAVAILABLE");
});
