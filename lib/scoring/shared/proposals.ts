// Score-driven proposal generation for findtrackers. Pure functions: matches +
// per-pair scores in, Proposal[] out. No DB, no I/O — the CLI in
// bin/findtrackers.ts owns persistence and the interactive review flow.
//
// A pair is proposed only when its post-demotion total clears
// SCORE_PROPOSE_NATS and, when either side is contested, its two-sided margin
// clears DEFAULT_AUTO_MARGIN_NATS. Every condition the old categorical gates
// encoded (within-tolerance, one-sidedness, competing claims) is already
// reflected in the score and the contention demotions, so the gate here is
// purely numeric; a demoted pair (negative total) can never be proposed.

import type {Compno, ClassName, FlarmID} from '../../types';
import type {TrackerMatch} from './findtrackers';
import type {ScoreBreakdown, Margins} from './trackerScore';
import {samePilotName} from './identity';
import {SCORE_PROPOSE_NATS, DEFAULT_AUTO_MARGIN_NATS} from '../../constants';

// A flarmid → pilots that produced a clean (within-tolerance, non-ambiguous)
// phase-1 match in any class of the same (compid, datecode). Used to surface
// "this assigned tracker actually matches a pilot in another class" — the
// case where a flarm unit was moved between gliders during a comp.
export interface CrossClassHit {
    className: ClassName;
    classDisplay: string;
    compno: Compno;
    name: string;
    deltaStart: number | null;
    deltaFinish: number | null;
    /** This flarmid is currently in the other-class pilot's trackerid list. */
    assigned: boolean;
    /** Score breakdown for this (compno, flarmid) in the other class, including prior evidence. */
    score: ScoreBreakdown;
    margins: Margins;
    pilotContested: boolean;
    flarmidContested: boolean;
    xcFacets: string[];
    /** Total was negated by a contention guard in that class. */
    demoted: boolean;
    demotedReason?: 'flarm' | 'pilot' | 'both';
}
export type CrossClassMap = Map<FlarmID, CrossClassHit[]>;

export interface ScoredPair {
    score: ScoreBreakdown;
    margins: Margins;
    pilotContested: boolean;
    flarmidContested: boolean;
    deltaStart: number | null;
    deltaFinish: number | null;
    xcFacets: string[];
    /** Total was negated by a contention guard — see demotedReason. */
    demoted: boolean;
    demotedReason?: 'flarm' | 'pilot' | 'both';
}
export type ScoreMap = Map<string, ScoredPair>;
export const scoreKey = (compno: Compno, flarmid: FlarmID) => `${compno}|${flarmid}`;

export interface Proposal {
    compno: Compno;
    name: string;
    currentTrackerid: string;
    newTrackerid: string;
    addedIds: FlarmID[];
    removedIds: FlarmID[];
    reason: string;
    // Start/finish crossing deltas for the chosen flarmid (the addedId, or the
    // assigned flarmid being removed when there's no addedId). These are the
    // ONLY score context persisted on the applied trackerhistory row — the next
    // day's prior loader rebuilds its crossing score from them. Everything else
    // (composite score, margin, ddb link) is derivable live and is not stored.
    deltaStart: number | null;
    deltaFinish: number | null;
}

export function parseCurrentIds(raw: string): FlarmID[] {
    const out: FlarmID[] = [];
    if (!raw) return out;
    for (const part of raw.split(',')) {
        const t = part.trim();
        if (!t) continue;
        const lc = t.toLowerCase();
        if (lc === 'unknown' || lc === 'blocked') continue;
        out.push(t as FlarmID);
    }
    return out;
}

export function crossClassHitsFor(flarmid: FlarmID, thisClass: ClassName, crossClass: CrossClassMap | undefined): CrossClassHit[] {
    if (!crossClass) return [];
    const all = crossClass.get(flarmid);
    if (!all) return [];
    return all.filter((h) => h.className !== thisClass);
}

// Cross-class hits that represent a genuine "moved glider" conflict — i.e.
// excluding hits that are the same physical glider scored in two classes:
// the same compno in a task-twin class (see loadTaskTwins), or the same
// compno AND same pilot name in any class of the comp (twin-pilot entry,
// detected even when the task geometry differs). A hit to a twin class under
// a *different* compno is still a real conflict and kept.
export function conflictingCrossClassHits(flarmid: FlarmID, thisClass: ClassName, crossClass: CrossClassMap | undefined, twinClasses: Set<ClassName>, compno: Compno, pilotName: string): CrossClassHit[] {
    return crossClassHitsFor(flarmid, thisClass, crossClass).filter((h) => {
        if (h.compno !== compno) return true;
        if (twinClasses.has(h.className)) return false;
        return !samePilotName(h.name, pilotName);
    });
}

/**
 * Short one-liner per cross-class hit. Used in proposal `reason` strings
 * (which get joined into a single-line CSV-friendly log entry).
 */
export function describeCrossClass(flarmid: FlarmID, thisClass: ClassName, crossClass: CrossClassMap | undefined): string[] {
    return crossClassHitsFor(flarmid, thisClass, crossClass).map((h) => {
        const classLabel = h.classDisplay ? `${h.classDisplay} [${h.className}]` : h.className;
        const tag = h.assigned ? ' [their assigned ID]' : '';
        return `also matches ${String(h.compno).trim()} in class ${classLabel}${tag}`;
    });
}

// A flarmid that was active in the scan window but overwhelmingly outside the
// task area is almost certainly a different comp's glider that briefly
// drifted into our bbox.
const STRONG_NEGATIVE_RATIO = 0.1;

export interface ProposalGates {
    /** Absolute total floor for proposing a pair (default SCORE_PROPOSE_NATS). */
    proposeNats?: number;
    /** Min two-sided margin when either side is contested (default DEFAULT_AUTO_MARGIN_NATS). */
    marginNats?: number;
}

export function computeProposals(matches: TrackerMatch[], scoreMap: ScoreMap, crossClass: CrossClassMap, thisClass: ClassName, twinClasses: Set<ClassName>, gates: ProposalGates = {}): Proposal[] {
    const proposeNats = gates.proposeNats ?? SCORE_PROPOSE_NATS;
    const marginNats = gates.marginNats ?? DEFAULT_AUTO_MARGIN_NATS;

    const byPilot = new Map<Compno, TrackerMatch[]>();
    for (const m of matches) {
        const arr = byPilot.get(m.compno) ?? [];
        arr.push(m);
        byPilot.set(m.compno, arr);
    }

    const fmt = (n: number) => n.toFixed(2);
    const out: Proposal[] = [];
    for (const [compno, rows] of byPilot) {
        const scored = (m: TrackerMatch): ScoredPair | undefined => scoreMap.get(scoreKey(compno, m.flarmid));

        // Already-good assignment: any assigned, non-demoted pair clearing the
        // proposal floor means the operator's choice stands — leave the pilot
        // alone even if a higher-scoring alternative exists.
        if (rows.some((m) => m.assigned && scored(m) && !scored(m)!.demoted && scored(m)!.score.total >= proposeNats)) continue;

        // Add candidate: highest post-demotion total among unassigned pairs.
        // Demoted pairs are never proposed — a contention guard concluded the
        // flarmid (or the pilot) is confidently held elsewhere. Contested pairs
        // additionally need a clear two-sided margin; a tie is contested with
        // margin ≤ 0, so it can never sneak through.
        let addRow: TrackerMatch | null = null;
        let addScored: ScoredPair | null = null;
        for (const m of rows) {
            if (m.assigned) continue;
            const s = scored(m);
            if (!s || s.demoted) continue;
            if (s.score.total < proposeNats) continue;
            if ((s.pilotContested || s.flarmidContested) && s.margins.margin < marginNats) continue;
            if (!addScored || s.score.total > addScored.score.total) {
                addRow = m;
                addScored = s;
            }
        }
        const addId: FlarmID | null = addRow?.flarmid ?? null;

        // Removal needs *positive* evidence the assigned id is wrong — a low
        // score alone can be poor FLARM coverage, a DNF, or a no-finish
        // landout. Strong-negative triggers: a replacement candidate, a
        // conflicting cross-class match ("moved glider"), every packet outside
        // the task area, or overwhelmingly-elsewhere traffic. Each trigger is
        // score-guarded: never remove an assigned pair that outscores the
        // replacement (or, with no replacement, one that clears the floor).
        const removeIds = new Set<FlarmID>();
        const removeNotes: string[] = [];
        for (const m of rows) {
            if (!m.assigned) continue;
            const s = scored(m);
            const total = s?.score.total ?? 0; // a demoted pair's total is already negative
            const scoreCeiling = addScored ? addScored.score.total : proposeNats;
            if (total >= scoreCeiling) continue;
            const crossClassHit = conflictingCrossClassHits(m.flarmid, thisClass, crossClass, twinClasses, compno, m.name).length > 0;
            const packets = (m.diag?.inBboxPackets ?? 0) + (m.diag?.bboxRejectedPackets ?? 0);
            const ratio = packets > 0 ? (m.diag?.inBboxPackets ?? 0) / packets : 0;
            const lowRatio = packets > 0 && ratio <= STRONG_NEGATIVE_RATIO;
            if (addId || crossClassHit || m.bboxOnly || lowRatio) {
                removeIds.add(m.flarmid);
                removeNotes.push(`S(${m.flarmid})=${fmt(total)}`);
            }
        }

        if (!addId && removeIds.size === 0) continue;

        const first = rows[0];
        const currentIds = parseCurrentIds(first.currentTrackerid);
        const newIds: FlarmID[] = [];
        for (const id of currentIds) if (!removeIds.has(id)) newIds.push(id);
        if (addId && !newIds.includes(addId)) newIds.push(addId);

        const newTrackerid = newIds.length ? newIds.join(',') : 'unknown';
        if (newTrackerid === first.currentTrackerid) continue;

        const addGate = addScored //
            ? addScored.pilotContested || addScored.flarmidContested
                ? `S=${fmt(addScored.score.total)} margin=${fmt(addScored.margins.margin)}`
                : `S=${fmt(addScored.score.total)} uncontested`
            : '';
        const baseReason = addId //
            ? removeIds.size
                ? `replace: ${addGate} > ${removeNotes.join(', ')}`
                : `associate: ${addGate}`
            : `assigned tracker has strong negative signal (${removeNotes.join(', ')}; out-of-area or other-class match)`;

        // Annotate the reason with any cross-class hits for the flarmids
        // we're removing — strong evidence the tracker is now flying with
        // a pilot in another class.
        const crossInfo: string[] = [];
        for (const id of removeIds) {
            for (const line of describeCrossClass(id, thisClass, crossClass)) {
                crossInfo.push(`${id} ${line}`);
            }
        }
        const reason = crossInfo.length ? `${baseReason}; ${crossInfo.join('; ')}` : baseReason;

        // Pull the crossing deltas for the flarmid we're acting on. Prefer the
        // addedId (the new chosen flarmid), else the assigned flarmid being
        // removed. Null when that flarmid never produced a tracked crossing.
        const focusFlarmid = addId ?? Array.from(removeIds)[0];
        const focusMatch = focusFlarmid ? rows.find((m) => m.flarmid === focusFlarmid) : undefined;
        out.push({
            compno,
            name: first.name,
            currentTrackerid: first.currentTrackerid,
            newTrackerid,
            addedIds: addId ? [addId] : [],
            removedIds: Array.from(removeIds),
            reason,
            deltaStart: focusMatch?.deltaStart ?? null,
            deltaFinish: focusMatch?.deltaFinish ?? null
        });
    }
    out.sort((a, b) => a.compno.localeCompare(b.compno));
    return out;
}
