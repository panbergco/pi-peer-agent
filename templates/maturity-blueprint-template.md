# Maturity Model — {{PRODUCT_NAME}}

**Purpose.** The stable rubric for scoring maturity row-by-row and computing the overall
Maturity Index. It sits above every individual snapshot. Snapshots apply this rubric to
the current row set and produce a dated score + Top-10 gap list. This file changes
rarely; snapshots are append-only.

**Authority hierarchy.** When sources disagree:

1. `peer-docs/strategic-intents.md` (if present) — the constitution. Canonical PMI
   target, kill-list, intent IDs.
2. `peer-docs/maturity-model.md` — this file. The scoring rubric + section catalog.
3. `peer-docs/assessments/` snapshots — point-in-time applications of the rubric.
   Never overrule the blueprint.

---

## Canonical target

**PMI ≥ 95.** This is the product-readiness bar. Below 95 the product carries known
unresolved debt in at least one dimension. If `strategic-intents.md` exists it is the
authoritative source of this target — this file inherits it, never sets it.

Band interpretation (rubric for individual rows AND overall PMI):

| Band | Label | Meaning |
|---|---|---|
| 0-20 | not started | doc only, no scaffolding |
| 21-40 | scaffolding | structure exists, no working behaviour |
| 41-60 | MVP | works on mocked / seeded inputs |
| 61-80 | works | works on real external systems |
| 81-95 | near parity | works + provable with evidence export |
| 96-100 | mature | audited + witnessed by third parties |

---

## PMI formula (universal 5-pillar)

```
PMI = 0.30·DIFFERENTIATION + 0.25·BUYER-READINESS + 0.15·CAPABILITY + 0.10·OPERATIONS + 0.20·VERIFICATION
```

Each pillar is the arithmetic mean of row scores in that pillar (simple percentage
average; row importance is expressed by adding or removing rows, **not** by
re-weighting within a pillar). Weights are fixed at **30/25/15/10/20** unless
`strategic-intents.md` formally revises them (see weight-revision protocol below).

---

## The five pillars (universal dev-lifecycle structure)

| Pillar | Weight | Question it answers | Think of it as the… |
|---|---|---|---|
| **DIFFERENTIATION** | 30% | Why would anyone choose this product over alternatives? What is it categorically? | "Is it different?" |
| **BUYER-READINESS** | 25% | Would this survive the procurement / adoption / app-store / peer-review gate that stands between you and a paying-customer signature? | "Would they sign?" |
| **CAPABILITY** | 15% | Does the user-facing surface actually work end-to-end? Feature breadth + depth + UX. | "Does it work?" |
| **OPERATIONS** | 10% | Can we sustain this commercially? Engine capacity, SLOs, observability, pricing, sales enablement. | "Can we run it?" |
| **VERIFICATION** | 20% | Is the product's claimed state **actually proven**, via observable end-to-end evidence across use cases, test types, and personas? | "Can we prove it?" |

**Why VERIFICATION is 20%.** A strong product with weak evidence fails enterprise sale.
A weaker product with overwhelming evidence wins. Proof is a first-class dimension, not
a side-effect of shipping.

---

## Pillar archetypes (section skeletons every project can start from)

These are **the archetype sections** each pillar tends to populate. Start with the
archetypes applicable to your product category; add sections only when a reference doc
in `docs/` defines the dimension.

### DIFFERENTIATION archetypes
- **A** Product principles / doctrine (what we believe; 5–10 principles)
- **B** P0 capabilities (differentiating features the product must ship)
- **H** Security & compliance moats (if regulated industry)
- **P** Protocol / standard primitives (if protocol-centric)
- **Z** Process discipline & engineering moats

### BUYER-READINESS archetypes
- **G** API patterns and canonical surface
- **K** Deployment modes (SaaS / single-tenant / private cloud / sovereign / air-gap / etc.)
- **M** Personas — every user class (buyer, power-user, admin, auditor, reviewer, end-user)
- **U** Identity + access depth
- **V** Security primitives (mTLS, KMS, HSM, secrets broker)
- **W** Compliance attestations (SOC 2, ISO, HIPAA, industry certs)
- **AC** Multi-layer access model per layer
- **AD** Multi-tenant lifecycle (if SaaS)
- **AF** Audit + SIEM + RTBF
- **AG** Commercial surface (pricing, SLAs, support tiers)
- **AH** Trust center / public posture

### CAPABILITY archetypes
- **E** Architecture planes / subsystems
- **F** Data model entities
- **Q** Authoring surface / creation UI
- **R** Tool / action surface
- **S** Reasoning / processing depth
- **T** Memory / knowledge layer
- **X** Channel coverage (web, API, mobile, terminal, integrations)
- **AA** Personalization + accessibility (WCAG)

### OPERATIONS archetypes
- **I** Operational targets (SLOs, MTTR, incident-volume)
- **J** Observability attributes (OTel, DLP-redaction counters, verdict metrics)
- **L** Commercial model
- **N** KPI instrumentation (TTL-to-first-value, etc.)
- **O** Engine capacity (parallelism, scheduler, routing)
- **Y** Sales kit + competitive enablement

### VERIFICATION archetypes — the universal 3 (MANDATORY from day 1)
- **Use-Case Coverage** — **every canonical end-to-end flow a customer would actually
  run**, one row per flow. Source → processing → action → actor → trigger. Evidence
  demands: real data + real UI + real receipts + independently-read proofs at every
  step. Target row count: 10–30 depending on product breadth.
- **Test Pyramid + Pre-Prod Discipline** — one row per test type: unit coverage per
  module, contract tests at every API boundary, integration tests with real infra,
  E2E of every use-case, load testing with SLOs, chaos engineering, SAST, DAST, SCA,
  secrets-scanning, mutation testing, visual regression, accessibility (axe-core),
  fuzz testing, multi-tenant isolation, upgrade/downgrade, DR / backup-restore,
  synthetic monitoring, policy-as-code, pentest cadence. Target row count: 15–20.
- **Persona + Lifecycle Simulation** — one row per persona (6–12 typical) ×
  harness-depth + one row per lifecycle stage (Day 0 onboarding / Day 7 first value /
  Day 30 steady state / Day 365 renewal / offboarding + RTBF) + incident-response
  drill cadence + scale simulation. Target row count: 10–15.

**Why these three.** They answer: "do the things we ship actually work for real
customers, across real flows, tested across real failure modes?" Without this pillar a
product can pass every gate AND still ship broken — the test pyramid catches unit
regressions; the use-case matrix catches integration regressions; the persona sim
catches "it works for me but not for the auditor / finance user" regressions.

### Optional VERIFICATION archetype — **Live-Path Cutover Status** (activates on declared cutover arcs)

When the project declares a cutover roadmap — a named multi-sprint effort migrating a
production path from a legacy / transitional shape to a spec-compliant shape — add a
transient **Live-Path Cutover Status** section with one row per cutover state. Rows
start at 0–15% (legacy dominant) and climb to 100 as wiring lands; retire the section
once every row reads 100 and the transitional path is deleted from code.

Typical rows: deploy-boundary write shape · execution-layer accept shape · verdict /
policy path routes through the declared authority · event / telemetry source of truth
is structured (not stdout inference) · abstraction enforcement (no hardcoded bypass) ·
enforcement library consumed on the live path (not just tests) · legacy shape
elimination · transitional-path count (target 1, never 2+).

**Why separate from Use-Case Coverage.** Coverage scores whether flows work. Cutover
scores whether the deployed runtime uses the declared primitives. Flows can pass 100%
on the wrong substrate. Scoring them separately prevents the "library shipped but live
path unchanged" inflation pattern.

**Scoring note.** Every row here is by definition a runtime-contract row (three-class
evidence rule below): library-plus-tests-only caps at 60; crossing 60 requires a
live-path integration walk.

---

## Row schema

Every row has seven fields:

| Field | Purpose |
|---|---|
| # | Row ID (e.g., B1, AB2, AY14) |
| Area | High-level grouping |
| Attribute | Specific capability |
| Strategic target | What "done" looks like for this row (cites reference doc) |
| Current state | Actual evidence: file path, route, sprint number, commit hash, or "not present" |
| Maturity % | Score per rubric (0–100) |
| Gap | What's missing to reach target |

---

## Scoring discipline (applies to every row, every snapshot)

1. **Evidence rule.** Every row must cite a file path, route, sprint number, or commit
   hash. "Claimed done" without an artefact ⇒ score ≤ 40%.
2. **Verify-file rule.** Scoring reads verification documents in the project's closed
   work archive — not commit messages. A commit title saying "X shipped" does not move
   a row. The verify doc's passing tests with real evidence does.
3. **Kill-list filter.** Kill-listed scope (see `strategic-intents.md`) is not
   tracked. Missing a kill-listed feature is not debt — it's scope exclusion. Never
   add a row for kill-listed work.
4. **Three-class evidence rule.** A row cannot cross 60% without evidence from at
   least two of three classes:
   - **Class A — Capability-depth** — feature works against the real external system,
     not a mock. For runtime-contract / enforcement-primitive / protocol-primitive
     rows, a library exercising the primitive against a real external system in
     unit / integration tests qualifies as Class A. Library-plus-tests-only evidence
     does **not** satisfy Class B.
   - **Class B — Integration-quality** — end-to-end recording on real data reviewed
     by a verifier. For runtime-contract rows, Class B specifically means an
     **integration walk that exercises the primitive against the deployed runtime**
     (the customer-facing execution path), not a unit test against the library in
     isolation. A library can ship perfectly with green tests (Class A) while the
     live path consumes a legacy contract — in that state the row caps at 60.
   - **Class C — External-witness** — third-party verifiable (real API response, live
     tenant install, auditor sign-off, cross-implementation test vector).
   Single-class evidence caps the row at 60.

   **Identifying runtime-contract rows.** Any row representing a contract the running
   product should consume — deployment shape, verdict protocol, event families,
   engine-profile abstractions, policy enforcement, tool-call envelopes — is a
   runtime-contract row. Rule of thumb: if the row could plausibly score high purely
   because a library exists and unit tests pass, apply the stricter Class B reading.
5. **Stakeholder-lowest rule.** Maturity score is the **lowest** across every
   stakeholder perspective (investor, CEO, sales, pre-sales, marketing, business
   user, platform engineer, CISO, compliance, IT ops, engineer). A feature that demos
   well for Sales but breaks for the Business User is not 70 — it's 50.
6. **Multi-leaf ceiling.** A row representing a multi-leaf capability (e.g., "Mail =
   send + read + list + create") is capped at
   `ceil(leaves_shipped / leaves_promised × 100) - 5` until all leaves ship.
7. **Dimension expansion is honesty.** When a new section is added, PMI typically
   drops. That drop is real, not a regression. New sections come from reference docs
   first (see dimension-expansion protocol).

---

## Snapshot discipline

- At least every 5 closed work-units (sprints or equivalent), write a new dated
  snapshot into `peer-docs/assessments/YYYY-MM-DDTHH-MM-maturity-snapshot.md`.
- On explicit request (release, demo, investor update), write a snapshot regardless.
- Never overwrite a prior snapshot. Append-only trajectory.
- Include "Δ vs previous snapshot" column per section.

---

## Dimension-expansion protocol

When a new dimension is identified (by the operator, an agent, or a retrospective):

1. Do NOT add rows directly to the next snapshot.
2. Write (or locate) a reference doc in `docs/` that defines the dimension. Deep web
   research on authoritative sources (NIST, OWASP, vendor docs, industry benchmarks)
   is acceptable input.
3. Get operator sign-off on the reference doc.
4. Update this file: add the new section to the catalog with its pillar assignment
   and source reference doc.
5. Next snapshot scores against the updated model.

Expanding the measurement surface causes honesty drops in PMI. **This is the system
working as designed.**

---

## Pillar-weight revision protocol

The 30/25/15/10/20 weighting holds unless:

1. `strategic-intents.md` formally requires a change.
2. The operator explicitly approves the new weighting in a single sign-off step.
3. The revision is documented inline in this file with old weights + new weights +
   rationale + date.

Without all three, the weights do not change. "The agent felt the weights were wrong"
is not a valid basis for revision.

---

## Evidence layout

Snapshots cite evidence wherever the host project keeps it (proof bundles, verify
docs, CI artifacts). Every scored row references at least one artefact by path with
its class tag (A/B/C). The rubric row ↔ work-unit → code → proof file → verify doc →
archive chain is the universal contract between the VERIFICATION pillar and the
project's delivery lifecycle.
