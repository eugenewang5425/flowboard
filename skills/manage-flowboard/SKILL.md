---
name: manage-flowboard
description: Manage Codex Flowboard projects, issues, comments, status, and Codex-linked work through flowctl. Use when the user names a Flowboard issue identifier or asks to synchronize work with this local task board.
---

# Manage Flowboard

Use the repository-local `cli/flowctl.mjs` for every board read or write. Consume JSON output and preserve exact issue identifiers.

## Existing task workflow

1. Read the issue with `issue get` and inspect all returned comments before starting work.
2. If the issue is `todo`, claim it by moving it to `in_progress` before editing project files.
3. Do not claim tasks already linked to a different active conversation.
4. Work only inside the project's configured workspace or bound worktree.
5. Verify the requested behavior, then add a concise comment describing changes, verification, outcome, and remaining risk.
6. Move completed implementation to `in_review`. Move to `done` only after the user explicitly accepts it.
7. Use `blocked` when work cannot continue and explain the blocker in a comment.

## Safety and consistency

- Treat latest comments as current requirements.
- Do not commit, push, publish, delete, or broaden scope unless the user asked.
- Let the CLI fetch the latest version before updates; never overwrite a version conflict blindly.
- Do not create cards for trivial conversation. Create durable tasks only when tracking adds value.

## Commands

Run from the Flowboard repository root:

```powershell
node cli/flowctl.mjs issue get --id DEMO-1 --json
node cli/flowctl.mjs issue move --id DEMO-1 --status in_progress --json
node cli/flowctl.mjs comment add --issue DEMO-1 --body "改动与验证摘要" --json
node cli/flowctl.mjs issue move --id DEMO-1 --status in_review --json
```
