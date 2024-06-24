import type {Epoch, Compno, TrackData} from '../types';
import {offlineTime} from '../constants';

import {IconLayer} from '@deck.gl/layers';

import {map as _map} from 'lodash';

function svgToDataURL(svg: string) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
import {faLocationPin} from '@fortawesome/free-solid-svg-icons';

/*function faToData(f: any, compno: Compno) {
    return svgToDataURL(`\
<svg width="30" height="30" xmlns="http://www.w3.org/2000/svg" fill="#fff" stroke="#fff" viewBox="0 0 200 200}">
<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle">${compno}</text>    
</svg>`);
}*/

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

//<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="#fff" stroke="#fff" >
//<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="10">20</text>
//</svg>`);

//<path d="${f.icon[4]}"/>

export function pilotsLayer(trackData: TrackData, selectedCompno: Compno, setSelectedCompno: (compno: Compno) => void, now: Epoch) {
    //
    // Generate the labels data, this is fairly simple and is extracted from the positions
    // data set rather than pilots so that the marker always aligns with the tracking points
    // we are adding more data so we get a nice tool tip, text colour is determined by how old
    // the point is
    const data = _map(trackData, (track) => {
        const p = track.deck;
        if (!p) {
            return {};
        }
        return {
            name: track.compno,
            compno: track.compno,
            v: p.climbRate[p.posIndex - 1], //
            g: p?.agl[p.posIndex - 1],
            a: p.positions[(p.posIndex - 1) * 3 + 2],
            t: p.t[p.posIndex - 1],
            position: [...p.positions.subarray((p.posIndex - 1) * 3, p.posIndex * 3)]
        };
    });

    if (data.length) {
        return new IconLayer<(typeof data)[0]>({
            id: 'labels',
            data: data,
            getColor: (d) => (now - d.t > offlineTime ? [0, 0, 0, 96] : [0, 0, 0, 255]),
            getSize: (d) => 35, //(d.compno == selectedCompno ? 35 : 30),
            getIcon: (i) => ({
                url: faToData(faLocationPin, i.compno, i.compno == selectedCompno),
                width: 128,
                height: 128,
                anchorY: 128,
                mask: false
            }),
            onClick: (i) => {
                setSelectedCompno(i.object?.name || '');
            },
            pickable: true
        });
    }

    return null;
}
