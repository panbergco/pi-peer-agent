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
main agent — ever having to ask.* This is a pi-native implementation of the MACP 2.0
delivery contract (spec §8), scoped to one machine and one harness first, with the
addressing and envelope shape kept protocol-faithful so the real center can be attached
later as a transport swap.

Differentiation, stated once: subagents and Claude-teams are **pull** (parent spawns,
then waits or asks). btw-sidecar is **pull** (human opens the overlay and reads). Peers
are **push on a loop with a set objective** — the tick makes monitoring deterministic,
not vibes-scheduled.

## 2. First principles

- **P1 — The framework issues the tick.** A peer never self-schedules (orchestrator doctrine
  parity). Cadence and backoff are policy derived from durable state, executed by the
  extension.
- **P2 — Push, never pull.** Findings enter the main agent through pi's own trusted
  channel (the steering queue) at an inference boundary — never as tool output, never
  by polling (MACP 2.0 D1–D6).
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
  peer starts (dispatch parity with the orchestrator). Every finding is attributable: which peer, which
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
| Push at boundary | `pi.sendMessage({customType, content, display}, {deliverAs: "steer", triggerTurn})` | pi dist `types.d.ts`; MACP `HARNESSES.md` pi survey (verified @ pinned commit) |
| Interrupt = create boundary | `ctx.abort()` → tool aborts, partial output retained, then redeliver | same two sources |
| Live streaming into UI | `session.subscribe((e: AgentSessionEvent) => …)` | btw `btw-runtime-core.ts` |
| Sidecar overlay | `ctx.ui.custom(factory, {overlay: true, overlayOptions, onHandle})`; `OverlayOptions` anchors incl. `right-center`, `%` sizing, `nonCapturing`, `setHidden` | btw `btw-runtime-core.ts` + pi-tui `tui.d.ts` |
| Scroll + mouse wheel in overlay | SGR mouse reporting + offset/viewport pattern | btw `btw-overlay.ts` (lines 92–348) |
| Global shortcut | `pi.registerShortcut("ctrl+alt+p", …)` | pi docs extensions.md §registerShortcut |
| Panel fallback | `ctx.ui.setWidget(key, lines, {placement})` | pi docs + live use (footer/tps) |
| Role file conventions | frontmatter `name/description/model/thinking/tools` + body | pi-subagents `frontmatter.ts` + README |
| Awareness block | idempotent markered block in `AGENTS.md`, versioned | the orchestrator's managed-block pattern |
| Tick policy discipline | cadence + consecutive-quiet backoff derived from durable state | the orchestrator `tick.ts` |

## 4. Identity, binding, and awareness

### 4.1 Addressing (MACP §4, adopted verbatim)

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

Two layers, the orchestrator-style separation of static rules from live state:

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
  environment variables required (the orchestrator serviceless parity: durable state over process
  state).

## 5. Roles — `.md` files

Discovery order (later shadows earlier by `name`):
`<package>/peers/*.md` (bundled) → `~/.pi/agent/peers/*.md` (user) → `<project>/.pi/peers/*.md` (project).

Format (pi-subagents frontmatter conventions, folded scalars supported):

```markdown
---
name: drift-sentinel
description: Watches the main agent's work for scope creep vs the stated mission
tick: 15                # base cadence, seconds
priorityCeiling: steering   # info | steering | interrupt — hard cap for this role
context: compacted      # default context recipe: fork | compacted | fresh
model: devin/glm-5-2    # optional; else parent session's model
thinking: low           # optional
tools: read, grep, find, ls   # subset of the read-only set; omit for all four
---
You watch the main agent's recent work for scope creep…
<body = system prompt: objective, method, examples of FINDING-worthy events>
```

`interrupt` ceiling is reserved for roles whose misses are catastrophic (e.g. a
secrets-leak watcher); v1 ships none by default. Two starter roles ship bundled:
`drift-sentinel` (mission/scope drift) and `evidence-auditor` (claims without proof —
the orchestrator-verifier-adjacent). the orchestrator integration adds roles that complement `decider`/`verifier`
rather than duplicating them (§12).

## 6. Tick engine

### 6.1 Cadence and backoff

- Base cadence per role (`tick:` frontmatter, seconds; floor 3s).
- Consecutive QUIET ticks escalate the interval: ×1 → ×2 → ×4 → ×8 (cap), the orchestrator
  ladder discipline. Any FINDING, any parent activity delta, or a retask resets to ×1.
- Ticks are staggered across peers (phase offset) so N peers never fire inference
  simultaneously.
- Soft cap: 6 concurrent peers (config `maxPeers`); warn-and-allow beyond, the orchestrator-style
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

## 7. Delivery contract (MACP 2.0 §8, mapped)

| MACP | pi-peer-agent implementation |
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

Broadcast (MACP §6.1 tiers): unicast (main→peer retask, peer→main finding), role-cast
(`role:verifier-like`), project broadcast (main→all peers; peer→all). In-process this is
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
3. **v2 MACP center** — the real `macp/center` (implemented, tested, plain MCP server):
   register main + peers, `macp_send` for all three tiers, cross-harness roster. A
   transport swap only; adopted when peer-agent meets the orchestrator's fleet phase.

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

Model-facing surface (inside the session): `pi.registerTool("peer_launch" | "peer_stop"
| "peer_retask" | "peer_roster" | "peer_broadcast")` so the MAIN AGENT can manage its
peers as tool calls (e.g. the orchestrator tick directive: "launch an evidence-auditor for this
sprint"), plus `/peer launch|stop|retask` and `/peers` for the human.

## 11. Ledger

`<project>/.pi/peer-agent/events.jsonl`, append-only, the orchestrator event discipline
(monotonic seq, ts, kind, payload). Kinds: `peer.spawned` (write-intent, §4.2),
`tick.issued`, `tick.skipped`, `finding.delivered` (envelope id, priority, clamped?),
`finding.info` (sidecar-only), `peer.malformed`, `peer.retasked`, `peer.stopped`,
`inbox.received`, `inbox.duplicate`. The peer's pi session file is the transcript;
the ledger is the coordination record — the pair reconstructs any incident.

## 12. Orchestrator integration plan (prepared, not premature)

_"The orchestrator" below is a private sprint-orchestration framework the author
operates; its name and internals are withheld from this public document._

- **Placement:** this package becomes a workspace package in the orchestrator's
  monorepo; the extension registers alongside its own; the CLI folds into its verb set.
- **Roles complement, not duplicate:** The orchestrator's `decider`/`verifier` are *dispatch* roles
  (spawn, answer, exit). Peer roles are *resident watch* roles. An evidence-auditor
  peer watching AC claims continuously is the standing counterpart of the verifier's
  final judgment — same philosophy (default-REJECT, read-only), different lifecycle.
- **Tick alignment:** peer ticks are seconds-scale and independent of the orchestrator's loop tick; both derive policy from durable state, never self-scheduled. An orchestrator tick directive may instruct the main agent to launch/retask peers via `peer_launch`.
- **AGENTS.md coexistence:** the peer-agent block sits beside the orchestrator's block, own
  markers, own version — the two managers never touch each other's spans.
- **Gate compatibility:** peers hold no write tools (P4/P8), so the orchestrator's write gates
  never see a peer; findings that demand repo changes are pushed to the main agent,
  who acts under the gate wall as the sole writer.
- **Vocabulary:** on integration, role names and event kinds register in its
  vocabulary registry so the lingo wall owns them.

### 12.1 Integration findings — live orchestrator observation (2026-08-05)

Read-only inspection of the orchestrator's live session (mid fleet-phase: budget-driven
dispatch, unified assignment scheduling, an author-never-fixes review rule,
worktree-per-executor isolation, a fleet board and a concurrency exit drill queued) surfaced concrete integration surfaces — and four pre-integration
enhancements to peer-agent itself:

**Where peers slot into the orchestrator's machinery:**

1. **Fleet observability (its fleet phase's missing layer).** Phase 3 runs ≥3 concurrent
   executors in isolated worktrees under one conductor. Peers are the natural
   per-executor watchdogs: a fleet-sentinel bound to each executor's WORKTREE pushes
   stall/drift/conflict-risk findings to the conductor's session; the fleet board
   renders the peer crew beside executors/claims/budgets.
2. **Findings ↦ review feedback (the author-never-fixes rule).** It enforces "feedback author never fixes" in the scheduler. A peer finding that demands a repo change
   should register as review feedback authored by the peer — gaining mechanical
   resolution tracking AND the two-hop wall for free (a peer can never be assigned
   anyway; its findings then carry scheduler weight, not just advisory weight).
3. **Budget integration (its budget doctrine).** Dispatch is budget-bounded by expected
   value; watchers cost tokens too. Peer per-tick usage feeds the same budget
   accounting so the conductor's spend picture includes its standing watch.
4. **Judgment tier support.** Sprints face a judge at archive. An evidence-auditor
   peer watching the proof bundle AS IT FORMS flags evidence gaps before the
   judgment tier does — standing counterpart to the judge's final verdict.
5. **Decision desk .** Steering findings that contradict a standing ruling should file decision requests to the decider (auto mode) instead of
   interrupting the operator — peers become a decider input channel.
6. **Server-first residence .** The orchestrator converges on a headless loop with attach-viewports. Peer-agent's session-decoupled transports (control files, inbox,
   roster/ledger reads) already match this shape; the peers panel is an attach-style
   viewport. Its attach verb should be able to surface the crew.
7. **Event store.** The orchestrator's events live in queryable SQLite; peer-agent's JSONL ledger
   should write through a pluggable sink so integrated deployments land peer events
   in that store under registered vocabulary.

**Pre-integration enhancements to peer-agent (do these here, before the move):**

- **E1 — per-peer cwd**: launch a peer bound to a directory other than the project
  root (an executor's worktree). Unlocks finding 1; small (launch param + tool pass-through).
- **E2 — per-peer usage accounting**: tokens/cost from the peer's AgentSession into
  roster + ledger (`peer.usage` events). Unlocks finding 3; independently valuable.
- **E3 — event-sink seam**: `appendEvent` behind an interface (JSONL default) so the
  the orchestrator store becomes a drop-in sink. Unlocks finding 7.
- **E4 — structured finding refs**: optional `files:[]` on FINDING verdicts so
  review-feedback registration (finding 2) has mechanical targets.

## 13. Phasing

- **P0 — resident core (prove the loop):** role discovery, one peer, fresh context,
  file-backed session, tick engine with skip/backoff, FINDING→steer push, ledger,
  roster, AGENTS.md block. Exit: a peer catches a planted drift and its finding lands
  attributed in the main context; `pi --session` resume of that peer works.
- **P1 — the full picture:** multi-peer + stagger + cap, fork/compacted context,
  sidecar with accordion + scroll + per-peer toggle, broadcast tiers in-process,
  `peer_*` tools, starter roles ship.
- **P2 — detachment:** file-inbox transport (resumed peers keep reporting), `pi-peer`
  CLI complete.
- **P3 — the orchestrator + center:** monorepo move, orchestrator peer verbs, vocabulary registration, MACP
  center transport behind the seam.

## 14. Decision ledger

| id | decision | status | rationale |
|---|---|---|---|
| D-01 | In-process peers (SDK sessions), not child processes | resolved | seconds-tick residency; live streaming; one process; the tmux/process shape was explicitly rejected |
| D-02 | Peers are file-backed named pi sessions | resolved | operator benchmark: individually resumable standalone |
| D-03 | Fork context = `SessionManager.forkFrom` | resolved | native lineage in the transcript beats message-seeding |
| D-04 | Read-only tools for peers, always | resolved | P4/P8; the orchestrator gate compatibility for free |
| D-05 | MACP envelope + addressing from day one, center deferred | resolved | protocol fidelity is cheap now, retrofit is expensive later |
| D-06 | `Ctrl+Alt+P` default toggle | resolved | Alt+P taken in operator's environment; configurable regardless |
| D-07 | Verdict-line protocol (QUIET/FINDING) over structured output | resolved (v1) | robust to small models; malformed ⇒ QUIET + ledger, never noise; revisit if clamp/malformed rates are high |
| D-08 | Info priority never wakes and never steers | resolved | MACP §8.2; attention economics (P6) |
| D-09 | Compacted context recipe: reuse parent's latest compaction summary when present, else summarize parent transcript at spawn | open | summarize-at-spawn costs one LLM call; measure whether stale-summary risk matters at P1 |
| D-10 | Copy is entry-based (`i` insert-to-editor / `y` OSC-52 yank), not terminal selection | resolved | rectangle selection breaks over bordered overlays; `setEditorText` + `copyToClipboard` are native and verified |

## 15. Not yet specified (fog)

- Peer-to-peer direct threads (beyond broadcast) — waits for a concrete need.
- Persistent peer memory across main-session restarts (re-attach to an old peer
  session rather than spawning fresh) — likely `pi-peer attach`, post-P2.
- Interrupt-priority roles and their authorization ceremony (MACP §9 grants; the orchestrator
  operator-directive pattern is the likely shape).
- Cost telemetry per peer (tokens/tick) surfaced in `pi-peer status` — P1 stretch.
