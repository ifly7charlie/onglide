import {map as _map, reduce as _reduce, find as _find, cloneDeep as _cloneDeep, zip as _zip} from 'lodash';
import {PositionMessage, DeckData, DisplayPilotTrackData, SortKey} from '../types';

import {PilotPosition} from '../protobuf/onglide';

import {deckPointIncrement} from '../constants';

import {resize} from '../flightprocessing/incremental';

import {colourise} from './colourise';

const oneHalfYearIsh = 3600 * 24 * 180;
const referenceDate =
    (process.env.NEXT_PUBLIC_REPLAY //
        ? parseInt(process.env.NEXT_PUBLIC_REPLAY) - (parseInt(process.env.NEXT_PUBLIC_REPLAY) % oneHalfYearIsh)
        : new Date(Date.now() - (Date.now() % (oneHalfYearIsh * 1000))).getTime() / 1000) - oneHalfYearIsh;

const colourFunctions = {
    climb: (v) => colourise(Math.min(255, Math.max(0, v * -12.5 + 128))),
    height: (v) => colourise(Math.min(255, Math.log2(v >> 5) * 35)),
    aheight: (v) => colourise(Math.min(255, Math.log2(v >> 5) * 35))
};

const bulkColourFunctions = {
    climb: (cf, deck: DeckData) => _map(deck.climbRate, cf).flat(2),
    height: (cf, deck: DeckData) => _map(deck.t, (_v, index) => cf(deck.positions[3 * index + 2])).flat(2),
    aheight: (cf, deck: DeckData) => _map(deck.agl, (v) => cf(v)).flat(2)
};

export function initaliseVH(glider: DisplayPilotTrackData, sortKey: SortKey): void {
    const cf = colourFunctions[sortKey];
    glider.deckAdditional = {
        tr: new Uint32Array(glider.deck.t.map((t) => t - referenceDate)),
        sortKey: cf ? sortKey : null,
        colours: cf ? new Uint8Array(bulkColourFunctions[sortKey](cf, glider.deck)) : null
    };
}

export function pruneVHStartline({deckAdditional}: DisplayPilotTrackData, indexRemove: number) {
    deckAdditional.tr = deckAdditional.tr.slice(indexRemove);
    deckAdditional.colours = deckAdditional.colours ? deckAdditional.colours.slice(indexRemove) : null;
}

export function mergeVHPoint(point: PositionMessage | PilotPosition, {deckAdditional, deck}: DisplayPilotTrackData, position: number) {
    // Resize required
    const newLength = position + deckPointIncrement;
    if (position >= deckAdditional.tr.length) {
        deckAdditional.tr = resize(Uint32Array, deckAdditional.tr, newLength);
    }
    deckAdditional.tr[position] = point.t - referenceDate;

    try {
        if (deckAdditional.colours) {
            if ((position + 1) * 3 >= deckAdditional.colours.length) {
                deckAdditional.colours = deckAdditional.colours ? resize(Uint8Array, deckAdditional.colours, newLength * 3) : null;
            }
            deckAdditional.colours.set(colourFunctions[deckAdditional.sortKey](deck.climbRate[position]), position * 3);
        }
    } catch (e) {
        console.error('------>', e);
        console.log(deckAdditional.colours);
        console.log(position);
    }
}
