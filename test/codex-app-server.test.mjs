import assert from "node:assert/strict";
import test from "node:test";

import { toCodexSandbox } from "../server/codex-app-server.mjs";

test("maps Flowboard sandbox names to Codex thread/start protocol values", () => {
  assert.equal(toCodexSandbox("readOnly"), "read-only");
  assert.equal(toCodexSandbox("workspaceWrite"), "workspace-write");
  assert.equal(toCodexSandbox("dangerFullAccess"), "danger-full-access");
  assert.throws(() => toCodexSandbox("unknown"), /不支持的沙箱策略/);
});
