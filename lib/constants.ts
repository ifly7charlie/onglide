// How much time between packets is considered to be a gap in the track (seconds)
export const gapLength = 60;

// How long till pilot is considered offline
export const offlineTime = 600;

export const recentTrackLength = 240; // seconds of recent track to show

// How many points to start/increase array allocation by
export const deckPointIncrement = 2000;
export const deckSegmentIncrement = 100;

// How long to delay track to ensure we aren't missing packets
export const inOrderDelay = 1;

// How often to refresh the 'static download' (seconds)
export const webPathBaseTime = 5 * 60;

// How many minutes of scores are we batching together
export const scoreChunkSize = 30 * 60;
