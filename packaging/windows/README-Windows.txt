Flowboard Windows x64 可移植版
================================

启动：双击 Flowboard.vbs（后台运行并打开默认浏览器）。
调试启动：右键用 PowerShell 运行 Start-Flowboard.ps1。
停止：右键用 PowerShell 运行 Stop-Flowboard.ps1。

默认地址：http://127.0.0.1:47823/
默认数据：%LOCALAPPDATA%\Flowboard\data
默认日志：%LOCALAPPDATA%\Flowboard\logs

说明：
- 安装包自带 Node.js 与 Windows x64 Codex CLI，不需要另装 npm。
- Codex 登录信息仍复用当前 Windows 用户的本机登录状态。
- 首版为未签名的可移植包，Windows 可能显示来源提示。
- Flowboard 仅监听 127.0.0.1；危险沙箱仍必须再次确认。
