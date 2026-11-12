---
name: pi-subagents
description: How to delegate work to focused child agents with the subagent tool (agents, parallel and chained runs, workflow scripts, background runs, steering, resume, supervisor replies).
---

# Delegating with `subagent`

Delegate only when the user's request or instructions authorize it; doing the work yourself stays the default.

- `subagent({ action: "list" })` lists the agents (`scout`, `worker`, `reviewer`, `oracle`, `delegate`, ... plus
  `~/.hortus/agents/*.md` and the project's `.hortus/agents/*.md`).
- One child: `subagent({ agent: "scout", task: "..." })`. Give it everything it needs: a fresh child sees only the task;
  `context: "fork"` starts it from this conversation.
- Parallel: `{ tasks: [{ agent, task }, ...] }`. Sequential: `{ chain: [{ agent, task }, { agent, task: "... {previous}" }] }`.
- Scripted: write one ```` ```js workflow ```` block in your reply (`await runs.run(key, { agent, task })`,
  `await runs.all([{ key, agent, task }])`, `args`, `return ...`), then call `subagent({ workflow: true })`.
- Runs go to the background by default; the result arrives as a message. Don't poll or sleep: continue with
  independent work or end your turn. `async: false` blocks until the child is done.
- Manage runs: `action: "status"` (with `id`: its transcript), `"steer"` (`id`, `message`, `mode: "follow_up"` for
  after its turn), `"interrupt"` (pause), `"stop"`, `"resume"` (`id`, `message`: continue its session).
- A background child that needs a decision asks through its supervisor channel: answer with
  `subagent_supervisor({ action: "reply", replyTo, message })` (`action: "pending"` lists open questions).
