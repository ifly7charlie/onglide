import {sortedIndex as _sortedIndex} from 'lodash';

import {gapLength, deckPointIncrement, deckSegmentIncrement} from '../constants';

import {Compno, PositionMessage, PilotTrackData, DisplayPilotTrackData, Epoch, DeckData, VarioData} from '../types';
import {PilotPosition} from '../protobuf/onglide';

// Helper fro resizing TypedArrays so we don't end up with them being huge
export function resize<T extends Uint8Array | Int8Array | Int16Array | Uint32Array | Float32Array>(allocator: {new (number): T}, a: T, b: number) {
    let c = new allocator(b);
    c.set(a);
    return c;
}

export function initialiseDeck(compno: Compno, glider: PilotTrackData, trackVersion: number): void {
    glider.deck = {
        compno: compno,
        positions: new Float32Array(deckPointIncrement * 3),
        indices: new Uint32Array(deckSegmentIncrement),
        agl: new Int16Array(deckPointIncrement),
        t: new Uint32Array(deckPointIncrement),
        climbRate: new Int8Array(deckPointIncrement),
        posIndex: 0,
        segmentIndex: 1,
        trackVersion
    };
    glider.vario = {min: Infinity, max: 0} as VarioData;
}

//
// Go through all the points and update the segments - this is needed when we merge two files
export function generateIndices(deck: DeckData, glider: PilotTrackData) {
    if (!deck) {
        return;
    }

    let lastTime = deck.t[0];
    if (!deck.indices) {
        deck.indices = new Uint32Array(deckSegmentIncrement);
        deck.tr = new Uint32Array(deckPointIncrement);
    }
    deck.indices[0] = 0;
    deck.segmentIndex = 1;
    for (let i = 1; i < deck.posIndex; i++) {
        if (deck.t[i] - lastTime > gapLength) {
            deck.indices[deck.segmentIndex++] = i;
        } else {
            deck.indices[deck.segmentIndex] = i;
        }
        lastTime = deck.t[i];
        if (deck.segmentIndex + 2 >= deck.indices.length) {
            deck.indices = resize(Uint32Array, deck.indices, deck.segmentIndex + deckSegmentIncrement);
        }
    }
    deck.indices[deck.segmentIndex] = deck.posIndex - 1;
}

export function mergePoint(point: PositionMessage | PilotPosition, glider: PilotTrackData, latest = true): false | {start: number; end: number} {
    // Ignore if before start
    let lastTime: number | null = null;

    if (!glider.deck) {
        if (latest) {
            return false;
        }
        initialiseDeck(glider.compno, glider, 0);
        if (!glider.deck) {
            return false;
        }
    } else {
        // If not first point then make sure we are in order!
        lastTime = glider.deck.t[glider.deck.posIndex - 1];
        if (point.t < lastTime) {
            //            console.log(glider.compno, point.t, '<', lastTime);
            return false;
        }
    }

    // Last point we got
    glider.t = point.t as Epoch;

    // Now we will work with this data
    const deck = glider.deck;
    const start = deck.posIndex;

    // Resize required
    if (deck.posIndex + 2 >= deck.t.length) {
        const newLength = deck.posIndex + deckPointIncrement;
        deck.positions = resize(Float32Array, deck.positions, newLength * 3);
        deck.t = resize(Uint32Array, deck.t, newLength);
        deck.agl = resize(Int16Array, deck.agl, newLength);
        deck.climbRate = resize(Int8Array, deck.climbRate, newLength);
    }

    if (deck.segmentIndex + 3 >= deck.indices.length) {
        deck.indices = resize(Uint32Array, deck.indices, deck.segmentIndex + deckSegmentIncrement);
    }

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
        pushPoint([point.lng, point.lat, point.a], point.g, point.t); // always have two points ;)
    } else {
        const previousSegmentStart = deck.indices[deck.segmentIndex - 1];
        // If the gap is too long then we need to start the next segment as well
        if (point.t - lastTime! > gapLength) {
            // If we have only one point in the previous segment then we should duplicate it
            if (previousSegmentStart == deck.posIndex - 1) {
                // add it to the previous segment so there are two points in it, it's not a line
                // without two points
                pushPoint(deck.positions.subarray(previousSegmentStart * 3, (previousSegmentStart + 1) * 3), deck.agl[previousSegmentStart], deck.t[previousSegmentStart]);
            }
            deck.indices[deck.segmentIndex] = deck.posIndex;
            // Start a new segment, on the next point (which has not yet been pushed)
            deck.segmentIndex++;
        } else {
            if (deck.posIndex - previousSegmentStart > 100) {
                pushPoint([point.lng, point.lat, point.a], point.g, point.t);
                deck.segmentIndex++;
            }
            deck.climbRate[deck.posIndex] = Math.trunc((point.a - deck.positions[(deck.posIndex - 1) * 3 + 2]) / (point.t - lastTime!));
        }
    }

    // Push the new point into the data array
    pushPoint([point.lng, point.lat, point.a], point.g, point.t);

    return {start, end: deck.posIndex};
}

// Calculate vario for the specific index
export function calculateVario(deck: DeckData, index: number) {
    const t = deck.t[index];

    // Find 40 seconds
    let start = index;
    while (start > 0 && t - deck.t[start] < 40) {
        start--;
    }

    let v = {gainXsecond: 0, lossXsecond: 0} as VarioData;

    // Add them up
    let previousAlt = deck.positions[start * 3 + 2];
    let initialAlt = previousAlt;
    for (let c = start; c < index; c++) {
        const altitude = deck.positions[c * 3 + 2];
        if (previousAlt !== undefined) {
            let diff = altitude - previousAlt;
            if (diff > 0) v.gainXsecond += diff;
            if (diff < 0) v.lossXsecond -= diff;
        }
        previousAlt = altitude;
    }

    // The total and the average, along with misc status values
    v.total = previousAlt - initialAlt;
    v.Xperiod = (t - deck.t[start]) as Epoch;
    v.average = Math.round((v.total * 10) / v.Xperiod) / 10;
    v.lng = deck.positions[index * 3];
    v.lat = deck.positions[index * 3 + 1];
    v.agl = deck.agl[index];
    v.altitude = previousAlt;
    v.t = t as Epoch;

    return v;
}

// Calculate vario for the specific index
export function calculateAverage(deck: DeckData, index: number) {
    const t = deck.t[index];

    // Find 40 seconds
    let start = index;
    while (start > 0 && t - deck.t[start] < 40) {
        start--;
    }

    if (start == index) {
        return null;
    }

    // Add them up
    return Math.round((10 * (deck.positions[index * 3 + 2] - deck.positions[start * 3 + 2])) / (t - deck.t[start])) / 10;
}
