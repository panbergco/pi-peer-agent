# <Arc name> — roadmap

<!-- CUSTOM-mode scorecard template. Point peer-docs/.active-scorecard at this file
     (or at several such files, one per line, for a chained run) to enter CUSTOM mode.
     Three H2 headings below are REQUIRED — mode arming validates their presence. -->

**Purpose:** <one paragraph: what this bounded run delivers and why now>

## Strategic intent map

| Intent | Advanced by |
|---|---|
| I-<NN> — <intent name> | <which slices> |

Every slice below MUST trace to an open intent here or to an arc-blocking debt entry.
If no remaining open slice cites an open intent, the arc has drifted — audit it.

## Sprint queue

| Slice | Status | Description |
|---|---|---|
| <ID> | open | <single recognizable deliverable line — not a basket> |

The first slice whose status matches `open|pending|ready|queued|todo|wip|waiting|new`
is the NEXT OPEN ARC-SLICE the loop surfaces. Slice IDs are the citation vocabulary of
CUSTOM mode — goal files and verify docs cite slice IDs, never "rows" (maturity vocab).

## Arc-slice grounding

### <slice-id>
- TASK: <the deliverable line this slice produces — what a stakeholder recognizes>
- METHOD: <the mandated path / governing constraint — how it MUST be built>
- EVIDENCE: <named product-produced artifact + mechanism that proves it>

The proxy-gap test for every anchor: **is there a cheaper path to a passing artifact
than doing the real work?** If yes, the anchor is broken — tighten it. TASK names the
real-world question answered, METHOD names the governed path (never a side-door CLI
standing in for the product), EVIDENCE names a product-produced artifact plus the
mechanism that proves provenance.

## Evidence standard

provenance: product-only
banned: <regex tells for off-product evidence, one per line>

## Not yet specified (fog)

<!-- OPTIONAL. Scope that belongs to the arc but whose stop-condition cannot yet be
     stated binarily. One rule, no in-between: an item is either a fully-grounded
     slice above, or fog linked to a decision ID (D-NN). The sharpness test for
     graduation: can you state the question precisely? If yes it is not fog — state
     the D-NN, resolve it, graduate the slice. An arc cannot close with nonempty fog. -->

| Fog item | Blocking decision |
|---|---|
| <what remains unsharp> | D-<NN> |

## Stop condition

The arc closes when ALL of:
- Throughput = 100% (every slice in the queue closed)
- Completeness = 100% (every closed slice passed C.1 closure + C.2 model-alignment + C.3 dependency-satisfaction)
- Quality average ≥ 3.5 / 4 (Q.1 all ACs full · Q.2 all gates attested · Q.3 real proof · Q.4 no uncited debt)
- Integration: every slice's I.1–I.4 sections reviewer-validated as substantive
- Strategic intent: every slice cited an open intent or arc-blocking debt
- Fog section empty (all items graduated or formally moved out of the arc)
