import { spawn } from "node:child_process";
import { startServer } from "../server/index.mjs";

const instance = await startServer();
const url = `http://${instance.host}:${instance.port}`;
console.log(`Codex Flowboard 已启动：${url}`);
console.log("关闭此窗口或按 Ctrl+C 可停止服务。\n");

if (process.platform === "win32") {
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process '${url}'`], {
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

const shutdown = async () => {
  console.log("\n正在停止 Flowboard…");
  await instance.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
