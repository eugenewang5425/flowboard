const DEFAULT_MAX_CHARS = 12_000;

export function createIssuePrompt(issue, message = "", { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const safeLimit = Math.max(1_000, Math.min(Number(maxChars) || DEFAULT_MAX_CHARS, 50_000));
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  const intro = [
    `请处理任务 ${issue.identifier}：${issue.title}`,
    "",
    "任务说明：",
    issue.description || "未提供额外说明。",
    "",
    "验收标准：",
    issue.acceptanceCriteria || "未提供明确验收标准，请先确认可验证的完成条件。",
    "",
    `当前工作流阶段：${issue.workflowStage || "implementation"}`,
    `当前状态：${issue.status}`,
    `优先级：${issue.priority}`,
    issue.branch ? `绑定分支：${issue.branch}` : "",
    issue.worktreePath ? `绑定 worktree：${issue.worktreePath}` : "",
    "",
    "用户本次指令：",
    String(message || "").trim() || "完成本阶段要求，验证结果，并在最终回复中列出改动、验证和剩余风险。",
    "",
    "最新任务评论：",
  ].filter((line) => line !== "").join("\n");
  const outro = "\n\n请只处理本任务与当前阶段范围。不要自动提交、推送、发布、删除用户数据，或扩大外部系统权限。";
  const available = Math.max(0, safeLimit - intro.length - outro.length - 2);
  const included = [];
  let used = 0;

  for (const comment of [...comments].reverse()) {
    const line = `- ${comment.author || "用户"}: ${String(comment.body || "").trim()}`;
    if (!line.trim() || used + line.length + 1 > available) continue;
    included.unshift(line);
    used += line.length + 1;
  }

  const omittedComments = Math.max(0, comments.length - included.length);
  const commentSection = included.length ? included.join("\n") : "- 无";
  const omission = omittedComments ? `\n- （为控制 Token，已省略 ${omittedComments} 条较早评论）` : "";
  let prompt = `${intro}\n${commentSection}${omission}${outro}`;
  if (prompt.length > safeLimit) {
    const marker = "\n\n（内容已按提示词预算截断）";
    prompt = `${prompt.slice(0, Math.max(0, safeLimit - marker.length))}${marker}`;
  }

  return {
    prompt,
    charCount: prompt.length,
    estimatedInputTokens: Math.ceil(prompt.length / 4),
    includedComments: included.length,
    omittedComments,
    maxChars: safeLimit,
  };
}

export function buildIssuePrompt(issue, message, options) {
  return createIssuePrompt(issue, message, options).prompt;
}
