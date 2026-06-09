# findtrackers — flarmid ↔ pilot identification

Tool for associating FLARM device IDs with pilots in a competition by
replaying APRS position logs against task geometry and scoring every
plausible pairing.

## Why it exists

The `tracker` table is operator-set; the trustworthy way to verify it
is to look at the data. Each task day, a pilot's tracker should
produce APRS packets that cross the start line near their official
start time and the finish line near their official finish time. If it
doesn't, the assignment is wrong (or the FLARM is misbehaving).

Beyond verification, the same logic identifies trackers for *unknown*
pilots — comp organisers often start the week without trackerids set
and rely on this tool to populate them.

The legacy logic was binary: max(|Δstart|, |Δfinish|) against a fixed
tolerance, with "outside tolerance" effectively meaning "wrong
tracker." That falsely penalised landout pilots, weak-coverage days,
and pair-flying pilots. The current system is probabilistic: each
candidate pairing gets a score in nats (log-likelihood-ratio units),
margins quantify how unambiguous the pair is against alternatives, and
multi-day evidence accumulates so a clean prior protects a noisy day.
The multi-day prior is built **only** from start/finish line crossings
(nothing derivable from the DDB or the cross-comp identity tables), and
a contention guard stops a weak contender from displacing a flarmid that
another glider already confidently holds.

## File layout

- `bin/findtrackers.ts` — CLI: argument parsing, DB I/O, operator
  prompts, proposal generation, write paths. Database-bound code lives
  here.
- `lib/scoring/shared/findtrackers.ts` — scan + match: reads APRS
  point log, runs `hasCrossed` on consecutive packets, produces
  `TrackerMatch[]` with `TrackerDiag` for each candidate pair.
- `lib/scoring/shared/trackerScore.ts` — pure scoring kernel:
  `scoreSignals`, `computeMargins`, `decayPrior`, `crossingScore`,
  `summarisePrior`, `contentionPenalty`, `physicalMatchScore`.
  No I/O. Unit-tested in `test/trackerScore.test.ts`.
- `lib/constants.ts` — all tunables and weights:
  `TRACKER_SCORE_WEIGHTS`, `DEFAULT_DIST_TOLERANCE_KM`, etc.
- `lib/ddb/index.ts` — FLARM device database loader (OGN + FlarmNet
  merged). Exports `loadMergedDDB`, `gliderEquivalent`, `DDBEntry`.
- `lib/flightprocessing/preparedTurnpoint.ts` — line/sector geometry.
  Its `hasCrossed(prev, pos)` returns line-aware `distanceKm` in the
  no-cross branch; findtrackers uses that, not centroid distance.

Migrations:
- `conf/sql/migrations/20260510_trackerhistory_evidence.sql` — schema
  columns for persisted evidence.
- `conf/sql/migrations/20260510_trackerhistory_method_score.sql` —
  adds `'evidence'` and `'startmatch-swap'` to the method enum.
- `conf/sql/migrations/20260607_trackerhistory_drop_derivable.sql` —
  drops `pair_score`, `margin`, `ddb_link`: the prior is now crossing-only
  and those values are recomputed live, so storing them only went stale.
- `conf/sql/onglide_schema.sql` — canonical schema includes all three.

## Pipeline

For one (compid, datecode) group:

```
loadOfficialResults  →  OfficialResult[]   (per pilot: compno, name,
                                            trackerid, startUtc,
                                            finishUtc | null,
                                            glidertype)
        │
        ▼
findTrackerMatches  →  TrackerMatch[]      (per (pilot, candidate-flarmid):
                                            deltaStart, deltaFinish,
                                            confidence, withinTolerance,
                                            ambiguous, assigned, diag)
        │
        ▼
loadPriorEvidence   →  PriorMap            (per (compno, flarmid):
                                            decayed sum of prior days'
                                            start/finish crossing scores,
                                            ≤1/day)
        │
        ▼
computeScoreMap     →  ScoreMap            (per pair: ScoreBreakdown,
                                            two-sided margins, contested
                                            flags, deltas, demoted flag;
                                            applies the contention guard)
        │
        ▼
printMatches        — operator-facing report (always runs)
        │
        ▼
computeProposals    →  Proposal[]          (adds, removes, reason,
                                            crossing deltas)
        │
        ▼
reviewProposals (interactive) | --yes      operator selection
        │
        ▼
applyProposals      — tracker + trackerhistory writes
        │
        ▼
writeEvidence       — trackerhistory evidence rows (multi-day fuel)
```

## Scan / match: the three phases

In `lib/scoring/shared/findtrackers.ts:matchCrossings`:

- **Phase 1** — flarmid crossed BOTH start AND finish lines within
  `tolerance` of a pilot's official times. `withinTolerance=true`.
  Multiple Phase-1 matches per pilot → all flagged `ambiguous`.
- **Phase 1.5** — single-sided: flarmid crossed only start (or only
  finish) within tolerance. Surfaces landout pilots (no finish), and
  pilots whose start was missed by APRS coverage but who finished
  cleanly. `withinTolerance=false` — single-sided evidence is weaker
  than both-sided and pair-flying makes one-sided ambiguity common.
- **Phase 2** — for each pilot's currently-assigned flarmid that
  wasn't already added by Phase 1 / 1.5, write a row showing whatever
  data we have (so the operator can see "this pilot's tracker was
  silent today"). `confidence=null` rows when no crossing exists.

Ambiguity flags fire only on Phase 1 matches; Phase 1.5 and Phase 2
rows don't artificially mark a clean two-sided match as ambiguous.

### Landout pilots

Pilots who started but didn't finish (no `pr.finish` time) load with
`finishUtc=null`. Phase 1 (both-sided) skips them, Phase 1.5 picks
them up via start-only. Distinct from "DNF" in the codebase, which
means "did not fly" — those don't appear in `OfficialResult` at all
(the SQL filters on `pr.start`).

### Multi-flarmid pilots

`tracker.trackerid` is comma-delimited (`"A12,B34"`). Both flarmids
are evaluated as candidates. Operations:

- **Phase 1**: each flarmid that crosses cleanly produces an
  `assigned=true && withinTolerance=true` row.
- **Pair-flying with two units**: both rows → both `ambiguous` → pilot
  skipped (no auto-decision; manual review).
- **Removing one of two**: handled — `parseCurrentIds` splits, the
  apply path filters and rejoins. Result preserves the multi-id
  shape minus the removed one.
- **Trackerhistory writes**: one row per *added* flarmid (not one per
  proposal with a comma-joined flarmid string). Critical for the
  prior loader, which keys on `(compno, flarmid)`.

### Distance metric

`hasCrossed(prev, pos)` returns line/sector-aware `distanceKm` in its
no-cross branch (`preparedTurnpoint.ts:471-477` for lines —
perpendicular distance with `onBoundary` clamped to the finite
segment; `preparedTurnpoint.ts:561-567` for sectors — distance to the
nearest boundary point). The scan harvests this on every consecutive
in-bbox pair via a post-scan pass and folds it into:

- `TrackerDiag.minDistanceKm` — closest approach across the whole
  scan.
- Per-sample `lineKm` — closest approach over the segments touching
  that fix, used by `bracketDist` to compute `distAtStartKm` /
  `distAtFinishKm` at the pilot's official time.

Crossing segments contribute `lineKm = 0` (the trajectory passed
through the line).

The 150 km first-sighting gate still uses centroid distance — at that
scale the geometry distinction doesn't matter.

## Scoring kernel

Pure functions in `lib/scoring/shared/trackerScore.ts`. Units: nats
(natural log-likelihood ratio).

```
pairScore(p, f, today) = Σ wᵢ · sᵢ(p, f, today) + prior(p, f, today)

prior(p, f, today)     = Σ_{d ∈ past task-days} crossingScore(p, f, d)
                                                · exp(−taskDaysAgo / τ)

crossingScore(p, f, d) = min(1, w_Δstart·s_Δstart + w_Δfinish·s_Δfinish)
```

All signals contribute non-negative weight when present, exactly 0
when absent, and the prior itself is ≥0. Contradictions normally emerge
through *other* candidates scoring higher, not via negative weights — the
**one** exception is the contention guard (below), which negates a whole
pair's total when a different glider confidently holds the flarmid.

The prior is deliberately narrow: it carries **only** that pair's own
start/finish line crossings, capped at `MAX_PRIOR_PER_DAY_NATS = 1.0`
per task day. A day with no crossing contributes 0, so repeated clean
days accumulate while a single shaky day can't dominate. It never folds
in DDB facets, the operator baseline, or cross-comp identity — those are
recomputed live every run, so persisting them into the prior would
double-count and go stale.

### Signal table

| Signal | Source | Saturating function `s ∈ [0,1]` | Weight `w` |
|---|---|---|---|
| Δstart | `TrackerMatch.deltaStart` | `max(0, 1 − \|Δ\|/T_tol)` | 1.0 |
| Δfinish | `TrackerMatch.deltaFinish` | same | 1.0 |
| distAtStart | `TrackerDiag.distAtStartKm` (line/sector-aware), modulated by `gapAroundStartSec` | `max(0, 1 − distKm/D_tol) · 1/(1 + gap/T_gap)` | 1.0 |
| distAtFinish | same | analogous | 1.0 |
| in-area presence | `inBboxPackets` AND `bboxRejectedPackets` | `min(1, inBbox/N_full) · inBboxRatio` | 0.5 |
| pre-launch sighting | `firstSeenT` vs earliest pilot start | `1` if firstSeen ≤ earliestStart − 30 min | 0.3 |
| DDB CN match | `ddb.cn == pilot.compno` (case-insensitive) | indicator | 1.5 |
| DDB glider match | `gliderEquivalent(ddb.aircraft_model, pilot.glidertype)` | indicator | 0.3 (weak) |
| operator baseline | flarmid in current `tracker.trackerid` | indicator | 1.0 |
| prior | persisted prior days' start/finish crossings, capped ≤1/day, decayed | `Σ crossingScore · exp(−daysAgo/τ)` | 1.0 (already in nats) |

Defaults (lib/constants.ts):
- `T_tol = 5 s` (`DEFAULT_TOLERANCE_SEC`)
- `D_tol = 0.3 km` (`DEFAULT_DIST_TOLERANCE_KM`)
- `T_gap = 30 s` (`DEFAULT_GAP_MODULATION_SEC`)
- `N_full = 200` (`DEFAULT_INBBOX_FULL_COUNT`)
- `τ = 4 task-days` (`DEFAULT_PRIOR_DECAY_DAYS`)
- `inBboxRatio < 0.3` excludes a flarmid from the candidate set
  (`DEFAULT_INBBOX_MIN_RATIO`) — mostly-elsewhere traffic that drifted
  briefly into our bbox.

### Gap-modulated distance

`distAtStartKm` is the closest approach of the bracketing-segment to
the start geometry at the pilot's official start time. When the gap
between the two packets bracketing the official time is wide (e.g.
60 s), the bracketing distance is a loose bound (the pilot could be
anywhere in the gap). The signal is multiplied by
`1/(1 + gap/T_gap)`:

- gap = 0 → ×1
- gap = T_gap (30 s) → ×0.5
- gap = 2·T_gap → ×0.33

So a 60 s gap with a 50 m bracketing distance scores like ~25 m at
zero gap — i.e., the bound is trusted less.

### Grandprix common-start exclusion

When a class is grandprix-scored (`classes.grandprixstart = 'Y'`) **and**
every pilot in the day's results shares one common start time, the
start-line crossing is the same for everyone and so can't tell pilots
apart. `processGroup` detects this (`grandprixstart && one distinct
startUtc`) and sets `excludeStart`, which nulls `deltaStart` /
`distAtStart` in `signalsFromMatch` and drops the start term from the
prior's `crossingScore` — both contribute 0, leaving the finish crossing
(plus presence, DDB, prior, xc) to do the discriminating. The report
prints `grandprix start with a single common start time — excluding
start-line crossing from scoring`. Both conditions are required: if the
start times actually differ they remain informative and are kept.

### Margins

`computeMargins({chosenScore, bestOtherFlarmidForPilot,
bestOtherPilotForFlarmid})` gives:

- `pilotMargin = chosen − best alternative on the pilot's side`
- `flarmidMargin = chosen − best alternative on the flarmid's side`
- `margin = min(pilotMargin, flarmidMargin)` (two-sided)

Margins are computed against the *candidates we've evaluated* (the
matches list), not the full universe of pilots × flarmids. That's
an approximation — Hungarian assignment over the full bipartite
graph is Stage 4 work.

**Uncontested** pairs (no other candidate on either side) have
margins equal to the chosen score — wide-looking but meaningless.
The CLI renders these as `S=1.02  uncontested (no competing
candidate seen)` to avoid mistaking it for confidence.

### Contention guard

`contentionPenalty(pairs, key, protectThreshold)` runs inside
`computeScoreMap` **before** margins, so the negation flows through to
the two-sided margins. Its job is to stop a poor match from displacing a
likely-good one. For each flarmid with more than one candidate:

1. The **holder** is the operator-baseline pair if its total clears
   `PRIOR_PROTECT_NATS = 3.0`, otherwise this run's highest-scoring pair
   if *that* clears the threshold (baseline takes precedence, so an
   existing good assignment is protected even when a contender scores
   higher). If neither clears the threshold there is no holder and
   nobody is penalised.
2. Every **other** glider competing for that flarmid is a contender; its
   whole (prior + current) total is negated — `total → −total` — so it
   can never win the assignment away from the confident holder.

The negated pair is flagged `demoted` in the `ScoreMap` and rendered as
`S=−4.05 (demoted: flarmid confidently held elsewhere)`. Because the
total is now negative it also falls below the ledger/auto-apply floors,
so a demoted contender is neither written as evidence nor auto-applied.

### Prior loading

`loadPriorEvidence(datecode, className)` in bin/findtrackers.ts:

1. Query `trackerhistory` rows for this class with non-null datecode,
   excluding today and excluding `*-blocked` / `none` methods. Only the
   `delta_start` / `delta_finish` crossing columns are read.
2. Rank the evidence-bearing datecodes (today included) in string order
   to get the task-day index, then for each row compute
   `taskDaysAgo = currentRank − rowRank`. Skip rows whose datecode isn't
   in that set (not part of this class's task sequence).
3. Convert each row's deltas to that day's `crossingScore` (≤1), group
   by `(compno, flarmid)`, and sum `Σ crossingScore · exp(−daysAgo / τ)`
   via `summarisePrior`. A row with no crossing (both deltas NULL) scores
   0; legacy rows that predate the delta columns therefore contribute
   nothing — they carry no crossing evidence, which is all the prior is.

**Task-day decay** is critical: a 7-day weather gap shouldn't erode
a prior. Decay runs on the count of intervening *task days*, not
calendar days.

**Schema-resilient**: if the migration hasn't been applied, the
columns don't exist, the query fails, and we latch
`priorEvidenceUnavailable = true` with a one-time warning. The rest
of the scan still produces a useful report.

## Database

### `trackerhistory` schema

```sql
CREATE TABLE trackerhistory (
    compno       char(4),                 -- pilot
    changed      datetime,                -- when this row was written
    flarmid      text,                    -- singular flarmid (one row per id)
    greg         char(12),                -- registration (unused by findtrackers)
    launchtime   time,                    -- written by launchlanding.ts
    method       enum(...),               -- source of this row (see below)
    -- Added by 20260510_trackerhistory_evidence.sql:
    class        char(15),                -- which class scope
    datecode     char(3),                 -- which competition day
    delta_start  smallint,                -- signed seconds, scan-crossing − official; NULL when no crossing
    delta_finish smallint,                -- same
    -- KEY idx_class_datecode_method (class, datecode, method)
);
```

`20260510_trackerhistory_evidence.sql` also added `pair_score`, `margin`
and `ddb_link`, but `20260607_trackerhistory_drop_derivable.sql` removes
them again: the prior is crossing-only and those three are recomputed
live each run (from the DDB feed and live scoring), so persisting them
only stored state that goes stale. The crossing deltas are the only
per-day evidence not derivable from another source, so they stay.

**Method values:**
- `'startmatch'` — applied by findtrackers's apply path (operator
  accepted / `--yes` / interactive).
- `'evidence'` — daily per-pair evidence row written by
  `writeEvidence`. Idempotent: DELETE-then-INSERT per (class,
  datecode). This is the multi-day fuel.
- `'startmatch-swap'` — reserved for Stage 4 swap detection.
- `'ognddb'`, `'pilot'`, `'igcfile'`, `'tltimes'`, `'soaringspot'`,
  `'grandprix'`, `'robocontrol'`, `'startline'` — other writers in
  the codebase. They carry no crossing deltas, so they contribute 0 to
  the prior (the prior is crossing-only).
- `'ogn-blocked'`, `'flarmnet-blocked'`, `'ddb-blocked'`, `'none'` —
  excluded from the prior query outright.

### Write paths in findtrackers

- **`applyProposals(className, datecode, proposals)`** — for each
  proposal: INSERT IGNORE seed `tracker` row, UPDATE `tracker.trackerid`
  with the comma-joined new value, then **one trackerhistory row per
  added flarmid** with method='startmatch' and only the crossing deltas
  (`delta_start`, `delta_finish`) — the lone bit of per-day evidence the
  next day's prior loader needs.
- **`writeEvidence(className, datecode, scoreMap, applied)`** — DELETE
  existing `method='evidence'` rows for this (class, datecode), then
  bulk INSERT one row per (compno, flarmid) pair whose live
  `score.total ≥ DEFAULT_LEDGER_MIN_NATS` (0.5) that wasn't already
  covered by a startmatch row in this run. The gate uses the full live
  total, but the row stores only the crossing deltas. Written every run,
  not just on proposal-driven changes — every clean pilot's crossings
  become tomorrow's prior fuel. (A `demoted` contender has a negative
  total, so it falls below the floor and is not written.)

Both run inside the same `mysql.transaction()`. `--dry-run` skips
both.

### Other trackerhistory writers (legacy, don't carry class/datecode)

- `bin/matchtrackers.ts` — DDB-driven offline match (method='ognddb',
  carries `greg`).
- `bin/ogn.ts` — runtime auto-match and blocked-source writes.
- `bin/soaringspot.ts`, `bin/ssscrape.ts` — scoring-source imports.
- `lib/flightprocessing/launchlanding.ts` — takeoff/landing time
  matches.

These produce rows with `class IS NULL` and `datecode IS NULL`, so
the prior loader doesn't see them. To make their rows count as priors,
they'd need to be updated to write class/datecode (not in scope here).

## CLI

```
findtrackers [--compid <id> | --all]
             [--datecode <dc>]
             [--class <cls>]
             [--tolerance <sec>]       # default 5
             [--max-gap <sec>]         # default 60
             [--reorder-window <sec>]  # default 20
             [--debug-flarmid <id>]    # repeatable
             [--debug-compno <cn>]     # repeatable
             [--dry-run | --yes]
```

### Modes

- **interactive** (default — no `--dry-run` / `--yes`): full report
  prints, then per-proposal y/n/a/q prompts via `reviewProposals`.
- **`--dry-run`**: full report only, no DB writes, no prompts. Shows
  `evidence-rows: N would be written` in the summary.
- **`--yes`**: full report, no prompts, every proposal auto-applied.

The report is **always printed** regardless of mode — score
breakdowns are useful even for clean pilots.

### Output anatomy

Per (compid, datecode) group, per class:

```
=== ${className} / ${datecode}   (compid X, YYYY-MM-DD) ===
  start scan: window N min, ... → ... with start crossings
  finish scan: ...               → ... with finish crossings

--- ${className} / ${datecode} — results ---       (only if multi-class)
  loaded N prior crossing-scores from earlier task days

  1P   Pilot Name                                 ⚠ ...flags...
       start time within ±5s of: 2B (+3s)
       flarmid: 3ECE07   Δstart: -1.0s  Δfinish: +0.0s  confidence: 1.0s   [assigned ✓]
         · 800 in-area + 30 outside (96% in-area)  |  closest 0.02 km to line  |  avg gap 1s, max 4s
         · S=4.05  margin=2.10 (p=2.10, f=2.05)  [Δs=0.80 Δf=1.00 distS=0.94 distF=0.97 presence=0.45 ddbCN=1.50 base=1.00]
       flarmid: 3EDDA2   ...

  Summary: 14 pilots, 12 matched, 1 ambiguous
```

A pair the contention guard demoted shows a negated total and a reason,
e.g. `S=−4.05 (demoted: flarmid confidently held elsewhere)` — the
flarmid is confidently assigned to another glider this run.

### Row tags (legacy + Phase 1.5 additions)

- `[assigned ✓]` — assigned + within tolerance (both lines).
- `[assigned, outside tolerance]` — both lines fired but timing
  didn't align.
- `[assigned, no finish crossing]` / `[assigned, no start crossing]` —
  Phase 2, only one side fired.
- `[assigned, start-only match]` / `[assigned, finish-only match]` —
  Phase 1.5, the one side that fired IS within tolerance.
- `[assigned, no crossings]` — Phase 2, neither line fired.
- `[assigned, all packets outside task area — wrong tracker]` —
  bboxOnly.
- `[assigned, skipped: out-of-area]` — first sighting > 150 km.
- `[match]` — unassigned, within tolerance both sides.
- `[start-only match]` / `[finish-only match]` — Phase 1.5 unassigned.

Stage 3 will replace these with score-based categories
(`[confirmed]`, `[held-from-prior]`, `[conflict]`, etc.).

## Proposal logic

`computeProposals` builds the list of `Proposal[]` from matches + score
map. Per pilot:

1. **Skip if structurally ambiguous** — concurrent-times group or
   any `m.ambiguous`. Manual review required.
2. **Skip if already-good** — any `m.assigned && m.withinTolerance`.
3. **Pick an add candidate** (in order):
   - `altMatches`: unassigned + within tolerance + non-ambiguous,
     exactly one.
   - `altSingleSided`: Phase 1.5 unassigned, where the flarmid has
     no competing claim from any other pilot (Phase 1 or Phase 1.5).
4. **Build remove set** from `assignedBad` (assigned but not
   within-tolerance) when ANY of:
   - `addId` is present (we have a replacement) — replace.
   - cross-class hit (the flarmid cleanly matches a pilot in another
     class today).
   - `bboxOnly` (flarmid was active but every packet was outside the
     task area).
   - `inBboxRatio ≤ 0.1` (overwhelmingly elsewhere).
5. **Reason string** describes the trigger.
6. **Crossing deltas** for the chosen flarmid recorded on the proposal —
   the only score context the persistence layer keeps.

Important nuance: the current logic *replaces* an existing flarmid
when a better candidate arrives (because `addId` puts everything in
`removeIds`). It does NOT propose adding alongside. To get the
"tentatively add, confirm-bad-then-remove" workflow, this would need
to be changed — see open work below.

## Operator workflow

Typical week:

1. **Day 1**: run `findtrackers --compid X` (interactive). Operator
   reviews proposals — most pilots already have correct trackers from
   matchtrackers / SoaringSpot, but unknowns get suggested
   assignments. Apply. `writeEvidence` persists today's scored pairs.
2. **Day 2+**: re-run. Prior evidence from Day 1 now contributes to
   each pair's score. Borderline cases (poor coverage, landout) get
   uplift from yesterday's clean evidence. The report shows
   `loaded N prior crossing-scores`. Auto-stable.
3. **Wrong tracker drifts in**: cross-class hits, low inBboxRatio,
   bboxOnly fire and propose removal.
4. **Multi-flarmid pilots**: handled but pair-flying triggers
   `[ambiguous]` — manual decision.

Re-running on the same day is safe:
- `writeEvidence` is DELETE+INSERT idempotent.
- `applyProposals` only fires when there's a real change (clean state
  produces no proposals on a re-run).

## Tests

`test/trackerScore.test.ts` — pure-function unit tests for the
scoring kernel. Run via:

```
npx vitest run test/trackerScore.test.ts
```

Coverage:
- Saturating signal functions (Δstart at knee, distance at 2·knee).
- Gap modulation.
- In-bbox ratio filter.
- Missing signal contributes 0.
- DDB CN vs glider weights (glider < CN).
- Margins.
- `crossingScore` (no crossing → 0, both spot-on → capped at 1/day,
  one-sided, knee boundary, linear partials).
- Decay and `summarisePrior` (single-day, multi-day accumulation,
  negative ages ignored, task-day decay).
- `contentionPenalty` (baseline-holder protection, baseline precedence
  over a higher-scoring contender, sub-threshold holder → no penalty,
  independent flarmids don't cross-penalise).

No DB-bound integration tests yet — `loadPriorEvidence`,
`applyProposals`, `writeEvidence` are exercised in the manual
end-to-end run.

## Open work

- **Update legacy writers** (matchtrackers, ogn, soaringspot,
  ssscrape, launchlanding) to set `class` + `datecode` so their rows
  count as priors. Currently invisible to the prior loader.
- **Add-then-confirm-bad workflow**: change `computeProposals` to
  propose adding rather than replacing when a new candidate arrives
  alongside an existing assignment. Pair with a stale-prior remove
  gate (assigned flarmid with no signal AND no prior > S_min for N
  task-days → propose remove) so dead ids don't accumulate.
- **Stage 3 — auto-apply category gate**: replace the
  `withinTolerance && !ambiguous` proposal logic with margin- and
  score-based categories. Tunables already in `lib/constants.ts`
  (`DEFAULT_AUTO_MARGIN_NATS`, `DEFAULT_SCORE_MIN_NATS`).
- **Stage 4 — swap detection**: Hungarian assignment over (pilots ×
  candidate flarmids) with `'startmatch-swap'` writes for both legs
  of a swap. Threshold relaxes after ≥3 prior days agree.
- **Legacy-row backfill**: derive `class` / `datecode` for pre-
  migration `trackerhistory` rows by joining `tracker.class` and
  converting `changed → datecode` via competition timezone. Gives
  multi-day prior credit to history written before the schema delta.

## Key file:line references

- `bin/findtrackers.ts:223` — `processGroup` main loop.
- `bin/findtrackers.ts:578` — `loadPriorEvidence`.
- `bin/findtrackers.ts:1117` — `computeScoreMap` (applies the contention guard).
- `bin/findtrackers.ts:1441` — `computeProposals`.
- `bin/findtrackers.ts:1699` — `applyProposals`.
- `bin/findtrackers.ts:1753` — `writeEvidence`.
- `lib/scoring/shared/findtrackers.ts:745` — `matchCrossings` (the
  three phases).
- `lib/scoring/shared/findtrackers.ts:505` — post-scan pass that
  harvests line-aware `distanceKm` from `hasCrossed`.
- `lib/scoring/shared/trackerScore.ts:128` — `scoreSignals`.
- `lib/scoring/shared/trackerScore.ts:218` — `crossingScore`.
- `lib/scoring/shared/trackerScore.ts:235` — `summarisePrior`.
- `lib/scoring/shared/trackerScore.ts:259` — `contentionPenalty`.
- `lib/constants.ts:127` — tracker-match scoring constants.
