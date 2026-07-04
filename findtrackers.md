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
  prompts, write paths. Database-bound code lives here.
- `lib/scoring/shared/findtrackers.ts` — scan + match: reads APRS
  point log, runs `hasCrossed` on consecutive packets, produces
  `TrackerMatch[]` with `TrackerDiag` for each candidate pair.
- `lib/scoring/shared/trackerScore.ts` — pure scoring kernel:
  `scoreSignals`, `computeMargins`, `decayPrior`, `crossingScore`,
  `summarisePrior`, `contentionPenalty`, `pilotContentionPenalty`,
  `applyContentionPenalties`, `twinPilotSupport`, `physicalMatchScore`.
  No I/O. Unit-tested in `test/trackerScore.test.ts`.
- `lib/scoring/shared/proposals.ts` — pure proposal generation:
  `computeProposals` (score/margin-gated), `Proposal`, `ScoreMap` /
  `ScoredPair`, `CrossClassHit` / `CrossClassMap`, cross-class conflict
  helpers, `parseCurrentIds`, `scoreKey`. Also the same-flight join
  post-processing (`liftSameFlightDemotions`,
  `applyPathSimilarityToProposals`). No I/O. Unit-tested in
  `test/computeProposals.test.ts`.
- `lib/scoring/shared/pathSimilarity.ts` — same-flight detection: a
  two-phase track-shape comparison (`runPathComparison`) that decides
  whether two flarmids on one pilot are the same physical flight, the
  prior-evidence veto policy (`resolveSameFlight`), the canonical pair
  key (`pathPriorKey`), and the report formatter (`formatPathSimilarity`,
  returns lines — no I/O). Leaf module: no dependency on `proposals.ts`.
  Unit-tested in `test/pathSimilarity.test.ts`.
- `lib/flightprocessing/trackshape.ts` — the shape primitive
  `pathSimilarity.ts` builds on: `loadStream` (reads the binary APRS
  point log via `loadPointsForIds` — same source as the crossing scan)
  and `compareShapes` (altitude cross-correlation lag estimate +
  piecewise-linear position comparison → a classified `ShapeReport`).
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
- `conf/sql/migrations/20260620_trackerhistory_paths.sql` — new
  `trackerhistory_paths` table holding per-(compno, pair) same-flight
  evidence (see Database below).
- `conf/sql/onglide_schema.sql` — canonical schema includes all of the
  above, including `trackerhistory_paths`.

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
twin-pilot evidence →  TwinClassEvidence   (group-level: same compno+name
                                            in another class of this comp
                                            — their assignment + raw
                                            crossing deltas there)
        │
        ▼
computeScoreMap     →  ScoreMap            (per pair: ScoreBreakdown,
                                            two-sided margins, contested
                                            flags, deltas, demoted flag +
                                            reason; applies both
                                            contention guards)
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

`processGroup` runs the group in passes: **1a** scan + load per class
(results, matches, prior, identity — no scoring yet); **1b** group-level
maps — task twins (`loadTaskTwins`), twin-pilot evidence (same
compno+name in another class: their `trackerid` assignment plus that
class's raw crossing deltas), and the differing-task warning set;
**1c** `computeScoreMap` per class with the twin evidence in place;
**1d** path similarity — for any pilot with ≥2 within-tolerance
ambiguous candidates, compare the track shapes and (subject to the
prior-evidence veto) lift the pilot-side demotion so the pair can be
*joined* rather than one demoted (see Same-flight detection below);
**2** the cross-class map (built from scored pairs, display/conflict
only); **3** per-class report, proposals, writes. Twin evidence is
deliberately built from *raw* scan output and the trackerid column in
1b, never from another class's scored total — `CrossClassHit.score`
contains the twin contribution, but it only feeds display and removal
conflicts, so the signal can't feed back on itself.

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
- **Two units, same flight (one aircraft, two trackers)**: both rows →
  both `ambiguous`. Pass 1d compares the track shapes; a `same_flight`
  verdict (not vetoed by prior history) *joins* both ids into the
  assignment instead of demoting the weaker one. See Same-flight
  detection below.
- **Two units, genuinely different flights** (or the comparison can't
  decide): the pilot-side contention guard demotes the weaker claim as
  normal — no join.
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
| Δstart | `TrackerMatch.deltaStart` | `max(0, 1 − \|Δ\|/T_tol)` × 0.8 when the row is `ambiguous` | 1.0 |
| Δfinish | `TrackerMatch.deltaFinish` | same | 1.0 |
| distAtStart | `TrackerDiag.distAtStartKm` (line/sector-aware), modulated by `gapAroundStartSec` | `max(0, 1 − distKm/D_tol) · 1/(1 + gap/T_gap)`; **zeroed when a within-tolerance start crossing exists** (the Δ signal already carries it) | 0.5 |
| distAtFinish | same | analogous, with the same within-tolerance-crossing gate on the finish side | 0.5 |
| in-area presence | `inBboxPackets` AND `bboxRejectedPackets` | `min(1, inBbox/N_full) · inBboxRatio` | 0.5 |
| pre-launch sighting | `firstSeenT` vs earliest pilot start | `1` if firstSeen ≤ earliestStart − 30 min | 0.3 |
| DDB CN match | `ddb.cn == pilot.compno` (case-insensitive) | indicator | 1.5 |
| DDB glider match | `gliderEquivalent(ddb.aircraft_model, pilot.glidertype)` | indicator | 0.3 (weak) |
| operator baseline | flarmid in current `tracker.trackerid` | indicator | 1.0 |
| twin pilot | same compno + same pilot name (`samePilotName` token-set match) in another class of this comp | `twinPilotSupport`: max over classes of `min(1, 0.5·assignedThere + crossingScore(rawΔs, rawΔf))` | 1.0 |
| prior | persisted prior days' start/finish crossings, capped ≤1/day, decayed | `Σ crossingScore · exp(−daysAgo/τ)` | 1.0 (already in nats) |

The dist signals' job is the coverage-gap case — the glider was seen
near the line but no clean crossing was detected. When a
within-tolerance crossing *was* found on that side, the distance would
just restate it (the segment crosses the line, dist ≈ 0 km), so it is
zeroed to avoid double-counting. The `ambiguous` ×0.8 factor
(`AMBIGUOUS_DELTA_FACTOR`) reflects that a matching time discriminates
less when it matches several pilots; the structural ambiguity itself is
resolved by margins and the contention guards, not by this factor.

The twin-pilot signal is excluded from `physicalMatchScore` (it is
identity-derived, and physical confidence is what gets stored as
cross-comp evidence) and from the within-comp prior (`crossingScore` is
crossing-only).

Defaults (lib/constants.ts):
- `T_tol = 5 s` (`DEFAULT_TOLERANCE_SEC`)
- `D_tol = 0.3 km` (`DEFAULT_DIST_TOLERANCE_KM`)
- `T_gap = 30 s` (`DEFAULT_GAP_MODULATION_SEC`)
- `N_full = 200` (`DEFAULT_INBBOX_FULL_COUNT`)
- `τ = 4 task-days` (`DEFAULT_PRIOR_DECAY_DAYS`)
- `inBboxRatio < 0.3` excludes a flarmid from the candidate set
  (`DEFAULT_INBBOX_MIN_RATIO`) — mostly-elsewhere traffic that drifted
  briefly into our bbox.
- `SCORE_PROPOSE_NATS = 2.0` — absolute proposal floor.
- `AMBIGUOUS_DELTA_FACTOR = 0.8` — Δ downgrade on ambiguous rows.

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
`distAtStart` in `signalsFromMatch`, drops the start term from the
prior's `crossingScore`, and nulls the start delta in any twin-pilot
evidence sourced from that class — all contribute 0, leaving the finish
crossing (plus presence, DDB, prior, xc) to do the discriminating. The report
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

### Contention guards (two-sided)

Two mirrored penalties run inside `computeScoreMap` **before** margins,
so the negation flows through to the two-sided margins. Their job is to
stop a poor match from displacing a likely-good one:

- **Flarm side** — `contentionPenalty`: for each flarmid with more than
  one candidate, the **holder** is the operator-baseline pair if its
  total clears `PRIOR_PROTECT_NATS = 3.0`, otherwise this run's
  highest-scoring pair if *that* clears the threshold (baseline takes
  precedence, so an existing good assignment is protected even when a
  contender scores higher). If neither clears, nobody is penalised.
  Every **other** glider competing for that flarmid has its whole
  (prior + current) total negated — `total → −total`.
- **Pilot side** — `pilotContentionPenalty`: the mirror image. Once a
  pilot confidently holds one flarmid (same baseline-then-best holder
  rule), the pilot's claims on *other* flarmids are negated — so a
  flarmid that happens to match their times doesn't block its rightful
  claimant's margin. Baseline rows are never penalised: a multi-unit
  pilot's second assigned id is the operator's statement, not a
  competing claim.

`applyContentionPenalties` computes both sets from the **same
pre-penalty totals**, unions them, and negates each pair once — the
result is independent of application order and cannot oscillate. The
pair is flagged `demoted` with a `demotedReason` (`flarm` / `pilot` /
`both`) and rendered as e.g. `S=−4.05 (demoted: flarmid confidently
held elsewhere)` or `(demoted: pilot confidently holds another
flarmid)`. Because the total is now negative it falls below the ledger
floor and the proposal gate, so a demoted contender is neither written
as evidence nor ever proposed.

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

## Same-flight detection (path similarity)

Crossing times can't tell two units in *one* aircraft apart from two
units in *two* aircraft that happened to start/finish together — both
produce two ambiguous Phase-1 rows for the same compno. The contention
guard's default is to demote the weaker claim. That's wrong when the two
trackers are the same flight: the right answer is to **join** both ids
into the assignment (`trackerid = "A,B"`), not discard one.

Pass 1d resolves this by comparing the two tracks' *shapes*, not just
their line-crossing times.

### Selection

Per class, collect compnos with **≥2 within-tolerance ambiguous**
candidates. The ≥2 filter matters: the `ambiguous` flag also fires for
"one flarmid, multiple pilots", but there each pilot has only a single
candidate, so they drop out here. For ≥3 candidates only the top two by
score are compared (a `⚠` is logged); a 3-tracker join is out of scope.

### Two-phase comparison

`runPathComparison(a, b, since, until, quickUntil)` in
`lib/scoring/shared/pathSimilarity.ts`:

1. Load both full tracks via `loadStream` over `[minStart − 2h,
   maxFinish + 1h]` — the binary APRS log, the same source the crossing
   scan reads, so if the scan found crossings the data is present.
2. **Quick phase** — if the pilot has ≥120 s of pre-start track on both
   ids, compare only the pre-start slice (`quickUntil = startUtc`). A
   solid `different_flight` here **aborts early** (`abortedAfterQuick`)
   without comparing the rest of the day.
3. **Full phase** — otherwise compare the whole window.

`compareShapes` (in `trackshape.ts`) estimates the lag between the two
streams by altitude cross-correlation (±120 s — covers clock skew and
any anti-cheat delay), aligns on it, then classifies the
piecewise-linear position/altitude deltas. Its `ShapeClassificationKind`
maps to a `SameFlightKind` via `classifyKind`:

- `matching`, `consistent_offset` → **`same_flight`**
- `very_different`, `diverged_abrupt`, `diverged_slow`,
  `alignment_failed` → **`different_flight`**
- `insufficient_overlap` → **`insufficient_data`**

### Prior-evidence veto

`resolveSameFlight(sim, prior)` combines today's verdict with prior days'
history from `trackerhistory_paths`. A same-day `same_flight` auto-joins
**unless** prior history strongly disagrees — `≥2` prior days
`different_flight` **and** `0` days `same_flight` — in which case it is
downgraded to a **flag** (`⚑`): the demotion stands, nothing is
auto-joined, and the report asks for manual review. A single prior
`same_flight` day defeats the veto. The threshold is the one constant
`PRIOR_VETO_MIN_DIFFERENT_DAYS = 2`. `resolveSameFlight` is the single
source of the join/flag/none decision — the demotion-lift, the proposal
join, and the display all call it, so they can't disagree.

### Effect on scoring and proposals

- `liftSameFlightDemotions` (proposals.ts) — for a `join` verdict,
  restores the negated total (`Math.abs`, valid because the pre-penalty
  total is ≥0 and contention negates it exactly once) and clears
  `demoted` — but **only** for `demotedReason === 'pilot'`. A `flarm` /
  `both` demotion means a *different pilot* confidently holds that
  flarmid; path similarity between one pilot's two trackers can't speak
  to that, so it's left intact.
- `applyPathSimilarityToProposals` (proposals.ts, runs after
  `computeProposals`) — widens or creates the join proposal so both ids
  are in `addedIds` / `newTrackerid`. If a proposal already exists it
  drops the joined ids from `removedIds` (so the proposal stays
  consistent with `newTrackerid`); if either id is being **displaced** to
  another pilot it leaves the proposal alone (a real conflict path
  similarity can't resolve).

**Tracker order / primary.** The first id in `trackerid` is the primary
stream downstream (`aprs.ts` `pickStickyPrimary`; secondaries only
gap-fill). A freshly-created join lists the higher-scored id first. When
*widening* an existing proposal the incumbent assigned id stays first and
the joined id is appended — consistent with `computeProposals`' own
"kept ids first, additions last" convention, and deliberately so:
re-ordering would change the authoritative device for an already-live
pilot.

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

### `trackerhistory_paths` schema (same-flight evidence)

Full DDL in `conf/sql/migrations/20260620_trackerhistory_paths.sql` (and
the canonical `onglide_schema.sql`). Separate from `trackerhistory`
because path similarity is a record about a **pair** of flarmids, not a
single one — `(compno, class, datecode, flarmid_a, flarmid_b)` plus the
`ShapeReport` summary (`kind`, classification, p95 position, alt bias,
lag, overlap, `aborted_after_quick`).

The pair is stored in **canonical order** (`flarmid_a < flarmid_b` by
ASCII, via `pathPriorKey`) so `(A,B)` and `(B,A)` map to one row; the
`uq_path` UNIQUE KEY lets `writePathSimilarityEvidence` upsert (INSERT …
ON DUPLICATE KEY UPDATE) on every re-run without accumulating duplicates.

- **`writePathSimilarityEvidence`** — one upserted row per compared pair
  (all kinds, including `insufficient_data`). Runs after `writeEvidence`,
  in its own transaction; `--dry-run` skips it.
- **`loadPriorPathSimilarity(datecode, className)`** — reads prior days'
  rows for this class (`datecode <> today`), counting `same_flight` vs
  `different_flight` days per `(compno, pair)` for the veto. Only those
  two kinds count; `insufficient_data` is ignored.

**Schema-resilient** like the prior loader: a missing table latches
`pathEvidenceUnavailable` with a one-time warning and the feature
no-ops — the rest of the scan still runs. Apply
`20260620_trackerhistory_paths.sql` to enable.

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

A pair a contention guard demoted shows a negated total and the side
that demoted it, e.g. `S=−4.05 (demoted: flarmid confidently held
elsewhere)` or `(demoted: pilot confidently holds another flarmid)`.
Twin-pilot contributions render as `twin=1.00` in the contribs list.
When a same-compno+name pilot appears in another class whose task
differs, the class block opens with a one-line `⚠ … also appears in
class X with a different task` warning.

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

The tags describe what the scan saw; the proposal decision itself is
purely score/margin-driven (below).

## Proposal logic

`computeProposals` (lib/scoring/shared/proposals.ts) builds the
`Proposal[]` from matches + score map. The gate is **purely numeric** —
every condition the old categorical gates encoded (within-tolerance,
one-sidedness, competing claims, ambiguity) is already reflected in the
post-demotion totals and margins. The same gate feeds interactive
review and `--yes`. Per pilot:

1. **Assigned-good skip** — any assigned, non-demoted pair with
   `total ≥ SCORE_PROPOSE_NATS` means the operator's choice stands;
   the pilot is left alone even if a higher-scoring alternative exists.
2. **Add candidate** — argmax post-demotion total over the pilot's
   unassigned, non-demoted pairs. Proposed only when
   `total ≥ SCORE_PROPOSE_NATS = 2.0` AND, if either side is contested,
   `margin ≥ DEFAULT_AUTO_MARGIN_NATS = 2.0`. A demoted pair (negative
   total) can never be proposed; a tie is contested with margin ≤ 0, so
   it can never sneak through. Ambiguous rows are NOT skipped — the
   ×0.8 Δ downgrade plus margins do the work.
3. **Remove set** — removal needs *positive* evidence the assigned id
   is wrong (low score alone can be poor coverage, a DNF, or a
   no-finish landout). Triggers: a replacement candidate (`addId`), a
   conflicting cross-class hit, `bboxOnly`, or `inBboxRatio ≤ 0.1`.
   Each trigger is score-guarded: never remove an assigned pair whose
   total ≥ the replacement's total (or ≥ the floor when there's no
   replacement). Same-compno hits to a task-twin class, and
   same-compno+`samePilotName` hits to ANY class of the comp, are
   corroboration (twin-pilot entries), not conflicts.
4. **Reason string** states the scores (`associate: S=3.42
   margin=2.61`, `replace: S=3.42 uncontested > S(F1)=0.61`), annotated
   with cross-class lines for removed ids.
5. **Crossing deltas** for the chosen flarmid recorded on the proposal —
   the only score context the persistence layer keeps.

SCORE_PROPOSE_NATS calibration: a clean both-sided match (Δs=−1s,
Δf=0s, saturated presence, pre-launch) totals ≈2.58 without DDB —
proposes. A start-only landout with zero corroboration (≈1.58) stays
manual until ddbCN (+1.5), a day of prior (+~1.0), or a twin-pilot link
lifts it. ddbCN + presence with no crossing at all (≈1.98) stays just
below the floor — identity alone can't propose.

Important nuance: the logic *replaces* an existing flarmid when a
better candidate arrives (because `addId` triggers removal of weaker
assigned ids). It does NOT propose adding alongside — **except** for the
same-flight join (Pass 1d / `applyPathSimilarityToProposals`), which is
the one path that keeps both ids. For the general "tentatively add,
confirm-bad-then-remove" workflow on *different*-flight candidates, this
would still need changing — see open work below.

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
4. **Multi-flarmid pilots / pair-flying**: ambiguous rows score with
   the ×0.8 Δ downgrade and compete normally; thin margins simply
   produce no proposal, while a claimant whose competitor is already
   confidently held elsewhere recovers its margin via the pilot-side
   contention guard.

Re-running on the same day is safe:
- `writeEvidence` is DELETE+INSERT idempotent.
- `applyProposals` only fires when there's a real change (clean state
  produces no proposals on a re-run).

## Tests

`test/trackerScore.test.ts` (scoring kernel),
`test/computeProposals.test.ts` (proposal gate), and
`test/pathSimilarity.test.ts` (same-flight helpers) — pure-function
unit tests. Run via:

```
npx vitest run test/trackerScore.test.ts test/computeProposals.test.ts test/pathSimilarity.test.ts
```

Kernel coverage:
- Saturating signal functions (Δstart at knee, distance at 2·knee).
- Gap modulation; within-tolerance-crossing gates on BOTH dist signals.
- Ambiguity ×0.8 on Δ only (default-off identical to unflagged).
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
- `pilotContentionPenalty` (mirror cases, plus: a multi-unit pilot's
  second baseline id is never penalised).
- `applyContentionPenalties` (union with per-key reasons, computed from
  pre-penalty totals, deterministic).
- `twinPilotSupport` (assigned-only 0.5, crossing saturates, capped,
  best-of-classes not sum).
- `physicalMatchScore` excludes prior/baseline/ddb/xc/twin.

Proposal coverage:
- Demoted candidate never proposed (the landout-pilot regression that
  motivated the score-driven rewrite).
- Absolute floor and contested-margin gates.
- Ambiguous rows propose when score + margin clear.
- Assigned-good skip; replacement; strong-negative removal triggers
  with the score guard; multi-id removal preserves the other id.
- Same-compno+name cross-class hit is corroboration, not a conflict.

Path-similarity coverage (`test/pathSimilarity.test.ts`):
- `sliceStream` time-range filter (inclusive bounds, empty/full spans).
- `classifyKind` maps every `ShapeClassificationKind` to the right
  `SameFlightKind`.
- `resolveSameFlight` veto policy: no prior → join; `≥2` different /
  `0` same → flag; one prior same day defeats the veto; a single
  different day is below threshold; `different_flight` /
  `insufficient_data` → none regardless of prior.

No DB-bound integration tests yet — `loadPriorEvidence`,
`loadPriorPathSimilarity`, `applyProposals`, `writeEvidence`,
`writePathSimilarityEvidence`, and `compareShapes` over real tracks are
exercised in the manual end-to-end run.

## Open work

- **Update legacy writers** (matchtrackers, ogn, soaringspot,
  ssscrape, launchlanding) to set `class` + `datecode` so their rows
  count as priors. Currently invisible to the prior loader.
- **Add-then-confirm-bad workflow**: change `computeProposals` to
  propose adding rather than replacing when a new candidate arrives
  alongside an existing assignment. Pair with a stale-prior remove
  gate (assigned flarmid with no signal AND no prior > S_min for N
  task-days → propose remove) so dead ids don't accumulate.
- **Threshold watch after the dist re-weighting**: totals dropped by up
  to ~1.0 for pairs that previously double-counted a within-tolerance
  finish (distF). The evidence-ledger floor (0.5) now drops distF-only
  weak pairs (good), `isGoodMatch`'s identity gate is effectively
  slightly stricter, and a clean assigned match without ddbCN
  (≈3.58) still clears `PRIOR_PROTECT_NATS = 3.0` but sparse-presence
  cases may not — watch before retuning.
- **≥3-tracker joins**: Pass 1d only compares the top two candidates by
  score; a pilot flying three units that are all one flight won't fully
  join. Would need all-pairs comparison + union-find over `same_flight`
  edges, one join per connected component.
- **Stage 4 — swap detection**: Hungarian assignment over (pilots ×
  candidate flarmids) with `'startmatch-swap'` writes for both legs
  of a swap. Threshold relaxes after ≥3 prior days agree.
- **Legacy-row backfill**: derive `class` / `datecode` for pre-
  migration `trackerhistory` rows by joining `tracker.class` and
  converting `changed → datecode` via competition timezone. Gives
  multi-day prior credit to history written before the schema delta.

## Key file:line references

- `bin/findtrackers.ts:221` — `processGroup` main loop (passes 1a/1b/1c/2/3).
- `bin/findtrackers.ts:635` — `loadPriorEvidence`.
- `bin/findtrackers.ts:1152` — `computeScoreMap` (applies both contention guards).
- `bin/findtrackers.ts:377` — Pass 1d: path-similarity orchestration
  (selection, window, `runPathComparison` fan-out, `liftSameFlightDemotions`).
- `bin/findtrackers.ts:1540` — `applyProposals`.
- `bin/findtrackers.ts:1594` — `writeEvidence`.
- `bin/findtrackers.ts:1987` — `loadPriorPathSimilarity`.
- `bin/findtrackers.ts:2017` — `writePathSimilarityEvidence`.
- `lib/scoring/shared/proposals.ts:133` — `computeProposals` (score/margin gate).
- `lib/scoring/shared/proposals.ts:338` — `liftSameFlightDemotions`.
- `lib/scoring/shared/proposals.ts:358` — `applyPathSimilarityToProposals`.
- `lib/scoring/shared/pathSimilarity.ts:67` — `runPathComparison` (two-phase).
- `lib/scoring/shared/pathSimilarity.ts:134` — `resolveSameFlight` (prior veto).
- `lib/scoring/shared/pathSimilarity.ts:154` — `formatPathSimilarity` (report lines).
- `lib/flightprocessing/trackshape.ts:123` — `loadStream`.
- `lib/flightprocessing/trackshape.ts:492` — `compareShapes`.
- `lib/scoring/shared/findtrackers.ts:746` — `matchCrossings` (the
  three phases).
- `lib/scoring/shared/findtrackers.ts:505` — post-scan pass that
  harvests line-aware `distanceKm` from `hasCrossed`.
- `lib/scoring/shared/trackerScore.ts:145` — `scoreSignals`.
- `lib/scoring/shared/trackerScore.ts:243` — `crossingScore`.
- `lib/scoring/shared/trackerScore.ts:269` — `twinPilotSupport`.
- `lib/scoring/shared/trackerScore.ts:289` — `summarisePrior`.
- `lib/scoring/shared/trackerScore.ts:313` — `contentionPenalty`.
- `lib/scoring/shared/trackerScore.ts:348` — `pilotContentionPenalty`.
- `lib/scoring/shared/trackerScore.ts:381` — `applyContentionPenalties`.
- `lib/constants.ts:137` — tracker-match scoring constants.
