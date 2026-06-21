// Websocket string control sentinels — sent as bare strings on the same socket
// (no protobuf). The server emits; the client matches on the exact value.
export const WS_RELOAD = 'reload'; // force a full page reload (unknown channel)
export const WS_MOVE = 'move'; // graceful handover: reconnect (client picks its own delay)
// Graceful-shutdown drain: on `move`, each client reconnects after a random
// delay in [0, CLIENT_MOVE_WINDOW_MS) ms, staggering the herd onto the new daemon.
// The departing daemon waits this long before tearing down, so it covers the
// worst-case client delay.
export const CLIENT_MOVE_WINDOW_MS = 10_000;

// How much time between packets is considered to be a display-side gap
// in the track (seconds) — at or beyond this the TripsLayer breaks the
// segment and the gap renders as a visible discontinuity. Strictly
// greater than SPLINE_DENSE_DT_S, so 21-59s gaps still render as a
// straight chord (line drawn between anchors with no Hermite-fabricated
// inner vertices, preserving track continuity at moderate FLARM
// coverage holes). Display-only — the scoring path uses its own
// segment notion.
export const gapLength = 60;

// Spline (display-side Hermite smoother) thresholds. See
// lib/flightprocessing/spline.ts.
//
// SPLINE_TANGENT_CAP_S: cap on the bracket-dt term scaling each anchor's
// velocity tangent in the Hermite curve. For bracket dt below this, the
// Hermite uses the natural `dt × v` tangent magnitude and the curve
// follows the reported bearings tightly (the "thermal looks like a
// thermal" win). For dt above this, the tangent term saturates so the
// curve can't deviate arbitrarily far from the chord — long brackets
// round their endpoints but stay close to a straight line through the
// middle. The hard segment-break (no line drawn at all) is gapLength.
// SPLINE_SUB_MIN_DT_S: brackets below this aren't subdivided. Set to
// 0.5 so 1Hz input always subdivides — anything denser is already at
// display resolution.
// SPLINE_SUB_TARGET_DT_S: target output vertex spacing. 0.5 = 2Hz output
// — drives sub-second cursor sweep on dense input. Lower for finer
// (0.2 = 5Hz, 0.1 = 10Hz).
// SPLINE_SUB_MAX: clamp on inner-vertex count per bracket. Caps the worst
// case (long coverage gaps) so memory stays bounded at SPLINE_SUB_MAX ×
// anchor count.
export const SPLINE_TANGENT_CAP_S = 20;
export const SPLINE_SUB_MIN_DT_S = 0.5;
export const SPLINE_SUB_TARGET_DT_S = 0.5;
export const SPLINE_SUB_MAX = 10;

// Display-cursor RAF interpolation (lib/react/deckgl.tsx). The imperative
// RAF loop advances a fractional epoch-seconds cursor at wall-clock rate,
// driving TripsLayer currentTime and the IconLayer pilot marker.
//
// DISPLAY_CURSOR_LAG_S: cursor sits this far behind the latest WebSocket
// update so incoming updates always land ahead of it — the advance is
// continuous; updates just shift the target forward, never the cursor.
// Bigger = smoother under jitter / late updates; smaller = less latency.
// DISPLAY_CURSOR_TICK_HZ: throttle on cursor advances per second. Each
// tick clones the time-sensitive layers and calls overlay.setProps, which
// drives a MapLibre repaint. Trade tick rate ↔ CPU/GPU load;
// DISPLAY_CURSOR_MAX_CATCHUP_S: if the cursor falls more than this far
// behind the target (tab backgrounded for a long time, first update after
// a gap), snap forward instead of grinding through wall-clock catch-up.
export const DISPLAY_CURSOR_LAG_S = 7;
export const DISPLAY_CURSOR_TICK_HZ = 5;
export const DISPLAY_CURSOR_MAX_CATCHUP_S = 30;

// How long till pilot is considered offline
export const offlineTime = 600;

export const recentTrackLength = 240; // seconds of recent track to show

// How many points to start/increase array allocation by
export const deckPointIncrement = 2000;
export const deckSegmentIncrement = 100;

// How often to refresh the 'static download' (seconds)
export const webPathBaseTimeDuration = 5 * 60;

// How many minutes of scores are we batching together
export const scoreChunkSize = 30 * 60;

// How often (seconds) to emit an interim stats update for the current open
// segment, even when no new segment has been finalised. Keeps the tooltip
// fresh during long thermals without sending stats on every tick.
export const STATS_INTERIM_INTERVAL = 30;

// ETA threshold (minutes) for promoting a class compstatus to 'F' (finishing):
// when any tracked pilot's distanceRemaining / taskSpeed implies arrival within
// this many minutes, the class is treated as imminently finishing.
export const FINISHING_ETA_MINUTES = 5;

// Thresholds for promoting a class compstatus to 'L' (launching). A single
// pilot getting airborne shouldn't flip the whole class — it could be a ferry,
// training flight, or test hop on a non-task day. Require enough of the field
// to be airborne that "the class is launching" is actually plausible.
export const LAUNCHING_TRACKED_FRACTION = 0.2; // 20% of tracked gliders
export const LAUNCHING_TOTAL_FRACTION = 0.1; // 10% of all gliders in the class

// Minimum tracker coverage (fraction of pilots in the class with a real,
// non-'unknown'/'blocked' tracker) before OGN evidence alone — without the
// official scorer finalising everyone — is allowed to widen allowFrom and
// recover a class stuck at B/G into H.
export const HOME_OGN_COVERAGE = 0.5;

// Cushion (seconds) before the scoring in-order generator emits a packet as
// "live". Lower means scoring sees data sooner; reorders within this window
// are absorbed without triggering a rescore.
export const inorderAdditionalDelay = 7;

// Cushion (seconds) for the display-path emit in aprs.ts processMessageQueue:
// packets with t < realNow - aprsAdditionalDelay are eligible for emission to
// the per-class BroadcastChannel that feeds the websocket. Larger values
// recover more late-arriving packets at the cost of fresher tracks.
export const aprsAdditionalDelay = 15;

// trackGlider coalescing window: each new glider registration arms (or
// re-arms) a setTimeout. After this many ms of quiet, flushLoads runs a
// single loadPointsForIds across the union of every queued glider's
// flarmIds and dispatches the yielded records to per-glider queues.
export const PENDING_LOAD_DEBOUNCE_MS = 250;

// How far beyond the finite extent of a start line a near-miss is accepted (metres)
export const RELAXED_START_TOLERANCE_M = 1500;

// Grid resolution for AAT optimal direction heatmap (cells per axis)
export const OPTIMAL_GRID_SIZE = 25;

// Flat-array layout for optimal grid cells: [lng, lat, taskDist, prevLng, prevLat, nextLng, nextLat, ...]
export const GRID = {
    STRIDE: 7,
    LNG: 0,
    LAT: 1,
    TASK_DIST: 2,
    PREV_LNG: 3,
    PREV_LAT: 4,
    NEXT_LNG: 5,
    NEXT_LAT: 6
} as const;

export const MAX_FLARM_DIST_KM = 150; // first sighting >150 km from the relevant TP → skip
export const DEFAULT_MAX_GAP_SEC = 60; // don't run hasCrossed across a coverage gap (override via opts.maxGapSec)
export const DEFAULT_REORDER_WINDOW_SEC = 20; // per-flarmid sliding reorder buffer (override via opts.reorderWindowSec)
export const DEFAULT_TOLERANCE_SEC = 5;

// ---- Tracker-match scoring (findtrackers ambiguity model) ---------------
// Saturating-knee parameters for per-day signal extraction. Positive signals
// produce s ∈ [0,1] then are multiplied by their nat weight; the two negative
// signals (negStart, negFinish) produce s ∈ [-1,0] and are modulated by gap
// coverage quality. See plans/the-outside-tolerance-is-recursive-barto.md.
//
// Scale factor for the wrong-time-crossing strand of negStart/negFinish.
// The signal saturates (reaches -1) at |Δ| = (1 + WRONG_CROSS_SCALE) × T_tol.
// At scale=5: fully negative at |Δ|=30s; larger deltas stay at -1.
export const WRONG_CROSS_SCALE = 5;

// Distance from the bracketing segment to the actual line/sector at which
// the distAtStart/distAtFinish signal still gives full credit; credit decays
// linearly to zero at 2× this value. Assumes the underlying distance is
// already line/sector-aware (PreparedTurnpoint.hasCrossed() returning the
// segment closest-approach when ev=false).
export const DEFAULT_DIST_TOLERANCE_KM = 0.3;

// Half-life (seconds) of distance-signal trust w.r.t. the bracketing-packet
// gap at the official time. distance contribution × 1/(1 + gap/T_gap).
export const DEFAULT_GAP_MODULATION_SEC = 30;

// In-bbox packet count at which the presence signal saturates.
export const DEFAULT_INBBOX_FULL_COUNT = 200;

// Minimum inBboxPackets / (inBboxPackets + bboxRejectedPackets) for a
// flarmid to be a candidate at all. Below this it's a different comp's
// traffic that drifted into our bbox briefly.
export const DEFAULT_INBBOX_MIN_RATIO = 0.3;

// The prior carries ONLY start/finish line-crossing evidence (nothing
// derivable from ddb / the flarm_* identity tables, which are recomputed live).
// Each task day contributes at most this many nats so a single shaky day can
// never dominate, and the running total is capped at ±MAX_TOTAL_PRIOR_NATS so
// many confirmed days don't drown out the current day's live signals.
// No decay: tracker-to-glider mapping doesn't degrade over time, so old
// confirmed evidence is as valid as recent.
export const MAX_PRIOR_PER_DAY_NATS = 1.0;
export const MAX_TOTAL_PRIOR_NATS = 3.0;
// A flarmid is treated as "confidently held" by a glider once that glider's
// total score clears this. A weaker contender for the same flarmid then has its
// (prior + current) score negated, so a poor match can't displace a likely-good
// one. See `contentionPenalty` in lib/scoring/shared/trackerScore.ts.
export const PRIOR_PROTECT_NATS = 3.0;

// Auto-apply gates (nats — natural log-LR units).
export const DEFAULT_AUTO_MARGIN_NATS = 2.0; // min two-sided margin for auto-apply
export const DEFAULT_SWAP_MARGIN_NATS = 3.0; // min net-gain for an auto-applied swap
export const DEFAULT_SCORE_MIN_NATS = 0.8; // absolute floor below which we never auto-apply
export const DEFAULT_LEDGER_MIN_NATS = 0.5; // S_min for writing an evidence row to trackerhistory

// Proposal gate: a candidate pair is proposed only when its post-demotion total
// clears this floor AND, when either side is contested, its two-sided margin
// clears DEFAULT_AUTO_MARGIN_NATS. Same gate for interactive and --yes.
// Calibration: a clean both-sided match (Δs=−1s, Δf=0s, saturated presence,
// pre-launch sighting) totals ≈0.80+1.00+0.48+0.30 = 2.58 without DDB — proposes.
// A start-only landout with zero corroboration (≈1.58) stays manual until ddbCN
// (+1.5) or a day of prior (+~1.0) lifts it. ddbCN+presence with no crossing at
// all (≈1.98) stays just below the floor: identity alone can't propose.
export const SCORE_PROPOSE_NATS = 2.0;

// Multiplier applied to the Δstart/Δfinish supports on rows the scan flagged
// `ambiguous` (multiple within-tolerance candidates, or a concurrent-times
// group): a matching time is weaker evidence when it matches several pilots.
export const AMBIGUOUS_DELTA_FACTOR = 0.8;

// Per-signal nat weights. Sum of available signals × saturating function
// produces pair_score; auto-apply compares pair_scores via the margin gates
// above. Tuneable as a single object so flag overrides hit one place.
export const TRACKER_SCORE_WEIGHTS = {
    deltaStart: 1.0,
    deltaFinish: 1.0,
    distAtStart: 0.5, // modulated by gap@start; zeroed when a within-tolerance start crossing already carries the evidence
    distAtFinish: 0.5, // modulated by gap@finish; zeroed when a within-tolerance finish crossing already carries the evidence
    inBbox: 0.5, // multiplied by inBboxRatio
    preLaunch: 0.3, // firstSeen ≥ 30 min before earliest pilot start
    ddbCn: 1.5,
    ddbGlider: 0.3, // weak — many pilots in a comp share a glider type, so this just rules out wildly mismatched gliders
    baseline: 1.0, // flarmid in current tracker.trackerid for (class, compno); suppressed when the assignment was auto-sourced from ognddb (double-counts ddbCn)

    // Negative evidence: wrong-time crossing (tracker seen crossing at the wrong pilot's time)
    // or confirmed positional absence (tracker far from line with good coverage). Both strands
    // are unified into one signal per side; the stronger strand wins (Math.max) to avoid double-count.
    negCross: 0.5, // weight applied to negStart and negFinish

    prior: 1.0, // already in nats; sum of decayed per-day crossing scores (may be negative with the new schema); capped at ±MAX_PRIOR_PER_DAY_NATS/day
    // ---- Cross-competition identity evidence (lib/scoring/shared/identity.ts) ----
    // Identity evidence from OTHER competitions (the current comp is excluded —
    // within-comp continuity is `prior`). `xcEvidenceScore` blends the per-facet
    // signals below into one `identityNats` for each prior comp, scales it by
    // that comp's physical-match confidence and its age, takes the single best
    // comp, and feeds the result back as one number weighted by `xc`. The seven
    // `xc*` below are therefore facet IMPORTANCES (consumed by identity.ts), not
    // independent breakdown lines. greg/fai/name discriminate; the rest nudge.
    xcGreg: 1.5, // candidate greg == aircraft greg, or flarmid is its permanent ICAO address — strongest
    xcFai: 1.2, // candidate real-FAI == a prior pilot clue's FAI — precise public id
    xcName: 1.2, // best privacy-preserving name-token overlap [0,1] — same crew flying again
    xcGlider: 0.4, // candidate glider key == aircraft glider key — many share a type
    xcClub: 0.4, // candidate club hash == a prior pilot clue's club hash — clubs are shared
    xcCompno: 0.3, // candidate compno == aircraft compno — usually consistent but not unique
    xcCountry: 0.2, // candidate country == aircraft country — huge equivalence class, mild corroboration
    xc: 1.0 // overall weight applied to the single confidence-scaled xcEvidenceScore nats
} as const;

// Real FAI ranking ids are below this; synthetic placeholders (assigned
// before name resolution) are >= FAI_SYNTHETIC_FLOOR (3,000,000). Only a real
// id is worth storing/matching as cross-comp identity evidence.
export const FAI_REAL_MAX = 300000;

// Cross-comp identity evidence is forgotten if not reconfirmed within this many
// months. last_seen is bumped on every confident re-collection; rows older than
// this are excluded at scoring time and periodically purged by findtrackers.
export const IDENTITY_EXPIRY_MONTHS = 18;

// Exponential decay timescale (months) for cross-comp identity evidence within
// the retention window: contribution × exp(-ageMonths / IDENTITY_DECAY_MONTHS).
// 9 → an 18-month-old match (the expiry edge) is already down to ~e^-2 ≈ 0.14.
export const IDENTITY_DECAY_MONTHS = 9;

// Stored physical-track match_score (nats) at which a prior comp's evidence is
// trusted at full strength: confidence = saturate(match_score / this). A clean
// both-sided match (~4–5 nats) saturates; a shaky start-only one (~2.4 nats)
// is discounted to ~0.8 — weaker historical matches contribute proportionally less.
export const IDENTITY_CONF_FULL_NATS = 3;

// Generic placeholder / team tokens stripped during name tokenisation
// (lib/scoring/shared/identity.ts). A "name" like "Team A" reduces to no
// usable tokens — it can't identify a person, so it contributes no name
// evidence. Real shared crews ("Smith / Jones", "Buddy & Claude") still keep
// both pilots' tokens.
export const NAME_STOPWORDS = new Set(['team', 'syndicate', 'group', 'club', 'the', 'and', 'crew', 'flying']);
