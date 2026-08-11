export const STATUS_COLUMNS = [
  { id: "backlog", label: "待规划", symbol: "◇", color: "#9b8cff" },
  { id: "todo", label: "待处理", symbol: "○", color: "#9298ad" },
  { id: "in_progress", label: "进行中", symbol: "◐", color: "#72a7ff" },
  { id: "in_review", label: "待审查", symbol: "◉", color: "#f0c56b" },
  { id: "blocked", label: "已阻塞", symbol: "!", color: "#f6788c" },
  { id: "done", label: "已完成", symbol: "✓", color: "#66d99a" },
  { id: "canceled", label: "已取消", symbol: "×", color: "#666d83" },
];

export const STATUS_LABELS = Object.fromEntries(STATUS_COLUMNS.map((item) => [item.id, item.label]));

export const PRIORITY_LABELS = { none: "无", low: "低", medium: "中", high: "高", urgent: "紧急" };
export const STAGE_LABELS = { planning: "规划", implementation: "实现", review: "审查", testing: "测试" };

export function filterIssues(issues, { search = "", status = "", priority = "" } = {}) {
  const needle = String(search).trim().toLocaleLowerCase("zh-CN");
  return issues.filter((issue) => {
    if (status && issue.status !== status) return false;
    if (priority && issue.priority !== priority) return false;
    if (!needle) return true;
    const haystack = [
      issue.identifier, issue.title, issue.description, issue.acceptanceCriteria, issue.assignee,
      ...(issue.labels || []),
    ].join(" ").toLocaleLowerCase("zh-CN");
    return haystack.includes(needle);
  });
}

export function renderMarkdown(value) {
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let listType = null;
  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = null;
  };
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { closeList(); output.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`); continue; }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const nextType = unordered ? "ul" : "ol";
      if (listType !== nextType) { closeList(); output.push(`<${nextType}>`); listType = nextType; }
      output.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
      continue;
    }
    closeList();
    output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  return output.join("") || '<p class="muted">暂无内容</p>';
}

function inlineMarkdown(value) {
  let safe = escapeHtml(value);
  safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
  safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  safe = safe.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  safe = safe.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return safe;
}

export function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function formatTokenCount(value) {
  const number = Number(value || 0);
  if (number < 1_000) return String(number);
  return `${(number / 1_000).toFixed(number >= 10_000 ? 0 : 1)}k`;
}

export function usageTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const breakdown = usage.last && typeof usage.last === "object" ? usage.last
    : usage.total && typeof usage.total === "object" ? usage.total : usage;
  const direct = Number(breakdown.totalTokens ?? breakdown.total_tokens ?? breakdown.totalTokenCount);
  if (Number.isFinite(direct)) return direct;
  return Number(breakdown.inputTokens ?? breakdown.input_tokens ?? 0) + Number(breakdown.outputTokens ?? breakdown.output_tokens ?? 0);
}
