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

// --- Landmark icons ----------------------------------------------------------
// Obstacles (turbines, masts, towers, cooling towers, power plants) are drawn in
// a warning red; heritage landmarks (castles, cathedrals, lighthouses, windmills)
// in muted gold. Each is a deliberately simple 32px glyph — fine detail is lost
// at on-map size. All anchor at the bottom, matching the landmark-point layer.

const OBSTACLE_COLOR = '#c0392b';
const HERITAGE_COLOR = '#7d6608';

function icon32(): CanvasRenderingContext2D {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    const ctx = c.getContext('2d')!;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    return ctx;
}

// Fill the current path in `color` with a white keyline so it reads over satellite.
function fillKeyed(ctx: CanvasRenderingContext2D, color: string): void {
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
}

// Stroke the current path as a coloured line with a white halo (for blades, sails,
// guy lines — features too thin to fill).
function strokeKeyed(ctx: CanvasRenderingContext2D, color: string, width: number): void {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = width + 2;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
}

function makeWindTurbineIcon(): ImageData {
    const ctx = icon32();
    ctx.beginPath(); // tower
    ctx.moveTo(15, 11);
    ctx.lineTo(17, 11);
    ctx.lineTo(18.2, 30);
    ctx.lineTo(13.8, 30);
    ctx.closePath();
    fillKeyed(ctx, OBSTACLE_COLOR);
    ctx.save(); // three blades from the hub
    ctx.translate(16, 11);
    for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -11);
        strokeKeyed(ctx, OBSTACLE_COLOR, 2.4);
        ctx.rotate((2 * Math.PI) / 3);
    }
    ctx.restore();
    ctx.beginPath(); // hub covers the blade roots
    ctx.arc(16, 11, 2.4, 0, 2 * Math.PI);
    fillKeyed(ctx, OBSTACLE_COLOR);
    return ctx.getImageData(0, 0, 32, 32);
}

function makeCoolingTowerIcon(): ImageData {
    const ctx = icon32();
    ctx.beginPath(); // hyperboloid: concave sides pinched at the waist
    ctx.moveTo(11, 6);
    ctx.quadraticCurveTo(17, 17.5, 9, 30);
    ctx.lineTo(23, 30);
    ctx.quadraticCurveTo(15, 17.5, 21, 6);
    ctx.closePath();
    fillKeyed(ctx, OBSTACLE_COLOR);
    return ctx.getImageData(0, 0, 32, 32);
}

function makeMastIcon(): ImageData {
    const ctx = icon32();
    ctx.beginPath(); // guy lines, behind the tower
    ctx.moveTo(16, 8);
    ctx.lineTo(6, 30);
    ctx.moveTo(16, 8);
    ctx.lineTo(26, 30);
    strokeKeyed(ctx, OBSTACLE_COLOR, 1.4);
    ctx.beginPath(); // tall thin tower
    ctx.moveTo(16, 3);
    ctx.lineTo(19, 30);
    ctx.lineTo(13, 30);
    ctx.closePath();
    fillKeyed(ctx, OBSTACLE_COLOR);
    return ctx.getImageData(0, 0, 32, 32);
}

function makeTowerIcon(): ImageData {
    const ctx = icon32();
    ctx.beginPath(); // antenna mast on top
    ctx.moveTo(16, 2);
    ctx.lineTo(16, 9);
    strokeKeyed(ctx, OBSTACLE_COLOR, 2);
    ctx.beginPath(); // tapered lattice body
    ctx.moveTo(13, 12);
    ctx.lineTo(19, 12);
    ctx.lineTo(23, 30);
    ctx.lineTo(9, 30);
    ctx.closePath();
    fillKeyed(ctx, OBSTACLE_COLOR);
    ctx.beginPath(); // observation platform
    ctx.moveTo(10, 9);
    ctx.lineTo(22, 9);
    ctx.lineTo(22, 12.5);
    ctx.lineTo(10, 12.5);
    ctx.closePath();
    fillKeyed(ctx, OBSTACLE_COLOR);
    return ctx.getImageData(0, 0, 32, 32);
}

function makePowerPlantIcon(): ImageData {
    const ctx = icon32();
    ctx.beginPath(); // chimney stack
    ctx.moveTo(16.5, 5);
    ctx.lineTo(20.5, 5);
    ctx.lineTo(21.5, 19);
    ctx.lineTo(15.5, 19);
    ctx.closePath();
    fillKeyed(ctx, OBSTACLE_COLOR);
    ctx.beginPath(); // building
    ctx.moveTo(6, 19);
    ctx.lineTo(26, 19);
    ctx.lineTo(26, 30);
    ctx.lineTo(6, 30);
    ctx.closePath();
    fillKeyed(ctx, OBSTACLE_COLOR);
    return ctx.getImageData(0, 0, 32, 32);
}

function makeCastleIcon(): ImageData {
    const ctx = icon32();
    ctx.beginPath(); // body with three crenellated merlons
    ctx.moveTo(8, 30);
    ctx.lineTo(8, 8);
    ctx.lineTo(12, 8);
    ctx.lineTo(12, 13);
    ctx.lineTo(14, 13);
    ctx.lineTo(14, 8);
    ctx.lineTo(18, 8);
    ctx.lineTo(18, 13);
    ctx.lineTo(20, 13);
    ctx.lineTo(20, 8);
    ctx.lineTo(24, 8);
    ctx.lineTo(24, 30);
    ctx.closePath();
    fillKeyed(ctx, HERITAGE_COLOR);
    return ctx.getImageData(0, 0, 32, 32);
}

function makeCathedralIcon(): ImageData {
    const ctx = icon32();
    ctx.beginPath(); // spire
    ctx.moveTo(16, 4);
    ctx.lineTo(20, 18);
    ctx.lineTo(12, 18);
    ctx.closePath();
    fillKeyed(ctx, HERITAGE_COLOR);
    ctx.beginPath(); // nave
    ctx.moveTo(10, 18);
    ctx.lineTo(22, 18);
    ctx.lineTo(22, 30);
    ctx.lineTo(10, 30);
    ctx.closePath();
    fillKeyed(ctx, HERITAGE_COLOR);
    ctx.beginPath(); // cross
    ctx.moveTo(16, 1);
    ctx.lineTo(16, 6);
    ctx.moveTo(13.5, 3);
    ctx.lineTo(18.5, 3);
    strokeKeyed(ctx, HERITAGE_COLOR, 1.6);
    return ctx.getImageData(0, 0, 32, 32);
}

function makeLighthouseIcon(): ImageData {
    const ctx = icon32();
    ctx.beginPath(); // light rays
    ctx.moveTo(11, 5);
    ctx.lineTo(7, 3);
    ctx.moveTo(21, 5);
    ctx.lineTo(25, 3);
    strokeKeyed(ctx, HERITAGE_COLOR, 1.6);
    ctx.beginPath(); // tapered tower
    ctx.moveTo(13, 12);
    ctx.lineTo(19, 12);
    ctx.lineTo(21.5, 30);
    ctx.lineTo(10.5, 30);
    ctx.closePath();
    fillKeyed(ctx, HERITAGE_COLOR);
    ctx.beginPath(); // lantern room
    ctx.moveTo(12.5, 7);
    ctx.lineTo(19.5, 7);
    ctx.lineTo(19.5, 12);
    ctx.lineTo(12.5, 12);
    ctx.closePath();
    fillKeyed(ctx, HERITAGE_COLOR);
    ctx.beginPath(); // roof
    ctx.moveTo(16, 3);
    ctx.lineTo(20.5, 7);
    ctx.lineTo(11.5, 7);
    ctx.closePath();
    fillKeyed(ctx, HERITAGE_COLOR);
    return ctx.getImageData(0, 0, 32, 32);
}

function makeWindmillIcon(): ImageData {
    const ctx = icon32();
    ctx.beginPath(); // tower
    ctx.moveTo(13, 14);
    ctx.lineTo(19, 14);
    ctx.lineTo(21, 30);
    ctx.lineTo(11, 30);
    ctx.closePath();
    fillKeyed(ctx, HERITAGE_COLOR);
    ctx.save(); // four sails in an X
    ctx.translate(16, 12);
    ctx.rotate(Math.PI / 4);
    for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -10);
        strokeKeyed(ctx, HERITAGE_COLOR, 2.2);
        ctx.rotate(Math.PI / 2);
    }
    ctx.restore();
    ctx.beginPath(); // hub
    ctx.arc(16, 12, 2, 0, 2 * Math.PI);
    fillKeyed(ctx, HERITAGE_COLOR);
    return ctx.getImageData(0, 0, 32, 32);
}

function makeSolarFarmIcon(): ImageData {
    const ctx = icon32();
    ctx.beginPath(); // support post, behind the panel
    ctx.moveTo(16.5, 20);
    ctx.lineTo(20.5, 20);
    ctx.lineTo(20.5, 30);
    ctx.lineTo(16.5, 30);
    ctx.closePath();
    fillKeyed(ctx, OBSTACLE_COLOR);
    ctx.beginPath(); // tilted PV panel
    ctx.moveTo(6, 17);
    ctx.lineTo(21, 12);
    ctx.lineTo(26, 18);
    ctx.lineTo(11, 23);
    ctx.closePath();
    fillKeyed(ctx, OBSTACLE_COLOR);
    ctx.beginPath(); // cell grid lines
    ctx.moveTo(11, 15.3);
    ctx.lineTo(16, 21.3);
    ctx.moveTo(16, 13.7);
    ctx.lineTo(21, 19.7);
    ctx.moveTo(8.5, 20);
    ctx.lineTo(23.5, 15);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();
    return ctx.getImageData(0, 0, 32, 32);
}

function makeMonumentIcon(): ImageData {
    const ctx = icon32();
    ctx.beginPath(); // obelisk: pyramidion + tapered shaft
    ctx.moveTo(16, 3);
    ctx.lineTo(18.5, 8);
    ctx.lineTo(19.2, 26);
    ctx.lineTo(12.8, 26);
    ctx.lineTo(13.5, 8);
    ctx.closePath();
    fillKeyed(ctx, HERITAGE_COLOR);
    ctx.beginPath(); // plinth
    ctx.moveTo(10, 26);
    ctx.lineTo(22, 26);
    ctx.lineTo(22, 30);
    ctx.lineTo(10, 30);
    ctx.closePath();
    fillKeyed(ctx, HERITAGE_COLOR);
    return ctx.getImageData(0, 0, 32, 32);
}

// Registry of every runtime image the style expects. Each entry is added
// independently with a hasImage guard so one failure can't skip the rest.
const ICONS: Array<[string, () => ImageData]> = [
    ['arrowlight', () => makeArrowImageData('white')],
    ['arrowdark', () => makeArrowImageData('grey')],
    ['peak', makePeakIcon],
    ['airport', makeAirportIcon],
    ['wind-turbine', makeWindTurbineIcon],
    ['cooling-tower', makeCoolingTowerIcon],
    ['mast', makeMastIcon],
    ['tower', makeTowerIcon],
    ['power-plant', makePowerPlantIcon],
    ['solar-farm', makeSolarFarmIcon],
    ['castle', makeCastleIcon],
    ['cathedral', makeCathedralIcon],
    ['lighthouse', makeLighthouseIcon],
    ['windmill', makeWindmillIcon],
    ['monument', makeMonumentIcon]
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
