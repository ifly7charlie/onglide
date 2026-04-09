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
