import {Epoch} from './types';
import {toDateCode} from './datecode';

const start = Math.trunc(Date.now() / 1000);
const compDelay = process.env.NEXT_PUBLIC_COMPETITION_DELAY ? parseInt(process.env.NEXT_PUBLIC_COMPETITION_DELAY || '10') : 10;

const replayBaseString = process.env.NEXT_PUBLIC_REPLAY ?? process.env.REPLAY ?? '0';
export const replayBase = replayBaseString.indexOf(':') != -1 ? new Date(replayBaseString).getTime() / 1000 : parseInt(replayBaseString);
let multiplier = replayBase ? parseInt(process.env.REPLAY_MULTIPLIER || '1') : 1;
let internalGetNow = (): Epoch => {
    return (Math.trunc(Date.now() / 1000) - compDelay) as Epoch;
};

// And the replay
if (replayBase) {
    internalGetNow = (): Epoch => {
        const now = Math.trunc(Date.now() / 1000);
        const elapsed = now - start;
        const effectiveElapsed = elapsed * multiplier;
        return (replayBase + effectiveElapsed) as Epoch;
    };
    console.log(`Competition replay, competition time: ${getNow()} = ${new Date(getNow() * 1000).toISOString()}, replay: ${replayBase > 0}, datecode=${getReplayDatecode()}`);
}

export function getReplayDatecode() {
    return replay() ? toDateCode(new Date(replayBase * 1000)) : undefined;
}

console.log(`Competition delay: ${compDelay} seconds`);

export function getNow() {
    return internalGetNow();
}

export function getDelay() {
    return compDelay as Epoch;
}

export const readOnly = process.env.REPLAY_DB ? true : process.env.OGN_READ_ONLY == undefined ? false : !!parseInt(process.env.OGN_READ_ONLY);

export function replay() {
    return replayBase > 0;
}

export function d(d: Epoch | number | undefined | null) {
    return new Date(Math.min(d ?? 0, 2145916800) * 1000).toISOString();
}
