import {
  PRIORITY_LABELS,
  STAGE_LABELS,
  STATUS_COLUMNS,
  STATUS_LABELS,
  escapeHtml,
  filterIssues,
  formatTokenCount,
  renderMarkdown,
  usageTokens,
} from "./ui-utils.js";

const PRIORITY_COLORS = { none: "#666d83", low: "#72a7ff", medium: "#f0c56b", high: "#f0986b", urgent: "#f6788c" };
const state = {
  projects: [],
  issues: [],
  agents: [],
  models: {},
  metrics: null,
  selectedProjectId: localStorage.getItem("flowboard.project") || null,
  selectedIssue: null,
  search: "",
  status: "",
  priority: "",
  archived: false,
  view: localStorage.getItem("flowboard.view") || "board",
  promptPreview: null,
  automation: null,
  refreshTimer: null,
};

const elements = {
  projectList: document.querySelector("#project-list"),
  projectTitle: document.querySelector("#project-title"),
  projectPath: document.querySelector("#project-path"),
  board: document.querySelector("#board"),
  list: document.querySelector("#list-view"),
  toolbar: document.querySelector("#toolbar"),
  summary: document.querySelector("#summary-strip"),
  empty: document.querySelector("#empty-state"),
  resultCount: document.querySelector("#result-count"),
  addProject: document.querySelector("#add-project-button"),
  addIssue: document.querySelector("#add-issue-button"),
  emptyAction: document.querySelector("#empty-action"),
  refresh: document.querySelector("#refresh-button"),
  search: document.querySelector("#search-input"),
  statusFilter: document.querySelector("#status-filter"),
  priorityFilter: document.querySelector("#priority-filter"),
  archivedFilter: document.querySelector("#archived-filter"),
  automationButton: document.querySelector("#automation-button"),
  projectDialog: document.querySelector("#project-dialog"),
  projectForm: document.querySelector("#project-form"),
  saveProject: document.querySelector("#save-project-button"),
  issueDialog: document.querySelector("#issue-dialog"),
  issueContent: document.querySelector("#issue-dialog-content"),
  automationDialog: document.querySelector("#automation-dialog"),
  automationContent: document.querySelector("#automation-dialog-content"),
  agentPanel: document.querySelector("#agent-panel"),
  agentStatus: document.querySelector("#agent-status-text"),
  connectAgent: document.querySelector("#connect-agent-button"),
  toasts: document.querySelector("#toast-stack"),
};

boot().catch((error) => toast("启动失败", error.message, true));

async function boot() {
  populateFilters();
  bindGlobalEvents();
  await refreshBoard();
  connectEvents();
  const deepLink = new URLSearchParams(location.search).get("issue");
  if (deepLink) {
    try { await openIssueDialog(deepLink); } catch (error) { toast("无法打开任务", error.message, true); }
  }
}

function populateFilters() {
  elements.statusFilter.insertAdjacentHTML("beforeend", Object.entries(STATUS_LABELS).map(([id, label]) => `<option value="${id}">${label}</option>`).join(""));
  elements.priorityFilter.insertAdjacentHTML("beforeend", Object.entries(PRIORITY_LABELS).map(([id, label]) => `<option value="${id}">${label}</option>`).join(""));
}

function bindGlobalEvents() {
  elements.addProject.addEventListener("click", openProjectDialog);
  elements.emptyAction.addEventListener("click", () => state.projects.length ? openIssueDialog() : openProjectDialog());
  elements.addIssue.addEventListener("click", () => openIssueDialog());
  elements.refresh.addEventListener("click", () => refreshBoard(true));
  elements.search.addEventListener("input", (event) => { state.search = event.target.value; renderWorkArea(); });
  elements.statusFilter.addEventListener("change", (event) => { state.status = event.target.value; renderWorkArea(); });
  elements.priorityFilter.addEventListener("change", (event) => { state.priority = event.target.value; renderWorkArea(); });
  elements.archivedFilter.addEventListener("change", async (event) => { state.archived = event.target.checked; await refreshBoard(); });
  elements.automationButton.addEventListener("click", openAutomationDialog);
  elements.toolbar.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  elements.projectForm.addEventListener("submit", (event) => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    saveProject();
  });
  elements.connectAgent.addEventListener("click", connectCodex);
  elements.issueDialog.addEventListener("close", clearIssueDeepLink);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.issueDialog.open) elements.issueDialog.close();
  });
  window.addEventListener("popstate", () => {
    const identifier = new URLSearchParams(location.search).get("issue");
    if (!identifier && elements.issueDialog.open) elements.issueDialog.close();
    else if (identifier && identifier !== state.selectedIssue?.identifier) openIssueDialog(identifier).catch((error) => toast("无法打开任务", error.message, true));
  });
}

async function refreshBoard(showSuccess = false) {
  const query = new URLSearchParams();
  if (state.selectedProjectId) query.set("projectId", state.selectedProjectId);
  query.set("archived", String(state.archived));
  const data = await api(`/api/bootstrap?${query}`);
  state.projects = data.projects;
  state.agents = data.agents || [];
  state.metrics = data.metrics;
  if (!state.selectedProjectId || !state.projects.some((project) => project.id === state.selectedProjectId)) state.selectedProjectId = data.selectedProjectId;
  if (state.selectedProjectId !== data.selectedProjectId && state.selectedProjectId) {
    state.issues = await api(`/api/issues?projectId=${encodeURIComponent(state.selectedProjectId)}&archived=${state.archived}`);
  } else state.issues = data.issues;
  render();
  if (showSuccess) toast("已刷新", "任务和 Agent 状态已同步");
}

function scheduleRefresh({ dialog = false } = {}) {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(async () => {
    try {
      await refreshBoard();
      if (dialog && state.selectedIssue && elements.issueDialog.open) {
        state.selectedIssue = await api(`/api/issues/${encodeURIComponent(state.selectedIssue.id)}`);
        renderIssueDialog();
      }
    } catch (error) { toast("同步失败", error.message, true); }
  }, 160);
}

function render() {
  renderProjects();
  renderHeader();
  renderSummary();
  renderWorkArea();
  renderAgentStatus();
}

function renderProjects() {
  elements.projectList.innerHTML = state.projects.map((project) => `
    <button class="project-button ${project.id === state.selectedProjectId ? "is-active" : ""}" type="button" data-project-id="${escapeHtml(project.id)}">
      <span class="project-color" style="--project-color:${escapeHtml(project.color)}"></span>
      <span>${escapeHtml(project.name)}</span><span class="project-count">${project.activeCount}</span>
    </button>`).join("");
  elements.projectList.querySelectorAll("[data-project-id]").forEach((button) => button.addEventListener("click", async () => {
    state.selectedProjectId = button.dataset.projectId;
    localStorage.setItem("flowboard.project", state.selectedProjectId);
    await refreshBoard();
  }));
}

function renderHeader() {
  const project = selectedProject();
  elements.projectTitle.textContent = project?.name || "选择一个项目";
  elements.projectPath.textContent = project?.workspacePath || "创建项目后即可开始";
  elements.addIssue.disabled = !project;
  elements.automationButton.disabled = !project;
  elements.toolbar.hidden = !project;
}

function renderSummary() {
  const project = selectedProject();
  elements.summary.hidden = !project;
  if (!project) { elements.summary.innerHTML = ""; return; }
  const active = state.issues.filter((issue) => !["done", "canceled"].includes(issue.status));
  const linked = state.issues.filter((issue) => Object.keys(issue.agentThreads || {}).length).length;
  const tokens = state.metrics?.runs?.totalTokens || 0;
  elements.summary.innerHTML = [
    ["#8b7cff", state.archived ? "归档任务" : "当前任务", state.issues.length],
    ["#72a7ff", "进行中", state.issues.filter((issue) => issue.status === "in_progress").length],
    ["#f6788c", "待处理重点", active.filter((issue) => ["high", "urgent"].includes(issue.priority)).length],
    ["#63d6d1", "已关联 Agent", linked],
    ["#f0c56b", "累计 Token", formatTokenCount(tokens)],
  ].map(([color, label, value]) => `<div class="summary-chip"><span style="background:${color}"></span>${label}<strong>${value}</strong></div>`).join("");
}

function renderWorkArea() {
  const project = selectedProject();
  elements.empty.hidden = Boolean(project);
  elements.board.hidden = !project || state.view !== "board";
  elements.list.hidden = !project || state.view !== "list";
  if (!project) return;
  const filtered = visibleIssues();
  elements.resultCount.textContent = `${filtered.length} 个结果`;
  elements.toolbar.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === state.view));
  renderBoard(filtered);
  renderList(filtered);
}

function visibleIssues() {
  return filterIssues(state.issues, { search: state.search, status: state.status, priority: state.priority });
}

function renderBoard(filtered) {
  elements.board.innerHTML = STATUS_COLUMNS.map((column) => {
    const issues = filtered.filter((issue) => issue.status === column.id);
    return `<section class="column" data-status="${column.id}" style="--status-color:${column.color}">
      <header class="column-header"><span class="status-symbol">${column.symbol}</span><strong>${column.label}</strong><span class="column-count">${issues.length}</span>
      <button class="column-add" type="button" data-add-status="${column.id}" aria-label="在${column.label}中新建">＋</button></header>
      <div class="column-body">${issues.length ? issues.map(taskCard).join("") : '<div class="column-empty">暂无任务</div>'}</div>
    </section>`;
  }).join("");
  bindTaskOpeners(elements.board);
  elements.board.querySelectorAll("[data-add-status]").forEach((button) => button.addEventListener("click", () => openIssueDialog(null, button.dataset.addStatus)));
  elements.board.querySelectorAll(".task-card").forEach((card) => {
    card.addEventListener("dragstart", (event) => { event.dataTransfer.setData("text/plain", card.dataset.issueId); card.classList.add("is-dragging"); });
    card.addEventListener("dragend", () => card.classList.remove("is-dragging"));
  });
  elements.board.querySelectorAll(".column").forEach((column) => {
    column.addEventListener("dragover", (event) => { event.preventDefault(); column.classList.add("is-dragover"); });
    column.addEventListener("dragleave", () => column.classList.remove("is-dragover"));
    column.addEventListener("drop", async (event) => {
      event.preventDefault(); column.classList.remove("is-dragover");
      const issue = state.issues.find((item) => item.id === event.dataTransfer.getData("text/plain"));
      if (!issue || issue.status === column.dataset.status || state.archived) return;
      try {
        replaceIssue(await api(`/api/issues/${encodeURIComponent(issue.id)}`, { method: "PATCH", body: { ifVersion: issue.version, status: column.dataset.status } }));
        render();
      } catch (error) { toast("移动失败", error.message, true); scheduleRefresh(); }
    });
  });
}

function renderList(filtered) {
  elements.list.innerHTML = filtered.length ? `<div class="table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>阶段</th><th>优先级</th><th>负责人</th><th>截止</th><th>更新</th></tr></thead><tbody>${filtered.map((issue) => `
    <tr data-issue-id="${escapeHtml(issue.id)}" tabindex="0"><td><strong>${escapeHtml(issue.identifier)}</strong><span>${escapeHtml(issue.title)}</span></td>
      <td><span class="status-pill">${STATUS_LABELS[issue.status]}</span></td><td>${STAGE_LABELS[issue.workflowStage] || issue.workflowStage}</td>
      <td>${PRIORITY_LABELS[issue.priority]}</td><td>${escapeHtml(issue.assignee || "你")}</td><td>${issue.dueDate || "—"}</td><td>${relativeTime(issue.updatedAt)}</td></tr>`).join("")}</tbody></table></div>` : '<div class="list-empty">没有符合筛选条件的任务</div>';
  bindTaskOpeners(elements.list);
}

function bindTaskOpeners(root) {
  root.querySelectorAll("[data-issue-id]").forEach((item) => {
    item.addEventListener("click", () => openIssueDialog(item.dataset.issueId));
    item.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) openIssueDialog(item.dataset.issueId); });
  });
}

function taskCard(issue) {
  const labels = (issue.labels || []).slice(0, 3).map((label) => `<span class="label">${escapeHtml(label)}</span>`).join("");
  const agent = Object.keys(issue.agentThreads || {})[0];
  return `<article class="task-card" draggable="${!state.archived}" data-issue-id="${escapeHtml(issue.id)}">
    <div class="task-topline"><span class="task-id">${escapeHtml(issue.identifier)}</span>${issue.priority !== "none" ? `<span class="priority-mark" style="--priority-color:${PRIORITY_COLORS[issue.priority]}">${PRIORITY_LABELS[issue.priority]}</span>` : ""}</div>
    <h3>${escapeHtml(issue.title)}</h3>${issue.description ? `<p class="task-description">${escapeHtml(issue.description)}</p>` : ""}
    ${labels ? `<div class="labels">${labels}</div>` : ""}<div class="task-details"><span>${STAGE_LABELS[issue.workflowStage] || issue.workflowStage}</span>${issue.dueDate ? `<span>截止 ${issue.dueDate}</span>` : ""}</div>
    <footer class="task-footer">${issue.commentCount ? `<span>评论 ${issue.commentCount}</span>` : ""}${issue.attachmentCount ? `<span>附件 ${issue.attachmentCount}</span>` : ""}${agent ? `<span class="thread-linked">● ${escapeHtml(agent)}</span>` : ""}<time>${relativeTime(issue.updatedAt)}</time></footer>
  </article>`;
}

function setView(view) {
  state.view = view === "list" ? "list" : "board";
  localStorage.setItem("flowboard.view", state.view);
  renderWorkArea();
}

function openProjectDialog() {
  elements.projectForm.reset();
  elements.projectForm.elements.workspacePath.value = state.projects[0]?.workspacePath || "C:\\Workspace\\";
  elements.projectDialog.showModal();
}

async function saveProject() {
  elements.saveProject.disabled = true;
  try {
    const project = await api("/api/projects", { method: "POST", body: Object.fromEntries(new FormData(elements.projectForm)) });
    state.selectedProjectId = project.id;
    localStorage.setItem("flowboard.project", project.id);
    elements.projectDialog.close();
    await refreshBoard();
    toast("项目已创建", project.name);
  } catch (error) { toast("创建失败", error.message, true); }
  finally { elements.saveProject.disabled = false; }
}

async function openIssueDialog(issueId = null, status = "todo") {
  if (!selectedProject()) return;
  state.selectedIssue = issueId ? await api(`/api/issues/${encodeURIComponent(issueId)}`) : null;
  state.promptPreview = null;
  renderIssueDialog(status);
  if (!elements.issueDialog.open) elements.issueDialog.showModal();
  if (state.selectedIssue) setIssueDeepLink(state.selectedIssue.identifier);
}

function renderIssueDialog(defaultStatus = "todo") {
  const issue = state.selectedIssue;
  const isNew = !issue;
  const value = {
    identifier: issue?.identifier || "新任务", title: issue?.title || "", description: issue?.description || "",
    acceptanceCriteria: issue?.acceptanceCriteria || "", status: issue?.status || defaultStatus,
    priority: issue?.priority || "none", labels: issue?.labels?.join(", ") || "", assignee: issue?.assignee || "你",
    startDate: issue?.startDate || "", dueDate: issue?.dueDate || "", branch: issue?.branch || "",
    worktreePath: issue?.worktreePath || "", workflowStage: issue?.workflowStage || "implementation",
  };
  const activeRun = issue?.runs?.find((run) => ["starting", "running"].includes(run.status));
  elements.issueContent.innerHTML = `<div class="issue-layout">
    <section class="issue-main">
      <div class="modal-header"><div class="issue-meta-line"><span>${escapeHtml(value.identifier)}</span>${issue?.archivedAt ? '<span class="warning-text">已归档</span>' : ""}</div><button id="close-issue-dialog" class="close-button" type="button" aria-label="关闭">×</button></div>
      <input id="issue-title-input" class="issue-title-input" maxlength="240" placeholder="任务标题" value="${escapeHtml(value.title)}" />
      <div class="section-heading">任务说明 · 支持 Markdown</div>
      <textarea id="issue-description-input" class="issue-description" placeholder="写清目标、边界和背景…">${escapeHtml(value.description)}</textarea>
      <div id="description-preview" class="markdown-preview">${renderMarkdown(value.description)}</div>
      <div class="section-heading">验收标准</div>
      <textarea id="issue-acceptance-input" class="issue-description compact" placeholder="- 条件一&#10;- 条件二">${escapeHtml(value.acceptanceCriteria)}</textarea>
      <div id="acceptance-preview" class="markdown-preview">${renderMarkdown(value.acceptanceCriteria)}</div>
      ${isNew ? '<div class="hint-card">先保存任务，才能添加评论、附件和启动 Agent。</div>' : detailSections(issue)}
    </section>
    <aside class="issue-side">
      ${sideField("状态", "issue-status-input", selectOptions(STATUS_LABELS, value.status))}
      ${sideField("工作流阶段", "issue-stage-input", selectOptions(STAGE_LABELS, value.workflowStage))}
      ${sideField("优先级", "issue-priority-input", selectOptions(PRIORITY_LABELS, value.priority))}
      ${textField("负责人", "issue-assignee-input", value.assignee, "你")}
      <div class="side-pair">${dateField("开始日期", "issue-start-input", value.startDate)}${dateField("截止日期", "issue-due-input", value.dueDate)}</div>
      ${textField("标签（逗号分隔）", "issue-labels-input", value.labels, "学习, 实验")}
      ${textField("Git 分支", "issue-branch-input", value.branch, "feat/task-name")}
      ${textField("独立 worktree 路径", "issue-worktree-input", value.worktreePath, "留空则使用项目目录")}
      <div class="modal-actions sticky-actions"><button id="save-issue-button" class="primary-button" type="button">${isNew ? "创建任务" : "保存修改"}</button>${isNew ? "" : `<button id="archive-issue-button" class="secondary-button ${issue.archivedAt ? "" : "danger-text"}" type="button">${issue.archivedAt ? "恢复任务" : "归档任务"}</button>`}</div>
      ${isNew ? "" : agentCard(issue, activeRun)}
    </aside>
  </div>`;
  bindIssueEvents(isNew, activeRun);
}

function detailSections(issue) {
  return `<div class="section-heading">任务关系</div>
    <div class="relation-list">${issue.relations?.length ? issue.relations.map(relationItem).join("") : '<div class="subtle-empty">暂无任务关系</div>'}</div>
    <div class="relation-composer"><select id="relation-type-input"><option value="related">相关</option><option value="blocks">阻塞目标</option><option value="parent">作为目标的父级</option></select><input id="relation-target-input" maxlength="120" placeholder="目标任务编号，如 FLOW-3" /><button id="add-relation-button" class="secondary-button" type="button">添加</button></div>
    <div class="section-heading">附件</div>
    <div class="attachment-toolbar"><input id="attachment-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain" /><small>图片、PDF、文本，最大 10 MB</small></div>
    <div class="attachment-list">${issue.attachments?.length ? issue.attachments.map(attachmentItem).join("") : '<div class="subtle-empty">暂无附件</div>'}</div>
    <div class="section-heading">评论与进展</div>
    <div class="comment-list">${issue.comments?.length ? issue.comments.map(commentItem).join("") : '<div class="subtle-empty">还没有评论</div>'}</div>
    <div class="comment-composer"><textarea id="comment-input" maxlength="20000" placeholder="补充要求或记录进展…"></textarea><button id="add-comment-button" class="secondary-button" type="button">添加</button></div>
    <div class="section-heading">活动历史</div><div class="activity-list">${issue.activities?.length ? issue.activities.map(activityItem).join("") : '<div class="subtle-empty">暂无活动</div>'}</div>
    <div class="section-heading">Agent 运行</div><div class="run-list">${issue.runs?.length ? issue.runs.map(runItem).join("") : '<div class="subtle-empty">尚未运行 Agent</div>'}</div>`;
}

function agentCard(issue, activeRun) {
  const providers = state.agents.length ? state.agents : [{ id: "codex", name: "OpenAI Codex" }];
  const modelOptions = (state.models.codex || []).map((model) => `<option value="${escapeHtml(model.id || model.model || model.slug)}">${escapeHtml(model.displayName || model.name || model.id || model.model)}</option>`).join("");
  return `<div class="agent-action-card"><div class="card-title"><div><span class="eyebrow">AGENT RUN</span><h3>阶段执行</h3></div><span class="run-indicator ${activeRun ? "is-live" : ""}">${activeRun ? "运行中" : "待命"}</span></div>
    <div class="agent-grid"><label>Agent<select id="agent-provider-input">${providers.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`).join("")}</select></label>
    <label>模型<select id="agent-model-input"><option value="">默认模型</option>${modelOptions}</select></label>
    <label>推理强度<select id="agent-effort-input"><option value="">默认</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">超高</option></select></label>
    <label>权限<select id="agent-sandbox-input"><option value="workspaceWrite">仅工作区写入</option><option value="readOnly">只读</option><option value="dangerFullAccess">完全访问（危险）</option></select></label>
    <label class="agent-wide">会话策略<select id="agent-session-input"><option value="stage">按阶段复用（推荐）</option><option value="fresh">每次新建（少历史）</option><option value="resume">继续 Agent 最近会话</option></select></label></div>
    <textarea id="agent-message-input" placeholder="本阶段的补充指令；留空则按任务信息执行"></textarea>
    <div id="prompt-preview" class="prompt-preview">${state.promptPreview ? promptPreview(state.promptPreview) : "预览后可确认输入规模与省略内容。"}</div>
    <div class="agent-actions"><button id="preview-prompt-button" class="secondary-button" type="button">预览提示词</button>${activeRun ? '<button id="interrupt-agent-button" class="secondary-button danger-text" type="button">中断运行</button>' : '<button id="start-agent-button" class="primary-button" type="button">启动本阶段</button>'}</div>
  </div>`;
}

function bindIssueEvents(isNew, activeRun) {
  document.querySelector("#close-issue-dialog").addEventListener("click", () => elements.issueDialog.close());
  const description = document.querySelector("#issue-description-input");
  const acceptance = document.querySelector("#issue-acceptance-input");
  description.addEventListener("input", () => { document.querySelector("#description-preview").innerHTML = renderMarkdown(description.value); });
  acceptance.addEventListener("input", () => { document.querySelector("#acceptance-preview").innerHTML = renderMarkdown(acceptance.value); });
  document.querySelector("#save-issue-button").addEventListener("click", () => saveIssue({ close: isNew }));
  if (isNew) return;
  document.querySelector("#archive-issue-button").addEventListener("click", archiveOrRestoreIssue);
  document.querySelector("#add-comment-button").addEventListener("click", addComment);
  document.querySelector("#add-relation-button").addEventListener("click", addRelation);
  elements.issueContent.querySelectorAll("[data-delete-relation]").forEach((button) => button.addEventListener("click", () => deleteRelation(button.dataset.deleteRelation)));
  elements.issueContent.querySelectorAll("[data-open-related]").forEach((button) => button.addEventListener("click", () => openIssueDialog(button.dataset.openRelated)));
  document.querySelector("#attachment-input").addEventListener("change", uploadSelectedAttachment);
  elements.issueContent.querySelectorAll("[data-delete-attachment]").forEach((button) => button.addEventListener("click", () => deleteAttachment(button.dataset.deleteAttachment)));
  document.querySelector("#preview-prompt-button").addEventListener("click", previewPrompt);
  if (activeRun) document.querySelector("#interrupt-agent-button").addEventListener("click", interruptAgent);
  else document.querySelector("#start-agent-button").addEventListener("click", startAgent);
}

async function saveIssue({ close = false, quiet = false } = {}) {
  const wasNew = !state.selectedIssue;
  const input = collectIssueInput();
  const button = document.querySelector("#save-issue-button");
  if (!input.title.trim()) { toast("无法保存", "请填写任务标题", true); return null; }
  button.disabled = true;
  try {
    const saved = state.selectedIssue
      ? await api(`/api/issues/${encodeURIComponent(state.selectedIssue.id)}`, { method: "PATCH", body: { ...input, ifVersion: state.selectedIssue.version } })
      : await api("/api/issues", { method: "POST", body: { ...input, projectId: state.selectedProjectId } });
    state.selectedIssue = saved;
    replaceIssue(saved);
    if (!quiet) toast(wasNew ? "任务已创建" : "任务已保存", saved.identifier);
    if (close) elements.issueDialog.close();
    else { setIssueDeepLink(saved.identifier); renderIssueDialog(); }
    render();
    return saved;
  } catch (error) { toast("保存失败", error.message, true); if (error.code === "VERSION_CONFLICT") scheduleRefresh({ dialog: true }); return null; }
  finally { if (button.isConnected) button.disabled = false; }
}

function collectIssueInput() {
  return {
    title: valueOf("#issue-title-input"), description: valueOf("#issue-description-input"), acceptanceCriteria: valueOf("#issue-acceptance-input"),
    status: valueOf("#issue-status-input"), workflowStage: valueOf("#issue-stage-input"), priority: valueOf("#issue-priority-input"),
    assignee: valueOf("#issue-assignee-input"), startDate: valueOf("#issue-start-input") || null, dueDate: valueOf("#issue-due-input") || null,
    labels: valueOf("#issue-labels-input").split(",").map((item) => item.trim()).filter(Boolean), branch: valueOf("#issue-branch-input") || null,
    worktreePath: valueOf("#issue-worktree-input") || null,
  };
}

async function archiveOrRestoreIssue() {
  const issue = state.selectedIssue;
  const action = issue.archivedAt ? "restore" : "archive";
  try {
    await api(`/api/issues/${encodeURIComponent(issue.id)}/${action}`, { method: "POST", body: { ifVersion: issue.version } });
    elements.issueDialog.close();
    await refreshBoard();
    toast(action === "archive" ? "任务已归档" : "任务已恢复", issue.identifier);
  } catch (error) { toast("操作失败", error.message, true); }
}

async function addComment() {
  const input = document.querySelector("#comment-input");
  if (!input.value.trim()) return;
  try {
    await api(`/api/issues/${encodeURIComponent(state.selectedIssue.id)}/comments`, { method: "POST", body: { body: input.value } });
    await reloadIssue(); toast("评论已添加");
  } catch (error) { toast("添加失败", error.message, true); }
}

async function addRelation() {
  const targetIdentifier = valueOf("#relation-target-input").trim();
  if (!targetIdentifier) { toast("无法添加关系", "请填写目标任务编号", true); return; }
  try {
    await api(`/api/issues/${encodeURIComponent(state.selectedIssue.id)}/relations`, {
      method: "POST", body: { targetIdentifier, type: valueOf("#relation-type-input") },
    });
    await reloadIssue();
    toast("任务关系已添加", targetIdentifier);
  } catch (error) { toast("添加失败", error.message, true); }
}

async function deleteRelation(id) {
  if (!confirm("确定删除这条任务关系？")) return;
  try {
    await api(`/api/relations/${encodeURIComponent(id)}`, { method: "DELETE" });
    await reloadIssue();
    toast("任务关系已删除");
  } catch (error) { toast("删除失败", error.message, true); }
}

async function uploadSelectedAttachment(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { toast("附件过大", "最大允许 10 MB", true); event.target.value = ""; return; }
  try {
    const base64 = arrayBufferToBase64(await file.arrayBuffer());
    await api(`/api/issues/${encodeURIComponent(state.selectedIssue.id)}/attachments`, { method: "POST", body: { filename: file.name, contentType: file.type || "text/plain", base64 } });
    await reloadIssue(); toast("附件已上传", file.name);
  } catch (error) { toast("上传失败", error.message, true); }
}

async function deleteAttachment(id) {
  if (!confirm("确定删除这个附件？此操作不可撤销。")) return;
  try { await api(`/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }); await reloadIssue(); toast("附件已删除"); }
  catch (error) { toast("删除失败", error.message, true); }
}

async function previewPrompt() {
  try {
    state.promptPreview = await api(`/api/issues/${encodeURIComponent(state.selectedIssue.id)}/agent/preview`, {
      method: "POST", body: { message: valueOf("#agent-message-input"), workflowStage: valueOf("#issue-stage-input") },
    });
    document.querySelector("#prompt-preview").innerHTML = promptPreview(state.promptPreview);
  } catch (error) { toast("预览失败", error.message, true); }
}

async function startAgent() {
  const runInput = {
    message: valueOf("#agent-message-input"), provider: valueOf("#agent-provider-input"),
    model: valueOf("#agent-model-input") || null, effort: valueOf("#agent-effort-input") || null,
    sandbox: valueOf("#agent-sandbox-input"), workflowStage: valueOf("#issue-stage-input"), sessionMode: valueOf("#agent-session-input"),
  };
  const saved = await saveIssue({ quiet: true });
  if (!saved) return;
  const sandbox = runInput.sandbox;
  const confirmed = sandbox !== "dangerFullAccess" || confirm("完全访问将允许 Agent 修改工作区之外的文件。确定继续？");
  if (!confirmed) return;
  try {
    const result = await api(`/api/issues/${encodeURIComponent(saved.id)}/agent/start`, { method: "POST", body: {
      ifVersion: saved.version, ...runInput, confirmDangerFullAccess: sandbox === "dangerFullAccess",
    } });
    state.selectedIssue = result.issue;
    await reloadIssue(); toast("Agent 已启动", `${result.run.provider} · ${STAGE_LABELS[result.run.workflowStage]}`);
  } catch (error) { toast("启动失败", error.message, true); await reloadIssue(); }
}

async function interruptAgent() {
  try {
    await api(`/api/issues/${encodeURIComponent(state.selectedIssue.id)}/agent/interrupt`, { method: "POST", body: {} });
    await reloadIssue(); toast("运行已中断");
  } catch (error) { toast("中断失败", error.message, true); }
}

async function reloadIssue() {
  state.selectedIssue = await api(`/api/issues/${encodeURIComponent(state.selectedIssue.id)}`);
  replaceIssue(state.selectedIssue);
  renderIssueDialog();
  render();
}

async function openAutomationDialog() {
  if (!state.selectedProjectId) return;
  try {
    await reloadAutomation();
    if (!elements.automationDialog.open) elements.automationDialog.showModal();
  } catch (error) { toast("无法打开自动化设置", error.message, true); }
}

async function reloadAutomation() {
  const projectId = encodeURIComponent(state.selectedProjectId);
  const [policy, preflight, queue] = await Promise.all([
    api(`/api/automation/policy?projectId=${projectId}`),
    api(`/api/automation/preflight?projectId=${projectId}`),
    api(`/api/automation/queue?projectId=${projectId}`),
  ]);
  state.automation = { policy, preflight, queue };
  renderAutomationDialog();
}

function renderAutomationDialog() {
  const { policy, preflight, queue } = state.automation;
  const providerIds = new Set([policy.provider, ...state.agents.map((agent) => agent.id)]);
  const providers = [...providerIds].map((id) => {
    const agent = state.agents.find((item) => item.id === id);
    return `<option value="${escapeHtml(id)}" ${id === policy.provider ? "selected" : ""}>${escapeHtml(agent?.name || id)}</option>`;
  }).join("");
  const reasons = preflight.reasons.length ? preflight.reasons : preflight.eligible.length ? ["守卫检查通过，可生成一个候选"] : ["当前没有符合来源状态的任务"];
  elements.automationContent.innerHTML = `<div class="automation-layout">
    <div class="modal-header"><div><div class="eyebrow">CONTROLLED AUTOMATION</div><h2>自动化候选</h2></div><button id="close-automation-dialog" class="close-button" type="button" aria-label="关闭">×</button></div>
    <div class="automation-warning"><strong>零 Token 设计</strong><span>这里仅筛选并排队任务，不会自动调用任何 Agent。你仍需打开任务并手动启动阶段。</span></div>
    <div class="automation-grid">
      <label class="check-card"><input id="automation-enabled-input" type="checkbox" ${policy.enabled ? "checked" : ""} /><span><strong>启用候选策略</strong><small>允许手动生成候选，不代表无人值守执行</small></span></label>
      <label>Agent<select id="automation-provider-input">${providers}</select></label>
      <label>目标阶段<select id="automation-stage-input">${selectOptions(STAGE_LABELS, policy.workflowStage)}</select></label>
      <label>来源状态<select id="automation-status-input">${selectOptions(STATUS_LABELS, policy.sourceStatus)}</select></label>
      <label>每日候选上限<input id="automation-cap-input" type="number" min="1" max="100" value="${policy.dailyRunCap}" /></label>
      <label>并发运行上限<input id="automation-concurrency-input" type="number" min="1" max="10" value="${policy.concurrencyLimit}" /></label>
      <label>最小间隔（分钟）<input id="automation-interval-input" type="number" min="5" max="1440" value="${policy.minimumIntervalMinutes}" /></label>
    </div>
    <div class="automation-actions"><button id="save-automation-button" class="secondary-button" type="button">保存策略</button><button id="queue-automation-button" class="primary-button" type="button" ${preflight.canQueue ? "" : "disabled"}>生成零 Token 候选</button></div>
    <div class="preflight-card"><div><strong>执行前检查</strong><span>${preflight.activeRuns} 个运行中 · 今日 ${preflight.queuedToday}/${policy.dailyRunCap} 个候选</span></div><ul>${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>${preflight.nextAllowedAt ? `<small>下次允许：${formatDateTime(preflight.nextAllowedAt)}</small>` : ""}</div>
    <div class="section-heading">候选队列</div>
    <div class="automation-queue">${queue.length ? queue.map(automationQueueItem).join("") : '<div class="subtle-empty">暂无候选。策略通过后可手动生成。</div>'}</div>
  </div>`;
  document.querySelector("#close-automation-dialog").addEventListener("click", () => elements.automationDialog.close());
  document.querySelector("#save-automation-button").addEventListener("click", saveAutomationPolicy);
  document.querySelector("#queue-automation-button").addEventListener("click", queueAutomationCandidate);
  elements.automationContent.querySelectorAll("[data-open-automation-issue]").forEach((button) => button.addEventListener("click", async () => {
    elements.automationDialog.close();
    await openIssueDialog(button.dataset.openAutomationIssue);
  }));
  elements.automationContent.querySelectorAll("[data-dismiss-automation]").forEach((button) => button.addEventListener("click", () => dismissAutomationCandidate(button.dataset.dismissAutomation)));
}

function collectAutomationPolicy() {
  return {
    enabled: document.querySelector("#automation-enabled-input").checked,
    provider: valueOf("#automation-provider-input"), workflowStage: valueOf("#automation-stage-input"),
    sourceStatus: valueOf("#automation-status-input"), dailyRunCap: Number(valueOf("#automation-cap-input")),
    concurrencyLimit: Number(valueOf("#automation-concurrency-input")), minimumIntervalMinutes: Number(valueOf("#automation-interval-input")),
  };
}

async function saveAutomationPolicy() {
  try {
    await api(`/api/automation/policy/${encodeURIComponent(state.selectedProjectId)}`, { method: "PUT", body: collectAutomationPolicy() });
    await reloadAutomation();
    toast("自动化策略已保存", "没有调用 Agent");
  } catch (error) { toast("保存失败", error.message, true); }
}

async function queueAutomationCandidate() {
  try {
    const item = await api("/api/automation/queue-next", { method: "POST", body: { projectId: state.selectedProjectId } });
    await reloadAutomation();
    toast("候选已生成", `${item.identifier} · 未调用 Agent`);
  } catch (error) { toast("生成失败", error.message, true); await reloadAutomation(); }
}

async function dismissAutomationCandidate(id) {
  try {
    await api(`/api/automation/queue/${encodeURIComponent(id)}`, { method: "POST", body: {} });
    await reloadAutomation();
    toast("候选已忽略");
  } catch (error) { toast("操作失败", error.message, true); }
}

function automationQueueItem(item) {
  const status = { pending: "待人工确认", started: "已启动", dismissed: "已忽略" }[item.status] || item.status;
  return `<article class="automation-item"><div><span class="queue-status status-${escapeHtml(item.status)}">${escapeHtml(status)}</span><button type="button" data-open-automation-issue="${escapeHtml(item.issueId)}"><strong>${escapeHtml(item.identifier)}</strong> ${escapeHtml(item.title)}</button><small>${escapeHtml(item.provider)} · ${STAGE_LABELS[item.workflowStage] || escapeHtml(item.workflowStage)} · ${formatDateTime(item.createdAt)}</small></div>${item.status === "pending" ? `<button type="button" class="secondary-button" data-dismiss-automation="${escapeHtml(item.id)}">忽略</button>` : ""}</article>`;
}

async function connectCodex() {
  elements.connectAgent.disabled = true;
  try {
    await api("/api/agents/codex/connect", { method: "POST", body: {} });
    const models = await api("/api/agents/codex/models");
    state.models.codex = models;
    await refreshBoard();
    toast("Codex 已连接", `${models.length} 个可用模型`);
  } catch (error) { toast("连接失败", error.message, true); }
  finally { elements.connectAgent.disabled = false; }
}

function renderAgentStatus() {
  const codex = state.agents.find((agent) => agent.id === "codex");
  const status = codex?.status || {};
  elements.agentPanel.classList.toggle("is-ready", Boolean(status.ready));
  elements.agentPanel.classList.toggle("is-offline", !status.ready);
  elements.agentStatus.textContent = status.ready ? "已连接" : status.available ? "可连接" : "未安装";
  elements.connectAgent.textContent = status.ready ? "刷新" : "连接";
}

function connectEvents() {
  const events = new EventSource("/api/events");
  events.addEventListener("data-change", () => scheduleRefresh({ dialog: true }));
  events.addEventListener("agent-status", () => scheduleRefresh());
  events.onerror = () => { elements.agentStatus.textContent = "服务重连中"; };
}

function detailLabel(type) {
  return ({ "issue.created": "创建任务", "issue.updated": "更新任务", "issue.archived": "归档任务", "issue.restored": "恢复任务", "comment.created": "添加评论", "attachment.created": "上传附件", "attachment.deleted": "删除附件", "relation.created": "添加任务关系", "relation.deleted": "删除任务关系", "automation.queued": "生成自动化候选" })[type] || type;
}

function commentItem(comment) {
  return `<article class="comment"><header><strong>${escapeHtml(comment.author)}</strong><time>${formatDateTime(comment.createdAt)}</time></header><div class="markdown-body">${renderMarkdown(comment.body)}</div></article>`;
}

function attachmentItem(attachment) {
  const isImage = attachment.contentType.startsWith("image/");
  return `<article class="attachment-item">${isImage ? `<img src="${attachment.url}" alt="${escapeHtml(attachment.filename)}" />` : '<span class="file-icon">▤</span>'}<div><a href="${attachment.url}" target="_blank">${escapeHtml(attachment.filename)}</a><small>${formatBytes(attachment.size)}</small></div><button type="button" data-delete-attachment="${escapeHtml(attachment.id)}" aria-label="删除附件">×</button></article>`;
}

function relationItem(relation) {
  const labels = {
    related: "相关",
    blocks: relation.direction === "outgoing" ? "阻塞" : "被阻塞于",
    parent: relation.direction === "outgoing" ? "父级于" : "子任务，父级",
  };
  return `<article class="relation-item"><span class="relation-kind">${escapeHtml(labels[relation.type] || relation.type)}</span><button type="button" data-open-related="${escapeHtml(relation.issueId)}"><strong>${escapeHtml(relation.identifier)}</strong> ${escapeHtml(relation.title)}</button><button type="button" data-delete-relation="${escapeHtml(relation.id)}" aria-label="删除关系">×</button></article>`;
}

function activityItem(activity) {
  return `<div class="activity-item"><span></span><div><strong>${escapeHtml(activity.actor)}</strong> ${escapeHtml(detailLabel(activity.type))}<time>${formatDateTime(activity.createdAt)}</time></div></div>`;
}

function runItem(run) {
  const tokens = usageTokens(run.usage);
  return `<article class="run-item"><header><strong>${escapeHtml(run.provider)} · ${STAGE_LABELS[run.workflowStage] || run.workflowStage}</strong><span class="run-status status-${run.status}">${run.status}</span></header><div>${escapeHtml(run.model || "默认模型")} · ${escapeHtml(run.effort || "默认强度")} · ${escapeHtml(run.sandbox)}</div><small>提示词约 ${formatTokenCount(run.estimatedInputTokens)} token${tokens ? ` · 实际 ${formatTokenCount(tokens)}` : ""} · ${formatDateTime(run.startedAt)}</small>${run.summary ? `<p>${escapeHtml(run.summary)}</p>` : ""}${run.error ? `<p class="error-text">${escapeHtml(run.error)}</p>` : ""}</article>`;
}

function promptPreview(preview) {
  return `<strong>本次新增提示词约 ${formatTokenCount(preview.estimatedInputTokens)} token</strong><span>不含 Agent 系统上下文与会话历史 · ${preview.charCount} 字符 · 纳入 ${preview.includedComments} 条评论${preview.omittedComments ? ` · 省略 ${preview.omittedComments} 条` : ""}</span><details><summary>查看完整提示词</summary><pre>${escapeHtml(preview.prompt)}</pre></details>`;
}

function sideField(label, id, options) { return `<div class="side-group"><label for="${id}">${label}</label><select id="${id}">${options}</select></div>`; }
function textField(label, id, value, placeholder) { return `<div class="side-group"><label for="${id}">${label}</label><input id="${id}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" /></div>`; }
function dateField(label, id, value) { return `<div class="side-group"><label for="${id}">${label}</label><input id="${id}" type="date" value="${escapeHtml(value)}" /></div>`; }
function selectOptions(values, selected) { return Object.entries(values).map(([id, label]) => `<option value="${id}" ${id === selected ? "selected" : ""}>${label}</option>`).join(""); }
function valueOf(selector) { return document.querySelector(selector)?.value ?? ""; }
function selectedProject() { return state.projects.find((project) => project.id === state.selectedProjectId) || null; }
function replaceIssue(issue) { const index = state.issues.findIndex((item) => item.id === issue.id); if (index >= 0) state.issues[index] = issue; else state.issues.push(issue); }

function setIssueDeepLink(identifier) {
  const url = new URL(location.href);
  if (url.searchParams.get("issue") === identifier) return;
  url.searchParams.set("issue", identifier); history.pushState({}, "", url);
}
function clearIssueDeepLink() {
  state.selectedIssue = null; state.promptPreview = null;
  const url = new URL(location.href); url.searchParams.delete("issue"); history.replaceState({}, "", url);
}

async function api(route, { method = "GET", body } = {}) {
  const response = await fetch(route, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error?.message || `请求失败（${response.status}）`); error.code = data.error?.code; error.details = data.error?.details; throw error; }
  return data;
}

function toast(title, detail = "", error = false) {
  const item = document.createElement("div"); item.className = `toast${error ? " is-error" : ""}`;
  item.innerHTML = `<strong>${escapeHtml(title)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}`;
  elements.toasts.append(item); setTimeout(() => item.remove(), error ? 7_000 : 3_200);
}

function relativeTime(value) {
  const delta = Date.now() - new Date(value).getTime();
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}
function formatDateTime(value) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatBytes(value) { const size = Number(value); return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`; }
function arrayBufferToBase64(buffer) { const bytes = new Uint8Array(buffer); let binary = ""; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(binary); }
