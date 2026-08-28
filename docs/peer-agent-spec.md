# pi-peer-agent — resident peer agents on a tick, pushing into the main session

Status: v1 draft · prepared for later integration into the author's private orchestration framework (§12)
Substrate: pi ≥ 0.83 native extension APIs only — no MCP servers, no tmux, no child processes for peers.

---

## 1. Purpose and north star

A **peer** is a partner agent that runs *inside* the main pi session's process, holds a
**standing objective** (monitor drift, audit evidence, watch dependencies…), wakes on a
**tick measured in seconds**, inspects what the main agent just did, and — only when it
finds something — **pushes** the finding into the main agent's context at the next
inference boundary. The main agent never polls its peers; discovery travels toward the
worker.

North star: *a reviewer that stops the bug before it ships, without the human — or the
main agent — ever having to ask.* This is built directly on pi's own extension surface
delivery contract (spec §8), scoped to one machine and one harness first, with the
addressing and envelope shape kept protocol-faithful so the real center can be attached
later as a transport swap.

Differentiation, stated once: subagents and Claude-teams are **pull** (parent spawns,
then waits or asks). btw-sidecar is **pull** (human opens the overlay and reads). Peers
are **push on a loop with a set objective** — the tick makes monitoring deterministic,
not vibes-scheduled.

## 2. First principles

- **P1 — The framework issues the tick.** A peer never self-schedules (a standing design constraint, established
  parity). Cadence and backoff are policy derived from durable state, executed by the
  extension.
- **P2 — Push, never pull.** Findings enter the main agent through pi's own trusted
  channel (the steering queue) at an inference boundary — never as tool output, never
  by polling.
- **P3 — A peer is a real pi session.** File-backed `SessionManager`, real session ID,
  named, resumable standalone via `pi --session <file>`. No in-memory ghosts.
- **P4 — Structural capability.** Peers get `createReadOnlyTools()` (read/grep/find/ls).
  A peer cannot write because it HAS no write tool — verifier discipline, not politeness.
- **P5 — CLI-native, not MCP.** The model-facing surface is `pi.registerTool` +
  slash commands; the human/scripting surface is a CLI binary. No MCP server anywhere
  in this package.
- **P6 — Quiet by default.** A tick's null result is silence. A finding must justify
  itself; priorities are capped per role. The main agent's attention is the scarcest
  resource in the system.
- **P7 — Provenance before action.** Write-intent events land in the ledger before the
  peer starts. Every finding is attributable: which peer, which
  tick, which session file, which parent.
- **P8 — One writer per workspace.** Peers observe and report; only the main agent
  mutates the repo. (Write-gate compatibility falls out of P4 for free.)

## 3. Substrate capability map — verified

Every mechanism below was verified against running code or shipped type definitions
before this spec was written (session of 2026-08-05).

| Need | Native API | Verified in |
|---|---|---|
| Resident in-process agent | `createAgentSession({sessionManager, model, modelRegistry: ctx.modelRegistry, thinkingLevel, tools})` | pi SDK exports; pi-btw-sidecar `btw-runtime-core.ts` (production use) |
| Real peer sessions | `SessionManager.create(cwd, sessionDir?, opts)`, `.getSessionId()`, `.getSessionFile()` | pi dist `session-manager.d.ts` |
| Fork context natively | `SessionManager.forkFrom(sourcePath, targetCwd)` | same |
| Resume standalone | `pi --session <file>` | pi CLI; used live this session |
| Read-only peer tools | `createReadOnlyTools()` (also individual `createReadTool` etc.) | pi SDK exports |
| Push at boundary | `pi.sendMessage({customType, content, display}, {deliverAs: "steer", triggerTurn})` | pi dist `types.d.ts`; the delivery contract`HARNESSES.md` pi survey (verified @ pinned commit) |
| Interrupt = create boundary | `ctx.abort()` → tool aborts, partial output retained, then redeliver | same two sources |
| Live streaming into UI | `session.subscribe((e: AgentSessionEvent) => …)` | btw `btw-runtime-core.ts` |
| Sidecar overlay | `ctx.ui.custom(factory, {overlay: true, overlayOptions, onHandle})`; `OverlayOptions` anchors incl. `right-center`, `%` sizing, `nonCapturing`, `setHidden` | btw `btw-runtime-core.ts` + pi-tui `tui.d.ts` |
| Scroll + mouse wheel in overlay | SGR mouse reporting + offset/viewport pattern | btw `btw-overlay.ts` (lines 92–348) |
| Global shortcut | `pi.registerShortcut("ctrl+alt+p", …)` | pi docs extensions.md §registerShortcut |
| Panel fallback | `ctx.ui.setWidget(key, lines, {placement})` | pi docs + live use (footer/tps) |
| Role file conventions | frontmatter `name/description/model/thinking/tools` + body | pi-subagents `frontmatter.ts` + README |
| Awareness block | idempotent markered block in `AGENTS.md`, versioned | a common managed-block pattern |
| Tick policy discipline | cadence + consecutive-quiet backoff derived from durable state | derived, not invented, from durable state |

## 4. Identity, binding, and awareness

### 4.1 Addressing

```
main session:  agent://pi/<main-session-id>
peer:          agent://pi/<main-session-id>/<peer-name>
```

The peer's own pi session ID is recorded alongside; the address expresses the *binding*
(child-of-main), the session ID expresses the *transcript identity*. Both appear in every
envelope and every ledger event.

### 4.2 Binding record

At spawn, before the peer session starts (P7), the ledger receives `peer.spawned`:

```json
{ "kind": "peer.spawned", "peer": "sentinel-7", "role": "drift-watch",
  "address": "agent://pi/<main-id>/sentinel-7",
  "peerSessionId": "<peer-id>", "peerSessionFile": "<abs path>",
  "parentSessionId": "<main-id>", "contextMode": "fork|compacted|fresh",
  "task": "…", "model": "…", "tickBaseS": 5 }
```

The same binding is written into the peer's session as its first custom entry, so a
standalone resume knows exactly whose peer it is (used by the inbox transport, §9.2).

### 4.3 Awareness — the AGENTS.md block and the roster

Two layers, separating static rules from live state:

1. **`AGENTS.md` managed block** (markers `<!-- peer-agent:start -->` /
   `<!-- peer-agent:end -->`, versioned, idempotent, refreshed by the extension on
   spawn/stop and by `pi-peer init`). Content ≈ 15 lines: what peer-agent is, that
   peers may push attributed findings mid-turn, where the live roster lives, where the
   inbox lives, and the one rule of the road for resumed peers (report via inbox, do
   not write to the repo). Everything outside the markers is untouched.
2. **Live roster** — `.pi/peer-agent/roster.json`: array of active peers
   `{name, role, address, peerSessionId, peerSessionFile, task, tickBaseS, status,
   startedAt}` — rewritten atomically on every membership change. The main agent, every
   peer, the sidecar, and the CLI all read the same file. `AGENTS.md` says where the
   map is; the roster IS the map (fresh at read time, not at session start).

### 4.4 Mutual awareness in context

- The **main agent** learns of its peers through the AGENTS.md block plus a one-line
  attributed notice when a peer spawns (`display: true` custom message, info priority).
- Each **peer** gets a standing preamble in its system prompt: its own address, its
  parent's address, the roster path, its objective, and the FINDING/QUIET protocol (§6.3).
- A **resumed peer** re-derives all of this from its session's binding entry — no
  environment variables required (durable state over process
  state).

## 5. Roles — `.md` files

Discovery order (later shadows earlier by `name`):
`<package>/peers/*.md` (bundled) → `~/.pi/agent/peers/*.md` (user) → `<project>/.pi/peers/*.md` (project).

Format (frontmatter + body; the body is the system prompt). The full operator-facing
reference is `docs/roles.md` — this section states the contract, not the catalogue.

```markdown
---
name: observer-watch          # defaults to the filename
description: Watches your work and tells you when it is going wrong
kind: watch                   # watch | mission | goal | task — what the agent IS
tick: 5m                      # cadence, MINUTES; refused on a task, which never ticks
priorityCeiling: steering     # info | steering | interrupt — hard cap for this role
authority: read-only          # read-only | write | shell — decides the toolbelt
authorityCeiling: read-only   # optional: the most this role may EVER be raised to
context: compacted            # fork | compacted | fresh
model: anthropic/claude-fable-5   # optional; else the parent session's model
fallbackModels: a, b          # optional: tried in order when a provider fails
skills: code-review           # optional: resolved through pi's own skill discovery
thinking: low                 # optional
tools: read, grep, ls         # optional: NARROWS the authority's set; over-reach refused
tickWithoutDelta: true        # optional: wake even when the main agent has been quiet
---
<body = system prompt: objective, method, what is worth reporting, when to stay quiet>
```

`kind` decides what the agent is at launch, so a role launches by name with no flags; an
explicit `--task` / `--mission` still overrides it. A file that cannot be read is refused
by name and value — an illegal kind, a `tick:` on a task, or a tool the authority does not
grant — while the other roles still load.

`interrupt` ceiling is reserved for roles whose misses are catastrophic (e.g. a
secrets-leak watcher); none ships by default. Five roles ship bundled: `observer-watch`,
`executor-tick`, `finisher-condition`, `builder-once`, `reviewer-once`.

## 6. Tick engine

### 6.1 Cadence and backoff

- Base cadence per role (`tick:` frontmatter, MINUTES; floor 1m). A `task` never ticks.
- Consecutive QUIET ticks escalate the interval: ×1 → ×2 → ×4 → ×8 (cap), a
  ladder discipline. Any FINDING, any parent activity delta, or a retask resets to ×1.
- Ticks are staggered across peers (phase offset) so N peers never fire inference
  simultaneously.
- Soft cap: 6 concurrent peers (config `maxPeers`); warn-and-allow beyond,
  conscious override.

### 6.2 The tick directive

Each tick, the framework (never the peer) assembles:

1. the peer's standing objective (role body + assigned task);
2. the **delta**: parent-session entries appended since the last observed leaf
   (serialized compactly, tool results truncated, capped ~6k chars);
3. the current roster (so peers know their siblings);
4. the response protocol (§6.3).

No delta and no unresolved prior thread ⇒ the tick is skipped entirely (zero inference
cost) unless the role opts into `tickWithoutDelta: true` (for wall-clock watchers).

### 6.3 Response protocol

The peer must end its turn with exactly one verdict line:

```
QUIET
FINDING[info|steering|interrupt]: <one-paragraph, self-contained, actionable>
```

Anything above the verdict line is the peer's working notes (kept in its transcript,
never delivered). Malformed verdicts are treated as QUIET and counted
(`peer.malformed` ledger event) — a noisy peer surfaces in `pi-peer status` rather
than in the main agent's context. Priorities above the role's ceiling are clamped,
and the clamp is recorded.

## 7. How a finding reaches the session

| Requirement | How this implements it |
|---|---|
| D1 drain at boundary | `pi.sendMessage(…, {deliverAs: "steer"})` — pi's steering queue is drained at the next inference boundary natively |
| D2 append-only | steering delivery appends; nothing rewritten |
| D3 priority order + coalescing | pending findings sorted interrupt > steering, then send order; coalesced into one attributed block per boundary |
| D4 visible attribution, trusted channel | block header `[peer-agent] finding from agent://pi/…/<peer> (steering)`; enters as a custom message, never as tool output |
| D5 no mid-inference injection | guaranteed by the steering queue's semantics |
| D6 tool result first, then envelope | pi's native ordering |
| §8.2 idle wake | steering+ uses `triggerTurn: true`; **info never wakes** — it lands in the sidecar, the ledger, and is batched onto the next natural boundary |
| I1–I2 interrupt creates boundary | `ctx.abort()` (same mechanism as user Esc; partial tool output enters transcript) then immediate steer redelivery |
| I4 steering must not abort | enforced structurally: only `interrupt` priority calls `ctx.abort()` |
| I5 duplicate suppression | envelope IDs (ulid); at-most-once injection per ID |

Message tiers: one to one (session→agent retask, agent→session finding), role-cast
(`role:verifier-like`), telling every agent in a project at once (session→all agents; agent→all). In-process this is
iteration over the roster; the tiers exist in the envelope schema from day one so the
center transport (§9.3) changes nothing above the transport seam.

## 8. Sidecar UI

- Toggle: `Ctrl+Alt+P` (configurable — `~/.pi/agent/peer-agent.json` `toggleKey`) or
  `/peers`. Peers run regardless of visibility.
- Surface: `ctx.ui.custom(…, {overlay: true})`, anchor `right-center`, `width: "30%"`,
  `maxHeight: "90%"`, `nonCapturing` while unfocused; `visible` callback hides below
  120 columns (widget-band fallback: one line per peer above the editor).
- Accordion: one section per peer — collapsed = `▸ name · role · tick-state · last
  finding (truncated)`; expanded = live streaming pane (btw streaming pattern).
  `↑/↓` select · `Enter`/`Space` toggle that peer individually · mouse wheel /
  `PgUp/PgDn` scroll within the expanded pane, per-peer offset, follow-tail until the
  user scrolls up, snap back at bottom · `Esc` unfocus (stays visible) · `q` hide.
- Detail line per peer: address, session ID, and the exact resume command
  (`pi --session <file>`).
- Known caveat, accepted: overlays occlude the transcript's right edge rather than
  reflowing it (pi renders the conversation full-width beneath). One keypress hides
  the dock.

### 8.1 Looks like pi, because it borrows pi's own idioms

The dock must read as *an overlay of a real pi session*, not a debug panel. Concretely:

- **Theme-derived everything** — all colors via `ctx.ui.theme` roles (accent, dim,
  warning…); zero hardcoded ANSI. The dock inherits the operator's theme automatically.
- **pi's transcript idioms** — streaming cursor `▍`, dim italic thinking, role badges,
  tool calls as one-line `read(path…)` rows — the same visual grammar as the main
  conversation (btw's `renderTranscript` is the reference implementation).
- **A session header per expanded pane** — `⬢ <model> · ⍏ <short-session-id> · ⟳ tick
  4s · $cost` — deliberately echoing pi's own footer line, because each pane IS a real
  session.
- **Priority as color, not noise** — findings tinted by priority (info dim, steering
  accent, interrupt warning); QUIET ticks compress to a single dim `·` in the pane's
  tick strip, so a healthy peer looks calm.

### 8.2 Copy and paste — discrete targets, two destinations

Terminal-level rectangle selection is useless over a bordered overlay, so the dock
makes copy **entry-based**: within an expanded pane, `↑/↓` moves an entry cursor over
discrete items (finding, assistant message, tool row, the resume command line) — the
same selection feel as pi's own lists. Then:

- **`i` — insert into the main prompt**: appends the selected entry's plain text to the
  editor via `ctx.ui.setEditorText(getEditorText() + …)` — drop a peer's finding or a
  quote from its transcript straight into what you're about to say, no clipboard round
  trip, cursor lands back in the main editor.
- **`y` — yank to system clipboard**: pi's native `copyToClipboard()` (OSC 52 — works
  over SSH); `Y` yanks the peer's entire visible pane; on the detail line, `y` yanks
  the ready-to-run resume command.
- Every yank/insert confirms with a transient `ctx.ui.setStatus` flash, never a modal.

## 9. Transports (the seam)

All transports carry the same envelope `{id, from, to, priority, body, replyTo?,
tick?, ts}`; delivery above the seam is identical.

1. **v1 in-process** — direct: the extension owns both ends. Peers → main via §7;
   main → peers via directive injection on the peer's next tick (or immediate wake
   for retask).
2. **v1 file inbox** — for peers resumed standalone (`pi --session …` in another
   terminal): the peer-agent extension in THAT session detects the binding entry
   (§4.2), and writes envelopes to `<project>/.pi/peer-agent/inbox/<envelope-id>.json`;
   the main session's extension watches the inbox (fs.watch + poll fallback) and
   delivers per §7. At-least-once with I5 dedupe.
3. **A shared router** — a small server that registers sessions and their agents and
   carries all three message tiers, so agents on different tools could reach each other.
   A transport swap only; adopted if cross-tool routing is ever needed.

## 10. CLI — `pi-peer` (pi-native contract surface; no MCP)

Pattern: the extension is the runtime, the CLI is inspection and
control over durable state — both read the same files, no daemon.

```
pi-peer status              # roster + per-peer tick state, quiet streaks, last findings
pi-peer roster              # machine-readable roster.json to stdout
pi-peer resume <name>       # exec: pi --session <peer session file>
pi-peer log [<name>]        # tail the ledger (all peers or one)
pi-peer stop <name|--all>   # request stop via control file (extension honors on next tick)
pi-peer init                # write/refresh the AGENTS.md block + .pi/peer-agent/ scaffold
```

Model-facing surface (inside the session): `peer_launch`, `peer_ask`, `peer_roster`,
`peer_model`, `peer_tick`, `peer_retask`, `peer_tell_all`, `peer_stop`, `peer_kill`, and `peer_panel`
so the MAIN AGENT can manage its peers as tool calls (e.g. "launch an observer-watch"),
plus `/peers launch|ask|retask|tick|model|authority|stop|kill` for the human.

## 11. Ledger

`<project>/.pi/peer-agent/events.jsonl`, append-only event log, mirroring common event-sourcing discipline
(monotonic seq, ts, kind, payload). Kinds: `peer.spawned` (write-intent, §4.2),
`tick.issued`, `tick.skipped`, `finding.delivered` (envelope id, priority, clamped?),
`finding.info` (sidecar-only), `peer.malformed`, `peer.retasked`, `peer.stopped`,
`inbox.received`, `inbox.duplicate`. The peer's pi session file is the transcript;
the ledger is the coordination record — the pair reconstructs any incident.

## 12. Embedding in a larger system (prepared, not premature)

peer-agent is designed to be embeddable: a resident crew that any larger automation system can drive without knowing peer-agent's internals, and without
peer-agent knowing anything about that system. No external system's name, design, or
mechanics are documented here.

- **Peers stay read-only.** Any host system remains the sole writer; a peer's
  findings are recommendations, never edits.
- **Standard extension surface.** A host registers alongside peer-agent's own
  extension; nothing about peer-agent requires bespoke integration code.
- **Pluggable event sink** (§7, E3): a host can receive every peer event in-process
  (`setEventSink`) without peer-agent depending on how or where that host stores them.
- **Structured finding references** (E4): a finding may cite the files it concerns,
  giving any consumer a mechanical target — independent of what that consumer does
  with it.
- **Per-peer working directory** (E1) and **per-peer usage accounting** (E2): a peer
  can watch a directory other than the project root and reports its own token/cost
  usage — both useful to any host that runs multiple concurrent workers, without
  assuming anything about how that host schedules them.

The pre-integration enhancements above (E1–E4) are complete and shipped; each stands
on its own regardless of what, if anything, is ever integrated with.

## 13. Phasing

- **P0 — resident core (prove the loop):** role discovery, one peer, fresh context,
  file-backed session, tick engine with skip/backoff, FINDING→steer push, ledger,
  roster, AGENTS.md block. Exit: a peer catches a planted drift and its finding lands
  attributed in the main context; `pi --session` resume of that peer works.
- **P1 — the full picture:** multi-peer + stagger + cap, fork/compacted context,
  sidecar with accordion + scroll + per-peer toggle, whole-crew messages in-process,
  `peer_*` tools, starter roles ship.
- **P2 — detachment:** file-inbox transport (resumed peers keep reporting), `pi-peer`
  CLI complete.
- **P3 — embedding + center:** monorepo move, host-side peer verbs, vocabulary registration, the delivery contract
  center transport behind the seam.

## 14. Decision ledger

| id | decision | status | rationale |
|---|---|---|---|
| decision 1 | In-process peers (SDK sessions), not child processes | resolved | seconds-tick residency; live streaming; one process; the tmux/process shape was explicitly rejected |
| decision 2 | Peers are file-backed named pi sessions | resolved | operator benchmark: individually resumable standalone |
| decision 3 | Fork context = `SessionManager.forkFrom` | resolved | native lineage in the transcript beats message-seeding |
| decision 4 | Read-only tools for peers, always | resolved | P4/P8; write-gate compatibility for free |
| decision 5 | the delivery contractenvelope + addressing from day one, center deferred | resolved | protocol fidelity is cheap now, retrofit is expensive later |
| decision 6 | `Ctrl+Alt+P` default toggle | resolved | Alt+P taken in operator's environment; configurable regardless |
| decision 7 | Verdict-line protocol (QUIET/FINDING) over structured output | resolved (v1) | robust to small models; malformed ⇒ QUIET + ledger, never noise; revisit if clamp/malformed rates are high |
| decision 8 | Info priority never wakes and never steers | resolved | the delivery contract; attention economics (P6) |
| decision 9 | Compacted context recipe: reuse parent's latest compaction summary when present, else summarize parent transcript at spawn | open | summarize-at-spawn costs one LLM call; measure whether stale-summary risk matters at P1 |
| decision 10 | Copy is entry-based (`i` insert-to-editor / `y` OSC-52 yank), not terminal selection | resolved | rectangle selection breaks over bordered overlays; `setEditorText` + `copyToClipboard` are native and verified |

## 15. Not yet specified (fog)

- Peer-to-peer direct threads — shipped: an agent's `send` reaches a named sibling.
- Persistent peer memory across main-session restarts (re-attach to an old peer
  session rather than spawning fresh) — likely `pi-peer attach`, post-P2.
- Interrupt-priority roles and their authorization ceremony.
- Cost telemetry per peer (tokens/tick) surfaced in `pi-peer status` — P1 stretch.

## 16. Agent taxonomy — four kinds, cut by what wakes the agent (human ruling 2026-08-06)

Four kinds, one visible surface. Everything launched through this extension is
OBSERVABLE — panel, roster, ledger, receipts — never a hidden background worker.

The cut is the DRIVER: what wakes the agent decides its kind. Two kinds are woken by
the clock, one by its own objective, one by a single call.

| Kind | Driven by | Behaviour | Ends when |
|---|---|---|---|
| WATCH | the clock (interval tick) | looks at what changed and reports what matters (QUIET/FINDING) | never on its own — the operator or the main session stops it |
| MISSION | the clock (interval tick) | works its standing charge every tick; it acts, it does not merely observe | never on its own — the operator or the main session stops it |
| GOAL | its own objective | works bounded cycles until a mechanically checkable condition holds (file exists, command exits 0, condition attested) | the FRAMEWORK observes the condition met, or the cycle cap is reached |
| TASK | a single call | runs straight through in one continuous engagement, then hands off | its job is done — it retires with a handoff (changed files, commands run, evidence, open decisions) |

- **WATCH and MISSION are tick-based.** They differ in posture, not in rhythm: the
  watcher's product is a report, the mission-holder's product is work performed.
  Neither can end itself.
- **GOAL is objective-based.** The completion condition is declared at launch and
  evaluated by the FRAMEWORK, never self-asserted: an agent claiming DONE while the
  condition is false is recorded and refused. This is the kind previously called
  "mission" here and in the code; it was renamed because the word names an objective,
  not a rhythm, and the ticked worker needed the name MISSION.
- **TASK is not tick-based.** It is the delegation kind (human ruling 2026-08-06:
  "TASK is not tick based", "this is beyond subtasks"): no interval, no standing
  objective, no cycles — one engagement to completion, then retirement. Its handoff is
  the deliverable.

Shared invariants across all four kinds: the same launch surfaces, the same
session-file identity and recovery, the same delivery/receipt contract, and the same
read-only wall by default — write authority is granted per agent by an explicit human
action, never by the agent and never by its kind alone. Concurrent writers serialize on
the project's advisory lock in the SHARED worktree (human ruling: no filesystem
isolation by default; separate checkouts only behind an explicit config opt-in).
Sub-agent launches route through this surface so the operator sees every agent that
exists: the anti-hidden-team principle.

The mode enum stays open. A fifth kind (e.g. event-bound: woken by external triggers
rather than by a clock, an objective, or a call) is provisioned for and deliberately
not designed.
