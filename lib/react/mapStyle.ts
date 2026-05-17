import type {StyleSpecification} from 'maplibre-gl';

const PMTILES_URL = process.env.NEXT_PUBLIC_PMTILES_URL || '';
// Optional: a separate labels-only pmtiles. When set, symbol (label) layers read
// from this smaller source so that in satellite mode — where every base vector
// layer is hidden — MapLibre stops fetching the big base tiles entirely.
const PMTILES_LABELS_URL = process.env.NEXT_PUBLIC_PMTILES_LABELS_URL || '';
const DEM_TILE_URL = process.env.NEXT_PUBLIC_DEM_TILE_URL || 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
// EOX Sentinel-2 cloudless 2024 mosaic (WMTS, GoogleMapsCompatible tiling scheme).
// Free for non-commercial use; attribution is mandatory — see SATELLITE_ATTRIBUTION
// below and https://s2maps.eu/ for licence terms.
const SATELLITE_TILE_URL = 'https://tiles.maps.eox.at/wmts?layer=s2cloudless-2024_3857&style=default&tilematrixset=g&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image/jpeg&TileMatrix={z}&TileCol={x}&TileRow={y}';
export const SATELLITE_ATTRIBUTION = 'Sentinel-2 cloudless 2024 by <a href="https://s2maps.eu" target="_blank" rel="noopener">EOX IT Services GmbH</a> (Contains modified Copernicus Sentinel data 2024)';

const HAS_SPLIT_LABELS = PMTILES_LABELS_URL && PMTILES_LABELS_URL !== PMTILES_URL;
export const LABELS_SOURCE = HAS_SPLIT_LABELS ? 'openmaptiles_labels' : 'openmaptiles';
// Self-hosted glyph atlases (SDF PBFs) for Atkinson Hyperlegible Next — the same UI typeface.
// See README "Map fonts" for the one-time generation step with font-maker.
const GLYPHS_URL = process.env.NEXT_PUBLIC_GLYPHS_URL || '/fonts/glyphs/{fontstack}/{range}.pbf';

const FONT_REGULAR = ['Atkinson Hyperlegible Next Regular'];
const FONT_BOLD = ['Atkinson Hyperlegible Next Bold'];
const FONT_ITALIC = ['Atkinson Hyperlegible Next Regular Italic'];

export function buildMapStyle(): StyleSpecification {
    return {
        version: 8,
        glyphs: GLYPHS_URL,
        sources: {
            openmaptiles: {
                type: 'vector',
                url: `pmtiles://${PMTILES_URL}`,
                attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            },
            ...(HAS_SPLIT_LABELS
                ? {
                      openmaptiles_labels: {
                          type: 'vector' as const,
                          url: `pmtiles://${PMTILES_LABELS_URL}`
                      }
                  }
                : {}),
            satellite: {
                type: 'raster',
                tiles: [SATELLITE_TILE_URL],
                tileSize: 256,
                // EOX s2cloudless tops out at zoom 17 on the GoogleMapsCompatible matrix set
                maxzoom: 17,
                attribution: SATELLITE_ATTRIBUTION
            },
            terrain: {
                type: 'raster-dem',
                tiles: [DEM_TILE_URL],
                tileSize: 256,
                encoding: 'terrarium',
                maxzoom: 15,
                attribution: 'Elevation: AWS Open Data — USGS, NASA, CGIAR, NRCan, GEBCO, EU-DEM'
            }
        },
        terrain: {source: 'terrain', exaggeration: 1},
        sky: {
            'sky-color': '#87ceeb',
            'sky-horizon-blend': 0.5,
            'horizon-color': '#e6f0f7',
            'horizon-fog-blend': 0.5,
            'fog-color': '#e6f0f7',
            'fog-ground-blend': 0.5,
            // Blend in atmospheric rendering as we zoom in (matches the old
            // sky-opacity curve on the Mapbox sky layer).
            'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0, 5, 0.3, 8, 1]
        },
        layers: [
            {id: 'background', type: 'background', paint: {'background-color': '#f8f4f0'}},
            {
                id: 'landcover-grass',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'landcover',
                filter: ['==', 'class', 'grass'],
                paint: {'fill-color': '#d8e8c8', 'fill-opacity': 0.6}
            },
            {
                id: 'landcover-wood',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'landcover',
                filter: ['==', 'class', 'wood'],
                paint: {'fill-color': '#c8d8b8', 'fill-opacity': 0.6}
            },
            {
                id: 'landuse-residential',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'landuse',
                filter: ['==', 'class', 'residential'],
                paint: {'fill-color': '#eae6e0'}
            },
            {
                id: 'park',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'park',
                paint: {'fill-color': '#d8e8c8', 'fill-opacity': 0.4}
            },
            {
                id: 'water',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'water',
                paint: {'fill-color': '#a0c8e0'}
            },
            {
                id: 'waterway',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'waterway',
                paint: {'line-color': '#a0c8e0', 'line-width': 1}
            },
            {
                id: 'landuse-aerodrome',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'aeroway',
                filter: ['==', '$type', 'Polygon'],
                paint: {'fill-color': '#e0e0e0'}
            },
            {
                id: 'aeroway-runway',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'aeroway',
                filter: ['all', ['==', '$type', 'LineString'], ['==', 'class', 'runway']],
                paint: {'line-color': '#a8a8a8', 'line-width': 4}
            },
            {
                id: 'aeroway-taxiway',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'aeroway',
                filter: ['all', ['==', '$type', 'LineString'], ['==', 'class', 'taxiway']],
                paint: {'line-color': '#a8a8a8', 'line-width': 1}
            },
            {
                id: 'building',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'building',
                minzoom: 12,
                paint: {'fill-color': '#e0dcd4', 'fill-outline-color': '#c8c4bc'}
            },
            {
                id: 'road-minor',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'transportation',
                filter: ['in', 'class', 'minor', 'service', 'track'],
                paint: {'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 3]}
            },
            {
                id: 'road-secondary',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'transportation',
                filter: ['in', 'class', 'secondary', 'tertiary'],
                paint: {'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 16, 6]}
            },
            {
                id: 'road-primary',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'transportation',
                filter: ['==', 'class', 'primary'],
                paint: {'line-color': '#fddc8a', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 16, 8]}
            },
            {
                id: 'road-trunk',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'transportation',
                filter: ['==', 'class', 'trunk'],
                paint: {'line-color': '#fbb65d', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.75, 16, 10]}
            },
            {
                id: 'road-motorway',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'transportation',
                filter: ['==', 'class', 'motorway'],
                paint: {'line-color': '#e892a2', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 16, 12]}
            },
            {
                id: 'boundary-country',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'boundary',
                filter: ['==', 'admin_level', 2],
                paint: {'line-color': '#888', 'line-width': 1, 'line-dasharray': [2, 2]}
            },
            {
                id: 'boundary-state',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'boundary',
                filter: ['==', 'admin_level', 4],
                paint: {'line-color': '#aaa', 'line-width': 0.5, 'line-dasharray': [2, 2]}
            },
            {
                // Satellite raster sits here so the overlay layers below it —
                // contours, landmark fills/lines, road and other labels — paint
                // on top of the imagery rather than being hidden behind it.
                id: 'satellite',
                type: 'raster',
                source: 'satellite',
                layout: {visibility: 'none'},
                paint: {'raster-opacity': 1}
            },
            {
                id: 'contour-line',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'contour',
                minzoom: 10,
                paint: {'line-color': '#a87040', 'line-width': 0.5, 'line-opacity': 0.4}
            },
            {
                // Solar farm extent from the landmarks schema — a large unlandable
                // surface; the footprint matters for routing, so it is drawn as a
                // shaded area (the landmark-point layer adds the icon at its centroid).
                id: 'landmark-solar',
                type: 'fill',
                source: LABELS_SOURCE,
                'source-layer': 'landmark',
                filter: ['==', 'class', 'solar_farm'],
                minzoom: 10,
                paint: {'fill-color': '#33415c', 'fill-opacity': 0.4, 'fill-outline-color': '#1c2535'}
            },
            {
                // White casing under the power line so the dark warning colour stays
                // visible against dark satellite imagery. On the light street basemap
                // the casing is effectively invisible, so that view is unchanged.
                id: 'landmark-power-line-casing',
                type: 'line',
                source: LABELS_SOURCE,
                'source-layer': 'landmark',
                filter: ['==', 'class', 'power_line'],
                minzoom: 10,
                paint: {
                    'line-color': '#ffffff',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.4, 16, 5],
                    'line-opacity': 0.55
                }
            },
            {
                // High-voltage power lines from the landmarks schema — a cable hazard,
                // so drawn dashed in a warning colour.
                id: 'landmark-power-line',
                type: 'line',
                source: LABELS_SOURCE,
                'source-layer': 'landmark',
                filter: ['==', 'class', 'power_line'],
                minzoom: 10,
                paint: {
                    'line-color': '#b03060',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 16, 2],
                    'line-dasharray': [3, 2],
                    'line-opacity': 0.8
                }
            },
            {
                id: 'road-label-major',
                type: 'symbol',
                source: LABELS_SOURCE,
                'source-layer': 'transportation_name',
                minzoom: 10,
                filter: ['in', 'class', 'motorway', 'trunk', 'primary'],
                layout: {
                    'symbol-placement': 'line',
                    'text-field': ['coalesce', ['get', 'ref'], ['get', 'name']],
                    'text-size': 11,
                    'text-font': FONT_REGULAR
                },
                paint: {'text-color': '#333', 'text-halo-color': '#fff', 'text-halo-width': 2}
            },
            {
                id: 'water-label-line',
                type: 'symbol',
                source: LABELS_SOURCE,
                'source-layer': 'water_name',
                filter: ['==', ['geometry-type'], 'LineString'],
                minzoom: 8,
                layout: {
                    'text-field': ['get', 'name'],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 13],
                    'text-font': FONT_ITALIC,
                    'symbol-placement': 'line'
                },
                paint: {'text-color': '#2d4d6a', 'text-halo-color': '#fff', 'text-halo-width': 1}
            },
            {
                id: 'water-label-point',
                type: 'symbol',
                source: LABELS_SOURCE,
                'source-layer': 'water_name',
                filter: ['==', ['geometry-type'], 'Point'],
                minzoom: 8,
                layout: {
                    'text-field': ['get', 'name'],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 13],
                    'text-font': FONT_ITALIC,
                    'symbol-placement': 'point'
                },
                paint: {'text-color': '#2d4d6a', 'text-halo-color': '#fff', 'text-halo-width': 1}
            },
            {
                id: 'aerodrome-label',
                type: 'symbol',
                source: LABELS_SOURCE,
                'source-layer': 'aerodrome_label',
                minzoom: 9,
                layout: {
                    'icon-image': 'airport',
                    'icon-anchor': 'bottom',
                    'icon-allow-overlap': true,
                    'text-field': ['case', ['has', 'icao'], ['concat', ['get', 'name'], ' (', ['get', 'icao'], ')'], ['get', 'name']],
                    'text-size': 11,
                    'text-anchor': 'top',
                    'text-offset': [0, 0.4],
                    'text-font': FONT_REGULAR
                },
                paint: {'text-color': '#444', 'text-halo-color': '#fff', 'text-halo-width': 1.5}
            },
            {
                id: 'mountain-peak',
                type: 'symbol',
                source: LABELS_SOURCE,
                'source-layer': 'mountain_peak',
                minzoom: 11,
                layout: {
                    'icon-image': 'peak',
                    'icon-anchor': 'bottom',
                    'icon-allow-overlap': false,
                    'text-field': [
                        'case',
                        ['all', ['has', 'ele'], ['!=', ['coalesce', ['get', 'name'], ''], '']],
                        ['concat', ['get', 'name'], '\n', ['get', 'ele'], 'm'],
                        ['has', 'ele'],
                        ['concat', ['get', 'ele'], 'm'],
                        ['coalesce', ['get', 'name'], '']
                    ],
                    'text-size': 10,
                    'text-anchor': 'top',
                    'text-offset': [0, 0.2],
                    'text-font': FONT_REGULAR
                },
                paint: {'text-color': '#66382c', 'text-halo-color': '#fff', 'text-halo-width': 1.5}
            },
            {
                id: 'place-city',
                type: 'symbol',
                source: LABELS_SOURCE,
                'source-layer': 'place',
                filter: ['in', 'class', 'city', 'town'],
                layout: {
                    'text-field': '{name}',
                    'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 12, 16],
                    'text-anchor': 'center',
                    'text-font': FONT_BOLD
                },
                paint: {'text-color': '#333', 'text-halo-color': '#fff', 'text-halo-width': 1.5}
            },
            {
                id: 'place-village',
                type: 'symbol',
                source: LABELS_SOURCE,
                'source-layer': 'place',
                minzoom: 10,
                filter: ['in', 'class', 'village', 'suburb', 'hamlet'],
                layout: {
                    'text-field': '{name}',
                    'text-size': ['interpolate', ['linear'], ['zoom'], 10, 9, 14, 13],
                    'text-anchor': 'center',
                    'text-font': FONT_REGULAR
                },
                paint: {'text-color': '#555', 'text-halo-color': '#fff', 'text-halo-width': 1.5}
            },
            {
                // Landmark + obstacle symbols from the landmarks schema, each with its
                // own icon (drawn in mapIcons.ts): obstacles — turbines, masts, towers,
                // cooling towers, power/solar plants — in warning red; heritage landmarks
                // — castles, cathedrals, lighthouses, windmills, monuments — in muted
                // gold. Power lines and solar-farm extent render in their own layers;
                // memorials and city gates are dropped upstream in landmarks.yml.
                id: 'landmark-point',
                type: 'symbol',
                source: LABELS_SOURCE,
                'source-layer': 'landmark',
                filter: ['!=', 'class', 'power_line'],
                minzoom: 10,
                layout: {
                    'icon-image': ['match', ['get', 'class'], 'wind_turbine', 'wind-turbine', 'cooling_tower', 'cooling-tower', 'mast', 'mast', 'tower', 'tower', 'power_plant', 'power-plant', 'solar_farm', 'solar-farm', 'cathedral', 'cathedral', 'lighthouse', 'lighthouse', 'windmill', 'windmill', 'monument', 'monument', ['castle', 'fort', 'manor', 'ruins'], 'castle', 'castle'],
                    'icon-size': ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 'class'], 'wind_turbine', 0.7, 0.5], 16, ['match', ['get', 'class'], 'wind_turbine', 1.4, 1]],
                    'icon-anchor': 'bottom',
                    'icon-allow-overlap': false,
                    'text-field': ['step', ['zoom'], '', 12, ['get', 'name']],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 13],
                    'text-font': FONT_REGULAR,
                    'text-anchor': 'top',
                    'text-offset': [0, 0.3],
                    'text-optional': true
                },
                paint: {'text-color': '#5a3d1e', 'text-halo-color': '#fff', 'text-halo-width': 1.5}
            }
        ]
    };
}
