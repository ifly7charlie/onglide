'use client';

import {recentTrackLength} from '../constants';

import type {Epoch, ClassName, Compno, TrackData, ScoreData, SelectedPilotDetails, OtherPilotData, PilotScore} from '../types';

import {SortKey} from '../types';

import {map as _map, reduce as _reduce, find as _find, cloneDeep as _cloneDeep} from 'lodash';

import {OgnTripsLayer} from './ogntripslayer';

// Figure out the baseline date
const oneHalfYearIsh = 3600 * 24 * 180;
const referenceDate =
    (process.env.NEXT_PUBLIC_REPLAY //
        ? parseInt(process.env.NEXT_PUBLIC_REPLAY) - (parseInt(process.env.NEXT_PUBLIC_REPLAY) % oneHalfYearIsh)
        : new Date(Date.now() - (Date.now() % (oneHalfYearIsh * 1000))).getTime() / 1000) - oneHalfYearIsh;

const complexColours = {height: true, aheight: true, climb: true};

export function pilotsTrackLayer(
    props: {trackData: TrackData; selectedCompno: Compno; setSelectedCompno: Function; t: Epoch}, //
    sortKey: SortKey,
    map2d: boolean,
    mapLight: boolean,
    fullPaths: boolean
) {
    if (!props.trackData) {
        console.log('missing layers');
        return [];
    }

    // Add a layer for the recent points for each pilot
    let layers = _reduce(
        props.trackData,
        (result, track, compno) => {
            // Don't include current pilot in list of all
            const selected = compno == props.selectedCompno;

            const p = track.deck;
            if (!p) {
                console.log(`deck missing from ${compno}`, track);
                return result;
            }

            // For all but selected gliders just show most recent track
            const tripsFiltering = {
                currentTime: props.t - referenceDate,
                fadeTrail: !fullPaths && !selected,
                trailLength: recentTrackLength
            };

            result.push(
                new OgnTripsLayer({
                    id: compno + p.trackVersion,
                    compno: compno,
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
                            getColor: complexColours[sortKey] ? {value: track.deckAdditional.colours, size: 3} : undefined
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
                    getWidth: selected ? 8 : 5,
                    widthMinPixels: selected ? 3 : 2,

                    // this only works if we aren't using a UInt array for colours
                    getColor: complexColours[sortKey] ? undefined : selected ? [255, 0, 255, 192] : mapLight ? [0, 0, 0, 127] : [224, 224, 224, 224],
                    // if number of points has changed then we need to redraw, nothing else can change without this changing
                    dataComparator: (newData: any, oldData: any) => newData.numberOfPoints == oldData.numberOfPoints,
                    // as this is a path layer the primary data structure is segments - we only need to redraw the last segment
                    _dataDiff: (newData: any, oldData: any) => [{startRow: oldData.length - 1, endRow: newData.length}],
                    updateTriggers: {
                        getPath: p.posIndex,
                        getColor: [complexColours[sortKey], sortKey, mapLight, selected],
                        getTimestamps: [track.deckAdditional?.tr?.length],
                        getWidth: selected
                    },

                    // Hover & click handlers
                    pickable: true,
                    tt: true,
                    onClick: (i) => {
                        props.setSelectedCompno(compno);
                    },

                    // Filtering options - controls if full path or not
                    ...tripsFiltering
                })
            );
            return result;
        },
        []
    );

    return layers;
}
