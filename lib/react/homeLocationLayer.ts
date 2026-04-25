import {IconLayer} from '@deck.gl/layers';
import {faLocationDot} from '@fortawesome/free-solid-svg-icons';

// Build the SVG once at module load — the URL is stable so deck.gl's image
// cache treats it as a single asset across re-renders.
function buildPinDataUrl(fill: string, stroke: string): string {
    const [width, height, , , pathRaw] = faLocationDot.icon;
    const path = Array.isArray(pathRaw) ? pathRaw.join(' ') : (pathRaw as string);
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
        `<path fill="${fill}" stroke="${stroke}" stroke-width="40" stroke-linejoin="round" paint-order="stroke" d="${path}"/>` +
        `</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const PIN_URL = buildPinDataUrl('rgb(220, 60, 60)', 'rgba(255,255,255,0.9)');
const PIN_W = faLocationDot.icon[0];
const PIN_H = faLocationDot.icon[1];

// Marker for the competition's site location (lt/lg from the competition row).
// Anchored at the bottom-centre so the pin's tip sits exactly on the lat/lng.
export function homeLocationLayer(lat: number | null | undefined, lng: number | null | undefined) {
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
    }
    return new IconLayer({
        id: 'competition-home',
        data: [{lat, lng}],
        pickable: false,
        getPosition: (d) => [d.lng, d.lat, 0],
        getIcon: () => ({
            url: PIN_URL,
            width: PIN_W,
            height: PIN_H,
            anchorX: PIN_W / 2,
            anchorY: PIN_H,
            mask: false
        }),
        getSize: 36,
        sizeUnits: 'pixels'
    });
}
