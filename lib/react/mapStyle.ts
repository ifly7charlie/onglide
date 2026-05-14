import type {StyleSpecification} from 'maplibre-gl';

const PMTILES_URL = process.env.NEXT_PUBLIC_PMTILES_URL || '';
// Optional: a separate labels-only pmtiles. When set, symbol (label) layers read
// from this smaller source so that in satellite mode — where every base vector
// layer is hidden — MapLibre stops fetching the big base tiles entirely.
const PMTILES_LABELS_URL = process.env.NEXT_PUBLIC_PMTILES_LABELS_URL || '';
const DEM_TILE_URL = process.env.NEXT_PUBLIC_DEM_TILE_URL || 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
// Satellite imagery temporarily disabled
// const SATELLITE_TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

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
            // Satellite imagery temporarily disabled
            // satellite: {
            //     type: 'raster',
            //     tiles: [SATELLITE_TILE_URL],
            //     tileSize: 256,
            //     maxzoom: 19,
            //     attribution: 'Imagery © Esri, Maxar, Earthstar Geographics'
            // },
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
                id: 'contour-line',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'contour',
                minzoom: 10,
                paint: {'line-color': '#a87040', 'line-width': 0.5, 'line-opacity': 0.4}
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
                    'text-field': ['coalesce', ['get', 'ref'], ['get', 'name:latin']],
                    'text-size': 11,
                    'text-font': FONT_REGULAR
                },
                paint: {'text-color': '#333', 'text-halo-color': '#fff', 'text-halo-width': 2}
            },
            // Satellite imagery temporarily disabled
            // {
            //     id: 'satellite',
            //     type: 'raster',
            //     source: 'satellite',
            //     layout: {visibility: 'none'},
            //     paint: {'raster-opacity': 1}
            // },
            {
                id: 'water-label-line',
                type: 'symbol',
                source: LABELS_SOURCE,
                'source-layer': 'water_name',
                filter: ['==', ['geometry-type'], 'LineString'],
                minzoom: 8,
                layout: {
                    'text-field': ['get', 'name:latin'],
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
                    'text-field': ['get', 'name:latin'],
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
                    'text-field': ['case', ['has', 'icao'], ['concat', ['get', 'name:latin'], ' (', ['get', 'icao'], ')'], ['get', 'name:latin']],
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
                        ['all', ['has', 'ele'], ['!=', ['coalesce', ['get', 'name:latin'], ''], '']],
                        ['concat', ['get', 'name:latin'], '\n', ['get', 'ele'], 'm'],
                        ['has', 'ele'],
                        ['concat', ['get', 'ele'], 'm'],
                        ['coalesce', ['get', 'name:latin'], '']
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
                    'text-field': '{name:latin}',
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
                    'text-field': '{name:latin}',
                    'text-size': ['interpolate', ['linear'], ['zoom'], 10, 9, 14, 13],
                    'text-anchor': 'center',
                    'text-font': FONT_REGULAR
                },
                paint: {'text-color': '#555', 'text-halo-color': '#fff', 'text-halo-width': 1.5}
            }
        ]
    };
}
