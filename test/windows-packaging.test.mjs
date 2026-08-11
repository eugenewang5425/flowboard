import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("ships a self-contained Windows x64 portable packaging workflow", () => {
  const files = [
    "packaging/windows/Flowboard.vbs",
    "packaging/windows/Start-Flowboard.ps1",
    "packaging/windows/Stop-Flowboard.ps1",
    "packaging/windows/README-Windows.txt",
    "packaging/windows/THIRD-PARTY-NOTICES.txt",
    "scripts/build-windows-portable.ps1",
    "scripts/verify-windows-package.ps1",
  ];
  for (const file of files) assert.equal(fs.existsSync(path.resolve(file)), true, file);
  const build = fs.readFileSync(path.resolve("scripts/build-windows-portable.ps1"), "utf8");
  assert.match(build, /codex-win32-x64/);
  assert.match(build, /ReparsePoint/);
  assert.match(build, /SHA256SUMS\.txt/);
  assert.match(build, /System\.Security\.Cryptography\.SHA256/);
  assert.doesNotMatch(build, /Get-FileHash/);
  const start = fs.readFileSync(path.resolve("packaging/windows/Start-Flowboard.ps1"), "utf8");
  assert.match(start, /LocalApplicationData/);
  assert.match(start, /127\.0\.0\.1/);
  assert.match(start, /runtime\\node\.exe/);
  const stop = fs.readFileSync(path.resolve("packaging/windows/Stop-Flowboard.ps1"), "utf8");
  assert.match(stop, /ExecutablePath/);
  assert.match(stop, /ParentProcessId/);
  assert.match(stop, /conhost\.exe/);
});
