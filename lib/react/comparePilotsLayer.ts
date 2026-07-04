//
// "Compare" mode for the options toolbar. Compares the selected glider (A) with a
// target glider (B), where B is:
//   1. the hovered glider (map icon or pilot list), when one is hovered, or
//   2. (Sailplane Grand Prix only) the leaderboard leader (auto sort) — or, when
//      the selection IS the leader, the glider directly behind it.
//
// The comparison is about *scored* progress, not raw GPS separation, so each
// glider is drawn as an arc of equal progress rather than connected by a straight
// line, and the two arcs are joined by a measurement line whose length is the
// scored gap with the label on it. In 3D each arc is drawn at its glider's
// altitude, so the vertical offset shows the height difference and the measurement
// line carries both gaps. Nothing is drawn until both gliders have started. The
// arc geometry itself lives in comparePilotsGeometry.ts (pure / unit-tested).
//

import {PathLayer, TextLayer} from '@deck.gl/layers';
import {PathStyleExtension} from '@deck.gl/extensions';

import type {Compno, Epoch, Units} from '../types';
import type {RootState} from '../redux/store';

import {selectAllPositions} from '../redux/tracksSlice';
import {selectAllScores} from '../redux/scoresSlice';
import {selectAuto} from '../redux/selectPilotResult';

import {displayHeight} from './displayunits';
import {distHaversineRaw} from '../flightprocessing/taskhelper';
import {remaining, buildArc, buildMeasure, pathMidpoint, buildArcSpec, buildVias, type CompareScore, type LngLat, type LngLatAlt, type CompareTask} from './comparePilotsGeometry';

export type {CompareTask} from './comparePilotsGeometry';

// Match the rest of the UI (see gaggleLayer) — already loaded via @font-face so
// deck.gl's TextLayer can rasterise it into its glyph atlas.
const UI_FONT = "'Atkinson Hyperlegible Next', sans-serif";

// Orange indicator; dark label background for contrast against it.
const LINE_COLOR: [number, number, number, number] = [255, 140, 0, 240];
const LABEL_BG: [number, number, number, number] = [20, 20, 20, 215];

// Separates a gap from its (approximate) time-equivalent; clock prefixes a time.
const SEP = '≈';
const TIME_ICON = '⏱';

export interface CompareResult {
    selCompno: Compno;
    tgtCompno: Compno;
    source: [number, number, number]; // [lng, lat, amsl]
    target: [number, number, number];
    label: string;
    labelPos: [number, number, number];
    arcSel2d: LngLat[];
    arcSel3d: LngLatAlt[];
    arcTgt2d: LngLat[];
    arcTgt3d: LngLatAlt[];
    measure2d: LngLat[];
    measure3d: LngLatAlt[];
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
    labels: CompareLabels,
    task?: CompareTask
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

    const scores = selectAllScores(state, scoreT) ?? {};
    const selScore = scores[selectedCompno] as CompareScore | undefined;
    const tgtScore = scores[tgtCompno] as CompareScore | undefined;

    // Before both gliders have started the comparison is meaningless (and the
    // arcs have no leg to sit on) — draw nothing.
    if (!selScore?.utcStart || !tgtScore?.utcStart) return null;

    // Task-aware separation: difference in remaining task distance, else great-circle.
    const selRem = remaining(selScore?.actual);
    const tgtRem = remaining(tgtScore?.actual);
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
            ? `${tgtCompno}: ${Math.round(Math.abs(gapSigned) * 10) / 10} ${labels.km} ${dirH(gapSigned)}` + (dTime !== undefined ? ` ${SEP} ${dur(dTime)}` : '')
            : `${tgtCompno}: ${Math.round(distHaversineRaw(source, target) * 10) / 10} ${labels.km}`;

    const heightLine = `${tgtCompno}: ${displayHeight(Math.abs(heightSigned), units)} ${dirV(heightSigned)}` + (cTime !== undefined ? ` ${SEP} ${dur(cTime)}` : '');

    const totalTime = (dTime ?? 0) + (cTime ?? 0);
    const totalLine = dTime !== undefined || cTime !== undefined ? `${tgtCompno}: ${dur(totalTime)} ${dirH(totalTime)}` : '';

    const label = [distLine, heightLine, totalLine].filter(Boolean).join('\n');

    // Build the scored-position arcs. behind = larger remaining; the measurement
    // line runs behind → ahead.
    const aat = !!task?.rules?.aat;
    const selSpec = buildArcSpec(aat, task?.legs, selScore, source);
    const tgtSpec = buildArcSpec(aat, task?.legs, tgtScore, target);

    const selBehind = selRem >= tgtRem;
    const behindSpec = selBehind ? selSpec : tgtSpec;
    const aheadSpec = selBehind ? tgtSpec : selSpec;
    const behindScore = selBehind ? selScore : tgtScore;
    const behindLeg = (selBehind ? selScore : tgtScore)?.currentLeg ?? 0;
    const aheadLeg = (selBehind ? tgtScore : selScore)?.currentLeg ?? 0;

    let arcSel2d: LngLat[] = [];
    let arcSel3d: LngLatAlt[] = [];
    let arcTgt2d: LngLat[] = [];
    let arcTgt3d: LngLatAlt[] = [];
    let measure2d: LngLat[];
    let measure3d: LngLatAlt[];

    if (behindSpec && aheadSpec && selSpec && tgtSpec) {
        ({arc2d: arcSel2d, arc3d: arcSel3d} = buildArc(selSpec));
        ({arc2d: arcTgt2d, arc3d: arcTgt3d} = buildArc(tgtSpec));
        const vias = buildVias(aat, task?.legs, behindScore, behindLeg, aheadLeg);
        const behindAnchor: LngLatAlt = [behindSpec.anchor[0], behindSpec.anchor[1], behindSpec.alt];
        const aheadAnchor: LngLatAlt = [aheadSpec.anchor[0], aheadSpec.anchor[1], aheadSpec.alt];
        ({measure2d, measure3d} = buildMeasure(behindAnchor, aheadAnchor, vias));
    } else {
        // No task geometry (e.g. task not loaded, or no scored point yet) — fall
        // back to a direct connector between the gliders so the label still shows.
        ({measure2d, measure3d} = buildMeasure(source, target, []));
    }

    const labelPos = pathMidpoint(measure3d) as [number, number, number];

    return {selCompno: selectedCompno, tgtCompno, source, target, label, labelPos, arcSel2d, arcSel3d, arcTgt2d, arcTgt3d, measure2d, measure3d};
}

// useSelector equality — only re-render when something visible changes, so the
// React layer is stable between the per-second data ticks the RAF loop smooths.
// The arc geometry derives deterministically from the endpoints + (stable) task,
// so comparing the endpoints and label is sufficient.
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

// The path rows the `compare-line` PathLayer draws: the measurement line plus the
// two arcs. Shared by `compareLayers` and the RAF clone in deckgl.tsx so both
// produce identical geometry. Each row carries 2D and 3D paths; the layer's
// getPath closure picks per map mode. Degenerate (single-point) paths are dropped.
export function compareLineRows(d: CompareResult): {path2d: LngLat[]; path3d: LngLatAlt[]; role: 'measure' | 'arc'}[] {
    const rows: {path2d: LngLat[]; path3d: LngLatAlt[]; role: 'measure' | 'arc'}[] = [
        {path2d: d.measure2d, path3d: d.measure3d, role: 'measure'},
        {path2d: d.arcSel2d, path3d: d.arcSel3d, role: 'arc'},
        {path2d: d.arcTgt2d, path3d: d.arcTgt3d, role: 'arc'}
    ];
    return rows.filter((r) => r.path2d.length > 1);
}

//
// Build the deck.gl layers for a comparison (dotted orange arcs + measurement line
// + billboard label). Returns empty-data layers when there's nothing to draw (so
// the RAF loop can still find and clone them). depth compare is forced 'always' so
// they aren't occluded by terrain in 3D; billboard off in 2D (doesn't render on
// some devices). The layer ids are matched by the RAF loop in deckgl.tsx to clone
// fresh geometry each frame without a React render.
export function compareLayers(result: CompareResult | null, map2d: boolean): any[] {
    type Row = {path2d: LngLat[]; path3d: LngLatAlt[]; role: 'measure' | 'arc'};
    const line = new PathLayer<Row>({
        id: 'compare-line',
        data: result ? compareLineRows(result) : [],
        getPath: (d) => (map2d ? d.path2d : d.path3d),
        getColor: LINE_COLOR,
        // Measurement line reads heavier than the arcs.
        getWidth: (d) => (d.role === 'measure' ? 3 : 2),
        widthUnits: 'pixels',
        widthMinPixels: 2,
        extensions: [new PathStyleExtension({dash: true})],
        // getDashArray/dashJustified are contributed by PathStyleExtension and
        // aren't on PathLayer's base prop type — cast just these two.
        ...({getDashArray: [3, 5], dashJustified: true} as object),
        jointRounded: true,
        capRounded: true,
        billboard: !map2d,
        parameters: {depthCompare: 'always', depthWriteEnabled: false},
        updateTriggers: {getPath: [map2d, result?.measure3d, result?.arcSel3d, result?.arcTgt3d]}
    });
    const label = new TextLayer<CompareResult>({
        id: 'compare-label',
        data: result ? [result] : [],
        getPosition: (d) => d.labelPos,
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
        updateTriggers: {getText: result?.label, getPosition: result?.labelPos}
    });
    return [line, label];
}
