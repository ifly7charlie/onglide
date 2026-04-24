import type {Map as MaplibreMap} from 'maplibre-gl';

// Each icon is drawn at runtime onto a canvas and registered with the map so
// style layers can reference it via `icon-image`. No sprite sheet, no external
// assets. The arrow MUST point right (east, 0°) so MapLibre rotates it along
// line-placed symbols to match the line bearing.

function makeArrowImageData(color: string): ImageData {
    const size = 32;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = color;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(size * 0.15, size * 0.2);
    ctx.lineTo(size * 0.85, size * 0.5);
    ctx.lineTo(size * 0.15, size * 0.8);
    ctx.lineTo(size * 0.38, size * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    return ctx.getImageData(0, 0, size, size);
}

function makePeakIcon(): ImageData {
    const size = 16;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#66382c';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(size * 0.5, size * 0.15);
    ctx.lineTo(size * 0.9, size * 0.85);
    ctx.lineTo(size * 0.1, size * 0.85);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    return ctx.getImageData(0, 0, size, size);
}

function makeAirportIcon(): ImageData {
    const size = 16;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#444';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(size * 0.5, size * 0.1);
    ctx.lineTo(size * 0.58, size * 0.5);
    ctx.lineTo(size * 0.95, size * 0.65);
    ctx.lineTo(size * 0.95, size * 0.75);
    ctx.lineTo(size * 0.58, size * 0.7);
    ctx.lineTo(size * 0.58, size * 0.85);
    ctx.lineTo(size * 0.75, size * 0.9);
    ctx.lineTo(size * 0.75, size * 0.95);
    ctx.lineTo(size * 0.5, size * 0.9);
    ctx.lineTo(size * 0.25, size * 0.95);
    ctx.lineTo(size * 0.25, size * 0.9);
    ctx.lineTo(size * 0.42, size * 0.85);
    ctx.lineTo(size * 0.42, size * 0.7);
    ctx.lineTo(size * 0.05, size * 0.75);
    ctx.lineTo(size * 0.05, size * 0.65);
    ctx.lineTo(size * 0.42, size * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    return ctx.getImageData(0, 0, size, size);
}

// Registry of every runtime image the style expects. Each entry is added
// independently with a hasImage guard so one failure can't skip the rest.
const ICONS: Array<[string, () => ImageData]> = [
    ['arrowlight', () => makeArrowImageData('white')],
    ['arrowdark', () => makeArrowImageData('grey')],
    ['peak', makePeakIcon],
    ['airport', makeAirportIcon]
];

export function registerMapIcons(map: MaplibreMap): void {
    for (const [id, make] of ICONS) {
        try {
            if (!map.hasImage(id)) map.addImage(id, make(), {pixelRatio: 2});
        } catch (e) {
            // Duplicate-add or transient style state — safe to ignore.
        }
    }
}
