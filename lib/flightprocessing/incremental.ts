import {sortedIndex as _sortedIndex} from 'lodash';

import {gapLength, deckPointIncrement, deckSegmentIncrement} from '../constants';

import {Compno, PositionMessage, PilotTrackData, Epoch, DeckData, VarioData} from '../types';
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

export function initialiseDeck(compno: Compno, glider: PilotTrackData): void {
    glider.deck = {
        compno: compno,
        positions: new Float32Array(deckPointIncrement * 3),
        agl: new Int16Array(deckPointIncrement),
        t: new Uint32Array(deckPointIncrement),
        climbRate: new Int8Array(deckPointIncrement),
        partial: true,
        posIndex: 0
    };
}

export function mergePoint(point: PositionMessage | PilotPosition, glider: PilotTrackData, latest = true, now = Date.now() / 1000): boolean {
    // Ignore if before start
    let lastTime: number | null = null;

    if (!glider.deck) {
        if (latest) {
            return false;
        }
        initialiseDeck(glider.compno, glider);
    } else {
        // If not first point then make sure we are in order!
        lastTime = glider.deck.t[glider.deck.posIndex - 1];
        if (point.t < lastTime) {
            return false;
        }
    }

    // Last point we got
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

    // Set the new positions
    function pushPoint(positions: Float32Array | number[], g: number, t: number) {
        deck.positions.set(positions, deck.posIndex * 3);
        deck.t[deck.posIndex] = t;
        deck.agl[deck.posIndex] = g;
        deck.posIndex++;
    }
    pushPoint([point.lng, point.lat, point.a], point.g, point.t);

    if (point.t - lastTime < gapLength) {
        deck.climbRate[deck.posIndex] = Math.trunc((point.a - deck.positions[(deck.posIndex - 1) * 3 + 2]) / (point.t - lastTime));
    }

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

    return true;
}

//
// If the pilot has started we can prune before the startline
export function pruneStartline(deck: DeckData, startTime: Epoch): boolean {
    //    console.log('pruneStartline', deck.compno, startTime);
    // Keep 30 seconds before start
    if (!deck || deck.t[0] >= startTime) {
        return false;
    }
    /*
    // Find the point in the array of times
    let indexRemove = _sortedIndex(deck.t.subarray(0, deck.posIndex - 1), startTime);
    if (!indexRemove || indexRemove == deck.posIndex - 1) {
        console.log(`can't prune startline for ${deck.compno} no enough points yet ${indexRemove} <> ${deck.posIndex}`);
        return false;
    }

    // Find the index into the segments that is the index or above
    let segmentPos = _sortedIndex(deck.indices.subarray(0, deck.segmentIndex), indexRemove);

    //    for (let c = 0; c <= deck.segmentIndex; c++) {
    //        console.log(`${deck.compno}: --> ${c > 0 ? deck.t[deck.indices[c] - 1] : '0'} [${c}-1/${deck.indices[c] - 1}] ... [${c}/${deck.indices[c]}] ${deck.t[deck.indices[c]]} -->`);
    //    }

    // A segment starts on this position - we can remove all before
    if (deck.indices[segmentPos] == indexRemove) {
    }
    // A segment starts one afterwards - this is tricky it means
    // the start point was the last point of previous segment
    // ie indexRemove points to the last point in the previous segment
    else if (deck.indices[segmentPos] == indexRemove + 1) {
        // in this case we will truncate the previous segment and keep one
        // more point
        segmentPos--;
        indexRemove--;
    }
    // in segment keep this segment but remove the segment before
    else {
        segmentPos--;
    }

    // first we need to remove old segments - start with the older list as may be points in it
    deck.recentIndices[0] = Math.max(deck.recentIndices[0] - indexRemove, 0);
    deck.recentIndices[1] = Math.max(deck.recentIndices[1] - indexRemove, 0);

    // Remove before
    deck.indices = new Uint32Array(deck.indices.subarray(segmentPos).map((p) => Math.max(0, p - indexRemove)));

    // Adjust the offsets and If we are removing anything then resze it down
    deck.segmentIndex -= segmentPos;
    deck.posIndex -= indexRemove;
    deck.indices[deck.segmentIndex] = deck.posIndex;

    // And then take the end of the buffer for displaying data
    deck.positions = deck.positions.slice(indexRemove * 3);
    deck.agl = deck.agl.slice(indexRemove);
    deck.t = deck.t.slice(indexRemove);
    deck.climbRate = deck.climbRate.slice(indexRemove);

    //    console.log('ir:', indexRemove, 'sp:', segmentPos, 'start:', startTime);
    //    for (let c = 0; c <= deck.segmentIndex; c++) {
    //        console.log(`${deck.compno}: --> ${c > 0 ? deck.t[deck.indices[c] - 1] : '0'} [${c}-1/${deck.indices[c] - 1}] ... [${c}/${deck.indices[c]}] ${deck.t[deck.indices[c]]} -->`);
    //    }
*/
    return true;
}

export function updateVarioFromDeck(deck: DeckData, vario: VarioData): [Epoch, VarioData] {
    const cp: any = vario || {min: Infinity, max: 0};
    try {
        const lastPos = deck.t.length - 1;
        cp.agl = deck.agl[lastPos];
        [cp.lng, cp.lat, cp.altitude] = [].concat(...deck.positions.subarray(lastPos * 3));
        cp.lossXsecond = cp.gainXsecond = cp.total = cp.average = cp.Xperiod = 0;
        cp.min = Math.min(cp.altitude || cp.min, cp.min);
        cp.max = Math.max(cp.altitude || cp.max, cp.max);
    } catch (_e) {
        console.log(_e);
    }
    return [deck.t[deck.t.length - 1] as Epoch, cp];
}
