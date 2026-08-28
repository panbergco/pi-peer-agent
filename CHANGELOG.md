# Changelog

## 0.25.0

**Breaking — the verbs now say who is talking to whom.** One word, `talk`, was used for two
opposite directions, `talk-main` named its destination from the outside, and `broadcast`
implied everyone while reaching one crew. The old names are gone rather than aliased.

- `pi-peer ask <name>` (was `talk`), `pi-peer ask-parent <session>` (was `talk-main`),
  `pi-peer tell-all` (new on the CLI, was only a slash command).
- `/peers ask` (was `/peers talk`), `/peers tell-all` (was `/peers broadcast`).
- `peer_ask` (was `peer_talk`), `peer_tell_all` (was `peer_broadcast`).
- Agents gained `crew` and `send` in 0.24.x; `send` is the peer-to-peer direction and keeps
  its name.

## 0.24.0 — 2026-08-09 — BREAKING: the ledger's shape changed

Three faults found by the pi-rotate extension while aligning the two products. All three
were real.

- **BREAKING — `seq` is now `sessionSeq`, and it means what it says.** It was a
  process-local counter that restarted at 1 every session while reading like a file-wide
  sequence, so it could not do the one job such a counter has: notice that lines are
  missing. It now counts one session's events, and `pi-peer doctor` checks each session's
  run for gaps — which works even though several sessions interleave in one file. Anything
  reading `seq` must read `sessionSeq`.
- **The ledger, roster and panel state are 0600**, enforced on every write. They hold your
  agents' words, every task, and your half-written messages; they were world-readable.
- **The ledger rotates at 32 MB** into `events-<n>.jsonl`. It had no cap. Readers take the
  rotated parts into account, so nothing is lost.
- `pi-peer doctor` now reports ledger size, file count, per-session gaps and permissions.

## 0.23.0 — 2026-08-09

- **The transcript scrolls line by line.** A page jump (shift+↑↓) was the only way to move
  it, which reads as "it does not scroll" when you are trying to re-read one line.
  **alt+↑↓** moves a line at a time, **shift+Home** jumps to the beginning and
  **shift+End** returns to live.
- The hidden-line counter now says how to move: `3 lines above, 12 below — shift+↑↓ page,
  alt+↑↓ line, shift+End newest`.

## 0.22.0 — 2026-08-09

- **Fixed: an agent could not use a model whose provider comes from a git-installed
  extension.** Provider extensions were resolved only from the npm folder, so a provider
  the operator could select in their own session was never loaded for their agents — every
  tick failed with "No API key found for <provider>". They are now resolved wherever pi
  installed them, and `pi-rotate` ships in the default list.
- `pi-peer census --json` publishes the crew for programs to read, including the product's
  own live/orphaned verdict.

## 0.21.1 — 2026-08-09

- `npm run check:panel-latency -- --with-crew` measures the loaded close path — an agent
  selected and an unsent draft — instead of only a bare session.
- The bundled watcher's own clock is now described wherever the crew is described; three
  documents still said it wakes only on your work.

## 0.21.0 — 2026-08-08

- **`npm run check:panel-latency`** — a standing check that drives a real session on its
  own tmux socket, toggles the panel repeatedly, and fails if closing regresses (median
  close must stay within twice the open and under 200ms). Previously the timing was only
  measured once, inside a proof bundle nobody runs.

## 0.20.3 — 2026-08-08

- **Fixed: a role file's change was reported once and then either forgotten or repeated.**
  A recovered agent did not carry the terms it was compared against, so the comparison
  went dead after the first recovery; when it did survive, the same edit was re-reported on
  every resume. The file's terms are now adopted as the baseline at the moment the change
  is reported.

## 0.20.2 — 2026-08-08

- The tick-change note renders through the same helper as everything else.
- The standalone `pi-peer` CLI renders every cadence through one mirrored helper. It
  hand-rolled the string three times — the crew listing and twice in the census — each
  with its own wording and its own default.

## 0.20.1 — 2026-08-08

- Every surface that names an agent's rhythm renders it through one helper. Nine
  hand-written copies survived the formatter that was meant to replace them — the launch
  confirmations, the panel's status line, the roster tool, the adoption message — and
  `pi-peer list` still printed an interval for agents that run once.
- The interactive launcher no longer asks a task for a tick interval it will never use.

## 0.20.0 — 2026-08-08

- **An agent can be traced to its contract.** The roster records the file a role came from
  and the terms it carried; `pi-peer census` prints the file under each agent.
- **A role file edited while an agent is away is reported, not applied in silence.** On
  recovery the file is compared against the terms the agent was launched with, and every
  field that moved is named in the ledger and to the operator. An unchanged contract says
  nothing.
- `observer-watch` now wakes on its own clock (`tickWithoutDelta`), because drift and
  unproven claims appear in the files between the things you type.
- The spec's role format matches the parser again: `kind`, `authority`, `authorityCeiling`,
  cadence in minutes, and a task that may not declare one.

## 0.19.2 — 2026-08-08

- **Panel state is persisted off the frame.** Closing the panel wrote the state file twice
  on the UI path — once from the component's teardown, once from the toggle — and nothing
  about your next keystroke depended on those writes having landed. Now queued and
  coalesced.
- **Fixed: a draft was only saved at shutdown.** The hook that persists half-written text
  when it changes was declared but never wired, so drafts survived only a clean exit.

## 0.19.1 — 2026-08-08

- **One formatter for a role's summary**, used by the panel, `pi-peer roles`,
  `/peers list`, the roster tool, both autocompletes and the launch confirmation. Seven
  places wrote it by hand and three still promised a cadence for roles that run once.
- A recovered agent's note no longer says "watch continues" for a task, or offers it an
  interval it never had.

## 0.19.0 — 2026-08-08

- **Roles renamed so the name says the rhythm** — `observer-watch` (wakes on your work),
  `executor-tick` (wakes on a clock), `finisher-condition` (stops when your condition is
  true), `builder-once` and `reviewer-once` (run a single time). Descriptions rewritten to
  state the job in one plain sentence instead of the mechanism.
- **A task can no longer claim a cadence.** `builder` and `reviewer` declared `tick: 5m`
  for weeks while the runtime never scheduled them; a `tick:` on a task contract is now
  refused, and every surface prints "runs once" instead of a fictional interval.
- **Callsigns carry the whole role name** — `builder-once-1`, not `once-1`. Taking the last
  hyphen segment gave two different jobs the same callsign.
- `docs/roles.md` opens with a single table — job, when it wakes, when it ends, what it may
  change — and the README, the skill and `pi-peer roles` all present the same five facts.

## 0.18.1 — 2026-08-08

- A `tools:` line may narrow an authority but can no longer claim more than it grants: a
  contract asking for a tool its authority does not include is refused by file and value
  instead of being silently narrowed (the trap that made `builder` believe it could run
  commands).
- An agent launched WITHOUT a role file now gets the same contract as one launched with
  it: it can be any kind, it carries the authority granted at launch, and its charter
  states the authority it actually holds instead of always asserting read-only.
- Removed a dead constant in role parsing.

## 0.18.0 — 2026-08-08

- **Five bundled colleagues covering five distinct jobs.** `watchdog` (watch, read-only —
  now also the session's memory, so the duplicate `notetaker` is gone), `keeper` (mission,
  write — wakes on its own clock and works a standing charge until you stop it),
  `finisher` (goal, shell — works in cycles until your condition actually holds),
  `builder` (task, shell), `reviewer` (task, read-only).
- **Fixed: `builder` was told it could run commands and could not.** An explicit `tools:`
  list silently narrowed the authority the contract declared. Omit `tools:` and the
  toolbelt now follows the authority; setting it still narrows deliberately.
- **`pi-peer roles`** — every role with its kind, authority and THE FILE IT IS DEFINED IN,
  plus the two directories you can copy a template into. The panel's role list shows the
  same. New reference: `docs/roles.md`.

## 0.17.0 — 2026-08-08

- **Four bundled colleagues instead of seven overlapping roles.** `watchdog` (the resident
  critic: work drifting off the job AND claims the repository does not support),
  `notetaker` (the session's memory), `builder` (does the work, fully elevated),
  `reviewer` (read-only investigation, before or after the fact). Retired:
  `drift-sentinel`, `evidence-auditor`, `observer`, `goal-runner`, `worker`, `scout` —
  their jobs live on in the four.
- Each bundled role now declares its own kind and authority, so launching by name needs no
  flags; the two watchers and the reviewer are capped read-only and cannot be elevated at
  all.
- **Fixed:** `--until-file` / `--until-exit0` were ignored when a role's contract declared
  a kind, so a builder asked to work in cycles quietly ran as a single task. An explicit
  objective now outranks the contract, as an explicit kind flag already did.

## 0.16.0 — 2026-08-08

- **A role file now says what the agent IS.** Add `kind: watch | mission | goal | task` to
  a role's frontmatter and launching it by name produces exactly that, from the shell and
  from inside a session. `--task` / `--mission` still override it for one-off work, so
  there are two ways to launch: by contract, or by hand.
- **A contract can grant its own authority, including full elevation.** A role declaring
  `authority: shell` is born holding the command tool; a role's own `authorityCeiling`
  still refuses any grant above it.
- **A broken role file fails loudly and alone.** An unreadable contract names its file and
  value, the rest of the crew still loads, and asking for that role refuses — where it
  used to silently hand you a nameless watcher instead.

## 0.15.3 — 2026-08-08

- An adopted agent is now TOLD it was adopted: it learns the session it belongs to and its
  new address, so its own reports stop pointing the operator at the session that died.
- The orphan hint in the CLI and census names the shipped verb (`pi-peer attach`) instead
  of promising a future one.

## 0.15.2 — 2026-08-08

- **Fixed: an adopted agent still signed its findings with the session that died.** Its
  address now moves with it, so a report from an adopted agent names the session it
  actually belongs to. Found by an independent audit of the previous release's evidence.
- Delivered findings now record the receiving session and the agent's address, so "did
  this land in the right session?" can be answered from the record instead of assumed.

## 0.15.1 — 2026-08-08

- Adoption declines an agent that belongs to a different project, naming that project and
  what to do instead — completing the refusal set (already-yours, finished, other project,
  unknown name, and an agent another live session is still ticking). Every refusal leaves
  the agent and the roster exactly as they were, is recorded with its reason, and exits
  non-zero so scripts can rely on it.

## 0.15.0 — 2026-08-08

- **`pi-peer attach <name>` / `/peers attach <name>`** — an agent whose own session is
  gone can now rejoin a working crew. The session that runs the command adopts it: it
  ticks again on its own cadence, keeps its whole memory, and everything it raises from
  then on arrives in the adopting session. Until now the only recovery was resuming it
  alone in a terminal, where no crew could see it.
- Adoption runs through the ordinary recovery path, so an adopted agent is
  indistinguishable from one the session launched itself — same roster shape, same panel
  row, and it comes back with that session's next restart.
- The panel now tells you what to DO about an orphan (`adopt it here: /peers attach
  <name>`) instead of only naming it; an orphan from another project says so instead.

## 0.14.0 — 2026-08-07

- **A resumed session comes back to the panel it left.** Open or closed, focused or
  passive, the same agent selected, the same height, the same half-written message still
  in the box. Remembered per session file under `.pi/peer-agent/panel-state.json`, saved
  on every change and at shutdown, restored after the crew is recovered. A corrupt state
  file is ignored rather than fatal.
- **Fixed: resuming a session orphaned its whole crew.** pi gives a resumed session a NEW
  id while keeping the same session file, and recovery matched on id alone — so every
  peer showed as orphaned and nothing ticked. A resumed session now re-adopts the peers of
  any earlier session that used the same file (`crew.readopted`), and the roster no longer
  lists them twice.

## 0.13.0 — 2026-08-06

- **The fourth agent kind runs: MISSION.** `pi-peer mission [role] "<charge>" --tick 10
  --authority write` launches a ticked WORKER — woken by the clock like a watcher, but
  advancing its own standing charge instead of reporting on someone else's work. It keeps
  working while the main session is silent (a watch would be skipped), it has no
  self-ending path at all, and only `pi-peer stop` ends it. `list`, `census` and the panel
  name the kind and its cadence.
- With this the taxonomy is complete: WATCH and MISSION are clock-driven, GOAL is
  objective-driven, TASK is a single engagement. An arc-close audit caught that MISSION
  had been specified and never built.

## 0.12.0 — 2026-08-06

- **`pi-peer cost`** — what the crew has cost: a row per agent (tokens and dollars) and a
  total, from durable state, reconciled against the ledger's own record. Works with no
  live session. Providers that report no price say so instead of showing a misleading $0.
- **`pi-peer doctor`** — one read-only check of the version, the config file, the roster
  and ledger, orphaned agents and the write lock. Says "nothing needs your attention" and
  exits 0 when healthy; names each fault and exits non-zero when not. It changes nothing.
- The panel title carries the crew total — dollars when the provider prices them, tokens
  when it does not.

## 0.11.0 — 2026-08-06

- **Agents can carry your skills.** Name them in a role file (`skills: a, b`) or at
  launch (`--skills a,b`): pi's own discovery resolves them, the skill's text is carried
  into the agent's prompt, and the agent follows it. An agent that names none carries
  none — a peer never inherits the whole catalogue silently.
- A skill name pi cannot find refuses the launch, saying which name failed and how many
  skills it did discover; the request and what was actually loaded are recorded.

## 0.10.0 — 2026-08-06

- **An agent survives its model provider refusing a turn.** List alternatives in the
  role file (`fallbackModels: a, b`) or at launch (`--fallback a,b`): on a provider
  failure the agent switches to the next one, says so in its own pane, records
  `peer.model-failover`, and carries on with the same job. Every surface then reports the
  model it is actually running.
- When the list runs out the failure stands: no handoff is invented, the agent ends
  visibly failed, and the main session is told it produced nothing.
- Agents with no list behave exactly as before.

## 0.9.0 — 2026-08-06

- **Hand over several jobs as one unit:**
  `pi-peer wave worker --authority shell "docs=update the README" "tests=add the missing test"`.
  Members run at the same time in the shared directory (their writes still serialize on
  the project lock) and you hear **once**, when the last one retires, with a per-key
  summary: which finished clean, which need you. A wave whose acceptance gate never
  passes, or whose member escalates a decision, arrives as steering; an all-clean wave
  arrives as quiet news.
- `list`, `census` and the panel show each member's wave key.
- A wave with duplicate keys, or fewer than two tasks, is refused with the reason.

## 0.8.0 — 2026-08-06

- **A delegated job can carry the condition for accepting it:**
  `pi-peer task worker --gate "npm test" "<job>"`. The FRAMEWORK runs that command
  after the agent hands off — a task cannot finish by saying it is finished. A failing
  check is handed back with its real output and the task keeps working (up to three
  attempts); a task that never passes is reported as NOT ACCEPTED and arrives as
  steering, not quiet news. `census`, `list` and the panel show the verdict.
- The task contract now states plainly that the gate checks the job and is not the job:
  satisfying the command by other means is a failure. (A drill caught an agent creating
  exactly the file its gate looked for instead of doing the work.)

## 0.7.0 — 2026-08-06

- **Two agents can write in the same directory without destroying each other's work.**
  Every mutation a granted agent makes (edit, write, bash) passes through the project's
  write lock, so a second writer waits its turn and both edits survive. The lock is
  cross-process (two pi sessions in one project serialize too), held per tool call so a
  long agent cannot block the crew, and taken over automatically if its holder died —
  with the takeover recorded. A waiting agent says so in its own pane; every wait,
  takeover and release is in the ledger.
- Read-only agents are never gated by the lock.
- **Separate checkouts are opt-in.** `--worktree` is refused with an explanation unless
  the project sets `"worktrees": true` in `~/.pi/agent/peer-agent.json`; with the opt-in,
  the agent gets its own `git worktree` and branch, and its file tools are rooted there.

## 0.6.0 — 2026-08-06

- **Three delegation roles ship with the crew:** `worker` (does one job end to end,
  then hands off), `scout` (fast recon — maps the ground, changes nothing) and
  `reviewer` (adversarial review of work already done, with evidence).
- **A role can cap its own authority.** `authorityCeiling:` in a role file means even
  the human elevation ceremony refuses to raise it: scout and reviewer are read-only by
  construction, not by convention. Refusals are recorded (`peer.authority-refused`).
- **Authority can be granted at launch:** `pi-peer task worker --authority shell "<job>"`
  (also on `launch`, and `authority` in `peer_launch`). A task runs its whole engagement
  immediately, so a grant issued afterwards would arrive after the work — this is the
  same explicit human action, expressed in time to matter. Grants above a role's ceiling
  are refused.

## 0.5.0 — 2026-08-06

- **New agent kind: TASK.** `pi-peer task [role] "<job>"` (or `peer_launch` with
  `kind: "task"`) hands the crew a job that finishes: one continuous engagement, no
  ticks, no cycles. The agent works, then hands back a structured report — summary,
  changed files, commands run with exit codes, evidence, surprises, and anything it
  refused to decide alone — and retires. The completion arrives in the main session
  through the ordinary finding path (steering when the handoff names decisions, info
  otherwise). Retired tasks stay in `census` with their handoff and a resume command.
- A turn the model provider refuses is now recorded and shown (`peer.turn-failed`,
  `peer.provider-error`) instead of read as an agent that said nothing. Found while
  proving the TASK kind: on this machine, elevated agents on the Anthropic OAuth path
  get provider errors, and they looked exactly like silence.
- Talking to an agent that has ended no longer resurrects it: a retired task, a
  completed or exhausted goal keeps its ending and can still answer questions.
- The panel counts ended agents separately (`0 watching + 2 retired`) instead of
  claiming a crew that no longer exists.

## 0.4.0 — 2026-08-06

- **Renamed: objective-driven agents are now GOAL, not "mission".** The kind that works
  in cycles until the framework observes its completion condition is objective-driven,
  so it carries the objective word: `--until-file` / `--until-exit0` launches report
  `GOAL` in the panel, `pi-peer list` and `pi-peer census`; the bundled role is
  `goal-runner`; ledger events are `goal.completed`, `goal.exhausted`,
  `goal.claim-refused`. Watches are unaffected.
- **Fixed (safety): a role file that does not name its authority is now born
  read-only.** The default was `shell`, so any role omitting `authority:` could run
  commands from birth — the bundled watchers all pin read-only, so the hole only
  showed on a role that did not. Found by this release's own screenshot, which badged
  an objective agent `⚡shell`; pinned by a regression check.
- The agent taxonomy is now four kinds cut by what wakes the agent: WATCH and MISSION
  are clock-driven (the first reports, the second works its charge), GOAL is
  objective-driven, TASK is a single engagement that runs to completion and retires.
  MISSION and TASK runtimes land in later releases; this release rules the vocabulary
  and renames the objective kind.

## 0.3.13 — 2026-08-06

- Fixed: closing the panel killed mouse-wheel scrolling for the rest of the session in
  pi's fullscreen mode (`tuiMode: "fullscreen"`), where pi itself owns mouse tracking
  to scroll the transcript. The panel's cleanup wrote an unconditional mouse-off
  sequence; it no longer touches mouse-tracking modes in either direction.

## 0.3.12 — 2026-08-06

- Panel resizing now works on GNOME: the desktop binds Ctrl+Alt+Up/Down to workspace
  switching at the compositor, so those chords never reach any terminal. `shift+alt+↑↓`
  ship as additional defaults, both families are configurable (`resizeUpKeys` /
  `resizeDownKeys`), and `/height <20-90>` in the panel sets an exact size with no
  chord involved. `/height` bare shows the current size.

## 0.3.11 — 2026-08-06

- The panel is resizable from the keyboard: `ctrl+alt+up` bigger, `ctrl+alt+down`
  smaller, in 10% steps between 20% and 90% of the screen — live, from the focused
  panel or while typing in the main prompt. Session-scoped; `panelHeightRatio` in the
  config file stays the startup default and is never rewritten.

## 0.3.10 — 2026-08-06

- Orphaned peers are named, not disguised: an agent whose owning session is gone
  (stopped, crashed, or heartbeat-stale) now reads `orphaned` in `pi-peer list` and
  `pi-peer census` — with the resume command beside it — and the panel title counts it
  as `+ N orphaned`, separate from agents live in other sessions. Previously it kept
  reading `waiting` although nothing would ever tick it.
- The last two internal-protocol notes in the peer transcript now speak plain language:
  "couldn't read this tick's summary — treating it as nothing to report" and "the peer
  says it's finished, but the goal isn't met yet — still working".

## 0.3.9 — 2026-08-06

- Fixed: after a peer answered a message, the shared roster file kept reporting it as
  busy ("thinking") until an unrelated write corrected it, so the CLI, the census and
  other sessions saw an agent that never became free again.

- Fixed: the peer pane could not be scrolled at all since 0.3.6. Scrolling had moved to
  PgUp/PgDn, but pi's host consumes those keys before a focused widget receives them.
  Scrolling is now `shift+↑` / `shift+↓`, which do reach the panel.

## 0.3.8 — 2026-08-06

- Reopening the panel returns you to the agent you were talking to, with the text you
  were typing. Previously it reset to the first agent in the list, so the draft that
  came back belonged to someone else's conversation.

## 0.3.7 — 2026-08-06

- The model picker is part of the CLI: `pi-peer models [query]` lists pi's available
  models (the same scoped source the panel shows), and `pi-peer model <name>` — bare or
  with an ambiguous substring — prints a numbered list and prompts for a choice on a
  TTY. Exact and unique refs keep applying directly; without a TTY the ambiguous forms
  list and exit non-zero instead of hanging.

## 0.3.6 — 2026-08-06

- The panel input is now a real pi prompt. It adopts the host's keybinding manager
  (root cause: an extension can resolve a second pi-tui instance whose binding
  singleton holds bare defaults), so word jumps, delete-word, kill/yank, Home/End,
  undo, paste, and multi-line input behave exactly like the main prompt — the
  per-key Home/End patches are gone.
- ↑↓ in the focused panel belong to the editor like pi's own prompt: multi-line
  cursor movement, and input history at the boundaries (submitted messages are
  recallable). The transcript scrolls with PgUp/PgDn/wheel.

## 0.3.5 — 2026-08-06

- Multiple main sessions can no longer erase one another from the roster. All roster
  read-modify-write cycles are serialized across sessions, and mains are identified by
  their full session ID rather than a colliding 8-character UUIDv7 time prefix.
- Main display names now include 16 compact UUID characters, so two sessions started
  seconds apart are visibly distinct in the census.
- Ambiguous `/model` queries now filter and choose inside the peers panel instead of
  handing control to pi's external selector.
- Long model lists stay within the panel's fixed height, and applying a model no longer
  inserts a notification into the main conversation; transcript and footer rows remain
  fixed throughout selection.


## 0.3.4 — 2026-08-06

- Panel transcripts no longer expose `QUIET`, an internal verdict token. A quiet-only
  check reads **“✓ Checked — nothing needs attention.”** Protocol finding lines are
  suppressed when the attributed finding is already rendered separately.
- Clearing input now clears autocomplete state too. Previously the editor looked empty
  while an invisible completion list still owned Tab, arrows and PageUp — the root cause
  of the reported “Tab stopped working” failure.
- Tick intervals and both authority argument levels autocomplete in the panel; explicit
  authority targets are preserved (`/authority observer-1 read-only`).
- A rate-limited/erroring peer no longer returns a successful empty reply. The model error
  is surfaced and the ledger marks `error: true`.


## 0.3.3 — 2026-08-06

- `/authority` works inside the panel: bare command opens an in-panel level picker for
  the selected agent; direct level and explicit name forms also work.
- `/model` now chooses inside the panel instead of opening pi's external selector. The
  footer stays at the same row throughout, so model changes no longer make the transcript
  look like it reloaded or scrolled.
- Model changes update the roster immediately rather than displaying the previous model
  until an unrelated refresh.


## 0.3.2 — 2026-08-06

### Fixed

- **Each agent now owns its own panel draft.** Switching agents with Tab, selecting one
  through the panel tool, changing/reordering the live agent list, or closing and
  reopening the panel saves the current text under that agent's callsign and restores
  only that agent's unfinished input. Before this fix, one shared `Editor` buffer made
  multiple agents look like one conversation: text typed for `observer-1` appeared when
  `sentinel-1` was selected.


## 0.3.1 — 2026-08-06

- **The panel never separates the transcript from the prompt.** It renders BELOW the
  prompt (`placement: "belowEditor"`, the default), so the conversation and the place you
  type stay adjacent, with the panel beneath them. `aboveEditor` remains available.
- Panel height is configurable (`panelHeightRatio`, default 0.5).

## 0.3.0 — 2026-08-06

### Fixed

- **The panel no longer makes the transcript jump when it opens.** Reported repeatedly as
  a flicker/refresh/"the whole transcript looks like it's scrolling". Measured with a bare
  probe extension: ANY overlay — 3 rows or 40, anchored top or bottom — makes pi relayout
  the screen and move its footer by 12 lines the moment it exists. No overlay option
  avoids it, so the panel stopped being an overlay: it now renders as a **widget** above
  the editor (`render: "widget"`, the default; `"overlay"` remains as an escape hatch).
  With the widget the footer does not move at all, before or after opening. Keyboard
  capture, which an overlay got for free, is done with `ctx.ui.onTerminalInput` while
  focused — consuming only what the panel handles and passing everything else through.

### Changed

- Panel chords swapped: **`ctrl+alt+o` opens/hides** (O for Open) and **`ctrl+alt+p`**
  moves the keyboard between panel and main prompt. `ctrl+alt+l` stays an accepted alias.
- Every hint the panel draws is derived from the configured keys rather than hardcoded
  text, so it can never advertise a chord the build no longer uses.

## 0.2.0 — 2026-08-06

Authority, scoping, and a hard look at what was actually broken.

### Added

- **Authority levels.** An agent's authority is a declared property of its role
  (`authority: read-only | write | shell`). The default is **full access scoped to the
  agent's own project directory**; roles that should stay pure observers declare
  `read-only` (the bundled `observer`, `drift-sentinel` and `evidence-auditor` do).
  Change a running agent with `/authority <name> <level>` or
  `pi-peer authority <name> <level>` — always an explicit human action, never automatic,
  always ledgered with from/to. Elevated agents are marked `⚡` in the panel.
- **Project scoping with a human gate.** Cross-project access is refused by default;
  `pi-peer allow <dir>` is the confirmation, `disallow` revokes, `pi-peer scope` shows
  the state. Passing `--cwd` is no longer sufficient to reach another project.
- **Agent provenance.** Every roster entry is stamped with its project at the single
  write point; the panel names the origin of any non-local agent instead of showing an
  unplaceable count.
- **Roles are optional at launch.** `pi-peer launch watch the tests for flakes` writes a
  role on the fly from the instruction, with the same standing contract.
- **`/keys` probe and unmatched-key telemetry.** Any escape sequence the panel cannot
  match is ledgered with its hex, so a dead chord is diagnosable from state.
- **`pi-peer version`** reports the running build and warns when the installed copy
  differs from the source checkout — the failure mode that wasted hours today.
- **macOS chords** via the kitty keyboard protocol (`cmd+alt`), both chord families
  always accepted (ratifies external PR #1 by @abhishakenp).

### Changed

- The panel **opens active** with the first agent selected (`focusOnOpen`, default on).
- The focus key defaults to **`ctrl+alt+o`**, with `ctrl+alt+l` kept as an alias:
  `ctrl+alt+L` is `ESC`+`0x0C`, and `0x0C` is `ctrl+L` which pi binds itself, so with
  tmux `extended-keys off` the chord can dissolve into two unrelated keys.
- Main sessions never appear in the panel; they stay in `pi-peer census`.

### Fixed

- **Recovery is unconditional.** An on-the-fly role, or a role file renamed or deleted
  between launch and reload, used to strand its agent permanently — suspended on
  shutdown, skipped on every recovery, silently. Recovery now rebuilds from the stored
  task, keeps the original role name, carries authority across the restart, and raises
  `peer.role-missing` rather than swallowing it.
- **Crew self-heal**: a shutdown whose matching start never ran can no longer leave the
  crew suspended while its session is demonstrably alive.
- **Peers can authenticate extension-provided models** — every tick was failing with
  "No API key found"; peers now build their own model/auth runtime.
- **A main session no longer briefs itself as a peer** (mains and peers share one roster
  table and kind was not filtered).
- **A live session no longer reports itself stopped** — the heartbeat updated its
  timestamp without clearing the flag.
- The focus key **toggles at both layers**; the panel matches chords with pi's own
  parser first, so it can never recognise fewer encodings than pi.
- Closing the panel hands the keyboard back and leaves **no stranded border**.
- A role declaring `authority: read-only   # comment` is read-only (the trailing comment
  was being compared as part of the value).
- Removed an unsafe `ESC`+letter chord fallback that made `ctrl+alt+L` match plain
  `Alt+L` — and made `Esc` followed by `l` readable as a focus toggle.

## 0.1.0

Initial resident peer agents: minute-tick monitors, findings pushed into the main
session, panel, CLI, missions, session lifecycle.
