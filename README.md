# pi-peer-agent

**Resident peer agents for pi** — partners with a standing objective that live *inside*
your session, wake on a seconds-tick, watch what the main agent does, and **push
findings into its context** the moment they matter. A pi-native implementation of the
[MACP 2.0](https://github.com/multiagentcognition/macp) delivery contract: no MCP
server, no tmux, no child processes.

```
/peer launch drift-sentinel watch that all work stays on the calculator utility
```

Seconds later, when the main agent wanders off-scope, it receives — mid-work, at its
next inference boundary:

```
[peer-agent] finding from agent://pi/<main-session>/sentinel-1 (steering) · tick 2

The task boundary restricts work to the math.js calculator utility. The main agent
just created promo.html (2KB landing page) … smallest correction: flag the conflict
before expanding further.
```

…and every peer is a **real pi session**: named, file-backed, individually resumable
in any terminal with `pi --session <file>`.

## Why not subagents / a sidecar?

Both are **pull**: a parent spawns and then waits or asks; a human opens an overlay
and reads. Peers are **push on a loop with a set objective** — the tick (configurable
per role, seconds-scale) makes monitoring deterministic, and findings travel *toward*
the worker through pi's own trusted steering channel, visibly attributed, priority-
tiered (`info` / `steering` / `interrupt` — MACP §7/§8).

## Install

```bash
pi install git:github.com/panbergco/pi-peer-agent
```

Or per-project in `.pi/settings.json`:

```json
{ "extensions": ["/path/to/pi-peer-agent/extensions/index.ts"] }
```

## Use

- `/peer launch <role> <task…>` (`--fork|--compacted|--fresh` to pick the context
  recipe) · `/peer stop <name|all>` · `/peer retask <name> <task…>` ·
  `/peer broadcast <text…>` · `/peer list`
- `/peer` (bare) or `Ctrl+Alt+P` — the sidecar: a centered overlay listing every peer;
  `↑/↓` pick, `Enter` expand/collapse individually, wheel/`PgUp/PgDn` scroll the live
  pane, `i` insert the latest finding into your prompt, `y`/`Y` yank finding/pane
  (OSC 52), `r` yank the ready-to-run resume command, `x` stop, `Esc` back, `q` hide.
- The **main agent** manages peers itself via native tools: `peer_launch`,
  `peer_roster`, `peer_retask`, `peer_broadcast`, `peer_stop`.

## Roles are markdown

`peers/*.md` (bundled) · `~/.pi/agent/peers/*.md` (user) · `<project>/.pi/peers/*.md`
(project) — frontmatter + charter body:

```markdown
---
name: drift-sentinel
description: Watches for scope creep vs the stated objective
tick: 15                 # seconds
priorityCeiling: steering
context: compacted       # fork | compacted | fresh
tools: read, grep, ls    # read-only set — peers structurally cannot write
---
You are a drift sentinel …
```

Bundled: `drift-sentinel` (scope/objective drift) and `evidence-auditor` (claims
without proof). Peers answer each tick with `QUIET` or
`FINDING[priority]: …` — quiet ticks back off (×1→×2→×4→×8), activity resets.

## State

`.pi/peer-agent/` in your project: `events.jsonl` (append-only ledger — spawns,
ticks, findings, all write-intent-first), `roster.json` (live map: names, addresses,
session files), plus a managed block in `AGENTS.md` so every agent in the project
knows peers exist and where the map is.

## Spec

The full design — identity/binding (MACP addressing), tick engine, delivery contract
mapping, transports (in-process → file inbox → MACP center), PISG integration plan —
lives in [docs/peer-agent-spec.md](docs/peer-agent-spec.md).

## Credits

- Delivery contract & addressing: [MACP 2.0](https://github.com/multiagentcognition/macp)
- In-process session + overlay patterns: [pi-btw-sidecar](https://github.com/MasuRii/pi-btw-sidecar) (MasuRii)
- Role-file conventions: [pi-subagents](https://github.com/nicobailon/pi-subagents) (nicobailon)

MIT.
