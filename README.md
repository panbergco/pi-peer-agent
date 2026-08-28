# pi-peer-agent

**Resident peer agents for pi** — long-running partners that live *inside* your session,
wake on their own tick (minutes), inspect what the main agent just did, and **push
findings into its context** the moment they matter. A pi-native implementation of the
MACP delivery contract: no MCP server, no tmux, no child processes.

```
/peers launch observer-watch watch that all work stays on the calculator utility --tick 15
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
in `QUIET` or `FINDING[priority]: …`; quiet ticks back off ×1→×8. An agent whose
owning session is gone shows as **orphaned** everywhere (list, census, panel title)
rather than pretending to wait.

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
- `/peers ask <name> <text…>` · `/peers retask <name> <task…>` · `/peers tick <name> <minutes>`
- `/peers model <name> <provider/model|substring>` · `/peers authority <name> <read-only|write|shell>` · `/peers tell-all <text…>`
- `/peers stop <name|all>` · `/peers kill <name>` · `/peers list`

### Keys

- **`Ctrl+Alt+O`** — Open / hide the panel
- **`Ctrl+Alt+P`** — move the keyboard between panel and main prompt (panel stays)
- **`Ctrl+C`** — return from the panel input to the main prompt (panel and draft stay)
- **`Esc`** — close the panel (clears a draft first)

Both chords are configurable (`toggleKey` / `focusKey`, see Configuration).

#### On macOS

The defaults become **`Cmd+Alt+P`** / **`Cmd+Alt+L`**. `Cmd` is reportable only by
terminals that speak the **kitty keyboard protocol** (iTerm2, Ghostty, kitty,
WezTerm) — a legacy terminal cannot encode it at all. Both chord families are always
accepted, so if the protocol did not negotiate, the `ctrl+alt` chords still work.
If a multiplexer swallowed the protocol handshake at startup, peer-agent re-asks for
it shortly after the session starts.

If your terminal is in legacy mode and you want the `ctrl+alt` chords instead:

1. **Enable Option-as-Meta and the defaults work as-is** — Terminal.app:
   *Settings → Profiles → Keyboard → "Use Option as Meta key"*; iTerm2:
   *Settings → Profiles → Keys → Left Option key → "Esc+"*.
2. **Or rebind to a chord your terminal can send.** Note that `shift+ctrl+X` is
   *byte-identical* to `ctrl+X` in a legacy terminal, and every free plain
   `ctrl+<letter>` is already a line-editing key (`ctrl+b` = cursor left,
   `ctrl+e` = end of line), so rebinding trades one problem for another unless
   your terminal supports the CSI-u / `modifyOtherKeys` protocol (iTerm2, kitty),
   in which case `shift+ctrl+...` is distinguishable and safe:

   ```json
   { "toggleKey": "shift+ctrl+b", "focusKey": "shift+ctrl+n" }
   ```

   Option 1 is the reliable route on a stock macOS terminal.

If Option is left as-is (not Meta), `Option+p` types `π` rather than sending a
chord — the panel accepts that glyph too, so the toggle still works while the
panel has focus, but the global shortcut will not fire. Use one of the two
options above for reliable behaviour.

### The panel

A fixed-size purple panel (bright = keys go here, dark = keys in the main prompt;
only a focused panel has an input box). Type to **ask the selected agent** — its
reply streams into the pane. The input **is a real pi prompt**: it shares pi's own
keybinding configuration, so word jumps, delete-word, kill/yank (ctrl+w/k/u/y),
`Pos1`/Home/End, undo, paste, multi-line input (shift+enter or ctrl+j), and ↑↓ input
history all behave exactly like the main prompt. `Tab` switches peers,
Scrolling the transcript: `shift+↑↓` moves a page, `alt+↑↓` moves a single line,
`shift+Home` jumps to the beginning and `shift+End` returns to live. The counter above the
input says how many lines are hidden and repeats these keys, so you never have to remember
them. (pi itself consumes PgUp/PgDn before the panel sees them, and the panel never
captures your mouse — the wheel stays with the terminal.) `ctrl+alt+↑↓` or `shift+alt+↑↓` grow/shrink the panel live, and `/height <20-90>`
sets an exact percentage (20–90% of the screen; the configured `panelHeightRatio`
stays the startup default). **GNOME users:** the desktop itself owns Ctrl+Alt+Up/Down
for workspace switching, so use `shift+alt+↑↓` or `/height` there — or rebind the
resize chords via `resizeUpKeys` / `resizeDownKeys` in `peer-agent.json`. Slash commands autocomplete exactly like
pi's own:

- `/launch [role task… --tick <min>]` — bare = interactive picker (role → task →
  context → **tick minutes**)
- `/model [query]` — switch the selected peer's model live; filtering and selection stay
  inside the panel, and the list mirrors **pi's scoped models** (same set as Ctrl+P)
- `/tick <minutes>` — change the selected peer's interval live
- `/stop [name]` (session kept) · `/kill [name]` (session deleted) · `/retask <task…>` · `/insert` (finding → your prompt) ·
  `/yank` · `/resume` (copy resume command) · `/close` · `/help`

### The main agent controls peers too (full parity)

`peer_launch{role, task, context?, tickMinutes?}` · `peer_ask{name, message}` → reply ·
`peer_roster{name?}` (deep detail; stopped peers serve history from the ledger) ·
`peer_model{name, model}` · `peer_tick{name, minutes}` · `peer_retask{name, task, tickMinutes?}` · `peer_tell_all{text}` ·
`peer_stop{name|all}` · `peer_kill{name}` · `peer_panel{action, peer?}` (surface the panel for the human).

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
pi-peer census                                # FULL picture: main sessions + every agent
pi-peer list                                  # crew overview (reads roster.json)
pi-peer findings [name]                       # delivered findings (reads the ledger)
pi-peer launch observer-watch "keep the record" --tick 5
pi-peer ask observer-watch-1 "what happened while I was away?"   # prints the reply
pi-peer ask-parent 019fd3b3 "stop and re-read the spec"      # message a MAIN session from outside
pi-peer retask observer-watch-1 "new focus" --tick 9
pi-peer tick observer-watch-1 7
pi-peer models gpt                            # list pi's available models (panel's source)
pi-peer model observer-watch-1                      # numbered picker — choose interactively
pi-peer model observer-watch-1 glm-5-2              # unique substring or provider/id applies directly
pi-peer stop observer-watch-1                       # or: stop all (session kept)
pi-peer kill observer-watch-1                       # end watch AND delete the session
pi-peer --cwd /path/to/project list           # target another project
```

Commands queue as files in `.pi/peer-agent/control/`; the session acks through the
ledger and the CLI prints the outcome (graceful timeout note if no session is live).

## The record

`<project>/.pi/peer-agent/` holds the ledger (`events.jsonl`, rotating at 32 MB into
`events-<n>.jsonl`), the roster, the panel state, and the control/inbox queues — all
`0600`, because they carry your agents' words and your unsent drafts. Every event names
its `project`, the `session` that wrote it and, for an agent's events, the `parent` that
owns it, so several pi instances can share one project's log without their histories
blurring. `sessionSeq` counts one session's events from 1 — it is not a file-wide
sequence, and `pi-peer doctor` uses it to spot missing lines.

Transcripts live with pi, not here: `~/.pi/agent/sessions/<project>/` for sessions and
`.../peer-agent/` for agents. `pi-peer history` prints both paths beside every id.

## Checks you can run

```bash
npm run check:panel-latency     # panel opens and closes fast — fails if closing regresses
```

## Roles are markdown

`peers/*.md` (bundled) · `~/.pi/agent/peers/*.md` (user) · `<project>/.pi/peers/*.md`
(project). Frontmatter + charter body (injected as the peer's system prompt):

```markdown
---
name: observer-watch
description: Watches your work and tells you when it is going wrong
kind: watch               # watch | mission | goal | task — what the agent IS
tick: 5m                  # minutes (floor 1m); refused on a task, which never ticks
priorityCeiling: steering # info | steering | interrupt
authority: read-only      # read-only | write | shell
authorityCeiling: read-only  # optional: the most it may EVER be raised to
context: compacted        # fork | compacted | fresh
tickWithoutDelta: true    # optional: wake even when you have been quiet
---
You watch the main agent's work …
```

Delegation roles: **builder-once** (does the work — one job end to end, or cycles until a
condition holds; its contract grants full authority), **reviewer-once** (investigation,
read-only by construction),
**reviewer-once** (adversarial review, read-only by construction). A role file may declare
`authorityCeiling:`, and then no human action can raise it.

Five bundled colleagues. The name carries the rhythm — `-watch` watches what you do (the
bundled one also wakes on its own clock), `-tick` runs on a clock, `-condition` stops when
something becomes true, `-once` runs a single time:

| Role | Does what | Wakes | Ends | Edit files | Run commands | Can be raised to |
|---|---|---|---|---|---|---|
| `observer-watch` | watches your work and tells you when it is going wrong | every 5m, whether or not you have typed | you stop it | no | no | nothing — capped |
| `executor-tick` | keeps one thing up to date without being asked again | every 15m, on the clock | you stop it | yes | no | editing only — capped |
| `finisher-condition` | works until the thing you asked for is actually true | every 1m | the condition is met | yes | yes | anything |
| `builder-once` | does one job and hands back what it did | once | the job is done | yes | yes | anything |
| `reviewer-once` | looks at something and tells you what it finds | once | the report is done | no | no | nothing — capped |

`pi-peer roles` prints them with the file each is defined in — copy one as a template.
Full reference: [docs/roles.md](docs/roles.md).

```
pi-peer task builder-once "add the --json flag to the export command and prove it works"
```

Agents come in four kinds, told apart by what wakes them: **WATCH** and **MISSION**
are woken by the clock (a watch reports what changed, a mission works its standing
charge), **GOAL** is woken by its own objective and ends when the framework observes
that objective met (`--until-file` / `--until-exit0`), and **TASK** is a single
engagement that runs straight through and retires with a handoff. All four ship today.

## Say what "done" means

```
pi-peer task builder-once --gate "npm test" "fix the failing export test"
```

The gate is run by the framework after the agent hands off, so the agent cannot finish
by declaring itself finished. If it fails, its real output goes back to the agent and
the work continues (three attempts); if it never passes, the task is reported as **not
accepted** and reaches you as steering rather than quiet news.

## An agent whose session died can join yours

```
pi-peer attach reviewer-once-1  # or /peers attach reviewer-once-1 in a session
```

The panel shows stranded agents and how to adopt them. An adopted agent keeps its memory,
ticks again, and reports to you from then on.

## Resume, and nothing is lost

Close a session with the panel open and come back to it: same panel, same agent, same
height, same unsent message. The crew comes back with it — a resumed session re-adopts
the peers it had before, so nothing is left orphaned.

## Two ways to launch

A role file is the whole contract — what the agent may do, how often it wakes, and what it
IS:

```yaml
kind: task          # watch · mission · goal · task
authority: write    # read-only · write · shell (full elevation)
```

`pi-peer launch builder-once "fix the failing test"` then does what the contract says. Override
it by hand with `--task` or `--mission` when the job is one-off.

## An agent that keeps at it

```
pi-peer mission executor-tick --tick 15 "keep the changelog current as commits land"
```

A MISSION wakes on the clock like a watcher, but its own work is the point. It carries on
while you are quiet, it cannot declare itself finished, and it stops when you stop it.

## What did it cost, and is anything wrong?

```
pi-peer cost      # a row per agent, a total, reconciled with the ledger
pi-peer doctor    # config, roster, ledger, orphans, write lock — exits non-zero on faults
```

Both read durable state, so they work with no session running, and `doctor` changes
nothing it inspects.

## Give an agent your skills

```
pi-peer task reviewer-once --skills "code-review,accessibility" "review the current diff"
```

Named skills are resolved by pi's own discovery and carried into the agent's prompt, so
it works the way you work. An agent that names no skills carries none, and a name pi
cannot find refuses the launch instead of quietly producing an agent without it.

## When a provider says no

```
pi-peer task builder-once --fallback "anthropic/claude-sonnet-5,openai-codex/gpt-5.6-sol" "<job>"
```

Rate limits, overloads and provider paths that refuse an agent used to end its turn in
silence. Now the agent moves to the next model you listed, notes the switch in its pane,
and finishes the job. If every listed model refuses, the failure is reported as a failure
— never as an empty success.

## Several jobs, one answer

```
pi-peer wave builder-once \
  "docs=update the README for the new flag" \
  "tests=add a test for the new flag" \
  "changelog=add the changelog entry"
```

Three tasks, launched together, running together, reported **once** — when the last one
retires — with a line per key saying what it did and whether it needs you. Three jobs
become one interruption instead of three.

## Two writers, one directory

Agents work in the SAME worktree on the SAME branch — no separate checkouts, no merge
dance. Every mutation goes through the project's write lock, so if two granted agents
reach for the same tree, one waits (it says so in its pane) and both edits survive. The
lock is cross-process, per tool call, and recovers automatically from an agent that died
holding it. Read-only agents are never gated.

If you genuinely want isolation, set `"worktrees": true` and pass `--worktree`: that
agent gets its own checkout and branch. Off by default, and refused with an explanation
while off.

## Configuration

`~/.pi/agent/peer-agent.json` (all optional):

| Key | Default | Meaning |
|---|---|---|
| `toggleKey` | `ctrl+alt+o` | panel Open/hide |
| `focusKey` | `ctrl+alt+p` | keyboard panel ⇄ main prompt |
| `overlayWidthRatio` / `overlayHeightRatio` | `0.7` | panel size vs terminal |
| `providerExtensions` | `["pi-devin-auth", "pi-anthropic-oauth", "pi-rotate"]` | provider packages loaded into agent sessions, so an agent can use the same models you can. Resolved from wherever pi installed them (npm or git). Add any other provider package by name. |
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
transports, embedding notes — in [docs/peer-agent-spec.md](docs/peer-agent-spec.md).

## Credits

- Delivery contract & addressing: MACP 2.0
- In-process session + overlay patterns: pi-btw-sidecar (MasuRii)
- Role-file conventions: pi-subagents (nicobailon)

MIT.
