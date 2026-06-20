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
import type {TrackerMatch, OfficialResult} from './findtrackers';
import type {ScoreBreakdown, Margins} from './trackerScore';
import {samePilotName} from './identity';
import {resolveSameFlight, pathPriorKey, type PathSimilarityResult, type PathPriorMap} from './pathSimilarity';
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
    /** Subset of removedIds displaced because another pilot was confidently assigned this flarmid. Gets a 'displaced' trackerhistory row. */
    displacedIds?: FlarmID[];
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

export function computeProposals(matches: TrackerMatch[], scoreMap: ScoreMap, crossClass: CrossClassMap, thisClass: ClassName, twinClasses: Set<ClassName>, allResults: OfficialResult[], gates: ProposalGates = {}): Proposal[] {
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

        // Already-good assignment: any assigned, non-demoted pair WITH usable
        // crossing evidence (confidence !== null) clearing the proposal floor
        // means the operator's choice stands. Phase-2 rows (confidence=null —
        // no crossings, or only one side within tolerance) are excluded from
        // this check: an assigned tracker that has never been seen crossing the
        // line should not block a better-evidenced replacement even if its
        // identity signals (ddbCN, baseline) push its total above the floor.
        const alreadyGood = rows.some((m) => m.assigned && m.confidence !== null && scored(m) && !scored(m)!.demoted && scored(m)!.score.total >= proposeNats);
        if (alreadyGood) {
            // Even when left alone, report any assigned tracker that has net-negative
            // evidence — likely a mismatched second tracker on a multi-tracker pilot.
            for (const m of rows) {
                if (!m.assigned) continue;
                const s = scored(m);
                if (s && s.score.total < 0) {
                    console.log(`  WARN: ${String(compno)} has assigned ${m.flarmid} with S=${s.score.total.toFixed(2)} (possible mismatched second tracker)`);
                }
            }
            continue;
        }

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
    // Displacement pass: for each proposal that adds a flarmid, find the
    // current holder of that flarmid in this class and generate a removal
    // for them. Cross-class propagation (same compno in twin classes) is
    // handled by syncDisplacementProposals in the caller after all per-class
    // proposals are computed.
    const currentHolderByFlarmid = new Map<FlarmID, {compno: Compno; name: string; trackerid: string}>();
    for (const r of allResults) {
        for (const id of parseCurrentIds(r.trackerid)) {
            currentHolderByFlarmid.set(id, {compno: r.compno, name: r.name, trackerid: r.trackerid});
        }
    }
    const addedByFlarmid = new Map<FlarmID, Proposal>();
    for (const p of out) {
        for (const id of p.addedIds) addedByFlarmid.set(id, p);
    }
    const displacementsByCompno = new Map<Compno, {name: string; trackerid: string; ids: FlarmID[]; reasons: string[]}>();
    for (const [id, adder] of addedByFlarmid) {
        const holder = currentHolderByFlarmid.get(id);
        if (!holder || holder.compno === adder.compno) continue;
        const entry = displacementsByCompno.get(holder.compno) ?? {name: holder.name, trackerid: holder.trackerid, ids: [], reasons: []};
        entry.ids.push(id);
        entry.reasons.push(`${id} taken by ${String(adder.compno)}`);
        displacementsByCompno.set(holder.compno, entry);
    }
    for (const [displacedCompno, {name, trackerid, ids, reasons}] of displacementsByCompno) {
        const reasonSuffix = `displaced: ${reasons.join(', ')}`;
        const existing = out.find((p) => p.compno === displacedCompno);
        if (existing) {
            // Already has a proposal — augment it to also remove the displaced IDs.
            for (const id of ids) {
                if (!existing.removedIds.includes(id)) {
                    existing.removedIds.push(id);
                    const stripped = parseCurrentIds(existing.newTrackerid).filter((t) => t !== id);
                    existing.newTrackerid = stripped.length ? stripped.join(',') : 'unknown';
                }
                if (!existing.displacedIds) existing.displacedIds = [];
                if (!existing.displacedIds.includes(id)) existing.displacedIds.push(id);
            }
            existing.reason += `; ${reasonSuffix}`;
        } else {
            const keptIds = parseCurrentIds(trackerid).filter((id) => !ids.includes(id as FlarmID));
            out.push({
                compno: displacedCompno,
                name,
                currentTrackerid: trackerid,
                newTrackerid: keptIds.length ? keptIds.join(',') : 'unknown',
                addedIds: [],
                removedIds: [...ids],
                displacedIds: [...ids],
                reason: reasonSuffix,
                deltaStart: null,
                deltaFinish: null
            });
        }
    }

    out.sort((a, b) => a.compno.localeCompare(b.compno));
    return out;
}

// Lift the pilot-side contention demotion for pairs that path similarity (and
// prior history) confirm are the same physical flight, so computeProposals
// sees positive totals for both IDs and can generate a join. Only the 'pilot'
// demotion is lifted — 'flarm'/'both' mean a *different pilot* holds the
// flarmid, which path similarity between this pilot's two trackers can't
// resolve. A prior-vetoed (flagged) result is NOT lifted: the demotion stands
// and the CLI surfaces the flag for manual review.
//
// Demotion negates an otherwise ≥0 total exactly once (see computeScoreMap in
// bin/findtrackers.ts), so Math.abs restores the original positive value.
export function liftSameFlightDemotions(scoreMap: ScoreMap, sameFlightMap: Map<Compno, PathSimilarityResult>, priorMap?: PathPriorMap): void {
    for (const [compno, sim] of sameFlightMap) {
        const decision = resolveSameFlight(sim, priorMap?.get(pathPriorKey(compno, sim.flarmidA, sim.flarmidB)));
        if (decision.action !== 'join') continue;
        for (const flarmid of [sim.flarmidA, sim.flarmidB]) {
            const entry = scoreMap.get(scoreKey(compno, flarmid));
            if (entry?.demoted && entry.demotedReason === 'pilot') {
                entry.score.total = Math.abs(entry.score.total);
                entry.demoted = false;
            }
        }
    }
}

// Post-process proposals so a confirmed same-flight pair is JOINED (both IDs
// kept) rather than the lower-scoring one demoted. Mutates `proposals` in place.
// Only acts on pairs resolved to 'join' (prior-vetoed 'flag' results are left
// for the operator). When a proposal already exists for the pilot it's widened
// to include both IDs; otherwise a fresh join proposal is created when both
// IDs are within tolerance.
export function applyPathSimilarityToProposals(proposals: Proposal[], sameFlightMap: Map<Compno, PathSimilarityResult>, priorMap: PathPriorMap | undefined, matches: TrackerMatch[], results: OfficialResult[]): void {
    for (const [compno, sim] of sameFlightMap) {
        const decision = resolveSameFlight(sim, priorMap?.get(pathPriorKey(compno, sim.flarmidA, sim.flarmidB)));
        if (decision.action !== 'join') continue;
        const {flarmidA, flarmidB, fullReport, quickReport} = sim;
        const report = fullReport ?? quickReport!;

        const existing = proposals.find((p) => p.compno === compno);
        if (existing) {
            // If either ID is being displaced to another pilot, this is a real
            // conflict path similarity can't resolve — leave the proposal alone.
            if ((existing.displacedIds ?? []).some((id) => id === flarmidA || id === flarmidB)) continue;
            const bothIds = [...new Set([...existing.addedIds, flarmidA, flarmidB])];
            existing.addedIds = bothIds;
            // We're keeping both IDs now — drop them from removedIds so the
            // proposal stays internally consistent with newTrackerid.
            existing.removedIds = existing.removedIds.filter((id) => id !== flarmidA && id !== flarmidB);
            const kept = parseCurrentIds(existing.currentTrackerid).filter((id) => !existing.removedIds.includes(id));
            existing.newTrackerid = [...new Set([...kept, ...bothIds])].join(',');
            existing.reason += `; path-similarity ${report.classification.summary}`;
        } else {
            // Neither candidate crossed the proposal threshold individually, but
            // path similarity confirms same flight — generate a join proposal.
            const mA = matches.find((m) => m.compno === compno && m.flarmid === flarmidA);
            const mB = matches.find((m) => m.compno === compno && m.flarmid === flarmidB);
            if (!mA?.withinTolerance || !mB?.withinTolerance) continue;
            const pilot = results.find((r) => r.compno === compno);
            if (!pilot) continue;
            proposals.push({
                compno,
                name: pilot.name,
                currentTrackerid: pilot.trackerid,
                newTrackerid: [flarmidA, flarmidB].join(','),
                addedIds: [flarmidA, flarmidB],
                removedIds: [],
                reason: `path similarity: ${report.classification.summary}`,
                deltaStart: mA.deltaStart ?? mB.deltaStart,
                deltaFinish: mA.deltaFinish ?? mB.deltaFinish
            });
        }
    }
}
