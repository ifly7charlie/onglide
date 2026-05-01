import {IconLayer} from '@deck.gl/layers';

// Hand-rolled X glyph rather than a FontAwesome icon — gives us full control
// over stroke weight (which is what determines "subtlety" at marker sizes).
// Centred in a 32×32 viewBox so anchor maths is trivial.
const X_SIZE = 32;
const X_URL =
    `data:image/svg+xml;utf8,` +
    encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${X_SIZE} ${X_SIZE}">` +
            `<g stroke="rgba(40,40,40,0.85)" stroke-width="3" stroke-linecap="round" fill="none">` +
            `<line x1="9" y1="9" x2="23" y2="23"/>` +
            `<line x1="23" y1="9" x2="9" y2="23"/>` +
            `</g>` +
            `</svg>`
    );

// Subtle X marker for the competition's site location (lt/lg from the
// competition row). Centred on the lat/lng so both arms of the X cross at
// the exact site coordinate.
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
            url: X_URL,
            width: X_SIZE,
            height: X_SIZE,
            anchorX: X_SIZE / 2,
            anchorY: X_SIZE / 2,
            mask: false
        }),
        getSize: 18,
        sizeUnits: 'pixels'
    });
}
