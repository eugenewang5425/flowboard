import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "canceled",
];

export const ISSUE_PRIORITIES = ["none", "low", "medium", "high", "urgent"];
export const ACTIVE_RUN_STATUSES = ["starting", "running"];
export const WORKFLOW_STAGES = ["planning", "implementation", "review", "testing"];
export const RELATION_TYPES = ["blocks", "related", "parent"];

export class FlowboardDatabase {
  constructor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
    this.interruptAbandonedRuns();
  }

  close() {
    this.db.close();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        issue_prefix TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#7c6cff',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        issue_number INTEGER NOT NULL,
        identifier TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        priority TEXT NOT NULL DEFAULT 'none',
        labels_json TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 1,
        codex_thread_id TEXT,
        branch TEXT,
        worktree_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, issue_number),
        UNIQUE(identifier)
      );

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '你',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS codex_runs (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        thread_id TEXT,
        turn_id TEXT,
        status TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        usage_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issue_activities (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        storage_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issue_relations (
        id TEXT PRIMARY KEY,
        source_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        target_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_issue_id, target_issue_id, type),
        CHECK(source_issue_id <> target_issue_id)
      );

      CREATE TABLE IF NOT EXISTS automation_policies (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL DEFAULT 'codex',
        workflow_stage TEXT NOT NULL DEFAULT 'planning',
        source_status TEXT NOT NULL DEFAULT 'backlog',
        daily_run_cap INTEGER NOT NULL DEFAULT 3,
        concurrency_limit INTEGER NOT NULL DEFAULT 1,
        minimum_interval_minutes INTEGER NOT NULL DEFAULT 60,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_queue (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        workflow_stage TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_comments_issue
        ON comments(issue_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_codex_runs_issue
        ON codex_runs(issue_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_issue_activities_issue
        ON issue_activities(issue_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_attachments_issue
        ON attachments(issue_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_issue_relations_source ON issue_relations(source_issue_id, type);
      CREATE INDEX IF NOT EXISTS idx_issue_relations_target ON issue_relations(target_issue_id, type);
      CREATE INDEX IF NOT EXISTS idx_automation_queue_project ON automation_queue(project_id, status, created_at DESC);
    `);

    this.#ensureColumn("issues", "acceptance_criteria", "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn("issues", "start_date", "TEXT");
    this.#ensureColumn("issues", "due_date", "TEXT");
    this.#ensureColumn("issues", "assignee", "TEXT NOT NULL DEFAULT '你'");
    this.#ensureColumn("issues", "archived_at", "TEXT");
    this.#ensureColumn("issues", "sort_order", "REAL NOT NULL DEFAULT 0");
    this.#ensureColumn("issues", "workflow_stage", "TEXT NOT NULL DEFAULT 'implementation'");
    this.#ensureColumn("issues", "agent_threads_json", "TEXT NOT NULL DEFAULT '{}'");
    this.#ensureColumn("codex_runs", "prompt_chars", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("codex_runs", "estimated_input_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("codex_runs", "model", "TEXT");
    this.#ensureColumn("codex_runs", "effort", "TEXT");
    this.#ensureColumn("codex_runs", "sandbox", "TEXT NOT NULL DEFAULT 'workspaceWrite'");
    this.#ensureColumn("codex_runs", "started_at", "TEXT");
    this.#ensureColumn("codex_runs", "finished_at", "TEXT");
    this.#ensureColumn("codex_runs", "error", "TEXT");
    this.#ensureColumn("codex_runs", "provider", "TEXT NOT NULL DEFAULT 'codex'");
    this.#ensureColumn("codex_runs", "workflow_stage", "TEXT NOT NULL DEFAULT 'implementation'");
    this.#ensureColumn("codex_runs", "session_mode", "TEXT NOT NULL DEFAULT 'stage'");
    this.db.exec(`
      DROP INDEX IF EXISTS idx_issues_project_status;
      CREATE INDEX idx_issues_project_status
        ON issues(project_id, archived_at, status, sort_order, updated_at DESC);
    `);
    this.db.prepare("INSERT OR IGNORE INTO runtime_metadata (key, value) VALUES ('revision', '0')").run();
  }

  #ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  revision() {
    return Number(this.db.prepare("SELECT value FROM runtime_metadata WHERE key = 'revision'").get()?.value || 0);
  }

  #touchRevision() {
    this.db.prepare(`
      UPDATE runtime_metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
      WHERE key = 'revision'
    `).run();
  }

  listProjects() {
    return this.db.prepare(`
      SELECT p.*,
        SUM(CASE WHEN i.archived_at IS NULL THEN 1 ELSE 0 END) AS issue_count,
        SUM(CASE WHEN i.archived_at IS NULL AND i.status NOT IN ('done', 'canceled') THEN 1 ELSE 0 END) AS active_count
      FROM projects p
      LEFT JOIN issues i ON i.project_id = p.id
      GROUP BY p.id
      ORDER BY p.updated_at DESC
    `).all().map(mapProject);
  }

  getProject(id) {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? mapProject(row) : null;
  }

  createProject(input) {
    const timestamp = now();
    const id = normalizeProjectId(input.id || input.name);
    const name = requiredText(input.name, "项目名称", 120);
    const workspacePath = requiredText(input.workspacePath, "项目目录", 2_048);
    if (!path.isAbsolute(workspacePath)) throw validationError("项目目录必须是绝对路径");
    const issuePrefix = normalizePrefix(input.issuePrefix || name);
    const color = validColor(input.color) ? input.color : "#7c6cff";
    try {
      this.db.prepare(`
        INSERT INTO projects (id, name, issue_prefix, workspace_path, color, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, issuePrefix, path.resolve(workspacePath), color, timestamp, timestamp);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw conflictError(`项目 ID「${id}」已存在`);
      throw error;
    }
    this.#touchRevision();
    return this.getProject(id);
  }

  listIssues({ projectId, status, search, archived = "false", priority } = {}) {
    const clauses = [];
    const values = [];
    if (projectId) {
      clauses.push("i.project_id = ?");
      values.push(projectId);
    }
    if (status) {
      if (!ISSUE_STATUSES.includes(status)) throw validationError("无效的任务状态");
      clauses.push("i.status = ?");
      values.push(status);
    }
    if (priority) {
      if (!ISSUE_PRIORITIES.includes(priority)) throw validationError("无效的优先级");
      clauses.push("i.priority = ?");
      values.push(priority);
    }
    if (archived === "false" || archived === false || archived === undefined) clauses.push("i.archived_at IS NULL");
    else if (archived === "true" || archived === true) clauses.push("i.archived_at IS NOT NULL");
    else if (archived !== "all") throw validationError("archived 必须为 false、true 或 all");
    if (search) {
      clauses.push("(i.title LIKE ? OR i.description LIKE ? OR i.acceptance_criteria LIKE ? OR i.identifier LIKE ?)");
      const pattern = `%${String(search).slice(0, 200)}%`;
      values.push(pattern, pattern, pattern, pattern);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`
      SELECT i.*, p.name AS project_name, p.workspace_path,
        (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comment_count,
        (SELECT COUNT(*) FROM attachments a WHERE a.issue_id = i.id) AS attachment_count
      FROM issues i
      JOIN projects p ON p.id = i.project_id
      ${where}
      ORDER BY
        CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        i.sort_order ASC,
        i.updated_at DESC
    `).all(...values).map(mapIssue);
  }

  getIssue(idOrIdentifier) {
    const row = this.db.prepare(`
      SELECT i.*, p.name AS project_name, p.workspace_path,
        (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comment_count,
        (SELECT COUNT(*) FROM attachments a WHERE a.issue_id = i.id) AS attachment_count
      FROM issues i
      JOIN projects p ON p.id = i.project_id
      WHERE i.id = ? OR i.identifier = ?
    `).get(idOrIdentifier, idOrIdentifier);
    if (!row) return null;
    const issue = mapIssue(row);
    issue.comments = this.listComments(issue.id);
    issue.runs = this.listRuns(issue.id);
    issue.activities = this.listActivities(issue.id);
    issue.attachments = this.listAttachments(issue.id);
    issue.relations = this.listRelations(issue.id);
    return issue;
  }

  createIssue(input) {
    const project = this.getProject(input.projectId);
    if (!project) throw notFoundError("项目不存在");
    const title = requiredText(input.title, "任务标题", 240);
    const description = optionalText(input.description, 100_000);
    const acceptanceCriteria = optionalText(input.acceptanceCriteria, 100_000);
    const status = normalizeStatus(input.status || "todo");
    const priority = normalizePriority(input.priority || "none");
    const labels = normalizeLabels(input.labels);
    const startDate = normalizeDate(input.startDate, "开始日期");
    const dueDate = normalizeDate(input.dueDate, "截止日期");
    if (startDate && dueDate && startDate > dueDate) throw validationError("开始日期不能晚于截止日期");
    const assignee = optionalText(input.assignee, 120) || "你";
    const workflowStage = normalizeWorkflowStage(input.workflowStage || "implementation");
    const branch = nullableText(input.branch, 500);
    const worktreePath = nullableText(input.worktreePath, 2_048);
    if (worktreePath && !path.isAbsolute(worktreePath)) throw validationError("worktree 路径必须是绝对路径");
    const timestamp = now();
    const id = randomUUID();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const next = this.db.prepare(
        "SELECT COALESCE(MAX(issue_number), 0) + 1 AS value FROM issues WHERE project_id = ?",
      ).get(project.id).value;
      const sortOrder = Number(this.db.prepare(
        "SELECT COALESCE(MAX(sort_order), 0) + 1000 AS value FROM issues WHERE project_id = ? AND status = ?",
      ).get(project.id, status).value);
      const identifier = `${project.issuePrefix}-${next}`;
      this.db.prepare(`
        INSERT INTO issues (
          id, project_id, issue_number, identifier, title, description, acceptance_criteria,
          status, priority, labels_json, assignee, start_date, due_date, sort_order, workflow_stage,
          branch, worktree_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, project.id, next, identifier, title, description, acceptanceCriteria,
        status, priority, JSON.stringify(labels), assignee, startDate, dueDate, sortOrder, workflowStage,
        branch, worktreePath ? path.resolve(worktreePath) : null, timestamp, timestamp,
      );
      this.#recordActivity(id, "issue.created", { title, status }, input.actor || "你", timestamp);
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(timestamp, project.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.#touchRevision();
    return this.getIssue(id);
  }

  updateIssue(idOrIdentifier, changes) {
    const current = this.getIssue(idOrIdentifier);
    if (!current) throw notFoundError("任务不存在");
    if (!Number.isInteger(changes.ifVersion)) throw validationError("更新任务必须提供 ifVersion");
    if (changes.ifVersion !== current.version) {
      throw conflictError("任务已被其他操作更新，请刷新后重试", { current });
    }

    const setters = [];
    const values = [];
    const changed = {};
    const add = (field, column, value) => {
      setters.push(`${column} = ?`);
      values.push(value);
      changed[field] = { before: current[field], after: value };
    };
    if (Object.hasOwn(changes, "title")) add("title", "title", requiredText(changes.title, "任务标题", 240));
    if (Object.hasOwn(changes, "description")) add("description", "description", optionalText(changes.description, 100_000));
    if (Object.hasOwn(changes, "acceptanceCriteria")) add("acceptanceCriteria", "acceptance_criteria", optionalText(changes.acceptanceCriteria, 100_000));
    if (Object.hasOwn(changes, "status")) add("status", "status", normalizeStatus(changes.status));
    if (Object.hasOwn(changes, "priority")) add("priority", "priority", normalizePriority(changes.priority));
    if (Object.hasOwn(changes, "labels")) add("labels", "labels_json", JSON.stringify(normalizeLabels(changes.labels)));
    if (Object.hasOwn(changes, "codexThreadId")) add("codexThreadId", "codex_thread_id", nullableText(changes.codexThreadId, 300));
    if (Object.hasOwn(changes, "branch")) add("branch", "branch", nullableText(changes.branch, 500));
    if (Object.hasOwn(changes, "worktreePath")) add("worktreePath", "worktree_path", nullableText(changes.worktreePath, 2_048));
    if (Object.hasOwn(changes, "assignee")) add("assignee", "assignee", optionalText(changes.assignee, 120) || "你");
    if (Object.hasOwn(changes, "startDate")) add("startDate", "start_date", normalizeDate(changes.startDate, "开始日期"));
    if (Object.hasOwn(changes, "dueDate")) add("dueDate", "due_date", normalizeDate(changes.dueDate, "截止日期"));
    if (Object.hasOwn(changes, "sortOrder")) add("sortOrder", "sort_order", normalizeSortOrder(changes.sortOrder));
    if (Object.hasOwn(changes, "workflowStage")) add("workflowStage", "workflow_stage", normalizeWorkflowStage(changes.workflowStage));
    if (Object.hasOwn(changes, "agentThreads")) add("agentThreads", "agent_threads_json", JSON.stringify(normalizeAgentThreads(changes.agentThreads)));
    if (setters.length === 0) return current;

    const resultingStart = Object.hasOwn(changes, "startDate") ? normalizeDate(changes.startDate, "开始日期") : current.startDate;
    const resultingDue = Object.hasOwn(changes, "dueDate") ? normalizeDate(changes.dueDate, "截止日期") : current.dueDate;
    if (resultingStart && resultingDue && resultingStart > resultingDue) throw validationError("开始日期不能晚于截止日期");
    if (changes.status === "done") {
      const blockers = this.blockingIssues(current.id);
      if (blockers.length) throw conflictError("任务仍被未完成任务阻塞", { blockers });
    }

    const timestamp = now();
    setters.push("version = version + 1", "updated_at = ?");
    values.push(timestamp, current.id, changes.ifVersion);
    const result = this.db.prepare(`
      UPDATE issues SET ${setters.join(", ")}
      WHERE id = ? AND version = ?
    `).run(...values);
    if (result.changes !== 1) throw conflictError("任务版本冲突，请刷新后重试");
    this.#recordActivity(current.id, "issue.updated", { changes: changed }, changes.actor || "你", timestamp);
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(timestamp, current.projectId);
    this.#touchRevision();
    return this.getIssue(current.id);
  }

  archiveIssue(idOrIdentifier, ifVersion, actor = "你") {
    const current = this.getIssue(idOrIdentifier);
    if (!current) throw notFoundError("任务不存在");
    if (current.archivedAt) return current;
    if (ifVersion !== current.version) throw conflictError("任务版本冲突，请刷新后重试", { current });
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE issues SET archived_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(timestamp, timestamp, current.id, ifVersion);
    if (result.changes !== 1) throw conflictError("任务版本冲突，请刷新后重试");
    this.#recordActivity(current.id, "issue.archived", {}, actor, timestamp);
    this.#touchRevision();
    return this.getIssue(current.id);
  }

  restoreIssue(idOrIdentifier, ifVersion, actor = "你") {
    const current = this.getIssue(idOrIdentifier);
    if (!current) throw notFoundError("任务不存在");
    if (!current.archivedAt) return current;
    if (ifVersion !== current.version) throw conflictError("任务版本冲突，请刷新后重试", { current });
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE issues SET archived_at = NULL, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(timestamp, current.id, ifVersion);
    if (result.changes !== 1) throw conflictError("任务版本冲突，请刷新后重试");
    this.#recordActivity(current.id, "issue.restored", {}, actor, timestamp);
    this.#touchRevision();
    return this.getIssue(current.id);
  }

  listComments(issueId) {
    return this.db.prepare("SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at ASC").all(issueId).map(mapComment);
  }

  addComment(issueIdOrIdentifier, input) {
    const issue = this.getIssue(issueIdOrIdentifier);
    if (!issue) throw notFoundError("任务不存在");
    const timestamp = now();
    const id = randomUUID();
    const author = optionalText(input.author, 80) || "你";
    const body = requiredText(input.body, "评论", 20_000);
    this.db.prepare(`
      INSERT INTO comments (id, issue_id, body, author, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, issue.id, body, author, timestamp);
    this.db.prepare("UPDATE issues SET version = version + 1, updated_at = ? WHERE id = ?").run(timestamp, issue.id);
    this.#recordActivity(issue.id, "comment.created", { commentId: id }, author, timestamp);
    this.#touchRevision();
    return mapComment(this.db.prepare("SELECT * FROM comments WHERE id = ?").get(id));
  }

  listActivities(issueId) {
    return this.db.prepare(
      "SELECT * FROM issue_activities WHERE issue_id = ? ORDER BY created_at DESC, id DESC LIMIT 100",
    ).all(issueId).map(mapActivity);
  }

  #recordActivity(issueId, type, detail = {}, actor = "你", timestamp = now()) {
    this.db.prepare(`
      INSERT INTO issue_activities (id, issue_id, type, actor, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), issueId, type, optionalText(actor, 80) || "你", JSON.stringify(detail), timestamp);
  }

  listAttachments(issueId) {
    return this.db.prepare("SELECT * FROM attachments WHERE issue_id = ? ORDER BY created_at ASC").all(issueId).map(mapAttachment);
  }

  getAttachment(id) {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
    return row ? mapAttachment(row) : null;
  }

  addAttachment(issueIdOrIdentifier, input) {
    const issue = this.getIssue(issueIdOrIdentifier);
    if (!issue) throw notFoundError("任务不存在");
    const timestamp = now();
    const id = randomUUID();
    const attachment = {
      id,
      issueId: issue.id,
      filename: requiredText(input.filename, "附件名称", 240),
      contentType: requiredText(input.contentType, "附件类型", 120),
      size: normalizeSize(input.size),
      storageName: requiredText(input.storageName, "附件存储名", 120),
      createdAt: timestamp,
    };
    this.db.prepare(`
      INSERT INTO attachments (id, issue_id, filename, content_type, size, storage_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, issue.id, attachment.filename, attachment.contentType, attachment.size, attachment.storageName, timestamp);
    this.db.prepare("UPDATE issues SET version = version + 1, updated_at = ? WHERE id = ?").run(timestamp, issue.id);
    this.#recordActivity(issue.id, "attachment.created", { attachmentId: id, filename: attachment.filename }, input.actor || "你", timestamp);
    this.#touchRevision();
    return this.getAttachment(id);
  }

  removeAttachment(id, actor = "你") {
    const attachment = this.getAttachment(id);
    if (!attachment) throw notFoundError("附件不存在");
    const timestamp = now();
    this.db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    this.db.prepare("UPDATE issues SET version = version + 1, updated_at = ? WHERE id = ?").run(timestamp, attachment.issueId);
    this.#recordActivity(attachment.issueId, "attachment.deleted", { attachmentId: id, filename: attachment.filename }, actor, timestamp);
    this.#touchRevision();
    return attachment;
  }

  listRelations(issueId) {
    return this.db.prepare(`
      SELECT r.*, s.identifier AS source_identifier, s.title AS source_title,
        t.identifier AS target_identifier, t.title AS target_title
      FROM issue_relations r
      JOIN issues s ON s.id = r.source_issue_id
      JOIN issues t ON t.id = r.target_issue_id
      WHERE r.source_issue_id = ? OR r.target_issue_id = ?
      ORDER BY r.created_at ASC
    `).all(issueId, issueId).map((row) => ({
      id: row.id,
      type: row.type,
      direction: row.source_issue_id === issueId ? "outgoing" : "incoming",
      issueId: row.source_issue_id === issueId ? row.target_issue_id : row.source_issue_id,
      identifier: row.source_issue_id === issueId ? row.target_identifier : row.source_identifier,
      title: row.source_issue_id === issueId ? row.target_title : row.source_title,
      createdAt: row.created_at,
    }));
  }

  createRelation(sourceIdOrIdentifier, input) {
    const source = this.getIssue(sourceIdOrIdentifier);
    const target = this.getIssue(requiredText(input.targetIdentifier, "目标任务", 120));
    if (!source || !target) throw notFoundError("关联任务不存在");
    if (source.id === target.id) throw validationError("任务不能关联自身");
    if (source.projectId !== target.projectId) throw validationError("首版仅支持同一项目内的任务关系");
    const type = String(input.type || "related");
    if (!RELATION_TYPES.includes(type)) throw validationError("无效的任务关系类型");
    let sourceId = source.id;
    let targetId = target.id;
    if (type === "related" && sourceId > targetId) [sourceId, targetId] = [targetId, sourceId];
    const id = randomUUID();
    const timestamp = now();
    try {
      this.db.prepare(`INSERT INTO issue_relations (id, source_issue_id, target_issue_id, type, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(id, sourceId, targetId, type, timestamp);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw conflictError("该任务关系已存在");
      throw error;
    }
    this.#recordActivity(source.id, "relation.created", { relationId: id, type, target: target.identifier }, input.actor || "你", timestamp);
    this.#recordActivity(target.id, "relation.created", { relationId: id, type, source: source.identifier }, input.actor || "你", timestamp);
    this.#touchRevision();
    return this.listRelations(source.id).find((relation) => relation.id === id);
  }

  removeRelation(id, actor = "你") {
    const row = this.db.prepare("SELECT * FROM issue_relations WHERE id = ?").get(id);
    if (!row) throw notFoundError("任务关系不存在");
    const timestamp = now();
    this.db.prepare("DELETE FROM issue_relations WHERE id = ?").run(id);
    this.#recordActivity(row.source_issue_id, "relation.deleted", { relationId: id, type: row.type }, actor, timestamp);
    this.#recordActivity(row.target_issue_id, "relation.deleted", { relationId: id, type: row.type }, actor, timestamp);
    this.#touchRevision();
    return { id, sourceIssueId: row.source_issue_id, targetIssueId: row.target_issue_id };
  }

  blockingIssues(issueId) {
    return this.db.prepare(`
      SELECT i.id, i.identifier, i.title, i.status
      FROM issue_relations r JOIN issues i ON i.id = r.source_issue_id
      WHERE r.target_issue_id = ? AND r.type = 'blocks' AND i.archived_at IS NULL
        AND i.status NOT IN ('done', 'canceled')
      ORDER BY i.identifier ASC
    `).all(issueId).map((row) => ({ id: row.id, identifier: row.identifier, title: row.title, status: row.status }));
  }

  getAutomationPolicy(projectId) {
    if (!this.getProject(projectId)) throw notFoundError("项目不存在");
    const row = this.db.prepare("SELECT * FROM automation_policies WHERE project_id = ?").get(projectId);
    return row ? mapAutomationPolicy(row) : {
      projectId, enabled: false, provider: "codex", workflowStage: "planning", sourceStatus: "backlog",
      dailyRunCap: 3, concurrencyLimit: 1, minimumIntervalMinutes: 60, updatedAt: null,
    };
  }

  updateAutomationPolicy(projectId, input) {
    this.getAutomationPolicy(projectId);
    const policy = {
      enabled: Boolean(input.enabled),
      provider: normalizeProvider(input.provider || "codex"),
      workflowStage: normalizeWorkflowStage(input.workflowStage || "planning"),
      sourceStatus: normalizeStatus(input.sourceStatus || "backlog"),
      dailyRunCap: boundedInteger(input.dailyRunCap, 1, 100, "每日上限"),
      concurrencyLimit: boundedInteger(input.concurrencyLimit, 1, 10, "并发上限"),
      minimumIntervalMinutes: boundedInteger(input.minimumIntervalMinutes, 5, 1_440, "最小间隔"),
      updatedAt: now(),
    };
    this.db.prepare(`
      INSERT INTO automation_policies (
        project_id, enabled, provider, workflow_stage, source_status, daily_run_cap,
        concurrency_limit, minimum_interval_minutes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled, provider=excluded.provider,
        workflow_stage=excluded.workflow_stage, source_status=excluded.source_status,
        daily_run_cap=excluded.daily_run_cap, concurrency_limit=excluded.concurrency_limit,
        minimum_interval_minutes=excluded.minimum_interval_minutes, updated_at=excluded.updated_at
    `).run(projectId, policy.enabled ? 1 : 0, policy.provider, policy.workflowStage, policy.sourceStatus,
      policy.dailyRunCap, policy.concurrencyLimit, policy.minimumIntervalMinutes, policy.updatedAt);
    this.#touchRevision();
    return this.getAutomationPolicy(projectId);
  }

  automationPreflight(projectId) {
    const policy = this.getAutomationPolicy(projectId);
    const queuedToday = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM automation_queue WHERE project_id = ? AND date(created_at) = date('now')
    `).get(projectId).count);
    const activeRuns = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM codex_runs r JOIN issues i ON i.id = r.issue_id
      WHERE i.project_id = ? AND r.status IN ('starting', 'running')
    `).get(projectId).count);
    const latestRun = this.db.prepare(`
      SELECT COALESCE(r.started_at, r.created_at) AS started_at
      FROM codex_runs r JOIN issues i ON i.id = r.issue_id
      WHERE i.project_id = ? AND r.provider = ?
      ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT 1
    `).get(projectId, policy.provider);
    const lastRunAt = latestRun?.started_at || null;
    const nextAllowedAt = lastRunAt
      ? new Date(Date.parse(lastRunAt) + policy.minimumIntervalMinutes * 60_000).toISOString()
      : null;
    const eligible = this.db.prepare(`
      SELECT i.* FROM issues i
      WHERE i.project_id = ? AND i.archived_at IS NULL AND i.status = ?
        AND NOT EXISTS (SELECT 1 FROM codex_runs r WHERE r.issue_id = i.id AND r.status IN ('starting', 'running'))
        AND NOT EXISTS (SELECT 1 FROM automation_queue q WHERE q.issue_id = i.id AND q.status = 'pending')
      ORDER BY CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        i.sort_order ASC, i.updated_at ASC LIMIT 20
    `).all(projectId, policy.sourceStatus).map(mapIssue);
    const reasons = [];
    if (!policy.enabled) reasons.push("策略当前未启用");
    if (queuedToday >= policy.dailyRunCap) reasons.push("已达到今日候选上限");
    if (activeRuns >= policy.concurrencyLimit) reasons.push("已达到 Agent 并发上限");
    if (nextAllowedAt && Date.now() < Date.parse(nextAllowedAt)) reasons.push("尚未达到最小执行间隔");
    return {
      policy, queuedToday, activeRuns, lastRunAt, nextAllowedAt, eligible,
      canQueue: policy.enabled && !reasons.length && eligible.length > 0,
      reasons,
    };
  }

  queueNextAutomation(projectId) {
    const preflight = this.automationPreflight(projectId);
    if (!preflight.canQueue) throw conflictError(preflight.reasons[0] || "没有符合条件的候选任务", { preflight });
    const issue = preflight.eligible[0];
    const id = randomUUID();
    const timestamp = now();
    const reason = `按 ${preflight.policy.sourceStatus} → ${preflight.policy.workflowStage} 策略生成；未调用 Agent`;
    this.db.prepare(`
      INSERT INTO automation_queue (id, project_id, issue_id, provider, workflow_stage, status, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(id, projectId, issue.id, preflight.policy.provider, preflight.policy.workflowStage, reason, timestamp, timestamp);
    this.#recordActivity(issue.id, "automation.queued", { queueId: id, provider: preflight.policy.provider, workflowStage: preflight.policy.workflowStage }, "Flowboard", timestamp);
    this.#touchRevision();
    return this.listAutomationQueue(projectId).find((item) => item.id === id);
  }

  listAutomationQueue(projectId) {
    return this.db.prepare(`
      SELECT q.*, i.identifier, i.title FROM automation_queue q JOIN issues i ON i.id = q.issue_id
      WHERE q.project_id = ? ORDER BY q.created_at DESC LIMIT 50
    `).all(projectId).map(mapAutomationQueue);
  }

  dismissAutomationQueue(id) {
    const row = this.db.prepare("SELECT * FROM automation_queue WHERE id = ?").get(id);
    if (!row) throw notFoundError("自动化候选不存在");
    this.db.prepare("UPDATE automation_queue SET status = 'dismissed', updated_at = ? WHERE id = ?").run(now(), id);
    this.#touchRevision();
    return { ok: true, id, projectId: row.project_id, issueId: row.issue_id };
  }

  markAutomationQueueStarted(issueId, provider, workflowStage) {
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE automation_queue SET status = 'started', updated_at = ?
      WHERE issue_id = ? AND provider = ? AND workflow_stage = ? AND status = 'pending'
    `).run(timestamp, issueId, normalizeProvider(provider), normalizeWorkflowStage(workflowStage));
    if (result.changes) this.#touchRevision();
    return Number(result.changes);
  }

  createRun(issueId, input = {}) {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO codex_runs (
        id, issue_id, thread_id, turn_id, status, summary, prompt_chars, estimated_input_tokens,
        model, effort, sandbox, provider, workflow_stage, session_mode, started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, issueId, input.threadId || null, input.turnId || null, input.status || "starting", input.summary || "",
      Number(input.promptChars || 0), Number(input.estimatedInputTokens || 0), input.model || null, input.effort || null,
      input.sandbox || "workspaceWrite", normalizeProvider(input.provider || "codex"),
      normalizeWorkflowStage(input.workflowStage || "implementation"), normalizeSessionMode(input.sessionMode || "stage"),
      timestamp, timestamp, timestamp,
    );
    this.#touchRevision();
    return this.getRun(id);
  }

  updateRun(id, changes) {
    const current = this.getRun(id);
    if (!current) return null;
    const status = changes.status || current.status;
    const terminal = ["completed", "failed", "interrupted"].includes(status);
    const values = {
      status,
      summary: Object.hasOwn(changes, "summary") ? String(changes.summary || "").slice(0, 100_000) : current.summary,
      usage: Object.hasOwn(changes, "usage") ? changes.usage : current.usage,
      turnId: Object.hasOwn(changes, "turnId") ? changes.turnId : current.turnId,
      threadId: Object.hasOwn(changes, "threadId") ? changes.threadId : current.threadId,
      error: Object.hasOwn(changes, "error") ? changes.error : current.error,
      model: Object.hasOwn(changes, "model") ? changes.model : current.model,
      effort: Object.hasOwn(changes, "effort") ? changes.effort : current.effort,
      sandbox: Object.hasOwn(changes, "sandbox") ? changes.sandbox : current.sandbox,
      provider: Object.hasOwn(changes, "provider") ? normalizeProvider(changes.provider) : current.provider,
      workflowStage: Object.hasOwn(changes, "workflowStage") ? normalizeWorkflowStage(changes.workflowStage) : current.workflowStage,
      sessionMode: Object.hasOwn(changes, "sessionMode") ? normalizeSessionMode(changes.sessionMode) : current.sessionMode,
      finishedAt: terminal ? (changes.finishedAt || current.finishedAt || now()) : current.finishedAt,
    };
    this.db.prepare(`
      UPDATE codex_runs SET
        status = ?, summary = ?, usage_json = ?, turn_id = ?, thread_id = ?, error = ?, model = ?, effort = ?,
        sandbox = ?, provider = ?, workflow_stage = ?, session_mode = ?, finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      values.status, values.summary, values.usage ? JSON.stringify(values.usage) : null,
      values.turnId || null, values.threadId || null, values.error || null, values.model || null,
      values.effort || null, values.sandbox || "workspaceWrite", values.provider, values.workflowStage,
      values.sessionMode, values.finishedAt || null, now(), id,
    );
    this.#touchRevision();
    return this.getRun(id);
  }

  getRun(id) {
    const row = this.db.prepare("SELECT * FROM codex_runs WHERE id = ?").get(id);
    return row ? mapRun(row) : null;
  }

  getActiveRun(issueId) {
    const row = this.db.prepare(`
      SELECT * FROM codex_runs WHERE issue_id = ? AND status IN ('starting', 'running')
      ORDER BY created_at DESC LIMIT 1
    `).get(issueId);
    return row ? mapRun(row) : null;
  }

  findRunByExternalId(provider, { turnId, threadId } = {}) {
    if (!turnId && !threadId) return null;
    const clauses = [];
    const values = [provider];
    if (turnId) { clauses.push("turn_id = ?"); values.push(turnId); }
    if (threadId) { clauses.push("thread_id = ?"); values.push(threadId); }
    const row = this.db.prepare(`
      SELECT * FROM codex_runs WHERE provider = ? AND (${clauses.join(" OR ")})
      ORDER BY created_at DESC LIMIT 1
    `).get(...values);
    return row ? mapRun(row) : null;
  }

  listRuns(issueId) {
    return this.db.prepare("SELECT * FROM codex_runs WHERE issue_id = ? ORDER BY created_at DESC LIMIT 30").all(issueId).map(mapRun);
  }

  listActiveRuns() {
    return this.db.prepare("SELECT * FROM codex_runs WHERE status IN ('starting', 'running') ORDER BY created_at ASC").all().map(mapRun);
  }

  interruptAbandonedRuns() {
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE codex_runs SET status = 'interrupted', error = COALESCE(error, '服务重启，运行状态已安全收敛'),
        finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE status IN ('starting', 'running')
    `).run(timestamp, timestamp);
    if (result.changes > 0) this.#touchRevision();
    return result.changes;
  }

  metrics() {
    const statusRows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM issues WHERE archived_at IS NULL GROUP BY status
    `).all();
    const runs = this.db.prepare("SELECT * FROM codex_runs").all().map(mapRun);
    const completed = runs.filter((run) => run.status === "completed");
    const totalDurationMs = completed.reduce((sum, run) => sum + (run.durationMs || 0), 0);
    return {
      revision: this.revision(),
      issues: Object.fromEntries(ISSUE_STATUSES.map((status) => [status, Number(statusRows.find((row) => row.status === status)?.count || 0)])),
      runs: {
        total: runs.length,
        active: runs.filter((run) => ACTIVE_RUN_STATUSES.includes(run.status)).length,
        completed: completed.length,
        failed: runs.filter((run) => run.status === "failed").length,
        interrupted: runs.filter((run) => run.status === "interrupted").length,
        totalTokens: runs.reduce((sum, run) => sum + usageTotalTokens(run.usage), 0),
        averageDurationMs: completed.length ? Math.round(totalDurationMs / completed.length) : 0,
        byProvider: Object.fromEntries([...new Set(runs.map((run) => run.provider))].map((provider) => [
          provider,
          {
            total: runs.filter((run) => run.provider === provider).length,
            totalTokens: runs.filter((run) => run.provider === provider).reduce((sum, run) => sum + usageTotalTokens(run.usage), 0),
          },
        ])),
      },
    };
  }
}

function mapProject(row) {
  return {
    id: row.id,
    name: row.name,
    issuePrefix: row.issue_prefix,
    workspacePath: row.workspace_path,
    color: row.color,
    issueCount: Number(row.issue_count || 0),
    activeCount: Number(row.active_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapIssue(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    workspacePath: row.workspace_path,
    issueNumber: row.issue_number,
    identifier: row.identifier,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria || "",
    status: row.status,
    priority: row.priority,
    labels: parseJson(row.labels_json, []),
    version: row.version,
    codexThreadId: row.codex_thread_id,
    branch: row.branch,
    worktreePath: row.worktree_path,
    assignee: row.assignee || "你",
    startDate: row.start_date,
    dueDate: row.due_date,
    archivedAt: row.archived_at,
    sortOrder: Number(row.sort_order || 0),
    workflowStage: row.workflow_stage || "implementation",
    agentThreads: parseJson(row.agent_threads_json, row.codex_thread_id ? { codex: row.codex_thread_id } : {}),
    commentCount: Number(row.comment_count || 0),
    attachmentCount: Number(row.attachment_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapComment(row) {
  return { id: row.id, issueId: row.issue_id, body: row.body, author: row.author, createdAt: row.created_at };
}

function mapActivity(row) {
  return {
    id: row.id,
    issueId: row.issue_id,
    type: row.type,
    actor: row.actor,
    detail: parseJson(row.detail_json, {}),
    createdAt: row.created_at,
  };
}

function mapAttachment(row) {
  return {
    id: row.id,
    issueId: row.issue_id,
    filename: row.filename,
    contentType: row.content_type,
    size: Number(row.size),
    storageName: row.storage_name,
    url: `/api/attachments/${encodeURIComponent(row.id)}/content`,
    createdAt: row.created_at,
  };
}

function mapRun(row) {
  const startedAt = row.started_at || row.created_at;
  const finishedAt = row.finished_at || null;
  return {
    id: row.id,
    issueId: row.issue_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    status: row.status,
    summary: row.summary,
    usage: parseJson(row.usage_json, null),
    promptChars: Number(row.prompt_chars || 0),
    estimatedInputTokens: Number(row.estimated_input_tokens || 0),
    model: row.model,
    effort: row.effort,
    sandbox: row.sandbox || "workspaceWrite",
    provider: row.provider || "codex",
    workflowStage: row.workflow_stage || "implementation",
    sessionMode: row.session_mode || "stage",
    error: row.error,
    startedAt,
    finishedAt,
    durationMs: finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAutomationPolicy(row) {
  return {
    projectId: row.project_id,
    enabled: Boolean(row.enabled),
    provider: row.provider,
    workflowStage: row.workflow_stage,
    sourceStatus: row.source_status,
    dailyRunCap: Number(row.daily_run_cap),
    concurrencyLimit: Number(row.concurrency_limit),
    minimumIntervalMinutes: Number(row.minimum_interval_minutes),
    updatedAt: row.updated_at,
  };
}

function mapAutomationQueue(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    issueId: row.issue_id,
    identifier: row.identifier,
    title: row.title,
    provider: row.provider,
    workflowStage: row.workflow_stage,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function usageTotalTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  if (usage.last && typeof usage.last === "object") return usageBreakdownTotal(usage.last);
  if (usage.total && typeof usage.total === "object") return usageBreakdownTotal(usage.total);
  return usageBreakdownTotal(usage);
}

function usageBreakdownTotal(usage) {
  for (const key of ["totalTokens", "total_tokens", "totalTokenCount"]) {
    if (Number.isFinite(usage[key])) return Number(usage[key]);
  }
  const input = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.outputTokens ?? usage.output_tokens ?? 0);
  return Number.isFinite(input + output) ? input + output : 0;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeProjectId(value) {
  const id = String(value || "").normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return id || `project-${Date.now()}`;
}

function normalizePrefix(value) {
  const latin = String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 8);
  return latin || "TASK";
}

function normalizeStatus(value) {
  if (!ISSUE_STATUSES.includes(value)) throw validationError("无效的任务状态");
  return value;
}

function normalizePriority(value) {
  if (!ISSUE_PRIORITIES.includes(value)) throw validationError("无效的优先级");
  return value;
}

function normalizeLabels(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  const labels = [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
  if (labels.length > 20 || labels.some((label) => label.length > 64)) throw validationError("标签最多 20 个，每个不超过 64 个字符");
  return labels;
}

function normalizeDate(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const result = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) {
    throw validationError(`${field}必须使用 YYYY-MM-DD`);
  }
  return result;
}

function normalizeSortOrder(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 1e12) throw validationError("排序值无效");
  return number;
}

function normalizeWorkflowStage(value) {
  if (!WORKFLOW_STAGES.includes(value)) throw validationError("无效的工作流阶段");
  return value;
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(provider)) throw validationError("Agent provider 无效");
  return provider;
}

function normalizeSessionMode(value) {
  if (!["stage", "resume", "fresh"].includes(value)) throw validationError("无效的 Agent 会话策略");
  return value;
}

function normalizeAgentThreads(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validationError("Agent 会话映射无效");
  return Object.fromEntries(Object.entries(value).map(([provider, threadId]) => [
    normalizeThreadKey(provider),
    requiredText(threadId, "Agent 会话 ID", 500),
  ]));
}

function normalizeThreadKey(value) {
  const key = String(value || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}(?::[a-z][a-z0-9_-]{0,31})?$/.test(key)) throw validationError("Agent 会话键无效");
  return key;
}

function normalizeSize(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) throw validationError("附件大小无效");
  return size;
}

function boundedInteger(value, minimum, maximum, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw validationError(`${field}必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return number;
}

function requiredText(value, field, maxLength) {
  const text = String(value || "").trim();
  if (!text) throw validationError(`${field}不能为空`);
  if (text.length > maxLength) throw validationError(`${field}过长`);
  return text;
}

function optionalText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length > maxLength) throw validationError("文本过长");
  return text;
}

function nullableText(value, maxLength) {
  if (value === null || value === undefined || value === "") return null;
  return optionalText(value, maxLength);
}

function validColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function now() {
  return new Date().toISOString();
}

export function appError(status, message, code, details) {
  return Object.assign(new Error(message), { status, code, details });
}

function validationError(message) {
  return appError(400, message, "VALIDATION_ERROR");
}

function notFoundError(message) {
  return appError(404, message, "NOT_FOUND");
}

function conflictError(message, details) {
  return appError(409, message, "VERSION_CONFLICT", details);
}
