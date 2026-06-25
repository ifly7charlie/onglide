import {useMemo} from 'react';

import {IconLayer} from '@deck.gl/layers';

import {useSelector} from '../redux';
import type {RootState} from '../redux/store';
import {selectPilotStats} from '../redux/scoresSlice';

import {sortedIndexNumber} from '../util/binarySearch';

import type {Compno, Epoch, DeckData} from '../types';
import type {StatSegment} from '../protobuf/onglide';

// One white spiral glyph, used as an alpha mask so the IconLayer can tint each
// thermal by climb strength via getColor (a single mask icon is far cheaper
// than baking a coloured icon per strength bucket into an atlas). An
// Archimedean spiral reads unambiguously as a thermal/circling at marker size
// and needs no arrowhead geometry.
function spiralPath(cx: number, cy: number, turns: number, rMax: number, points: number): string {
    let d = '';
    for (let i = 0; i <= points; i++) {
        const f = i / points;
        const ang = f * turns * 2 * Math.PI;
        const r = f * rMax;
        const x = cx + r * Math.cos(ang);
        const y = cy + r * Math.sin(ang);
        d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    }
    return d.trim();
}

const ICON_PX = 48;
const SPIRAL_URL =
    `data:image/svg+xml;utf8,` +
    encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_PX}" height="${ICON_PX}" viewBox="0 0 ${ICON_PX} ${ICON_PX}">` +
            `<path d="${spiralPath(24, 24, 2.5, 18, 80)}" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` +
            `</svg>`
    );

const SPIRAL_ICON = {url: SPIRAL_URL, width: ICON_PX, height: ICON_PX, anchorX: ICON_PX / 2, anchorY: ICON_PX / 2, mask: true};

// Colour ramp keyed on average climb (m/s — avgDelta is already unscaled to m/s
// by the wire codec). Weak climbs read cool/muted, strong climbs hot, matching
// the way pilots think about thermal strength at a glance.
const RAMP: Array<[number, [number, number, number]]> = [
    [0, [120, 150, 170]], // grey-blue: barely lifting
    [1, [49, 163, 84]], // green: workable
    [2, [254, 196, 79]], // amber: good
    [3.5, [227, 74, 51]] // red: strong
];

function climbColour(climb: number): [number, number, number] {
    const c = Math.max(0, climb);
    if (c <= RAMP[0][0]) return RAMP[0][1];
    for (let i = 1; i < RAMP.length; i++) {
        if (c <= RAMP[i][0]) {
            const [lo, loC] = RAMP[i - 1];
            const [hi, hiC] = RAMP[i];
            const u = (c - lo) / (hi - lo);
            return [Math.round(loC[0] + u * (hiC[0] - loC[0])), Math.round(loC[1] + u * (hiC[1] - loC[1])), Math.round(loC[2] + u * (hiC[2] - loC[2]))];
        }
    }
    return RAMP[RAMP.length - 1][1];
}

// Smallest thermal (seconds) worth marking — matches the 30s floor the tooltip
// uses before it shows segment detail, and keeps brief circling blips off the map.
const MIN_THERMAL_SECONDS = 30;

interface ThermalPoint {
    position: [number, number, number];
    compno: Compno;
    t: Epoch; // mid-thermal time (for the tooltip)
    climb: number; // m/s
    stats: StatSegment; // so the existing deckTooltip object.stats branch lights up
}

// Resolve each thermal segment to a map position by sampling the glider's track
// at the segment mid-time. StatSegment carries no position of its own, so the
// deck is the source of truth. `t` (cursor) bounds how far we look so a replay
// never paints a thermal the glider hasn't reached yet — selectPilotStats
// already trims future segments, this guards the open segment's position too.
function thermalPoints(deck: DeckData | undefined, segments: StatSegment[] | undefined, t: Epoch | undefined): ThermalPoint[] {
    if (!deck?.posIndex || !segments?.length) return [];
    const limit = t ?? Infinity;
    const ts = deck.t.subarray(0, deck.posIndex);
    const out: ThermalPoint[] = [];
    for (const seg of segments) {
        if (seg.state !== 'thermal') continue;
        if (seg.end - seg.start < MIN_THERMAL_SECONDS) continue;
        if (seg.start > limit) continue;
        const mid = Math.min((seg.start + seg.end) / 2, limit) as Epoch;
        let i = sortedIndexNumber(ts, mid);
        if (i >= deck.posIndex) i = deck.posIndex - 1;
        out.push({
            position: [deck.positions[i * 3], deck.positions[i * 3 + 1], deck.positions[i * 3 + 2]],
            compno: deck.compno,
            t: mid,
            climb: seg.avgDelta ?? 0,
            stats: seg
        });
    }
    return out;
}

// Thermal-strength markers for the selected and/or hovered glider, including
// the in-progress thermal (the open segment, which is always the last entry in
// stats.segments). Returns null when neither pilot has thermals to show.
export function thermalLayer(selectedCompno: Compno | undefined, hoveredCompno: Compno | null, t: Epoch | undefined) {
    // Only fetch the hovered pilot's stats when it differs from the selected one.
    const hovered = hoveredCompno && hoveredCompno !== selectedCompno ? hoveredCompno : undefined;

    const selectedSegments = useSelector((state: RootState) => selectPilotStats(state, selectedCompno, t));
    const hoveredSegments = useSelector((state: RootState) => selectPilotStats(state, hovered, t));
    const selectedDeck = useSelector((state: RootState) => (selectedCompno ? state.tracks.tracks[selectedCompno]?.deck : undefined));
    const hoveredDeck = useSelector((state: RootState) => (hovered ? state.tracks.tracks[hovered]?.deck : undefined));

    const data = useMemo(() => [...thermalPoints(selectedDeck, selectedSegments, t), ...thermalPoints(hoveredDeck, hoveredSegments, t)], [selectedDeck, selectedSegments, hoveredDeck, hoveredSegments, t]);

    if (!data.length) return null;

    return new IconLayer<ThermalPoint>({
        id: 'thermals',
        data,
        getPosition: (d) => d.position,
        getIcon: () => SPIRAL_ICON,
        getColor: (d) => climbColour(d.climb),
        // Bigger spiral for stronger lift; clamped so a booming thermal doesn't
        // swamp the map and a weak one is still legible.
        getSize: (d) => Math.max(22, Math.min(48, 22 + d.climb * 6)),
        sizeUnits: 'pixels',
        pickable: true
    });
}
