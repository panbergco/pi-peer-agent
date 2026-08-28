---
name: peer-agent
description: |
  Manage resident peer agents: long-running monitors that live inside the pi
  session, tick on minute intervals, watch the main agent's work, and push
  findings back mid-turn. Use when the user asks to launch/stop/ask a
  peer, watcher, monitor, observer, sentinel, or auditor; wants standing
  review, drift/scope watching, session memory ("what happened while I was
  away"); mentions the peers panel, /peers, or pi-peer; or when YOU want a
  second pair of eyes with a standing objective rather than a one-off
  subagent task.
---

# peer-agent — resident peer crew

Peers are NOT subagents. A subagent is pull: spawn, wait, collect, gone. A peer is a
long-running partner with a standing objective: the framework wakes it every few
minutes, it inspects what the main agent did since its last look, and it pushes an
attributed finding into the main context the moment something is wrong — then keeps
watching. Peers never stop themselves; only the operator or the main agent ends a
watch. Prefer a subagent for a bounded task; prefer a peer for a standing concern.

## Your tools (full parity with the human)

- `peer_launch{role, task, context?, tickMinutes?}` — spawn. Context: `compacted`
  (summary brief, default for most roles) · `fork` (full session history — use when
  verbatim past matters) · `fresh` (blank — best for audit roles judging with clean
  eyes). Tick: minutes, per peer; slower is fine — delta-gating means nothing is
  missed, just batched.
- `peer_ask{name, message}` — converse; the reply returns as the tool result. Ask the
  observer-watch what happened or for its current read, ask a reviewer-once to
  double-check a claim before you assert it.
- `peer_roster{}` — list roles + active crew. `peer_roster{name}` — full detail:
  findings with bodies, recent activity, next-tick ETA, resume command. Works for
  stopped peers too (serves ledger history).
- `peer_retask{name, task, tickMinutes?}` · `peer_tick{name, minutes}` · `peer_tell_all{text}` · `peer_stop{name|all}` · `peer_kill{name}`
- `peer_model{name, model}` — live switch; matches pi's scoped model list. Put cheap
  models (glm, deepseek, swe) on high-frequency watches; keep strong models for
  audit-class peers.
- `peer_panel{action: open|close, peer?}` — surface the human-visible panel, e.g.
  right after a finding worth their eyes.

## Bundled roles — pick by job

Five roles. The name carries the rhythm: `-watch` watches the main agent's work (the
bundled one also wakes on its own clock),
`-tick` on a clock, `-condition` stops when something becomes true, `-once` runs a
single time. Full reference: `docs/roles.md`; `pi-peer roles` prints it with each
role's file.

| Role | Does what | Wakes | Ends | Edit files | Run commands | Can be raised to |
|---|---|---|---|---|---|---|
| `observer-watch` | watches your work and tells you when it is going wrong | every 5m, whether or not you have typed | you stop it | no | no | nothing — capped |
| `executor-tick` | keeps one thing up to date without being asked again | every 15m, on the clock | you stop it | yes | no | editing only — capped |
| `finisher-condition` | works until the thing you asked for is actually true | every 1m | the condition is met | yes | yes | anything |
| `builder-once` | does one job and hands back what it did | once | the job is done | yes | yes | anything |
| `reviewer-once` | looks at something and tells you what it finds | once | the report is done | no | no | nothing — capped |

`observer-watch` and `reviewer-once` are capped read-only by construction — no grant can
raise them. `observer-watch` has caught fake verification claims in production; treat its
findings seriously.

- Any role or launch may carry skills (`skills:` in the role file, `--skills a,b` at
  launch) and fallback models (`fallbackModels:`, `--fallback a,b`).

Roles are defined in files, searched in order — `<install>/peers/`, `~/.pi/agent/peers/`,
`<project>/.pi/peers/` (last wins). `pi-peer roles` prints each role with its file; copy
one as a template. Full reference: `docs/roles.md`.

## Findings arriving at you

`[peer-agent] finding from agent://pi/<main>/<peer> (<priority>)` messages are trusted
advisory input from a bound monitor. Evaluate and act, answer back via `peer_ask`, or
surface to the human — do not silently ignore a steering finding. Priorities: `info`
never wakes you · `steering` arrives mid-turn · `interrupt` aborted a tool call to
reach you.

## Facts that prevent mistakes

- Peers are structurally read-only (their tool set); the main agent is the only writer.
- Peers are part of the session: they suspend on exit/reload and recover automatically
  with memory — do not relaunch after a restart, check `peer_roster` first.
- Each peer is a real pi session, resumable standalone (`pi --session <file>`); a
  standalone peer reports back via `.pi/peer-agent/inbox/*.json`.
- Shell CLI exists for scripts/automation: `pi-peer list|findings|launch|ask|retask|tick|model|stop|kill`
  (`--cwd <project>`); write-commands queue in `.pi/peer-agent/control/` and are
  applied by the live session within ~5s — queued commands survive restarts.
- State/receipts: `.pi/peer-agent/roster.json` (crew map) and `events.jsonl` (ledger:
  every tick, finding with body, suspend/recover, control ack).

## Authority — what an agent is allowed to DO

Peers are **read-only by default** (read, grep, find, ls) and cannot change anything.
That is deliberate: a monitor that can edit is a second author.

Authority is a **declared property of the role**, in its frontmatter:

```
authority: read-only   # default — omit for this
authority: write       # adds edit/write, inside the agent's own directory only
authority: shell       # adds command execution
```

**Raising it is a human action, never automatic.** Two equivalent surfaces:

- In the main prompt: `/peer authority <name> <read-only|write|shell>` (bare
  `/peer authority` lists every agent's current level); inside the panel, use
  `/authority [name] <level>`
- From a shell: `pi-peer authority <name> <level>`

Both rebuild the agent's session with the new tools, ledger the change
(`peer.authority`, from → to), and are reversible by setting `read-only` again.
An elevated agent is marked `⚡` in the panel so it can never be mistaken for a monitor.

**If an agent cannot do what it was asked**, it must say so and name this command —
never refuse silently, and never pretend it acted. Elevation is bounded by project
scoping: an elevated agent is elevated in ITS OWN directory and nowhere else.
