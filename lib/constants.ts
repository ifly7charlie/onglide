// How much time between packets is considered to be a gap in the track (seconds)
export const gapLength = 60;

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
export const inorderAdditionalDelay = 2;

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
// Saturating-knee parameters for per-day signal extraction. Each signal
// produces s ∈ [0,1] then is multiplied by its nat weight; missing signals
// contribute 0 (never negative). See plans/the-outside-tolerance-is-recursive-barto.md.

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

// Decay timescale (days) for prior-day pair_score contributions when
// summing within-comp history.
export const DEFAULT_PRIOR_DECAY_DAYS = 4;

// Auto-apply gates (nats — natural log-LR units).
export const DEFAULT_AUTO_MARGIN_NATS = 2.0; // min two-sided margin for auto-apply
export const DEFAULT_SWAP_MARGIN_NATS = 3.0; // min net-gain for an auto-applied swap
export const DEFAULT_SCORE_MIN_NATS = 0.8; // absolute floor below which we never auto-apply
export const DEFAULT_LEDGER_MIN_NATS = 0.5; // S_min for writing an evidence row to trackerhistory
// Weight assigned to a prior trackerhistory row that doesn't carry its own
// pair_score (typically a legacy 'ognddb' / 'pilot' / 'startline' row from
// before the score columns existed). Treated as a fixed positive prior so
// past operator/system confirmations still influence today's score; lower
// than a typical scored day to reflect the missing context.
export const LEGACY_PRIOR_NATS = 1.0;

// Per-signal nat weights. Sum of available signals × saturating function
// produces pair_score; auto-apply compares pair_scores via the margin gates
// above. Tuneable as a single object so flag overrides hit one place.
export const TRACKER_SCORE_WEIGHTS = {
    deltaStart: 1.0,
    deltaFinish: 1.0,
    distAtStart: 1.0, // modulated by gap@start
    distAtFinish: 1.0, // modulated by gap@finish
    inBbox: 0.5, // multiplied by inBboxRatio
    preLaunch: 0.3, // firstSeen ≥ 30 min before earliest pilot start
    ddbCn: 1.5,
    ddbGlider: 0.3, // weak — many pilots in a comp share a glider type, so this just rules out wildly mismatched gliders
    baseline: 1.0, // flarmid in current tracker.trackerid for (class, compno)
    prior: 1.0 // already in nats; sum of decayed prior-day pair_scores
} as const;
