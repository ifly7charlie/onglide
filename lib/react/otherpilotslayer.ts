import type {Epoch, OtherPilotData} from '../types';

import {IconLayer} from '@deck.gl/layers';

import {map as _map} from 'lodash';

function svgToDataURL(svg: string) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

//import {faChessRook} from '@fortawesome/free-regular-svg-icons';
//import {faCircleUp} from '@fortawesome/free-regular-svg-icons';
import {faCircleUser} from '@fortawesome/free-regular-svg-icons';
//import {faCircleUp} from '@fortawesome/free-regular-svg-icons';

function faToData(f: any) {
    return svgToDataURL(`\
<svg width="30" height="30" xmlns="http://www.w3.org/2000/svg" fill="#fff" stroke="#fff" viewBox="0 0 ${f.icon[0]} ${f.icon[1]}">
  <path d="${f.icon[4]}"/>
</svg>`);
}

const otherUrl = () => faToData(faCircleUser);

export function otherPilotsLayer(others: OtherPilotData, mapLight: boolean, map2d: boolean, now: Epoch) {
    const timeCutoff = (now - 180) as Epoch;
    const data = _map(others, (pos, key) => {
        return {
            className: key.split('_')[0],
            compno: pos.c,
            ...pos,
            position: [pos.lng, pos.lat, pos.a]
        };
    }).filter((p) => p.t > timeCutoff);
    return new IconLayer<(typeof data)[0]>({
        id: 'other_pilots',
        data,
        getSize: map2d ? 14 : 12,
        /*        getAngle: (i) => {
            if (i.c == 'TA') {
                console.log(i.c, i.b);
            }
            return i.b ? i.b : 0;
        }, */

        getColor: mapLight ? [64, 64, 192, 255] : [255, 255, 255, 255],

        getIcon: (i) => ({
            url: otherUrl(),
            width: 64,
            height: 64,
            mask: true
        }),
        pickable: true,
        updateTriggers: {
            getAngle: Math.random(),
            getColor: mapLight == true ? 1 : 0
        }
    });
}
