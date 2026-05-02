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

// Slack on the all-landed verdict for promoting a class to 'H' (home). One
// glider stuck on grid or landed-out shouldn't keep the whole class flagged
// as still flying — allow a small fraction of tracked pilots to be in
// non-landed states and still call it home.
export const HOME_SLACK_FRACTION = 0.05;
// Minimum tracker coverage (fraction of pilots in the class with a real,
// non-'unknown'/'blocked' tracker) before OGN evidence alone — without the
// official scorer finalising everyone — is allowed to widen allowFrom and
// recover a class stuck at B/G into H.
export const HOME_OGN_COVERAGE = 0.5;

export const inorderAdditionalDelay = 6;

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
