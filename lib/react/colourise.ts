import {map as _map, reduce as _reduce, find as _find, cloneDeep as _cloneDeep, zip as _zip} from 'lodash';

const steps = 11;
export function colourise(v) {
    return colourMaps[Math.trunc(((v / 255) * steps) % steps)];
}

const colourMaps: number[][] = ['800009', '9F0033', 'BF0069', 'DF00AC', 'FF00F8', 'DF22FF', 'C144FF', 'AD66FF', 'A688FF', 'ADAAFF', 'CCCCFF'].map((a) => [a.slice(0, 2), a.slice(2, 4), a.slice(4, 6)].map((p) => parseInt(p, 16)));
/*
function progression(f, t, offset) {
    const start = parseInt(f.slice(offset * 2, offset * 2 + 2) || 'ff', 16);
    const end = parseInt(t.slice(offset * 2, offset * 2 + 2) || 'ff', 16);
    const step = (end - start) / steps;
    return Array(steps)
        .fill(0)
        .map((_e, index) => start + Math.round(index * step));
}

function makeMaps() {
    const f = 'FFCB32';
    const t = '2F7604';
    return _zip(
        progression(f, t, 0), // R
        progression(f, t, 1), // G
        progression(f, t, 2) // B
    ); // A
}

export const colourMaps: [number, number, number][] = makeMaps();
*/
