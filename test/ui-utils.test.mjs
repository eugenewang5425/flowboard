import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { filterIssues, renderMarkdown, usageTokens } from "../web/ui-utils.js";

test("filters tasks across searchable fields, status and priority", () => {
  const issues = [
    { identifier: "MAP-1", title: "点云地图", description: "LiDAR", acceptanceCriteria: "可导出", assignee: "你", labels: ["三维"], status: "backlog", priority: "high" },
    { identifier: "MAP-2", title: "路径规划", description: "A star", acceptanceCriteria: "", assignee: "Codex", labels: [], status: "done", priority: "medium" },
  ];
  assert.deepEqual(filterIssues(issues, { search: "lidar" }).map((item) => item.identifier), ["MAP-1"]);
  assert.deepEqual(filterIssues(issues, { search: "三维", status: "backlog", priority: "high" }).map((item) => item.identifier), ["MAP-1"]);
  assert.equal(filterIssues(issues, { status: "todo" }).length, 0);
});

test("renders useful Markdown while escaping raw HTML and unsafe links", () => {
  const html = renderMarkdown("# 标题\n- **完成** `npm test`\n<script>alert(1)</script>\n[x](javascript:alert(1))\n[官网](https://example.com)");
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>完成<\/strong>/);
  assert.match(html, /<code>npm test<\/code>/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /href="https:\/\/example.com"/);
});

test("normalizes token usage variants", () => {
  assert.equal(usageTokens({ totalTokens: 12 }), 12);
  assert.equal(usageTokens({ input_tokens: 9, output_tokens: 3 }), 12);
  assert.equal(usageTokens({ total: { totalTokens: 999 }, last: { totalTokens: 21 } }), 21);
  assert.equal(usageTokens(null), 0);
});

test("ships all primary UI controls with safe dialog cancel behavior", () => {
  const html = fs.readFileSync(path.resolve("web/index.html"), "utf8");
  const css = fs.readFileSync(path.resolve("web/styles.css"), "utf8");
  for (const id of ["search-input", "status-filter", "priority-filter", "archived-filter", "automation-button", "board", "list-view", "project-dialog", "issue-dialog", "automation-dialog", "connect-agent-button"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /aria-label="关闭"[^>]*formnovalidate/);
  assert.match(html, /value="cancel"[^>]*formnovalidate>取消<\/button>/);
  assert.match(html, /data-view="board"/);
  assert.match(html, /data-view="list"/);
  assert.match(css, /\[hidden\]\{display:none!important\}/);
  const app = fs.readFileSync(path.resolve("web/app.js"), "utf8");
  assert.match(app, /id="agent-session-input"/);
  assert.match(app, /不含 Agent 系统上下文与会话历史/);
  assert.match(app, /id="relation-target-input"/);
  assert.match(app, /零 Token 设计/);
  assert.match(app, /不会自动调用任何 Agent/);
});
