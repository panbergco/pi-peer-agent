# UC<NN> Journey-Model — <Use-Case Title>

<!-- Scorecard template. Copy to peer-docs/uc-journey-models/uc<NN>-journey-model.md
     and point peer-docs/.active-scorecard at it to enter USECASE mode. -->

**Scorecard interface contract.** This file plays the same role in USECASE mode that
`peer-docs/maturity-model.md` plays in MATURITY mode: it is the rubric the loop and the
assessor churn against. All machinery is identical across modes — only the rubric and
the KPI label differ. The KPI here is **UCMI** (Use-Case Maturity Index, 0-100, per
UC), notated `UCMI(UC<NN>)`.

---

## Pillars (production-contract coverage)

Pillars are the benchmark sections of this use-case's production contract. Each row
belongs to exactly one pillar. Weights MUST sum to 100; adjust per UC based on which
sections matter most for shipping this UC (demo-first UCs weight the end-to-end
walkthrough higher; compliance-first UCs weight evidence/audit higher).

| Pillar | Weight | Scope |
|---|---|---|
| §A Entry / setup | 10 | From first contact to a bound, deployable configuration |
| §B Grounded interaction | 15 | The product answers/acts with full context, per persona |
| §C Deployment flow | 10 | Wire-up, credentials, spawn/activation observation |
| §D Outputs in product | 15 | Surfaces where results land, per persona |
| §E Action lifecycle | 15 | Full state machine incl. approvals / HITL |
| §F Evidence and audit | 10 | Receipts, audit chain, reviewer paths |
| §G Persistence and continuity | 10 | Cross-session, cross-tenant, cross-run |
| §H Full walkthrough | 15 | End-to-end stitched journey, recorded, reviewable |

Rename/replace §A–§H with the sections of YOUR use-case's contract — the labels above
are the archetype, not a mandate. Keep the sum at 100.

---

## Row schema

Every row is a **journey-node × persona × variant** combo. Row ID convention:

```
UC<NN>-<§X>-<node-slug>-<persona>-<variant>
```

Example: `UC01-B-grounded-answer-cfo-erp17` = UC01, §B pillar, "grounded answer"
journey node, CFO persona, ERP-v17 variant.

### Row fields

| Field | Required | Semantics |
|---|---|---|
| `id` | yes | Stable ID (convention above) |
| `pillar` | yes | One of the pillar sections |
| `journey_node` | yes | Short label from the journey model |
| `persona` | yes | One of the UC's personas |
| `variant` | yes | Concrete deployment variant (incl. edge/failure variants) |
| `class_a` | 0-100 | Capability-depth: primitive implemented and unit-testable |
| `class_b` | 0-100 | Integration-quality: end-to-end walk on real infra |
| `class_c` | 0-100 | External-witness: third-party verifiable |
| `score` | derived | min-gated composite (see scoring) |
| `evidence` | yes | Paths/citations per class, or "not present" |
| `gap` | yes | What's missing to reach target |

### Scoring

Row score = the three-class evidence rule from the maturity blueprint applied per row:
two of three classes required to cross 60; the stakeholder-lowest rule and multi-leaf
ceiling apply unchanged.

```
UCMI(UC<NN>) = Σ pillar_weight · mean(row scores in pillar) / 100
```

---

## Snapshot discipline

Identical to MATURITY mode, same folder (`peer-docs/assessments/`), filename
`YYYY-MM-DDTHH-MM-uc<NN>-coverage-snapshot.md`, append-only, Δ column per pillar.
Do NOT mix vocabularies across modes: USECASE snapshots cite journey-row IDs and
report UCMI — never PMI, never maturity-row IDs.
