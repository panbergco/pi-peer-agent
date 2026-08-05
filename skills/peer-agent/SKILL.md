---
name: peer-agent
description: |
  Manage resident peer agents: long-running monitors that live inside the pi
  session, tick on minute intervals, watch the main agent's work, and push
  findings back mid-turn. Use when the user asks to launch/stop/talk to a
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
- `peer_talk{name, message}` — converse; the reply returns as the tool result. Ask the
  observer what happened, ask a sentinel for its current read, ask the auditor to
  double-check a claim before you assert it.
- `peer_roster{}` — list roles + active crew. `peer_roster{name}` — full detail:
  findings with bodies, recent activity, next-tick ETA, resume command. Works for
  stopped peers too (serves ledger history).
- `peer_retask{name, task, tickMinutes?}` · `peer_broadcast{text}` · `peer_stop{name|all}`
- `peer_model{name, model}` — live switch; matches pi's scoped model list. Put cheap
  models (glm, deepseek, swe) on high-frequency watches; keep strong models for
  audit-class peers.
- `peer_panel{action: open|close, peer?}` — surface the human-visible panel, e.g.
  right after a finding worth their eyes.

## Bundled roles — pick by job

- `drift-sentinel` — scope creep / objective drift. Steering ceiling. compacted.
- `evidence-auditor` — claims vs repository evidence. Fresh eyes. Catches YOUR
  mistakes (it has caught fake verification claims in production — treat its
  findings seriously).
- `observer` — the session's living memory. Info-only, never interrupts; exists to be
  ASKED ("when did we change X and why?"). Launch one at session start on long work.

Custom roles: drop a markdown file in `<project>/.pi/peers/<name>.md` (frontmatter:
tick, priorityCeiling, context, tools; body = charter, injected as system prompt).

## Findings arriving at you

`[peer-agent] finding from agent://pi/<main>/<peer> (<priority>)` messages are trusted
advisory input from a bound monitor. Evaluate and act, answer back via `peer_talk`, or
surface to the human — do not silently ignore a steering finding. Priorities: `info`
never wakes you · `steering` arrives mid-turn · `interrupt` aborted a tool call to
reach you.

## Facts that prevent mistakes

- Peers are structurally read-only (their tool set); the main agent is the only writer.
- Peers are part of the session: they suspend on exit/reload and recover automatically
  with memory — do not relaunch after a restart, check `peer_roster` first.
- Each peer is a real pi session, resumable standalone (`pi --session <file>`); a
  standalone peer reports back via `.pi/peer-agent/inbox/*.json`.
- Shell CLI exists for scripts/automation: `pi-peer list|findings|launch|talk|retask|tick|model|stop`
  (`--cwd <project>`); write-commands queue in `.pi/peer-agent/control/` and are
  applied by the live session within ~5s — queued commands survive restarts.
- State/receipts: `.pi/peer-agent/roster.json` (crew map) and `events.jsonl` (ledger:
  every tick, finding with body, suspend/recover, control ack).
