import {DisplayPilotTrackData} from '../types';

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

// Renderer-side per-vertex sidecar (timestamps + RGB). Sourced from the
// smoothed sidecar when present (Hermite-subdivided), falling back to
// the raw anchor arrays otherwise. RGB is computed per-vertex from the
// (interpolated) agl/climb so colour gradients stay continuous along
// smoothed sections.
function vhSource(glider: DisplayPilotTrackData): {t: Uint32Array; agl: Int16Array; climbRate: Int8Array; posIndex: number} {
    return glider.deck.smoothed ?? glider.deck;
}

export function initaliseVH(glider: DisplayPilotTrackData): void {
    const src = vhSource(glider);
    const len = src.posIndex;
    const tr = new Uint32Array(len);
    const climbArr = new Uint8Array(len * 3);
    const aheightArr = new Uint8Array(len * 3);
    for (let i = 0; i < len; i++) {
        tr[i] = src.t[i] - referenceDate;
        climbArr.set(climb(src.climbRate[i]), i * 3);
        aheightArr.set(aheight(src.agl[i]), i * 3);
    }
    glider.deckAdditional = {
        tr,
        climb: climbArr,
        aheight: aheightArr
    };
}

