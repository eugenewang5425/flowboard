# Flowboard

Flowboard 是一个 Windows 优先、本地优先的 Agent 工作流看板。它把“任务状态”和“Agent 执行阶段”分开管理，让你能先梳理工作，再选择 Codex（后续兼容 Claude Code）承担规划、实现、审查或测试阶段。

当前 `v0.2.0` 是优先发布的 Codex 版。项目采用原创 clean-room 实现，只参考 `dashi-taskboard` 公开可见的工作流思想，不复制其源码、品牌或素材。

## 已实现

- 七段任务生命周期：待规划、待处理、进行中、待审查、已阻塞、已完成、已取消；
- 看板与列表视图、搜索、状态/优先级/归档筛选、拖拽流转；
- Markdown 说明与验收标准、负责人、日期、标签、Git 分支和独立 worktree；
- 评论、活动历史、图片/PDF/文本附件；
- 任务关系：相关、阻塞、父级；被未完成任务阻塞时不能错误标记为完成；
- 受控自动化候选：每日上限、并发上限、最小间隔和执行前检查；
- 官方 Codex app-server 集成、模型选择、推理强度、沙箱、运行/中断和 Token 记录；
- 三种会话策略：按阶段复用、每次新建、继续最近会话；
- Agent provider 注册表与阶段路由接口，为 Claude Code 适配保留统一边界；
- SQLite 迁移、乐观并发控制、SSE 同步、Host/Origin/字段白名单保护；
- Windows x64 可移植包，内置 Node.js 24 和 Codex CLI。

## Token 控制逻辑

Flowboard 本身的看板、筛选、关系和自动化候选都不会调用 Agent，因此不消耗模型 Token。只有你在任务详情中点击“启动本阶段”时才会发起 Agent 运行。

提示词预览显示的是本次由 Flowboard 新增的任务上下文估算，不包含 Agent 系统上下文和既有会话历史。减少 Codex Token 的主要手段是：

1. 把长任务拆成可验收的阶段；
2. 在不需要历史时选择“每次新建”；
3. 仅在同一阶段确有连续上下文时复用会话；
4. 让自动化只生成候选，保留人工启动门槛；
5. 后续通过阶段路由把合适工作分流到 Claude Code。

## Windows 可移植版

从私有 GitHub Release 下载 `Flowboard-0.2.0-win-x64.zip`，解压后：

- 双击 `Flowboard.vbs`：后台启动并打开浏览器；
- 运行 `Stop-Flowboard.ps1`：停止服务与其 Agent 子进程；
- 默认地址：<http://127.0.0.1:47823/>；
- 默认数据：`%LOCALAPPDATA%\Flowboard\data`；
- 默认日志：`%LOCALAPPDATA%\Flowboard\logs`。

这是未签名的 x64 可移植包，Windows 可能显示来源提示。包内包含 `SHA256SUMS.txt` 和第三方组件说明。

## 源码运行

要求 Windows 与 Node.js 24：

```powershell
Set-Location -LiteralPath 'C:\Workspace\flowboard'
npm ci
.\Start-Flowboard.ps1
```

也可以直接运行：

```powershell
npm start
```

源码模式默认数据位于项目的 `.data` 目录；该目录不会进入 Git 或 Windows 包。

## 构建与验收

```powershell
npm run check
npm run build:win
npm run verify:win
```

`npm run check` 包含 JavaScript 语法、Windows PowerShell 5.1 语法和 28 项自动化测试。`verify:win` 会从最终 ZIP 解压，在独立端口启动安装态服务，校验全部文件哈希、内置 Codex CLI、API 创建闭环和停止/端口释放，然后清理临时数据。

## CLI 示例

```powershell
npm run flowctl -- project create `
  --name '示例项目' `
  --workspace-path 'C:\Workspace\example-project' `
  --prefix DEMO

npm run flowctl -- issue create `
  --project 示例项目 `
  --title '实现可验证的功能基线' `
  --priority high `
  --labels control,mujoco
```

## 安全边界

- 服务默认只监听 `127.0.0.1`，并验证本地请求的 Host 与 Origin；
- Codex 默认使用 `workspaceWrite`，完全访问必须再次明确确认；
- Flowboard 不自动提交、推送、发布或删除项目数据；
- 自动化策略只创建候选，不会后台调用 Agent；
- 附件限制为图片、PDF 和纯文本，单个最大 10 MB；
- Codex 登录信息由本机 Codex CLI 管理，不写入 Flowboard 数据库或仓库。

## 多 Agent 路线

`v0.2.0` 优先稳定 Codex 工作流。下一阶段会实现 Claude Code provider、按项目/阶段保存路由，以及跨 provider 的运行与 Token 对比；现有 `AgentRegistry`、`workflowStage`、`provider` 和独立会话映射已经为此建立兼容层。

## Skill

仓库包含 `skills/manage-flowboard/SKILL.md`，用于从 Codex 中管理 Flowboard。项目不会自动修改个人 Codex 配置；如需全局安装，应由用户明确执行。
