'use client';

import {recentTrackLength} from '../constants';

import type {Epoch, Compno, SortKey} from '../types';
import {PathLength} from '../types';

import {selectAllTracks} from '../redux/tracksSlice';
import {selectAllTimes} from '../redux/scoresSlice';
import {useSelector} from '../redux';

import {map as _map, reduce as _reduce, find as _find, cloneDeep as _cloneDeep} from 'lodash';

import {OgnTripsLayer} from './ogntripslayer';

// Figure out the baseline date
import {referenceDate} from '../flightprocessing/referenceDate';

const complexColours = {height: true, aheight: true, climb: true};

const selectedColour = [255, 0, 255];
const c = {
    light: {
        all: [32, 32, 32, 128],
        normal: [32, 32, 32]
    },
    dark: {
        normal: [255, 255, 255],
        all: [255, 255, 255, 128]
    }
};

export function pilotsTrackLayer(
    props: {selectedCompno: Compno; setSelectedCompno: Function; replayTime: Epoch}, //
    latestUpdate: Epoch,
    sortKey: SortKey,
    map2d: boolean,
    mapLight: boolean,
    fullPaths: PathLength
) {
    const trackData = useSelector((state) => selectAllTracks(state));
    const startTimes = useSelector((state) => selectAllTimes(state));

    if (!trackData) {
        console.log('missing layers');
        return [];
    }

    // Add a layer for the recent points for each pilot
    let layers = _map(trackData, (track, compno) => {
        // Don't include current pilot in list of all
        const selected = compno == props.selectedCompno;

        const p = track.deck;
        if (!p) {
            console.log(`deck missing from ${compno}`, track);
            return;
        }

        const currentTime = props.replayTime || latestUpdate;
        const clipStartAt = (startTimes[compno]?.startUtc ?? Infinity) - 30;

        // For all but selected gliders just show most recent track
        const tripsFiltering = {
            currentTime: currentTime - referenceDate - 2,
            fadeTrail: fullPaths == PathLength.recent || (fullPaths == PathLength.selectedFull && !selected) || currentTime <= clipStartAt,
            trailLength: recentTrackLength,
            startTime: currentTime > clipStartAt ? clipStartAt - 5 - referenceDate : 0
        };

        console.log(tripsFiltering, startTimes[compno]);

        const getColor = sortKey == 'climb' ? {value: track.deckAdditional.climb, size: 3} : sortKey == 'aheight' ? {value: track.deckAdditional.aheight, size: 3} : undefined;

        return new OgnTripsLayer({
            id: compno + p.trackVersion,
            compno: compno,
            beforeId: 'tpe',
            data: {
                length: p.segmentIndex, // note this is not segmentIndex-1 (segmentIndex is one we are in, indices[segmentIndex] is defined)
                startIndices: p.indices,
                numberOfPoints: p.posIndex,
                t: p.t,
                v: p.climbRate,
                g: p.agl,
                p: p.positions,
                attributes: {
                    getPath: {value: p.positions, size: 3},
                    getTimestamps: {value: track.deckAdditional.tr, size: 1},
                    getColor
                }
            },

            // Rendering options, we will always render 3d
            _pathType: 'open',
            positionFormat: 'XYZ',
            fp64: false,
            jointRounded: true,

            // For 2d we don't want to use billboard as it doesn't render on some devices
            billboard: map2d ? false : true,

            // How wide is the line
            getWidth: selected ? 5 : 3,
            widthUnits: 'meters',
            widthMinPixels: selected ? 3 : 2,

            // this only works if we aren't using a UInt array for colours
            getColor: getColor ? undefined : selected ? selectedColour : c[mapLight ? 'light' : 'dark'][fullPaths ? 'all' : 'normal'],

            // if number of points has changed then we need to redraw, nothing else can change without this changing
            dataComparator: (newData: any, oldData: any) => newData.numberOfPoints == oldData.numberOfPoints,
            // as this is a path layer the primary data structure is segments - we only need to redraw the last segment
            _dataDiff: (newData: any, oldData: any) => [{startRow: oldData.length - 1, endRow: newData.length}],
            updateTriggers: {
                getPath: p.posIndex,
                getColor: [mapLight, complexColours[sortKey] ? sortKey : 'normal', mapLight, selected, fullPaths],
                getTimestamps: [track.deckAdditional?.tr?.length],
                getWidth: selected
            },

            // Hover & click handlers
            pickable: true,
            tt: true,
            onClick: () => {
                props.setSelectedCompno(compno);
            },

            // Filtering options - controls if full path or not
            ...tripsFiltering
        });
    });

    return layers;
}
