import {map as _map, reduce as _reduce, find as _find, cloneDeep as _cloneDeep, zip as _zip} from 'lodash';
import {PositionMessage, DeckData, DisplayPilotTrackData, SortKey} from '../types';

import {PilotPosition} from '../protobuf/onglide';

import {deckPointIncrement} from '../constants';

import {resize} from '../flightprocessing/incremental';
import {referenceDate} from '../flightprocessing/referenceDate';

const colourMaps = ['800009', '9F0033', 'BF0069', 'DF00AC', 'FF00F8', 'DF22FF', 'C144FF', 'AD66FF', 'A688FF', 'ADAAFF', 'CCCCFF'].map(
    (a): [number, number, number] => [a.slice(0, 2), a.slice(2, 4), a.slice(4, 6)].map((p) => parseInt(p, 16)) as [number, number, number]
);

function clamp(a) {
    return a < 0 ? 0 : a > 9 ? 9 : Math.trunc(a);
}

const climb = (v: number) => colourMaps[clamp(v + 5)];
const aheight = (v: number) => colourMaps[clamp(Math.log(Math.max(v >> 5, 0)))];
//const    height = (v) => colourise(Math.min(255, Math.log2(v >> 5) * 35))

const climbBulk = (deck: DeckData) => _map(deck.climbRate, climb).flat(2);
//const aheightBulk = (deck: DeckData) => deck.agl.values().map(aheight).flat(2);
//const heightBulk = (cf, deck: DeckData) => _map(deck.t, (_v, index) => cf(deck.positions[3 * index + 2])).flat(2);

function doFlatMap<T extends Int16Array | Int8Array>(ta: T, cb: (v: T[0]) => [number, number, number]): Uint8Array {
    const result = new Uint8Array(ta.length * 3);
    const l = ta.length;
    for (let i = 0, r = 0; i < l; i++, r += 3) {
        result.set(cb(ta[i]), r);
    }
    return result;
}

export function initaliseVH(glider: DisplayPilotTrackData): void {
    glider.deckAdditional = {
        tr: new Uint32Array(glider.deck.t.map((t) => t - referenceDate)),
        climb: doFlatMap(glider.deck.climbRate, climb),
        aheight: doFlatMap(glider.deck.agl, aheight)
    };
}

export function pruneVHStartline({deckAdditional}: DisplayPilotTrackData, indexRemove: number) {
    deckAdditional.tr = deckAdditional.tr.slice(indexRemove);
    deckAdditional.climb = deckAdditional.climb.slice(indexRemove * 3);
    deckAdditional.aheight = deckAdditional.aheight.slice(indexRemove * 3);
}

export function mergeVHPoint(point: PositionMessage | PilotPosition, {deckAdditional, deck}: DisplayPilotTrackData, position: number) {
    // Resize required
    const newLength = position + deckPointIncrement;
    if (position >= deckAdditional.tr.length) {
        deckAdditional.tr = resize(Uint32Array, deckAdditional.tr, newLength);
        deckAdditional.climb = resize(Uint8Array, deckAdditional.climb, newLength * 3);
        deckAdditional.aheight = resize(Uint8Array, deckAdditional.aheight, newLength * 3);
    }
    deckAdditional.tr[position] = point.t - referenceDate;
    deckAdditional.climb.set(climb(deck.climbRate[position]), position * 3);
    deckAdditional.aheight.set(climb(deck.agl[position]), position * 3);
}
