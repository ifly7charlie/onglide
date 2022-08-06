import {sortedIndex as _sortedIndex} from 'lodash';

import {gapLength, deckPointIncrement, deckSegmentIncrement} from '../constants';

import {PositionMessage, PilotTrackData, Epoch, DeckData, VarioData} from '../types';
import {PilotPosition} from '../protobuf/onglide';

/*
//
// This goes through all the pilots in data and marks the ones that are overdue as 'grey'
export function checkGrey(pilotsGeoJSON, timestamp) {
    for (const f of pilotsGeoJSON.locations.features) {
        f.properties.v = timestamp - f.properties.t > gapLength ? 'grey' : 'black';
        console.log(f.properties.c, f.properties.v);
    }
}
*/

// Helper fro resizing TypedArrays so we don't end up with them being huge
function resize<T extends Int8Array | Int16Array | Uint32Array | Float32Array>(allocator: {new (number): T}, a: T, b: number) {
    let c = new allocator(b);
    c.set(a);
    return c;
}

export function mergePoint(point: PositionMessage | PilotPosition, glider: PilotTrackData, latest = true, now = Date.now() / 1000): void {
    // Ignore if before start
    const compno = glider.compno;
    let lastTime: number | null = null;

    if (!glider.deck) {
        glider.deck = {
            compno: compno,
            positions: new Float32Array(deckPointIncrement * 3),
            indices: new Uint32Array(deckSegmentIncrement),
            agl: new Int16Array(deckPointIncrement),
            t: new Uint32Array(deckPointIncrement),
            recentIndices: new Uint32Array(2),
            climbRate: new Int8Array(deckPointIncrement),
            partial: true,
            posIndex: 0,
            segmentIndex: 0
        };
    } else {
        // If not first point then make sure we are in order!
        lastTime = glider.deck.t[glider.deck.posIndex - 1];
        if (point.t < lastTime) {
            return;
        }
    }

    // Last point we go
    glider.t = point.t as Epoch;

    // Now we will work with this data
    const deck = glider.deck;

    // Resize required
    if (deck.posIndex >= deck.t.length) {
        const newLength = deck.posIndex + deckPointIncrement;
        deck.positions = resize(Float32Array, deck.positions, newLength * 3);
        deck.t = resize(Uint32Array, deck.t, newLength);
        deck.agl = resize(Int16Array, deck.agl, newLength);
        deck.climbRate = resize(Int8Array, deck.climbRate, newLength);
    }

    if (deck.segmentIndex + 2 >= deck.indices.length) {
        deck.indices = resize(Uint32Array, deck.indices, deck.segmentIndex + deckSegmentIncrement);
    }

    // Set the new positions
    function pushPoint(positions: Float32Array | number[], g: number, t: number) {
        deck.positions.set(positions, deck.posIndex * 3);
        deck.t[deck.posIndex] = t;
        deck.agl[deck.posIndex] = g;
        //		deck.colours.set( [ 64, 64, 64 ], deck.posIndex*3 );
        deck.posIndex++;
        // Also the indicies array needs to be terminated
        deck.indices[deck.segmentIndex] = deck.posIndex;
    }

    // Start the first segment
    if (deck.posIndex == 0) {
        deck.indices[deck.segmentIndex++] = 0;
    } else {
        // If the gap is too long then we need to start the next segment as well
        if (point.t - lastTime > gapLength) {
            // If we have only one point in the previous segment then we should duplicate it
            const previousSegmentStart = deck.indices[deck.segmentIndex - 1];
            if (previousSegmentStart == deck.posIndex) {
                // add it to the previous segment so there are two points in it, it's not a line
                // without two points
                pushPoint(deck.positions.subarray(previousSegmentStart * 3, (previousSegmentStart + 1) * 3), deck.agl[previousSegmentStart], deck.t[previousSegmentStart]);
            }

            // Start a new segment, on the next point (which has not yet been pushed)
            deck.segmentIndex++;
        } else {
            deck.climbRate[deck.posIndex] = Math.trunc((point.a - deck.positions[(deck.posIndex - 1) * 3 + 2]) / (point.t - lastTime));
        }
    }

    // Push the new point into the data array
    pushPoint([point.lng, point.lat, point.a], point.g, point.t);

    // Generate the recent track for the glider
    let recentOldest = deck.recentIndices[0];
    while (point.t - deck.t[recentOldest] > gapLength && recentOldest < deck.posIndex) {
        recentOldest++;
    }
    deck.recentIndices[0] = recentOldest;
    deck.recentIndices[1] = deck.posIndex;

    // Update the altitude and height AGL for the pilot
    // Mutate the vario and altitude back into SWR
    const cp: any = glider.vario || {min: Infinity, max: 0};
    try {
        cp.altitude = point.a;
        cp.agl = point.g;
        cp.lat = point.lat;
        cp.lng = point.lng;

        var min: number, max: number;

        if (point.v) {
            [cp.lossXsecond, cp.gainXsecond, cp.total, cp.average, cp.Xperiod, min, max] = point.v.split(',').map((a) => parseFloat(a));
        }

        cp.min = Math.min(min || point.a, cp.min);
        cp.max = Math.max(max || point.a, cp.max);
        if (!glider.vario) {
            glider.vario = cp;
        }
    } catch (_e) {
        console.log(_e);
    }
}

//
// If the pilot has started we can prune before the startline
export function pruneStartline(deck: DeckData, startTime: Epoch): boolean {
    // Keep 30 seconds before start
    if (!deck || deck.t[0] > startTime - 30) {
        return false;
    }

    let indexRemove = _sortedIndex(deck.t, startTime - 20);
    if (!indexRemove) {
        return false;
    }

    // first we need to remove old segments - start with the older list as may be points in it
    deck.recentIndices[0] = Math.max(indexRemove, deck.recentIndices[0]);
    deck.recentIndices[1] = Math.max(indexRemove, deck.recentIndices[1]);

    // now go through the segment list
    let pruneIndex = 0;
    for (let index = 0; index < deck.indices.length; index += 2) {
        // If both are greater then we will discard
        if (deck.indices[index + 1] < indexRemove) {
            pruneIndex = index;
            continue;
        }
        // If the first is then we update that
        else if (deck.indices[index] < indexRemove) {
            deck.indices[index] = 0;
        } else {
            deck.indices[index] -= indexRemove;
            deck.indices[index + 1] -= indexRemove;
        }
    }

    if (pruneIndex) {
        deck.indices = new Uint32Array(deck.indices.buffer, pruneIndex * 2 * Uint32Array.BYTES_PER_ELEMENT);
    }

    // And prune it out
    deck.positions = new Float32Array(deck.positions.buffer, indexRemove * 3 * Float32Array.BYTES_PER_ELEMENT);
    deck.agl = new Int16Array(deck.agl.buffer, indexRemove * Int16Array.BYTES_PER_ELEMENT);
    deck.t = new Uint32Array(deck.t.buffer, indexRemove * Uint32Array.BYTES_PER_ELEMENT);
    deck.climbRate = new Int8Array(deck.climbRate.buffer, indexRemove * Int8Array.BYTES_PER_ELEMENT);
    return true;
}

export function updateVarioFromDeck(deck: DeckData, vario: VarioData): [Epoch, VarioData] {
    const cp: any = vario || {min: Infinity, max: 0};
    try {
        const lastPos = deck.t.length - 1;
        cp.agl = deck.agl[lastPos];
        [cp.lng, cp.lat, cp.altitude] = deck.positions.subarray(lastPos * 3);

        cp.lossXsecond = cp.gainXsecond = cp.total = cp.average = cp.Xperiod = 0;

        //        cp.min = Math.min(min || point.a, cp.min);
        //      cp.max = Math.max(max || point.a, cp.max);
    } catch (_e) {
        console.log(_e);
    }
    return [deck.t[deck.t.length - 1] as Epoch, cp];
}
