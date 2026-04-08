import React, {useCallback, useMemo, useRef, useState} from 'react';
import {Source, Layer, LayerProps} from 'react-map-gl';

import {assembleOptimalDirection, distKm} from './optimalDirection';
import type {PilotScoreDisplay} from '../types';

interface OptimalGridEntry {
    t: number;
    currentLeg: number;
    grid: number[];
}

interface SelectedPosition {
    lat: number;
    lng: number;
}

interface OptimalGridLayersProps {
    optimalGrid: OptimalGridEntry | undefined;
    debouncedScore: PilotScoreDisplay | undefined;
    selectedPosition: SelectedPosition | undefined;
    taskGeoJSONtp: any;
    lastLeg: boolean | undefined | 0;
    constructionLines: boolean;
    aat: boolean | undefined;
}

/**
 * Hooks + JSX for the optimal direction grid heatmap, baseline path,
 * and cell hover visualization. Returns the layers to render and
 * the Map event handlers.
 */
export function useOptimalGridLayers({optimalGrid, debouncedScore, selectedPosition, taskGeoJSONtp, lastLeg, constructionLines, aat}: OptimalGridLayersProps) {
    const [hoverGeoJSON, setHoverGeoJSON] = useState<GeoJSON.FeatureCollection | null>(null);
    const hoverThrottleRef = useRef<number>(0);

    // Filled gradient heatmap for AAT in-sector visualization showing net efficiency of each point
    const optimalDirectionGeoJSON = useMemo(() => {
        if (!constructionLines || !aat || !optimalGrid?.grid?.length || !selectedPosition || (!debouncedScore?.inSector && !debouncedScore?.inPenalty) || lastLeg) {
            return null;
        }

        // Don't display grid from a different sector
        if (optimalGrid.currentLeg !== debouncedScore?.currentLeg) {
            return null;
        }

        const sp = debouncedScore.scoredPoints;
        const currentLeg = debouncedScore.currentLeg;
        if (!sp || sp.length < (currentLeg + 1) * 4 || currentLeg < 1) return null;

        // S = current scored point in this sector (4 floats per point: lng, lat, dist, hdist)
        const sIdx = currentLeg * 4;
        if (sIdx + 1 >= sp.length) return null;

        // Find the sector polygon for the current leg from task GeoJSON
        const sectorFeature = taskGeoJSONtp?.features?.find((f: any) => f.properties?.leg === currentLeg);
        if (!sectorFeature?.geometry) return null;

        const pos = {lat: selectedPosition.lat, lng: selectedPosition.lng};
        const C = debouncedScore.optimalNextSectorPoint;

        // Build convex hull polygon from flat [lng, lat, lng, lat, ...] array.
        // Grid cells inside the hull are already enclosed and skipped.
        const hullFlat = debouncedScore.legs?.[currentLeg]?.convexHull;
        let hullPolygon: GeoJSON.Feature<GeoJSON.Polygon> | null = null;
        if (hullFlat && hullFlat.length >= 8) {
            const coords: [number, number][] = [];
            for (let i = 0; i < hullFlat.length - 2; i += 2) {
                coords.push([hullFlat[i], hullFlat[i + 1]]);
            }
            coords.push(coords[0]); // close the ring
            hullPolygon = {type: 'Feature' as const, properties: {}, geometry: {type: 'Polygon' as const, coordinates: [coords]}};
        }

        const baseline = debouncedScore.optimalGridBaseline;
        if (baseline == null) return null;

        return assembleOptimalDirection(optimalGrid.grid, pos, baseline, sectorFeature as GeoJSON.Feature<GeoJSON.Polygon>, hullPolygon, C);
    }, [
        optimalGrid,
        debouncedScore?.optimalGridBaseline,
        debouncedScore?.scoredPoints,
        debouncedScore?.currentLeg,
        debouncedScore?.inSector,
        debouncedScore?.inPenalty,
        debouncedScore?.optimalNextSectorPoint?.lat,
        debouncedScore?.optimalNextSectorPoint?.lng,
        debouncedScore?.legs,
        selectedPosition?.lat,
        selectedPosition?.lng,
        constructionLines,
        aat,
        lastLeg,
        taskGeoJSONtp
    ]);

    // Handle hover on optimal direction grid cells -- throttled, builds GeoJSON directly
    const onGridHover = useCallback(
        (e: any) => {
            const now = performance.now();
            const feature = e.features?.[0];
            if (!feature?.properties?.prevLng) {
                setHoverGeoJSON(null);
                return;
            }
            // Throttle to ~50ms
            if (now - hoverThrottleRef.current < 50) return;
            hoverThrottleRef.current = now;

            const coords = feature.geometry.coordinates[0];
            const p = feature.properties;
            const cellLng = (coords[0][0] + coords[2][0]) / 2;
            const cellLat = (coords[0][1] + coords[2][1]) / 2;
            const pos = selectedPosition;
            if (!pos) return;

            const prevDist = distKm({lat: p.prevLat, lng: p.prevLng}, {lat: cellLat, lng: cellLng});
            const nextDist = distKm({lat: cellLat, lng: cellLng}, {lat: p.nextLat, lng: p.nextLng});

            setHoverGeoJSON({
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: {lineType: 'transit', label: `${p.transitDist}km`},
                        geometry: {type: 'LineString', coordinates: [[pos.lng, pos.lat], [cellLng, cellLat]]}
                    },
                    {
                        type: 'Feature',
                        properties: {lineType: 'taskLeg', label: `${Math.round(prevDist * 10) / 10}km`},
                        geometry: {type: 'LineString', coordinates: [[p.prevLng, p.prevLat], [cellLng, cellLat]]}
                    },
                    {
                        type: 'Feature',
                        properties: {lineType: 'taskLeg', label: `${Math.round(nextDist * 10) / 10}km`},
                        geometry: {type: 'LineString', coordinates: [[cellLng, cellLat], [p.nextLng, p.nextLat]]}
                    },
                    {
                        type: 'Feature',
                        properties: {lineType: 'apex', label: `${p.improvement >= 0 ? '+' : ''}${p.improvement}km\n${Math.round(p.ratio * 10) / 10}:1`},
                        geometry: {type: 'Point', coordinates: [cellLng, cellLat]}
                    }
                ]
            });
        },
        [selectedPosition]
    );
    const onGridLeave = useCallback(() => setHoverGeoJSON(null), []);

    // Baseline path visualization: scored path + max remaining forward
    const baselineGeoJSON = useMemo(() => {
        const bp = debouncedScore?.optimalGridBaselinePath;
        if (!bp || bp.length < 4) return null;
        const coords: [number, number][] = [];
        for (let i = 0; i + 1 < bp.length; i += 2) {
            coords.push([bp[i], bp[i + 1]]);
        }
        const features: any[] = [];
        // First leg with distance label
        if (coords.length >= 2) {
            features.push({
                type: 'Feature' as const,
                properties: {label: `${Math.round(debouncedScore?.optimalGridBaseline || 0)}km`},
                geometry: {type: 'LineString' as const, coordinates: coords.slice(0, 2)}
            });
        }
        // Remaining legs without label
        if (coords.length > 2) {
            features.push({
                type: 'Feature' as const,
                properties: {},
                geometry: {type: 'LineString' as const, coordinates: coords.slice(1)}
            });
        }
        return features.length ? {type: 'FeatureCollection' as const, features} : null;
    }, [debouncedScore?.optimalGridBaselinePath, debouncedScore?.optimalGridBaseline]);

    return {optimalDirectionGeoJSON, baselineGeoJSON, hoverGeoJSON, onGridHover, onGridLeave};
}

/** JSX for the optimal grid Sources/Layers. Render inside the Map component. */
export function OptimalGridSources({optimalDirectionGeoJSON, baselineGeoJSON, hoverGeoJSON}: {optimalDirectionGeoJSON: GeoJSON.FeatureCollection | null; baselineGeoJSON: GeoJSON.FeatureCollection | null; hoverGeoJSON: GeoJSON.FeatureCollection | null}) {
    return (
        <>
            {optimalDirectionGeoJSON ? (
                <Source type="geojson" data={optimalDirectionGeoJSON} key={'optimal_'} id={'optimal'}>
                    <Layer {...optimalHeatmapStyle} />
                    <Layer {...optimalNextPointStyle} />
                </Source>
            ) : null}
            {baselineGeoJSON ? (
                <Source type="geojson" data={baselineGeoJSON} key={'optimal_baseline_'}>
                    <Layer {...optimalBaselineStyle} />
                    <Layer {...optimalBaselineLabelStyle} />
                </Source>
            ) : null}
            {hoverGeoJSON ? (
                <Source type="geojson" data={hoverGeoJSON} key={'optimal_hover_'}>
                    <Layer {...optimalHoverTransitStyle} />
                    <Layer {...optimalHoverTransitLabelStyle} />
                    <Layer {...optimalHoverLegStyle} />
                    <Layer {...optimalHoverLegLabelStyle} />
                    <Layer {...optimalHoverApexStyle} />
                </Source>
            ) : null}
        </>
    );
}

// --- Layer styles ---

const optimalHeatmapStyle: LayerProps = {
    id: 'optimal_heatmap',
    type: 'fill',
    filter: ['has', 'delta'],
    paint: {
        'fill-color': ['interpolate', ['linear'], ['get', 'delta'], -1, 'rgba(255, 0, 0, 0.4)', -0.25, 'rgba(255, 165, 0, 0.4)', 0, 'rgba(255, 255, 0, 0.4)', 0.25, 'rgba(144, 238, 144, 0.4)', 1, 'rgba(0, 180, 0, 0.4)'],
        'fill-opacity': 1
    }
};

const optimalNextPointStyle: LayerProps = {
    id: 'optimal_next_point',
    type: 'circle',
    filter: ['==', ['get', 'optimalNextPoint'], true],
    paint: {
        'circle-radius': 8,
        'circle-color': '#ff0000',
        'circle-stroke-color': '#000',
        'circle-stroke-width': 2,
        'circle-opacity': 1
    }
};

const optimalBaselineStyle: LayerProps = {
    id: 'optimal_baseline',
    type: 'line',
    paint: {
        'line-color': '#ff00ff',
        'line-width': 2,
        'line-opacity': 0.8,
        'line-dasharray': [6, 3]
    }
};

const optimalBaselineLabelStyle: LayerProps = {
    id: 'optimal_baseline_label',
    type: 'symbol',
    layout: {
        'symbol-placement': 'line-center',
        'text-field': ['get', 'label'],
        'text-size': 12,
        'text-allow-overlap': true
    },
    paint: {
        'text-color': '#fff',
        'text-halo-color': '#000',
        'text-halo-width': 1.5
    }
};

const optimalHoverTransitStyle: LayerProps = {
    id: 'optimal_hover_transit',
    type: 'line',
    filter: ['==', ['get', 'lineType'], 'transit'],
    paint: {
        'line-color': '#fff',
        'line-width': 2,
        'line-opacity': 0.9,
        'line-dasharray': [4, 2]
    }
};

const optimalHoverTransitLabelStyle: LayerProps = {
    id: 'optimal_hover_transit_label',
    type: 'symbol',
    filter: ['==', ['get', 'lineType'], 'transit'],
    layout: {
        'symbol-placement': 'line-center',
        'text-field': ['get', 'label'],
        'text-size': 12,
        'text-allow-overlap': true
    },
    paint: {
        'text-color': '#fff',
        'text-halo-color': '#000',
        'text-halo-width': 1.5
    }
};

const optimalHoverLegStyle: LayerProps = {
    id: 'optimal_hover_leg',
    type: 'line',
    filter: ['==', ['get', 'lineType'], 'taskLeg'],
    paint: {
        'line-color': '#00bfff',
        'line-width': 3,
        'line-opacity': 0.9
    }
};

const optimalHoverLegLabelStyle: LayerProps = {
    id: 'optimal_hover_leg_label',
    type: 'symbol',
    filter: ['==', ['get', 'lineType'], 'taskLeg'],
    layout: {
        'symbol-placement': 'line-center',
        'text-field': ['get', 'label'],
        'text-size': 12,
        'text-allow-overlap': true
    },
    paint: {
        'text-color': '#fff',
        'text-halo-color': '#000',
        'text-halo-width': 1.5
    }
};

const optimalHoverApexStyle: LayerProps = {
    id: 'optimal_hover_apex',
    type: 'symbol',
    filter: ['==', ['get', 'lineType'], 'apex'],
    layout: {
        'text-field': ['get', 'label'],
        'text-size': 14,
        'text-allow-overlap': true,
        'text-anchor': 'bottom',
        'text-offset': [0, -0.5]
    },
    paint: {
        'text-color': '#ffff00',
        'text-halo-color': '#000',
        'text-halo-width': 2
    }
};
