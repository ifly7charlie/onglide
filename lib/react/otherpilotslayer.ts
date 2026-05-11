import type {Epoch, OtherPilotData, ClassName} from '../types';

import {IconLayer} from '@deck.gl/layers';

import {useSelector} from '../redux';
import {selectAllPositions} from '../redux/otherPilotsSlice';

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

const otherUrl = faToData(faCircleUser);

export function otherPilotsLayer(vc: ClassName, mapLight: boolean, map2d: boolean, now: Epoch | undefined) {
    const data = useSelector((state) => selectAllPositions(state, vc, now));

    if (!data || !data.length) {
        return null;
    }

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

        getColor: !mapLight ? [64, 64, 192, 255] : [255, 255, 255, 255],

        getIcon: () => ({
            id: 'other',
            url: otherUrl,
            width: 64,
            height: 64,
            mask: true
        }),
        pickable: true,
        updateTriggers: {
            getColor: mapLight == true ? 1 : 0
        }
    });
}
