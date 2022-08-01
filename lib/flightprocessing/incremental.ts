import _find from 'lodash.find';
import _foreach from 'lodash.foreach';

import {gapLength, deckPointIncrement, deckSegmentIncrement} from '../constants';

import {PositionMessage} from '../webworkers/positionmessage';

export interface DeckData {
    positions: Float32Array;
    indices: Uint32Array;
    agl: Int16Array;
    t: Uint32Array;
    recentIndices: Uint32Array;
    climbRate: Int8Array;
    posIndex: number;
    segmentIndex: number;
}

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
function resize(a, b: number) {
    let c = new a.constructor(b);
    c.set(a);
    return c;
}

export function mergePoint(point: PositionMessage, glider, latest = true, now = Date.now() / 1000): void {
    // Ignore if before start
    const compno = glider.compno;
    if (glider?.utcstart && point.t < glider.utcstart) {
        return;
    }

    if (!glider.deck) {
        glider.deck = {
            compno: compno,
            positions: new Float32Array(deckPointIncrement * 3),
            indices: new Uint32Array(deckSegmentIncrement),
            agl: new Int16Array(deckPointIncrement),
            t: new Uint32Array(deckPointIncrement),
            recentIndices: new Uint32Array(2),
            climbRate: new Int8Array(deckPointIncrement),
            posIndex: 0,
            segmentIndex: 0
        };
    }

    // Now we will work with this data
    const deck = glider.deck;

    if (deck.posIndex >= deck.t.length) {
        const newLength = deck.posIndex + deckPointIncrement;
        deck.positions = resize(deck.positions, newLength * 3);
        deck.t = resize(deck.t, newLength);
        deck.agl = resize(deck.agl, newLength);
        deck.climbRate = resize(deck.climbRate, newLength);
    }

    if (deck.segmentIndex + 2 >= deck.indices.length) {
        deck.indices = resize(deck.indices, deck.segmentIndex + deckSegmentIncrement);
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
        const lastTime = deck.t[deck.posIndex - 1];

        // If the gap is too long then we need to start the next segment as well
        if (point.t - lastTime > gapLength) {
            // If we have only one point in the previous segment then we should duplicate it
            const previousSegmentStart = deck.indices[deck.segmentIndex - 1];
            if (previousSegmentStart == deck.posIndex) {
                // add it to the previous segment so there are two points in it, it's not a line
                // without two points
                pushPoint(
                    deck.positions.subarray(previousSegmentStart * 3, (previousSegmentStart + 1) * 3),
                    deck.agl[previousSegmentStart],
                    deck.t[previousSegmentStart]
                );
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
}
