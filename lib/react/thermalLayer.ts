import {useMemo} from 'react';

import {TextLayer} from '@deck.gl/layers';
import {CollisionFilterExtension} from '@deck.gl/extensions';
import type {CollisionFilterExtensionProps} from '@deck.gl/extensions';

import {useSelector} from '../redux';
import type {RootState} from '../redux/store';
import {selectPilotStats, selectPilotScore} from '../redux/scoresSlice';

import {sortedIndexNumber} from '../util/binarySearch';
import {OPEN_THERMAL_TOLERANCE_S} from '../constants';
import {displayClimb, displayHeight} from './displayunits';

import type {Compno, Epoch, DeckData} from '../types';
import type {StatSegment} from '../protobuf/onglide';

// The pilot's track already draws the circling spiral, so this layer no longer
// re-draws the shape — it annotates each thermal with the numbers the track
// can't convey: how strong the lift was and how much height it gained. A
// number-led badge reads at a glance where a tinted glyph did not.

// Colour ramp keyed on climb (m/s — avgDelta and the live vario are both already
// unscaled to m/s). Sink reads red, neutral amber, and the stronger the lift the
// greener then bluer — the way a glider pilot reads "is this any good": red = get
// out, blue = stay. Spans negative (sink) through strong lift.
const RAMP: Array<[number, [number, number, number]]> = [
    [-3, [200, 50, 45]], // red: strong sink
    [0, [240, 190, 70]], // amber: neutral / barely moving
    [1.5, [60, 175, 85]], // green: workable lift
    [4, [45, 125, 215]] // blue: strong lift
];

export function climbColour(climb: number): [number, number, number] {
    const c = climb;
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
export const MIN_THERMAL_SECONDS = 30;

interface ThermalPoint {
    position: [number, number, number];
    compno: Compno;
    t: Epoch; // mid-thermal time (for the tooltip)
    climb: number; // m/s
    heightgain: number; // m
    stats: StatSegment; // so the existing deckTooltip object.stats branch lights up
    utcStart?: Epoch; // pilot's task start, for the tooltip's relative (time-into-task) readout
}

// Geometric centre of the track positions spanning a thermal, so the badge sits
// in the middle of the visible loop rather than on its edge (a mid-*time* sample
// lands on the rim). Returns undefined when no points fall in the range.
function centroid(deck: DeckData, startIdx: number, endIdx: number): [number, number, number] | undefined {
    let sx = 0,
        sy = 0,
        sz = 0,
        n = 0;
    for (let i = startIdx; i <= endIdx; i++) {
        sx += deck.positions[i * 3];
        sy += deck.positions[i * 3 + 1];
        sz += deck.positions[i * 3 + 2];
        n++;
    }
    return n ? [sx / n, sy / n, sz / n] : undefined;
}

// Resolve each thermal segment to a centred map position by averaging the
// glider's track over the segment. StatSegment carries no position of its own,
// so the deck is the source of truth. `t` (cursor) bounds how far we look so a
// replay never paints a thermal the glider hasn't reached yet — the
// `seg.start > limit` clip drops future segments and the `endIdx` clamp keeps
// the open segment's centroid to the flown-so-far portion.
//
// The *open* thermal (the one the cursor sits inside) is dropped here: the
// gaggle/solo layer labels the current climb of every circling glider, so
// annotating it again would double up. This layer is just the completed-thermal
// history of the selected/hovered glider.
function thermalPoints(deck: DeckData | undefined, segments: StatSegment[] | undefined, utcStart: Epoch | undefined, t: Epoch | undefined): ThermalPoint[] {
    if (!deck?.posIndex || !segments?.length) return [];
    const limit = t ?? Infinity;
    const ts = deck.t.subarray(0, deck.posIndex);
    const out: ThermalPoint[] = [];
    for (const seg of segments) {
        if (seg.state !== 'thermal') continue;
        if (seg.end - seg.start < MIN_THERMAL_SECONDS) continue;
        // Tie the markers to the scored track: drop any thermal that finished
        // before the pilot's start. The displayed trace is clipped at the start
        // line, so a pre-start marker would float with no trail beneath it.
        if (utcStart && seg.end <= utcStart) continue;
        if (seg.start > limit) continue;
        // The open thermal is owned by the gaggle/solo layer, which extends the
        // *final* thermal segment past its reported end by OPEN_THERMAL_TOLERANCE_S
        // (its end lags the live cursor). Drop it over the same window so the two
        // layers never both badge it.
        const openEnd = seg === segments[segments.length - 1] ? seg.end + OPEN_THERMAL_TOLERANCE_S : seg.end;
        if (seg.start <= limit && limit <= openEnd) continue;
        const startIdx = sortedIndexNumber(ts, seg.start as Epoch);
        let endIdx = sortedIndexNumber(ts, Math.min(seg.end, limit) as Epoch);
        if (endIdx >= deck.posIndex) endIdx = deck.posIndex - 1;
        const pos = centroid(deck, Math.min(startIdx, endIdx), endIdx);
        if (!pos) continue;
        out.push({
            position: pos,
            compno: deck.compno,
            t: Math.min((seg.start + seg.end) / 2, limit) as Epoch,
            climb: seg.avgDelta ?? 0,
            heightgain: seg.heightgain ?? 0,
            stats: seg,
            utcStart
        });
    }
    return out;
}

// Number-led thermal-strength badges for the completed thermals of the selected
// and/or hovered glider. The open (in-progress) thermal is omitted — the
// gaggle/solo layer labels every circling glider's current climb. Returns null
// when neither pilot has a completed thermal to show.
//
// `t` is the display cursor (replay time, or the live now) used to place markers
// and trim the future. `replayTime` is the raw replay slider value — undefined
// in live mode — which selectPilotScore needs to pick the live vs historical
// score store for utcStart; passing the live cursor there would read the empty
// historical store and silently drop the start-clip.
//
// The badge is white text with a dark halo on a strength-coloured pill: legible
// on the light, dark, and satellite basemaps alike, so it needs no mapLight.
export function thermalLayer(selectedCompno: Compno | undefined, hoveredCompno: Compno | null, t: Epoch | undefined, replayTime: Epoch | undefined, units: number | boolean) {
    // Only fetch the hovered pilot's stats when it differs from the selected one.
    const hovered = hoveredCompno && hoveredCompno !== selectedCompno ? hoveredCompno : undefined;

    const selectedSegments = useSelector((state: RootState) => selectPilotStats(state, selectedCompno));
    const hoveredSegments = useSelector((state: RootState) => selectPilotStats(state, hovered));
    const selectedDeck = useSelector((state: RootState) => (selectedCompno ? state.tracks.tracks[selectedCompno]?.deck : undefined));
    const hoveredDeck = useSelector((state: RootState) => (hovered ? state.tracks.tracks[hovered]?.deck : undefined));
    const selectedStart = useSelector((state: RootState) => (selectedCompno ? (selectPilotScore(state, selectedCompno, replayTime)?.utcStart as Epoch | undefined) : undefined));
    const hoveredStart = useSelector((state: RootState) => (hovered ? (selectPilotScore(state, hovered, replayTime)?.utcStart as Epoch | undefined) : undefined));

    const data = useMemo(
        () => [...thermalPoints(selectedDeck, selectedSegments, selectedStart, t), ...thermalPoints(hoveredDeck, hoveredSegments, hoveredStart, t)],
        [selectedDeck, selectedSegments, selectedStart, hoveredDeck, hoveredSegments, hoveredStart, t]
    );

    if (!data.length) return null;

    return new TextLayer<ThermalPoint, CollisionFilterExtensionProps<ThermalPoint>>({
        id: 'thermals',
        data,
        getPosition: (d) => d.position,
        // Climb on top (the headline), height gain below when there is any.
        getText: (d) => `▲${displayClimb(d.climb, units)}${d.heightgain ? `\n+${displayHeight(d.heightgain, units)}` : ''}`,
        getColor: [255, 255, 255, 255],
        getSize: 13,
        // Sit the badge just above the thermal rather than on its centroid: the
        // circling track crosses densely through the middle and makes a centred
        // label unreadable. Anchored at the centroid, drawn above it (baseline
        // bottom + a small pixel lift), so it stays attached to the right loop.
        getPixelOffset: [0, -10],
        getBackgroundColor: (d) => {
            const [r, g, b] = climbColour(d.climb);
            return [r, g, b, 255]; // fully opaque so the track behind never bleeds through
        },
        background: true,
        backgroundPadding: [6, 3, 6, 3],
        // SDF + dark halo keeps the white text readable over the pill and over a
        // busy satellite basemap. characterSet:'auto' picks up ▲ + digits + units.
        fontSettings: {sdf: true},
        characterSet: 'auto',
        fontWeight: 700,
        outlineWidth: 2,
        outlineColor: [0, 0, 0, 220],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'bottom',
        billboard: true, // face the camera when the map is pitched in 3D
        pickable: true,
        // On a phone a long flight has dozens of thermals; collision filtering
        // drops overlapping badges by priority so only the strongest survive when
        // zoomed out, revealing the rest on zoom-in.
        extensions: [new CollisionFilterExtension()],
        collisionEnabled: true,
        collisionGroup: 'thermals',
        getCollisionPriority: (d) => Math.min(900, Math.round(d.climb * 100)),
        updateTriggers: {
            getText: [units]
        }
    });
}
