import {map as _map, reduce as _reduce, find as _find, cloneDeep as _cloneDeep, zip as _zip} from 'lodash';

const steps = 11;
export function colourise(v: number) {
    return colourMaps[Math.trunc(((v / 255) * steps) % steps)];
}

const colourMaps: number[][] = ['800009', '9F0033', 'BF0069', 'DF00AC', 'FF00F8', 'DF22FF', 'C144FF', 'AD66FF', 'A688FF', 'ADAAFF', 'CCCCFF'].map((a) =>
    [a.slice(0, 2), a.slice(2, 4), a.slice(4, 6)].map((p) => parseInt(p, 16))
);
