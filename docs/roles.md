# Roles — the crew, and how to write your own

## The five roles

| Role | Does what | Wakes | Ends | Edit files | Run commands | Can be raised to |
|---|---|---|---|---|---|---|
| `observer-watch` | watches your work and tells you when it is going wrong | every 5m, whether or not you have typed | you stop it | no | no | nothing — capped |
| `executor-tick` | keeps one thing up to date without being asked again | every 15m, on the clock | you stop it | yes | no | editing only — capped |
| `finisher-condition` | works until the thing you asked for is actually true | every 1m | the condition is met | yes | yes | anything |
| `builder-once` | does one job and hands back what it did | once | the job is done | yes | yes | anything |
| `reviewer-once` | looks at something and tells you what it finds | once | the report is done | no | no | nothing — capped |

The name says the rhythm: `-watch` watches what you do (and the bundled one also wakes
on its own 5-minute clock, so it notices files you never mentioned), `-tick` wakes on a
clock, `-condition` stops when something becomes true, `-once` runs a single time.

**Capped** means the role limits its own elevation — no command can raise it further.

## Launching one

```
pi-peer launch builder-once "add the --json flag to the export command"
pi-peer roles                      # the table above, with each role's file
```

The role file decides what the agent is, so no flags are needed. Override by hand with
`--task` or `--mission` when a job is one-off.

## Where roles live

Three directories, searched in order. A later one **overrides** an earlier one with the
same name, so a project can replace a bundled role without touching the package.

| # | Directory | Scope |
|---|---|---|
| 1 | `<install>/peers/*.md` | the five above |
| 2 | `~/.pi/agent/peers/*.md` | your own roles, in every project |
| 3 | `<project>/.pi/peers/*.md` | this project only — **wins** |

Copy any bundled file into 2 or 3 and edit it. That is the whole template mechanism.

## The four rhythms

| Kind | Wakes | Ends | Used by |
|---|---|---|---|
| `watch` | the clock, when the main agent has done something — or every tick if the role sets `tickWithoutDelta` | you stop it | `observer-watch` (which sets it) |
| `mission` | the clock, always | you stop it | `executor-tick` |
| `goal` | the clock | the framework sees your condition hold | `finisher-condition` |
| `task` | once, immediately — **never ticks** | it finishes and hands back | `builder-once`, `reviewer-once` |

A `task` contract may not declare `tick:` — the file is refused if it does, because
nothing would honour it.

## Authority

| Level | Tools | Reach |
|---|---|---|
| `read-only` | read, grep, find, ls | inspect only |
| `write` | + edit, write | change files in the project |
| `shell` | + bash | **run commands — bounded by your user account, not by the project.** No command filter exists. Grant it deliberately. |

Omit `tools:` and the toolbelt follows the authority. A `tools:` line may **narrow** it;
naming a tool the authority does not grant is refused.

## Writing one

```yaml
---
name: releaser-once            # defaults to the filename
description: One line — what it does, when it wakes, when it stops
kind: task                     # watch · mission · goal · task
authority: write               # read-only · write · shell
authorityCeiling: write        # optional: the most this role may EVER be raised to
tick: 10m                      # how often it wakes — NOT allowed on a task
priorityCeiling: steering      # info · steering · interrupt — the loudest it may be
context: fresh                 # fresh · compacted · fork — what it is born knowing
model: anthropic/claude-fable-5   # optional
fallbackModels: a, b           # optional: tried in order when a provider fails
skills: code-review            # optional: resolved through pi's own skill discovery
tools: read, grep, ls          # optional: narrows the authority's toolbelt
tickWithoutDelta: true         # optional: wake even when the main agent has been quiet
---
Everything below is the agent's charter, injected verbatim as its system prompt. Write
it as instructions to a colleague: what to look at, what to report, what to leave
alone, and when to stay quiet.
```

A file that cannot be read is refused by name and value — an illegal `kind`, a `tick:` on
a task, or a tool the authority does not grant each name the file and the problem. The
other roles still load, and asking for the broken one tells you why.
