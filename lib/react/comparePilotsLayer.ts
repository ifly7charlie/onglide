//
// "Compare" mode for the distance toolbar control. Draws a connecting line and a
// label between the selected glider and a target glider, where the target is:
//   1. the hovered glider (map icon or pilot list), when one is hovered, or
//   2. (Sailplane Grand Prix only) the leaderboard leader (auto sort) — or, when
//      the selection IS the leader, the glider directly behind it.
//
// The "distance" shown is task-aware: the difference in remaining task distance
// (how far apart the two gliders are along the course), falling back to a
// straight-line geographic distance when remaining isn't available. The height
// difference is the AMSL delta. Rendered as deck.gl layers using the gliders'
// 3D positions so it connects them at altitude and tracks the RAF cursor in 3D.
//

import {PathLayer, TextLayer} from '@deck.gl/layers';

import type {Compno, Epoch, Units} from '../types';
import type {RootState} from '../redux/store';

import {selectAllPositions} from '../redux/tracksSlice';
import {selectAllScores} from '../redux/scoresSlice';
import {selectAuto} from '../redux/selectPilotResult';

import {displayHeight} from './displayunits';
import {distHaversineRaw} from '../flightprocessing/taskhelper';

// Match the rest of the UI (see gaggleLayer) — already loaded via @font-face so
// deck.gl's TextLayer can rasterise it into its glyph atlas.
const UI_FONT = "'Atkinson Hyperlegible Next', sans-serif";

// Thick orange indicator; dark label background for contrast against it.
const LINE_COLOR: [number, number, number, number] = [255, 140, 0, 240];
const LABEL_BG: [number, number, number, number] = [20, 20, 20, 215];

// Separates a gap from its (approximate) time-equivalent; clock prefixes a time.
const SEP = '≈';
const TIME_ICON = '⏱';

// L-shaped path between the two gliders: a horizontal leg at the *lower* glider's
// altitude, running across to directly beneath the *higher* glider, then a
// vertical leg up to it. Decomposes the separation into horizontal distance +
// height gain, which reads clearly when the map is pitched into 3D.
function lPath(source: [number, number, number], target: [number, number, number]): [number, number, number][] {
    const low = source[2] <= target[2] ? source : target;
    const high = source[2] <= target[2] ? target : source;
    const corner: [number, number, number] = [high[0], high[1], low[2]];
    return [low, corner, high];
}

// Localized unit labels, resolved by the caller (so this module stays free of
// the translation hook and can run inside the RAF loop).
export interface CompareLabels {
    km: string;
    sec: string;
    min: string;
    hr: string;
    ahead: string;
    behind: string;
    above: string;
    below: string;
}

export interface CompareResult {
    selCompno: Compno;
    tgtCompno: Compno;
    source: [number, number, number]; // [lng, lat, amsl]
    target: [number, number, number];
    mid: [number, number, number];
    label: string;
}

// distanceRemaining (racing) or minPossible (AAT) — same precedence the
// leaderboard's "remaining" column uses (selectPilotResult).
const remaining = (a: {distanceRemaining?: number; minPossible?: number} | undefined): number => (a ? a.distanceRemaining || a.minPossible || 0 : 0);

// Single-unit short duration using the localized time.*_short labels:
// "24s" under a minute, "2m" under an hour, "2h" beyond.
function fmtDuration(seconds: number, labels: CompareLabels): string {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s}${labels.sec}`;
    if (s < 3600) return `${Math.round(s / 60)}${labels.min}`;
    return `${Math.round(s / 3600)}${labels.hr}`;
}

// Average climb (m/s) over the selected glider's completed thermal segments up to
// `refTime` (Infinity = all so far). 0 when none recorded yet.
function avgThermalClimb(state: RootState, compno: Compno, refTime: number): number {
    const segments = state.scores.pilotStats[compno];
    if (!segments?.length) return 0;
    let sum = 0;
    let n = 0;
    for (const s of segments) {
        if (s.state === 'thermal' && s.avgDelta > 0 && s.end <= refTime) {
            sum += s.avgDelta;
            n++;
        }
    }
    return n > 0 ? sum / n : 0;
}

//
// Resolve the comparison from store state. `posT` selects the (interpolated)
// positions to connect (cursor time); `scoreT` selects scores/ranking (undefined
// for live, replay time otherwise). Returns null when there's nothing to draw.
export function computeCompare(
    state: RootState, //
    posT: Epoch | undefined,
    scoreT: Epoch | undefined,
    selectedCompno: Compno | undefined,
    hoveredCompno: Compno | null,
    grandPrix: boolean,
    units: Units | number | boolean,
    labels: CompareLabels
): CompareResult | null {
    if (!selectedCompno) return null;

    const positions = selectAllPositions(state, posT);
    const posByCompno = new Map<string, (typeof positions)[number]>();
    for (const p of positions) if (p.position) posByCompno.set(p.compno, p);

    const sel = posByCompno.get(selectedCompno);
    if (!sel?.position) return null;

    // Pick the target: the hovered glider wins (when it isn't the selection and is
    // on the map) for any task type. With nothing hovered, fall back to the
    // leaderboard leader (or next-behind when we lead) only for a Sailplane Grand
    // Prix — that's the format where "gap to the leader" is the meaningful metric.
    let tgtCompno: Compno | undefined;
    if (hoveredCompno && hoveredCompno !== selectedCompno && posByCompno.has(hoveredCompno)) {
        tgtCompno = hoveredCompno;
    } else if (grandPrix) {
        const ranking = selectAuto(state, scoreT)
            .slice()
            .sort((a, b) => b.sortKey - a.sortKey);
        for (const r of ranking) {
            if (r.compno === selectedCompno) continue; // skip self → "directly behind" when we lead
            if (!posByCompno.has(r.compno)) continue; // need a position to draw to
            tgtCompno = r.compno;
            break;
        }
    }
    if (!tgtCompno) return null;
    const tgt = posByCompno.get(tgtCompno);
    if (!tgt?.position) return null;

    const source = sel.position as [number, number, number];
    const target = tgt.position as [number, number, number];
    const mid: [number, number, number] = [(source[0] + target[0]) / 2, (source[1] + target[1]) / 2, (source[2] + target[2]) / 2];

    // Task-aware separation: difference in remaining task distance, else great-circle.
    const scores = selectAllScores(state, scoreT) ?? {};
    const selScore = scores[selectedCompno];
    const selRem = remaining(selScore?.actual);
    const tgtRem = remaining(scores[tgtCompno]?.actual);
    // Everything below describes the TARGET (B) relative to the selected glider
    // (A): positive = B is ahead on task / above in height — the gap A has to make
    // up. Distance needs known task remaining for both, else falls back to an
    // (unsigned) straight-line gap.
    const haveRem = selRem > 0 && tgtRem > 0;
    const gapSigned = haveRem ? selRem - tgtRem : undefined; // km, + = B further along
    const heightSigned = target[2] - source[2]; // m AMSL, + = B higher

    // Time equivalents A would need to close each gap, signed the same way:
    // distance at A's task-average speed, climb at A's average thermal climb.
    const speed = selScore?.actual?.taskSpeed ?? 0; // km/h
    const climb = avgThermalClimb(state, selectedCompno, scoreT ?? Infinity); // m/s
    const dTime = gapSigned !== undefined && speed > 0 ? (gapSigned / speed) * 3600 : undefined; // s, signed
    const cTime = climb > 0 ? heightSigned / climb : undefined; // s, signed

    // "ahead"/"behind" along the task, "above"/"below" for height (+ = B ahead/above).
    const dirH = (v: number) => (v >= 0 ? labels.ahead : labels.behind);
    const dirV = (v: number) => (v >= 0 ? labels.above : labels.below);
    // Durations carry a small clock so the time term reads at a glance.
    const dur = (seconds: number) => `${TIME_ICON}${fmtDuration(Math.abs(seconds), labels)}`;

    // Every line is anchored on the target B (the selected glider A is the magenta
    // one the line runs from). Line 1 — along-task gap and the time A needs to
    // cover it; line 2 — height gap and the climb time; line 3 — the net.
    const distLine =
        gapSigned !== undefined
            ? `${tgtCompno} ${Math.round(Math.abs(gapSigned) * 10) / 10} ${labels.km} ${dirH(gapSigned)}` + (dTime !== undefined ? ` ${SEP} ${dur(dTime)}` : '')
            : `${tgtCompno} ${Math.round(distHaversineRaw(source, target) * 10) / 10} ${labels.km}`;

    const heightLine = `${tgtCompno} ${displayHeight(Math.abs(heightSigned), units)} ${dirV(heightSigned)}` + (cTime !== undefined ? ` ${SEP} ${dur(cTime)}` : '');

    const totalTime = (dTime ?? 0) + (cTime ?? 0);
    const totalLine = dTime !== undefined || cTime !== undefined ? `${tgtCompno} ${dur(totalTime)} ${dirH(totalTime)}` : '';

    const label = [distLine, heightLine, totalLine].filter(Boolean).join('\n');

    return {selCompno: selectedCompno, tgtCompno, source, target, mid, label};
}

// useSelector equality — only re-render when something visible changes, so the
// React layer is stable between the per-second data ticks the RAF loop smooths.
export function compareEqual(a: CompareResult | null, b: CompareResult | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return (
        a.selCompno === b.selCompno &&
        a.tgtCompno === b.tgtCompno &&
        a.label === b.label &&
        a.source[0] === b.source[0] &&
        a.source[1] === b.source[1] &&
        a.source[2] === b.source[2] &&
        a.target[0] === b.target[0] &&
        a.target[1] === b.target[1] &&
        a.target[2] === b.target[2]
    );
}

//
// Build the deck.gl layers for a comparison (thick yellow path + billboard
// label). Returns empty-data layers when there's nothing to draw (so the RAF
// loop can still find and clone them). depth compare is forced 'always' so the
// path/label aren't occluded by terrain in 3D. In 2D there's no height axis, so
// the path is just the straight connector between the two gliders; in 3D it's
// the L-shape (horizontal at the lower glider, vertical up to the higher). The
// layer ids are matched by the RAF loop in deckgl.tsx to clone fresh positions
// each frame without a React render.
export function compareLayers(result: CompareResult | null, map2d: boolean): any[] {
    const line = new PathLayer<CompareResult>({
        id: 'compare-line',
        data: result ? [result] : [],
        getPath: (d) => (map2d ? [d.source, d.target] : lPath(d.source, d.target)),
        getColor: LINE_COLOR,
        getWidth: 4,
        widthUnits: 'pixels',
        widthMinPixels: 4,
        jointRounded: true,
        capRounded: true,
        // Screen-space width in 3D — otherwise the vertical leg (zero horizontal
        // extent) collapses under ground-plane extrusion. Match the track layer:
        // billboard off in 2D (doesn't render on some devices).
        billboard: !map2d,
        parameters: {depthCompare: 'always', depthWriteEnabled: false},
        updateTriggers: {getPath: [map2d, result?.source, result?.target]}
    });
    const label = new TextLayer<CompareResult>({
        id: 'compare-label',
        data: result ? [result] : [],
        getPosition: (d) => d.mid,
        getText: (d) => d.label,
        getColor: [255, 255, 255, 255],
        getSize: 14,
        getBackgroundColor: LABEL_BG,
        background: true,
        backgroundPadding: [6, 3, 6, 3],
        fontFamily: UI_FONT,
        characterSet: 'auto',
        billboard: true,
        getPixelOffset: [0, -12],
        parameters: {depthCompare: 'always', depthWriteEnabled: false},
        updateTriggers: {getText: result?.label}
    });
    return [line, label];
}
