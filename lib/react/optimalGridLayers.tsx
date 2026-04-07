import React, {useCallback, useMemo, useRef, useState} from 'react';
import {Source, Layer, LayerProps} from 'react-map-gl';

import {assembleOptimalDirection} from './optimalDirection';
import lineIntersect from '@turf/line-intersect';
import {lineString as turfLineString} from '@turf/helpers';

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
    const [hoverGeoJSON, setHoverGeoJSON] = useState<any>(null);
    const hoverThrottleRef = useRef<number>(0);

    // Filled gradient heatmap for AAT in-sector visualization showing net efficiency of each point
    const optimalDirectionGeoJSON = useMemo(() => {
        if (!constructionLines || !aat || !optimalGrid?.grid?.length || !selectedPosition || (!debouncedScore?.inSector && !debouncedScore?.inPenalty) || lastLeg) {
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

        const aIdx = (currentLeg - 1) * 4;
        const A = {lng: sp[aIdx], lat: sp[aIdx + 1]};
        const S = {lng: sp[sIdx], lat: sp[sIdx + 1]};
        const pos = {lat: selectedPosition.lat, lng: selectedPosition.lng};
        const C = debouncedScore.optimalNextSectorPoint;

        // Build convex hull polygon from flat [lng, lat, lng, lat, ...] array,
        // expanded with min distance line / sector boundary intersection points.
        // Grid cells inside this hull are already enclosed and won't be rendered.
        const hullFlat = debouncedScore.legs?.[currentLeg]?.convexHull;
        let hullPolygon: any = null;
        if (hullFlat && hullFlat.length >= 8) {
            const hullPoints: [number, number][] = [];
            for (let i = 0; i < hullFlat.length - 2; i += 2) {
                hullPoints.push([hullFlat[i], hullFlat[i + 1]]);
            }

            // Find where the min distance line crosses the sector boundary, and
            // include the arc of the sector boundary between those crossings on the
            // A-side. This encloses the "dead zone" that won't improve the score.
            try {
                const sectorRing: [number, number][] = (sectorFeature as any).geometry.coordinates[0];
                const sectorLine = turfLineString(sectorRing);
                const n = sectorRing.length - 1; // exclude closing vertex (same as first)

                // A -> S segment (entry side)
                const entryLine = turfLineString([
                    [A.lng, A.lat],
                    [S.lng, S.lat]
                ]);
                const entryHits = lineIntersect(entryLine, sectorLine);
                const entryPt = entryHits.features[0]?.geometry.coordinates as [number, number] | undefined;

                // S -> next min point segment (exit side)
                let exitPt: [number, number] | undefined;
                const minPts = debouncedScore.minDistancePoints;
                if (minPts && minPts.length >= 8) {
                    const nextMin: [number, number] = [minPts[4], minPts[5]];
                    const exitLine = turfLineString([[S.lng, S.lat], nextMin]);
                    const exitHits = lineIntersect(exitLine, sectorLine);
                    exitPt = exitHits.features[0]?.geometry.coordinates as [number, number] | undefined;
                }

                if (entryPt && exitPt) {
                    hullPoints.push(entryPt);
                    hullPoints.push(exitPt);

                    // Find which segment each intersection lies on
                    const segDist2 = (pt: [number, number], a: [number, number], b: [number, number]) => {
                        const dx = b[0] - a[0],
                            dy = b[1] - a[1];
                        const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / (dx * dx + dy * dy)));
                        const px = a[0] + t * dx - pt[0],
                            py = a[1] + t * dy - pt[1];
                        return px * px + py * py;
                    };
                    let entryIdx = 0,
                        exitIdx = 0,
                        bestE = Infinity,
                        bestX = Infinity;
                    for (let k = 0; k < n; k++) {
                        const d = segDist2(entryPt, sectorRing[k], sectorRing[k + 1]);
                        if (d < bestE) {
                            bestE = d;
                            entryIdx = k;
                        }
                        const d2 = segDist2(exitPt, sectorRing[k], sectorRing[k + 1]);
                        if (d2 < bestX) {
                            bestX = d2;
                            exitIdx = k;
                        }
                    }

                    // Collect vertices in both directions around the ring
                    const fwd: [number, number][] = [];
                    for (let k = (entryIdx + 1) % n; k !== (exitIdx + 1) % n; k = (k + 1) % n) {
                        fwd.push(sectorRing[k]);
                    }
                    const bwd: [number, number][] = [];
                    for (let k = (exitIdx + 1) % n; k !== (entryIdx + 1) % n; k = (k + 1) % n) {
                        bwd.push(sectorRing[k]);
                    }

                    // Pick the arc on the A-side using cross product with the entry->exit line
                    const crossVal = (p: [number, number]) => (p[0] - entryPt[0]) * (exitPt[1] - entryPt[1]) - (p[1] - entryPt[1]) * (exitPt[0] - entryPt[0]);
                    const aSide = crossVal([A.lng, A.lat]);
                    const fwdTest = fwd.length > 0 ? crossVal(fwd[Math.floor(fwd.length / 2)]) : 0;
                    const arcVertices = aSide * fwdTest > 0 ? fwd : bwd;

                    for (const v of arcVertices) {
                        hullPoints.push(v);
                    }
                } else {
                    // Only got one intersection -- still add it
                    if (entryPt) hullPoints.push(entryPt);
                    if (exitPt) hullPoints.push(exitPt);
                }
            } catch (_e) {
                // If intersection computation fails, proceed with hull points only
            }

            // Rebuild convex hull with the expanded point set
            if (hullPoints.length >= 3) {
                const sorted = hullPoints.map((p) => ({lng: p[0], lat: p[1]})).sort((a, b) => (a.lat === b.lat ? a.lng - b.lng : a.lat - b.lat));

                // Simple convex hull (Andrew's monotone chain)
                const cross = (o: any, a: any, b: any) => (a.lat - o.lat) * (b.lng - o.lng) - (a.lng - o.lng) * (b.lat - o.lat);
                const lower: any[] = [];
                for (const p of sorted) {
                    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
                    lower.push(p);
                }
                const upper: any[] = [];
                for (let i = sorted.length - 1; i >= 0; i--) {
                    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], sorted[i]) <= 0) upper.pop();
                    upper.push(sorted[i]);
                }
                upper.pop();
                lower.pop();
                const hull = lower.concat(upper);

                if (hull.length >= 3) {
                    const coords = hull.map((p) => [p.lng, p.lat] as [number, number]);
                    coords.push(coords[0]); // close the ring
                    hullPolygon = {type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [coords]}};
                }
            }
        }

        const baseline = debouncedScore.optimalGridBaseline;
        if (baseline == null) return null;

        return assembleOptimalDirection(optimalGrid.grid, pos, baseline, sectorFeature as any, hullPolygon, C);
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
        debouncedScore?.minDistancePoints,
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
                        properties: {lineType: 'taskPath', label: `${p.taskDist}km (${p.improvement >= 0 ? '+' : ''}${p.improvement}km)`},
                        geometry: {type: 'LineString', coordinates: [[p.prevLng, p.prevLat], [cellLng, cellLat], [p.nextLng, p.nextLat]]}
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
export function OptimalGridSources({optimalDirectionGeoJSON, baselineGeoJSON, hoverGeoJSON}: {optimalDirectionGeoJSON: any; baselineGeoJSON: any; hoverGeoJSON: any}) {
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
                    <Layer {...optimalHoverPathStyle} />
                    <Layer {...optimalHoverPathLabelStyle} />
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

const optimalHoverPathStyle: LayerProps = {
    id: 'optimal_hover_path',
    type: 'line',
    filter: ['==', ['get', 'lineType'], 'taskPath'],
    paint: {
        'line-color': '#00bfff',
        'line-width': 3,
        'line-opacity': 0.9
    }
};

const optimalHoverPathLabelStyle: LayerProps = {
    id: 'optimal_hover_path_label',
    type: 'symbol',
    filter: ['==', ['get', 'lineType'], 'taskPath'],
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
