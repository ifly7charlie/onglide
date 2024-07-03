import type {Epoch, Compno} from '../types';
import {offlineTime} from '../constants';

import {selectAllPositions} from '../redux/tracksSlice';
import {useSelector} from '../redux';

import {IconLayer} from '@deck.gl/layers';

import {faLocationPin} from '@fortawesome/free-solid-svg-icons';

function svgToDataURL(svg: string) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function faToData(f: any, compno: Compno, selected: boolean) {
    return !selected
        ? svgToDataURL(`\
<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg" fill="black" stroke="#000" viewBox="0 0 ${f.icon[0]} ${f.icon[1]}">
<path fill="white" stroke="#070f" stroke-width="20" d="${f.icon[4]}"/>
<text x="50%" y="44%" dominant-baseline="middle" text-anchor="middle" fill="black" font-size="210">${compno}</text>    
</svg>`)
        : svgToDataURL(`\
<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg" fill="black" stroke="#000" viewBox="0 0 ${f.icon[0]} ${f.icon[1]}">
<path fill="white" stroke="#f0f" stroke-width="30" d="${f.icon[4]}"/>
<text x="50%" y="44%" dominant-baseline="middle" text-anchor="middle" fill="#f0f" font-size="210">${compno}</text>    
</svg>`);
}

export function pilotsLayer(selectedCompno: Compno, setSelectedCompno: (compno: Compno) => void, now: Epoch) {
    const data = useSelector((state) => selectAllPositions(state, now));

    if (data.length) {
        return new IconLayer<(typeof data)[0], {beforeId: string}>({
            id: 'labels',
            beforeId: 'tpe',
            data: data,
            getColor: (d) => (now - d.t > offlineTime ? [0, 0, 0, 96] : [0, 0, 0, 255]),
            getSize: (d) => 35, //(d.compno == selectedCompno ? 35 : 30),
            getIcon: (i) => {
                return {
                    id: i.compno == selectedCompno ? 'S' + i.compno : i.compno,
                    url: i.compno == selectedCompno ? faToData(faLocationPin, i.compno, true) : faToData(faLocationPin, i.compno, false),
                    //                    url: i.compno == selectedCompno ? trackData[i.compno].iconSelected : trackData[i.compno].icon,
                    width: 128,
                    height: 128,
                    anchorY: 128,
                    mask: false
                };
            },
            onClick: (i) => {
                setSelectedCompno(i.object?.compno || '');
            },
            updateTriggers: {
                getPosition: [now]
            },
            pickable: true
        });
    }

    return null;
}
