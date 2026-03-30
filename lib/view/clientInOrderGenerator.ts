import type {Compno, Epoch, PositionMessage, InOrderGenerator, InOrderGeneratorFunction} from '../types';

import {sortedIndexBy as _sortedIndexBy} from 'lodash';

// How often to mark a point as "live" to trigger score emission (seconds)
const SCORE_INTERVAL = 30;

// Client-side replacement for the BroadcastChannel-based inOrderGenerator.
// IGC files are always in time order, so no sorting is needed - just stream straight through.
// Points are marked as "live" (_: true) at regular intervals to trigger intermediate
// score emission, which populates Redux historical data for replay.
export function bindClientInOrderGenerator(compno: Compno, fixes: PositionMessage[]): InOrderGeneratorFunction {
    const inOrderGenerator = async function* (_getNow: () => Epoch): InOrderGenerator {
        let lastLiveT: Epoch = 0 as Epoch;

        for (let position = 0; position < fixes.length; position++) {
            const isLast = position === fixes.length - 1;
            const elapsed = fixes[position].t - lastLiveT;
            const isLive = isLast || elapsed >= SCORE_INTERVAL;

            if (isLive) {
                lastLiveT = fixes[position].t;
            }

            const message = {...fixes[position], _: isLive};
            const nextPoint: Epoch | void = yield message;

            // Support rewind protocol used by taskPositionGenerator for dogleg detection
            if (nextPoint) {
                position = _sortedIndexBy(fixes, {t: nextPoint} as any, (o) => o.t) - 1;
                if (position < 0) position = 0;
            }
        }

        // Final tick to flush any remaining scoring state
        yield {c: compno, _: true, tick: true, t: fixes[fixes.length - 1].t} as any;
    };

    return inOrderGenerator;
}
