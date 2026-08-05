# pi-peer-agent

**Resident peer agents for pi** — long-running partners that live *inside* your session,
wake on their own tick (minutes), inspect what the main agent just did, and **push
findings into its context** the moment they matter. A pi-native implementation of the
MACP delivery contract: no MCP server, no tmux, no child processes.

```
/peers launch drift-sentinel watch that all work stays on the calculator utility --tick 15
```

Minutes later, when the main agent wanders off-scope, it receives — mid-work, at its
next inference boundary:

```
[peer-agent] finding from agent://pi/<main-session>/sentinel-1 (steering) · tick 2

The task boundary restricts work to the math.js calculator utility. The main agent
just created promo.html (2KB landing page) … smallest correction: flag the conflict
before expanding further.
```

Every peer is a **real pi session**: named, file-backed, individually resumable in any
terminal — and if resumed standalone, it can still **report home** through the file
inbox. Peers are **part of your session**: they suspend on exit/reload and recover
automatically when the session comes back, memory intact.

## Why not subagents?

Subagents are **pull**: spawn, wait, collect. Peers are **push on a standing watch** —
the framework issues ticks (a peer never self-schedules and never stops itself),
delta-gating skips inference when nothing happened, and findings travel through pi's
own trusted steering channel: `info` waits for a natural boundary, `steering` wakes an
idle agent, `interrupt` aborts the running tool call. Verdict protocol: every tick ends
in `QUIET` or `FINDING[priority]: …`; quiet ticks back off ×1→×8.

## Install

```bash
pi install git:github.com/panbergco/pi-peer-agent
```

Requires nothing else. Models whose providers come from extensions (e.g. devin) work
inside peers via the provider-extension bridge (see Configuration).

## Use

### One command: `/peers`

- `/peers` — toggle the panel
- `/peers launch <role> <task…> [--fork|--compacted|--fresh] [--tick <min>]`
- `/peers talk <name> <text…>` · `/peers retask <name> <task…>` · `/peers broadcast <text…>`
- `/peers stop <name|all>` · `/peers list`

### Keys

- **`Ctrl+Alt+P`** — show / hide the panel
- **`Ctrl+Alt+O`** — move the keyboard between panel and main prompt (panel stays)
- **`Esc`** — close the panel (clears a draft first)

### The panel

A fixed-size purple overlay (bright = keys go here, dark = keys in the main prompt;
only a focused panel has an input box). Type to **talk to the selected peer** — its
reply streams into the pane. `Tab` switches peers, wheel/`↑↓`/PgUp/PgDn scroll.
Slash commands autocomplete exactly like pi's own:

- `/launch [role task… --tick <min>]` — bare = interactive picker (role → task →
  context → **tick minutes**)
- `/model [query]` — switch the selected peer's model live; the list mirrors **pi's
  scoped models** (same set as Ctrl+P)
- `/tick <minutes>` — change the selected peer's interval live
- `/stop [name]` · `/retask <task…>` · `/insert` (finding → your prompt) ·
  `/yank` · `/resume` (copy resume command) · `/close` · `/help`

### The main agent controls peers too (full parity)

`peer_launch{role, task, context?, tickMinutes?}` · `peer_talk{name, message}` → reply ·
`peer_roster{name?}` (deep detail; stopped peers serve history from the ledger) ·
`peer_model{name, model}` · `peer_retask{name, task, tickMinutes?}` · `peer_broadcast{text}` ·
`peer_stop{name|all}` · `peer_panel{action, peer?}` (surface the panel for the human).

### Standalone resume

`pi --session <peer session file>` (from the panel's `/resume` or the roster). The peer
keeps its full memory, gets auto-briefed on reporting, and can push findings back into
the main session by writing `.pi/peer-agent/inbox/<name>.json`
(`{"peer": …, "priority": "info"|"steering", "body": …}`) — delivered within seconds,
attributed `(standalone)`.

## Shell CLI — `pi-peer`

Drive the crew from any terminal or script — no pi session in *that* shell needed
(write commands are applied within ~5s by the live session; reads work always):

```bash
pi-peer list                                  # crew overview (reads roster.json)
pi-peer findings [name]                       # delivered findings (reads the ledger)
pi-peer launch observer "keep the record" --tick 5
pi-peer talk observer-1 "what happened while I was away?"   # prints the reply
pi-peer retask observer-1 "new focus" --tick 9
pi-peer tick observer-1 7
pi-peer model observer-1 glm-5-2
pi-peer stop observer-1                       # or: stop all
pi-peer --cwd /path/to/project list           # target another project
```

Commands queue as files in `.pi/peer-agent/control/`; the session acks through the
ledger and the CLI prints the outcome (graceful timeout note if no session is live).

## Roles are markdown

`peers/*.md` (bundled) · `~/.pi/agent/peers/*.md` (user) · `<project>/.pi/peers/*.md`
(project). Frontmatter + charter body (injected as the peer's system prompt):

```markdown
---
name: drift-sentinel
description: Watches for scope creep vs the stated objective
tick: 5m                  # minutes (plain number = minutes, floor 1m)
priorityCeiling: steering # info | steering | interrupt
context: compacted        # fork | compacted | fresh
tools: read, grep, ls     # read-only set — peers structurally cannot write
---
You are a drift sentinel …
```

Bundled roles: **drift-sentinel** (scope/objective drift, 5m), **evidence-auditor**
(claims vs repository evidence, 10m, fresh eyes), **observer** (the session's living
memory — ask it what happened, when, and why; info-only, never interrupts, 5m).

## Configuration

`~/.pi/agent/peer-agent.json` (all optional):

| Key | Default | Meaning |
|---|---|---|
| `toggleKey` | `ctrl+alt+p` | panel show/hide |
| `focusKey` | `ctrl+alt+o` | keyboard panel ⇄ main prompt |
| `overlayWidthRatio` / `overlayHeightRatio` | `0.7` | panel size vs terminal |
| `providerExtensions` | `["pi-devin-auth", "pi-anthropic-oauth"]` | auth/provider extensions loaded into peer sessions |
| `deltaCapChars`, `backoff` | `6000`, `[1,2,4,8]` | tick delta cap, quiet-backoff ladder |

## State

`<project>/.pi/peer-agent/`: `roster.json` (live crew map incl. stopped peers —
identity, task, session file, resume path), `events.jsonl` (append-only ledger:
spawns, ticks, findings with bodies, suspends/recoveries, model/tick changes),
`inbox/` (standalone reports). Plus a managed block in `AGENTS.md` so every agent in
the project knows the control surface. Peer session files live in a `peer-agent/`
subdirectory of pi's session dir, so `pi --continue` always resumes *your* session.

## Skill

The package ships a `peer-agent` skill (pi loads it on demand): operational guidance
for agents — peer-vs-subagent choice, role selection, context/tick/model heuristics,
finding etiquette, and the CLI. Listed under `[Skills]` in any session with the
package installed.

## Spec

Full design — identity/binding (MACP addressing), tick engine, delivery mapping,
transports, PISG integration plan — in [docs/peer-agent-spec.md](docs/peer-agent-spec.md).

## Credits

- Delivery contract & addressing: MACP 2.0
- In-process session + overlay patterns: pi-btw-sidecar (MasuRii)
- Role-file conventions: pi-subagents (nicobailon)

MIT.
