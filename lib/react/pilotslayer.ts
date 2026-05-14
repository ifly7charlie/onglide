import {useEffect, useMemo, useState} from 'react';

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

// Pre-pack every pilot's regular + selected icon into a single atlas canvas
// up front. Avoids deck.gl IconLayer's auto-pack mode, where each selection
// change can append new entries to the atlas — with many pilots and a few
// clicks the atlas got into a state where unselected icons stopped rendering.
const ICON_SIZE = 128;
const ATLAS_COLS = 16;

type AtlasState = {
    key: string;
    iconAtlas: string;
    iconMapping: Record<string, {x: number; y: number; width: number; height: number; anchorY: number; mask: boolean}>;
};

async function buildAtlas(compnos: Compno[]): Promise<AtlasState> {
    const total = compnos.length * 2;
    const rows = Math.max(1, Math.ceil(total / ATLAS_COLS));
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_COLS * ICON_SIZE;
    canvas.height = rows * ICON_SIZE;
    const ctx = canvas.getContext('2d')!;

    const iconMapping: AtlasState['iconMapping'] = {};
    const draws: Promise<void>[] = [];

    let idx = 0;
    for (const compno of compnos) {
        for (const selected of [false, true]) {
            const id = selected ? 'S/' + compno : compno;
            const url = faToData(faLocationPin, compno, selected);
            const x = (idx % ATLAS_COLS) * ICON_SIZE;
            const y = Math.floor(idx / ATLAS_COLS) * ICON_SIZE;
            iconMapping[id] = {x, y, width: ICON_SIZE, height: ICON_SIZE, anchorY: ICON_SIZE, mask: false};
            draws.push(
                new Promise<void>((resolve) => {
                    const img = new Image();
                    img.onload = () => {
                        ctx.drawImage(img, x, y, ICON_SIZE, ICON_SIZE);
                        resolve();
                    };
                    img.onerror = () => resolve();
                    img.src = url;
                })
            );
            idx++;
        }
    }

    await Promise.all(draws);
    return {key: compnos.join(','), iconAtlas: canvas.toDataURL('image/png'), iconMapping};
}

export function pilotsLayer(selectedCompno: Compno, setSelectedCompno: (compno: Compno) => void, now: Epoch) {
    const data = useSelector((state) => selectAllPositions(state, now));

    // Stable key for the pilot list so we only rebuild the atlas when pilots
    // actually join/leave — not on every position tick.
    const compnoKey = useMemo(() => data.map((d) => d.compno).sort().join(','), [data]);

    const [atlas, setAtlas] = useState<AtlasState | null>(null);

    useEffect(() => {
        if (!compnoKey) return;
        let cancelled = false;
        buildAtlas(compnoKey.split(',') as Compno[]).then((result) => {
            if (!cancelled) setAtlas(result);
        });
        return () => {
            cancelled = true;
        };
    }, [compnoKey]);

    if (!data.length || !atlas || atlas.key !== compnoKey) {
        return null;
    }

    return new IconLayer<(typeof data)[0], {beforeId: string}>({
        id: 'labels',
        data: data,
        iconAtlas: atlas.iconAtlas,
        iconMapping: atlas.iconMapping,
        getColor: (d) => (now - d.t > offlineTime ? [0, 0, 0, 96] : [0, 0, 0, 255]),
        getSize: (_d) => 35,
        getIcon: (d) => (d.compno === selectedCompno ? 'S/' + d.compno : d.compno),
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
