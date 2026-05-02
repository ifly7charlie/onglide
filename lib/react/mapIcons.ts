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

// Roadsign: rectangle with triangular point on the right edge so the sign
// rotates along a line-placed symbol with the point indicating travel direction.
// The label is baked into the canvas so it stays welded to the sign body.
function makeSignpostIcon(label: string): ImageData {
    const w = 78;
    const h = 36;
    const tip = 14;
    const inset = 3;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.beginPath();
    ctx.moveTo(inset, inset);
    ctx.lineTo(w - tip, inset);
    ctx.lineTo(w - inset, h / 2);
    ctx.lineTo(w - tip, h - inset);
    ctx.lineTo(inset, h - inset);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    // White halo first (wider), then red border on top — leaves a clean
    // white keyline outside the red edge.
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = '#cc0000';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#cc0000';
    ctx.font = '800 22px "Atkinson Hyperlegible Next", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, (w - tip) / 2, h / 2 - 1);
    return ctx.getImageData(0, 0, w, h);
}

function makeAirportIcon(): ImageData {
    const size = 32;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#444';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
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

// Signposts bake the site UI font into the canvas; we redraw once the
// webfont is ready so the first paint isn't stuck with the fallback metric.
const SIGNPOST_ICONS: Array<[string, () => ImageData]> = [
    ['signpost-min', () => makeSignpostIcon('min')],
    ['signpost-max', () => makeSignpostIcon('max')]
];
const SIGNPOST_FONT = '800 18px "Atkinson Hyperlegible Next"';

export function registerMapIcons(map: MaplibreMap): void {
    for (const [id, make] of ICONS) {
        try {
            if (!map.hasImage(id)) map.addImage(id, make(), {pixelRatio: 2});
        } catch (e) {
            // Duplicate-add or transient style state — safe to ignore.
        }
    }
    const drawSignposts = () => {
        for (const [id, make] of SIGNPOST_ICONS) {
            try {
                if (map.hasImage(id)) map.removeImage(id);
                map.addImage(id, make(), {pixelRatio: 2});
            } catch (e) {
                // ignore
            }
        }
    };
    if (typeof document !== 'undefined' && document.fonts) {
        document.fonts.load(SIGNPOST_FONT).then(drawSignposts, drawSignposts);
    } else {
        drawSignposts();
    }
}
