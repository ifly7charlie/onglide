import {ScatterplotLayer, TextLayer} from '@deck.gl/layers';

import {distHaversineRaw} from '../flightprocessing/taskhelper';
import {OPEN_THERMAL_TOLERANCE_S} from '../constants';
import {displayClimb} from './displayunits';
import {climbColour} from './thermalLayer';

import type {Compno, Epoch} from '../types';
import type {StatSegment, Wind} from '../protobuf/onglide';

// A "gaggle" is two or more gliders working the same thermal at the same moment.
// The map already shows every glider's icon and track, but at the zoom levels
// phone users actually fly with, co-circling gliders collapse into an illegible
// pile. Collapsing them into a single marker that reads "how many, climbing how
// well" is both the readability fix and the "what is the gaggle achieving"
// story. This is a *live* (cursor-time) view — unlike the per-thermal badges in
// thermalLayer, which annotate a pilot's whole flight.

// Two gliders within this horizontal distance (km) at the cursor are treated as
// the same thermal. Gliders stacked at different heights in one thermal are
// pulled apart horizontally by wind drift — the higher glider has spent longer
// drifting downwind — so a snapshot of one column can span the better part of a
// kilometre in a stiff breeze. 0.8 km is wide enough to keep a stacked gaggle
// together while staying short of the typical spacing between separate thermals.
// Match the rest of the UI (styles/onglide.scss --font-family-ui). Already loaded
// via @font-face, so deck.gl's TextLayer can rasterise it into its glyph atlas.
const UI_FONT = "'Atkinson Hyperlegible Next', sans-serif";

export const GAGGLE_RADIUS_KM = 0.8;

// Gliders in one thermal, projected back to the ground along the wind (see
// projectToGround), should land on essentially the same point — the thermal's
// source. Two ground cores further apart than this are taken to be separate
// thermals, even if the gliders are momentarily within GAGGLE_RADIUS_KM of each
// other. Tighter than GAGGLE_RADIUS_KM because the drift has been removed.
export const GAGGLE_CORE_RADIUS_KM = 0.3;

// Below this climb a glider isn't really thermalling (or the 40s average is
// noise), and AGL/climb — the time the air has been rising — blows up, throwing
// the projected core kilometres away. Treat such a climb as unusable and fall
// back (neighbours, then the thermal-segment average).
const MIN_CLIMB_FOR_PROJECTION = 0.3;

// Minimal shape we need from selectAllPositions — every loaded pilot with their
// interpolated position at the cursor (absent when the pilot has no deck yet) and
// their AGL (`g`), needed to project the thermal core back to the ground.
export interface PilotPositionLite {
    compno: Compno;
    position?: [number, number, number];
    agl?: number;
}

export interface GaggleMember {
    compno: Compno;
    climb: number; // m/s — live 40s vario (falls back to the thermal-segment average)
}

export interface Gaggle {
    position: [number, number, number]; // lng/lat at the cluster centroid, altitude at the lowest glider (footprint sits under the stack)
    count: number; // every glider in the on-screen cluster
    bestClimb: number; // m/s — strongest live vario among the co-located members (disc colour)
    varioAvg: number; // m/s — mean live vario over the co-located members
    members: GaggleMember[]; // every cluster member, strongest first
}

// A glider circling on its own at the cursor — not part of any gaggle. It gets a
// plain climb label beside it (no footprint disc): a lone glider is not a gaggle,
// but the user still wants to see how it is climbing.
export interface Solo {
    compno: Compno;
    position: [number, number, number];
    climb: number; // m/s — live 40s vario (falls back to the thermal-segment average)
}

// Everything the label layers need to place text beside a marker on the side of
// the screen with the most room (so it never spills off the edge) and to know how
// far out the footprint disc reaches in pixels. Supplied by deckgl.tsx from the
// live map camera; `viewKey` changes whenever the camera moves so the per-datum
// anchor/offset accessors are re-evaluated.
export interface LabelPlacement {
    project: (lngLat: [number, number]) => {x: number; y: number} | null;
    screenWidth: number;
    zoom: number;
    viewKey: string;
}

// The open thermal's `end` only reaches the client every STATS_INTERIM_INTERVAL
// (stats for an in-progress thermal are re-sent at that cadence, not per fix), so
// for most of each interval the live cursor (latestUpdate − DISPLAY_CURSOR_LAG_S)
// sits *past* the reported end even though the glider is still circling — which is
// why the hover tooltip (which reads an actual fix time inside the segment) shows
// the thermal but the live badge did not. OPEN_THERMAL_TOLERANCE_S treats the
// *final* segment as still-open for a while past its reported end (see constants).
//
// The thermal segment a pilot is inside at time `t`, if any. The pilotStats
// store is a single accumulator with no per-time snapshot, so we scan for a
// 'thermal' segment whose [start,end] straddles the cursor, then fall back to the
// open (last) thermal within the tolerance above.
function currentThermal(segments: StatSegment[] | undefined, t: Epoch): StatSegment | undefined {
    if (!segments?.length) return undefined;
    for (const seg of segments) {
        if (seg.state === 'thermal' && seg.start <= t && t <= seg.end) return seg;
    }
    const last = segments[segments.length - 1];
    if (last?.state === 'thermal' && t >= last.start && t <= last.end + OPEN_THERMAL_TOLERANCE_S) return last;
    return undefined;
}

// A glider's current circling state at the cursor: where it is, the open thermal
// segment it's in (for the segment average + wind), and its AGL (to project the
// thermal core back to the ground).
interface Circler {
    compno: Compno;
    position: [number, number, number];
    seg: StatSegment;
    agl?: number;
}

const METERS_PER_DEG_LAT = 111320;

// Project a circling glider's air back to the thermal's ground source along the
// wind. The bubble left the ground `AGL / climb` seconds ago and has drifted
// downwind since, so its source lies that drift *upwind* of the glider — i.e. a
// move of `windSpeed × driftTime` along the bearing the wind comes FROM
// (`wind.direction`). Returns the unchanged ground position when there's nothing
// to project (no wind, on the deck, or not climbing).
export function projectToGround(position: [number, number, number], agl: number | undefined, climbMps: number, wind: Wind | undefined): [number, number] {
    const lng = position[0],
        lat = position[1];
    if (!wind?.speed || !agl || agl <= 0 || climbMps <= 0) return [lng, lat];
    const driftTime = agl / climbMps; // s the air has been rising
    const dist = (wind.speed / 3.6) * driftTime; // m upwind to the source (kph → m/s)
    const theta = (wind.direction * Math.PI) / 180; // bearing the wind comes FROM
    const north = dist * Math.cos(theta);
    const east = dist * Math.sin(theta);
    const dLat = north / METERS_PER_DEG_LAT;
    const dLng = east / (METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
    return [lng + dLng, lat + dLat];
}

// The climb to use when projecting a member's core: its own live vario, else the
// mean live vario of the other members, else its own thermal-segment average.
// null when none of those is a usable (thermalling) climb.
function resolveClimb(member: Circler, group: Circler[], avgClimb: Record<string, number | null>): number | null {
    const own = avgClimb[member.compno];
    if (own != null && own >= MIN_CLIMB_FOR_PROJECTION) return own;
    const others = group.filter((o) => o !== member).map((o) => avgClimb[o.compno]).filter((v): v is number => v != null && v >= MIN_CLIMB_FOR_PROJECTION);
    if (others.length) return others.reduce((a, b) => a + b, 0) / others.length;
    const seg = member.seg.avgDelta ?? 0;
    return seg >= MIN_CLIMB_FOR_PROJECTION ? seg : null;
}

// Wind for a member's projection: its own segment wind, else any neighbour's.
function resolveWind(member: Circler, group: Circler[]): Wind | undefined {
    if (member.seg.wind) return member.seg.wind;
    for (const o of group) if (o.seg.wind) return o.seg.wind;
    return undefined;
}

// Of an on-screen cluster, the members that actually share one thermal: project
// each to its ground core (along the wind) and keep the largest core-cluster.
// Members we can't project (no usable climb or wind) are always kept — we have no
// evidence to exclude them — so with no wind data this degrades to "all members".
export function coLocatedMembers(group: Circler[], avgClimb: Record<string, number | null>): Circler[] {
    if (group.length <= 1) return group;

    const cores = group.map((m) => {
        const climb = resolveClimb(m, group, avgClimb);
        const wind = resolveWind(m, group);
        return climb == null || !wind ? null : projectToGround(m.position, m.agl, climb, wind);
    });
    if (cores.every((c) => c == null)) return group;

    const coreless = group.filter((_, i) => !cores[i]);
    const withCore = group.map((m, i) => ({m, core: cores[i]})).filter((x): x is {m: Circler; core: [number, number]} => !!x.core);

    // Same greedy single-linkage-to-seed clustering as the gaggle pass, but on the
    // ground cores and with a tighter radius; the largest cluster is the thermal.
    const remaining = [...withCore];
    let best: typeof withCore = [];
    while (remaining.length) {
        const seed = remaining.shift()!;
        const cl = [seed];
        for (let i = remaining.length - 1; i >= 0; i--) {
            if (distHaversineRaw(seed.core, remaining[i].core) <= GAGGLE_CORE_RADIUS_KM) {
                cl.push(remaining[i]);
                remaining.splice(i, 1);
            }
        }
        if (cl.length > best.length) best = cl;
    }
    return [...best.map((x) => x.m), ...coreless];
}

// Cluster every currently-thermalling glider into gaggles. Pure (no Redux/React)
// so it can be unit-tested and reused by deckgl.tsx to suppress the live
// per-pilot badge of any pilot a gaggle already speaks for. `avgClimb` is the
// live 40s vario per pilot (selectAllAverageClimb) — the headline climb number;
// the thermal-segment average (`seg.avgDelta`) is the secondary readout.
export function computeGaggles(
    positions: PilotPositionLite[] | undefined,
    allPilotStats: Record<string, StatSegment[]> | undefined,
    avgClimb: Record<string, number | null> | undefined,
    t: Epoch | undefined
): {gaggles: Gaggle[]; members: Set<Compno>; solos: Solo[]} {
    const members = new Set<Compno>();
    if (!positions?.length || t == null) return {gaggles: [], members, solos: []};
    const climbRate = avgClimb ?? {};

    // Live vario for a pilot, falling back to their thermal-segment average when
    // the vario is stale/missing — so a badge always shows a number. calculateAverage
    // returns NaN when the deck carries a NaN altitude, and `??` does NOT catch NaN
    // (only null/undefined), so test finiteness explicitly or one bad fix turns the
    // whole gaggle average into NaN.
    const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
    const liveClimb = (compno: Compno, seg: StatSegment): number => (finite(climbRate[compno]) ? (climbRate[compno] as number) : finite(seg.avgDelta) ? seg.avgDelta : 0);

    // Everyone who is circling right now, with their open thermal and AGL.
    const climbing: Circler[] = [];
    for (const p of positions) {
        if (!p.position) continue;
        const seg = currentThermal(allPilotStats?.[p.compno], t);
        if (!seg) continue;
        climbing.push({compno: p.compno, position: p.position, agl: p.agl, seg});
    }

    // Greedy single-linkage-to-seed clustering. N is the number of *circling*
    // gliders in one class — small — so the O(n²) scan is fine.
    const remaining = [...climbing];
    const gaggles: Gaggle[] = [];
    while (remaining.length) {
        const seed = remaining.shift()!;
        const group = [seed];
        for (let i = remaining.length - 1; i >= 0; i--) {
            if (distHaversineRaw(seed.position, remaining[i].position) <= GAGGLE_RADIUS_KM) {
                group.push(remaining[i]);
                remaining.splice(i, 1);
            }
        }
        if (group.length < 2) continue; // a lone glider is not a gaggle

        // Centroid + member list span the whole visible cluster, but the averages
        // only count the members sharing one thermal (projected to the ground).
        // The disc lies flat at the centroid's lng/lat, but its altitude is the
        // *lowest* glider in the stack — a flat plane at the mean height occludes
        // everyone circling below it, so sit it under the whole stack instead.
        let sx = 0,
            sy = 0,
            minZ = Infinity;
        const memberList: GaggleMember[] = [];
        for (const g of group) {
            sx += g.position[0];
            sy += g.position[1];
            if (g.position[2] < minZ) minZ = g.position[2];
            memberList.push({compno: g.compno, climb: liveClimb(g.compno, g.seg)});
            members.add(g.compno);
        }
        memberList.sort((a, b) => b.climb - a.climb);

        const coLocated = coLocatedMembers(group, climbRate);
        let bestClimb = -Infinity,
            sumVario = 0;
        for (const g of coLocated) {
            const vario = liveClimb(g.compno, g.seg);
            sumVario += vario;
            if (vario > bestClimb) bestClimb = vario;
        }

        gaggles.push({
            position: [sx / group.length, sy / group.length, minZ],
            count: group.length,
            bestClimb,
            varioAvg: sumVario / coLocated.length,
            members: memberList
        });
    }

    // Whoever is circling but didn't land in a gaggle is a solo: labelled, but
    // with no disc. (members already holds every gaggle member.)
    const solos: Solo[] = climbing.filter((p) => !members.has(p.compno)).map((p) => ({compno: p.compno, position: p.position, climb: liveClimb(p.compno, p.seg)}));

    return {gaggles, members, solos};
}

// metres-per-pixel at a given latitude/zoom for the web-mercator basemap, used to
// turn the disc's metre radius into the pixel offset that places the label just
// outside its edge.
const EARTH_CIRCUMFERENCE_M_PER_PX_Z0 = 156543.03392; // at the equator, zoom 0
function metersPerPixel(lat: number, zoom: number): number {
    return (EARTH_CIRCUMFERENCE_M_PER_PX_Z0 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

// On-screen radius of a gaggle's footprint disc, matching getRadius +
// radiusMin/MaxPixels below — so the label sits exactly at the rim.
function discPixelRadius(count: number, lat: number, zoom: number): number {
    const px = (200 + count * 40) / metersPerPixel(lat, zoom);
    return Math.max(26, Math.min(140, px));
}

// Decide which side of a marker to hang its label: project the marker to the
// screen and put the text into the roomier half (left-half marker → label to the
// right, and vice versa) so a label near an edge never spills off it. Returns the
// text anchor and the horizontal pixel offset (already signed).
function placeBeside(position: [number, number, number], placement: LabelPlacement, gapPx: number): {anchor: 'start' | 'end'; dx: number} {
    const p = placement.project([position[0], position[1]]);
    const inLeftHalf = p ? p.x < placement.screenWidth / 2 : true;
    return inLeftHalf ? {anchor: 'start', dx: gapPx} : {anchor: 'end', dx: -gapPx};
}

const DARK_STROKE: [number, number, number, number] = [255, 255, 255, 220];
const LIGHT_STROKE: [number, number, number, number] = [32, 32, 32, 210];
const SELECTED_STROKE: [number, number, number, number] = [255, 0, 255, 255]; // matches pilotstracklayer
const HOVERED_STROKE: [number, number, number, number] = [255, 170, 0, 255];

function strokeColour(d: Gaggle, selectedCompno: Compno | undefined, hoveredCompno: Compno | null, mapLight: boolean): [number, number, number, number] {
    if (selectedCompno && d.members.some((m) => m.compno === selectedCompno)) return SELECTED_STROKE;
    if (hoveredCompno && d.members.some((m) => m.compno === hoveredCompno)) return HOVERED_STROKE;
    return mapLight ? LIGHT_STROKE : DARK_STROKE;
}

// Three layers:
//  - a translucent footprint disc under each gaggle (flat in the ground plane so
//    it reads as a footprint when the map is pitched),
//  - the "N ▲climb" gaggle badge (count + averaged live vario of the co-located
//    members), hung just outside the disc on the roomier side of the screen so it
//    clears the circling gliders and never spills off an edge,
//  - a plain "▲climb" badge beside every solo (lone-circling) glider — same idea,
//    no disc.
// Returns [] when there is nothing circling.
export function gaggleLayer(gaggles: Gaggle[], solos: Solo[], units: number | boolean, mapLight: boolean, selectedCompno: Compno | undefined, hoveredCompno: Compno | null, placement: LabelPlacement) {
    const layers: any[] = [];

    if (gaggles.length) {
        const disc = new ScatterplotLayer<Gaggle>({
            id: 'gaggle',
            data: gaggles,
            getPosition: (d) => d.position,
            // Footprint grows a little with crowd size; min-pixels keeps it a
            // finger-sized tap target on a phone even when zoomed out.
            getRadius: (d) => 200 + d.count * 40,
            radiusUnits: 'meters',
            radiusMinPixels: 26,
            radiusMaxPixels: 140,
            getFillColor: (d) => {
                const [r, g, b] = climbColour(d.bestClimb);
                return [r, g, b, 60];
            },
            stroked: true,
            filled: true,
            getLineColor: (d) => strokeColour(d, selectedCompno, hoveredCompno, mapLight),
            getLineWidth: (d) => ((selectedCompno && d.members.some((m) => m.compno === selectedCompno)) || (hoveredCompno && d.members.some((m) => m.compno === hoveredCompno)) ? 3 : 2),
            lineWidthUnits: 'pixels',
            billboard: false, // lie flat in the horizontal plane → footprint when pitched
            pickable: true,
            updateTriggers: {
                getLineColor: [selectedCompno, hoveredCompno, mapLight],
                getLineWidth: [selectedCompno, hoveredCompno]
            }
        });

        const labels = new TextLayer<Gaggle>({
            id: 'gaggle-labels',
            data: gaggles,
            getPosition: (d) => d.position,
            getText: (d) => `${d.count} ▲${displayClimb(d.varioAvg, units)}`,
            getColor: [255, 255, 255, 255],
            getSize: 15,
            getBackgroundColor: (d) => {
                const [r, g, b] = climbColour(d.bestClimb);
                return [r, g, b, 235];
            },
            background: true,
            backgroundPadding: [6, 3, 6, 3],
            fontFamily: UI_FONT,
            characterSet: 'auto',
            fontWeight: 700,
            // Beside the disc (vertically centred on it), on the side of the screen
            // with more room, just clear of the rim.
            getTextAnchor: (d) => placeBeside(d.position, placement, discPixelRadius(d.count, d.position[1], placement.zoom) + 8).anchor,
            getAlignmentBaseline: 'center',
            getPixelOffset: (d) => [placeBeside(d.position, placement, discPixelRadius(d.count, d.position[1], placement.zoom) + 8).dx, 0],
            billboard: true,
            // The disc lies flat at the bottom of the stack; in a pitched (3D) view
            // the billboard label rises from that plane and the disc occludes its
            // lower half via the depth buffer. Always-pass depth + no depth write so
            // the label floats clear of its own footprint (no effect in 2D).
            parameters: {depthCompare: 'always', depthWriteEnabled: false},
            pickable: false, // let picks fall through to the disc (carries the tooltip)
            updateTriggers: {
                getText: [units],
                getTextAnchor: [placement.viewKey],
                getPixelOffset: [placement.viewKey]
            }
        });

        layers.push(disc, labels);
    }

    if (solos.length) {
        const soloLabels = new TextLayer<Solo>({
            id: 'gaggle-solo',
            data: solos,
            getPosition: (d) => d.position,
            getText: (d) => `▲${displayClimb(d.climb, units)}`,
            getColor: [255, 255, 255, 255],
            getSize: 12,
            getBackgroundColor: (d) => {
                const [r, g, b] = climbColour(d.climb);
                return [r, g, b, 235];
            },
            background: true,
            backgroundPadding: [5, 2, 5, 2],
            fontFamily: UI_FONT,
            characterSet: 'auto',
            fontWeight: 700,
            // Beside the glider (a small fixed gap — there's no disc to clear) on
            // the roomier side of the screen.
            getTextAnchor: (d) => placeBeside(d.position, placement, 14).anchor,
            getAlignmentBaseline: 'center',
            getPixelOffset: (d) => [placeBeside(d.position, placement, 14).dx, 0],
            billboard: true,
            pickable: false,
            updateTriggers: {
                getText: [units],
                getTextAnchor: [placement.viewKey],
                getPixelOffset: [placement.viewKey]
            }
        });

        layers.push(soloLabels);
    }

    return layers;
}
