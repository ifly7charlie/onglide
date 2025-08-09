import type {Epoch, Compno} from '../types';
import {offlineTime} from '../constants';

import {selectAllPositions} from '../redux/tracksSlice';
import {useSelector} from '../redux';

import {IconLayer} from '@deck.gl/layers';

import {faLocationPin} from '@fortawesome/free-solid-svg-icons';

import {memoize} from 'lodash';

function svgToDataURL(svg: string) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function faToData(f: any, compno: Compno, selected: boolean) {
    const size = compno.length > 3 ? 160 : 210;
    return !selected
        ? svgToDataURL(`\
<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg" fill="black" stroke="#000" viewBox="0 0 ${f.icon[0]} ${f.icon[1]}">
<path fill="white" stroke="#070f" stroke-width="20" d="${f.icon[4]}"/>
<text x="50%" y="44%" dominant-baseline="middle" text-anchor="middle" fill="black" font-size="${size}">${compno}</text>    
</svg>`)
        : svgToDataURL(`\
<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg" fill="black" stroke="#000" viewBox="0 0 ${f.icon[0]} ${f.icon[1]}">
<path fill="white" stroke="#f0f" stroke-width="30" d="${f.icon[4]}"/>
<text x="50%" y="44%" dominant-baseline="middle" text-anchor="middle" fill="#f0f" font-size="${size}">${compno}</text>    
</svg>`);
}

let getIcon = memoize(
    function getIcon(compno: Compno, selectedCompno: Compno | undefined) {
        return {
            id: compno == selectedCompno ? 'S/' + compno : compno,
            url: compno == selectedCompno ? faToData(faLocationPin, compno, true) : faToData(faLocationPin, compno, false),
            width: 128,
            height: 128,
            anchorY: 128,
            mask: false
        };
    },
    (c: Compno, s: Compno | undefined) => c + '/' + (s ?? '')
);

export function pilotsLayer(selectedCompno: Compno, setSelectedCompno: (compno: Compno) => void, now: Epoch) {
    const data = useSelector((state) => selectAllPositions(state, now));

    if (data.length) {
        return new IconLayer<(typeof data)[0], {beforeId: string}>({
            id: 'labels',
            beforeId: 'tpe',
            data: data,
            getColor: (d) => (now - d.t > offlineTime ? [0, 0, 0, 96] : [0, 0, 0, 255]),
            getSize: (_d) => 35,
            getIcon: (i) => getIcon(i.compno, selectedCompno),
            onClick: (i) => {
                setSelectedCompno(i.object?.compno || '');
            },
            updateTriggers: {
                getIcon: [selectedCompno],
                getPosition: [now]
            },
            pickable: true
        });
    }

    return null;
}
