# Maturity model + operating modes

pi-peer-agent ships a complete maturity-tracking subsystem: a universal 5-pillar
blueprint, dated append-only snapshots, and a three-mode scorecard dispatch — ported
from a battle-tested autonomous sprint-governance methodology and driven here by two
bundled peer roles plus one slash command.

## The three modes (one pointer file decides)

`peer-docs/.active-scorecard` is the single source of truth:

| Mode | Pointer content | Rubric | KPI | Citation vocab |
|---|---|---|---|---|
| `<maturity>` (default) | absent, or `maturity-model.md` | `peer-docs/maturity-model.md` | **PMI** 0-100 | maturity-row IDs |
| `<usecase>` | `peer-docs/uc-journey-models/uc<NN>-journey-model.md` | that journey model | **UCMI(UC<NN>)** 0-100 | journey-row IDs |
| `<custom>` | one or more roadmap doc paths (multi-line = arc chain) | roadmap Sprint queue + Stop condition | Quality avg (0-4) · Completeness % · Integration | **arc-slice IDs** |

All machinery is identical across modes — only rubric and KPI label differ.
Vocabularies never mix: a CUSTOM report never says "row", a MATURITY snapshot never
reports UCMI. Multi-line pointers declare a chained run: the first arc whose Stop
condition is unmet is active; when it closes, the chain auto-advances.

## The command

- `/maturity` — status: active mode, scorecard path(s) with validation marks, latest
  snapshot + its KPI line.
- `/maturity mode maturity` — arm MATURITY (advises `/maturity build` if no blueprint).
- `/maturity mode usecase <NN>` — arm USECASE for UC-NN.
- `/maturity mode custom <roadmap.md> [more…]` — arm CUSTOM; **refuses to arm** any
  roadmap missing the three required H2 headings (`## Strategic intent map`,
  `## Sprint queue`, `## Stop condition`) and lists exactly what to repair.
- `/maturity build` — launch the **maturity-architect** peer (construct/rebuild the
  blueprint).
- `/maturity snapshot` — launch the **maturity-assessor** peer (score one dated
  snapshot now, then stand watch).

## Construction: the spec rollup that looks beyond the spec

The architect role works in four phases: (1) **roll up** every spec/strategy doc in
the project automatically — operator docs are gold, re-interviewing them is the
failure mode; (2) **specialize** the bundled universal blueprint
(`templates/maturity-blueprint-template.md`): five pillars at 30/25/15/10/20, seven
scoring rules, three mandatory VERIFICATION archetypes — non-negotiable even if the
spec never mentions testing; (3) **look beyond the spec**: archetype-gap walk with
justified absences, competitive/domain research, the hardest-reviewer gauntlet,
failure-mode rows, provenance tags on every row (`spec §X` vs `beyond-spec`), and
self-flagged gameable targets via the proxy-gap test; (4) **surface for sign-off**
on one screen, then write (previous model archived first, operator-owned files never
touched).

## Scoring: why the numbers stay honest

The blueprint carries the full discipline: evidence rule (no artefact ⇒ ≤40),
verify-docs-not-commit-messages, kill-list filter, three-class evidence rule (two of
A/B/C to cross 60; runtime-contract rows demand a live-path integration walk for
Class B), stakeholder-lowest rule, multi-leaf ceiling
`ceil(shipped/promised × 100) − 5`, and the honesty-drop principle: adding a
measurement dimension lowers the index, and that drop is the system working.

Snapshots are append-only in `peer-docs/assessments/` with a Δ column and a Top-10
gap list ranked by weight × gap — the planning input for whatever loop drives the
project.

## Templates

- `templates/maturity-blueprint-template.md` — the universal 5-pillar skeleton.
- `templates/uc-journey-model-template.md` — USECASE rubric (journey-node × persona ×
  variant rows, per-class scores).
- `templates/custom-roadmap-template.md` — CUSTOM roadmap with required headings,
  TASK/METHOD/EVIDENCE grounding (proxy-gap test), optional fog section, stop
  condition.
