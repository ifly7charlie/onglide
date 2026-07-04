import {describe, test, expect} from 'vitest';
import {computeProposals, scoreKey, type ScoreMap, type ScoredPair, type CrossClassMap, type CrossClassHit} from '../lib/scoring/shared/proposals';
import type {TrackerMatch} from '../lib/scoring/shared/findtrackers';
import type {ScoreBreakdown} from '../lib/scoring/shared/trackerScore';
import type {ClassName, Compno, FlarmID} from '../lib/types';

const THIS_CLASS = 'club' as ClassName;
const OTHER_CLASS = 'std' as ClassName;
const NO_TWINS = new Set<ClassName>();
const GATES = {proposeNats: 2.0, marginNats: 2.0};

const breakdown = (total: number): ScoreBreakdown => ({deltaStart: 0, deltaFinish: 0, distAtStart: 0, distAtFinish: 0, negStart: 0, negFinish: 0, inBbox: 0, preLaunch: 0, ddbCn: 0, ddbGlider: 0, baseline: 0, prior: 0, xc: 0, total});

const match = (over: Omit<Partial<TrackerMatch>, 'compno' | 'flarmid'> & {compno: string; flarmid: string}): TrackerMatch => ({
    name: 'A Pilot',
    deltaStart: -1,
    deltaFinish: 0,
    confidence: 1,
    currentTrackerid: 'unknown',
    assigned: false,
    withinTolerance: true,
    ambiguous: false,
    skipped: false,
    bboxOnly: false,
    diag: undefined,
    ...over,
    compno: over.compno as Compno,
    flarmid: over.flarmid as FlarmID
});

const scored = (total: number, over: Partial<ScoredPair> = {}): ScoredPair => ({
    score: breakdown(total),
    margins: {pilotMargin: total, flarmidMargin: total, margin: total},
    pilotContested: false,
    flarmidContested: false,
    deltaStart: -1,
    deltaFinish: 0,
    xcFacets: [],
    demoted: false,
    ...over
});

const scoreMapOf = (entries: [TrackerMatch, ScoredPair][]): ScoreMap => new Map(entries.map(([m, s]) => [scoreKey(m.compno, m.flarmid), s]));

const crossHit = (over: Omit<Partial<CrossClassHit>, 'compno'> & {compno: string}): CrossClassHit => ({
    className: OTHER_CLASS,
    classDisplay: 'Standard',
    name: 'A Pilot',
    deltaStart: 0,
    deltaFinish: 0,
    assigned: true,
    score: breakdown(5),
    margins: {pilotMargin: 5, flarmidMargin: 5, margin: 5},
    pilotContested: false,
    flarmidContested: false,
    xcFacets: [],
    demoted: false,
    ...over,
    compno: over.compno as Compno
});

describe('computeProposals (score-driven)', () => {
    test('regression: a demoted candidate is never proposed, even as the only option', () => {
        // HM (landout, no tracker) start-only matches D003D4 — but the scorer
        // demoted the pair because SNV confidently holds that flarmid.
        const hm = match({compno: 'HM', flarmid: 'D003D4', deltaFinish: null, withinTolerance: false});
        const snv = match({compno: 'SNV', flarmid: 'D003D4', deltaStart: -9, currentTrackerid: 'D003D4', assigned: true, withinTolerance: false});
        const sm = scoreMapOf([
            [hm, scored(-1.3, {demoted: true, demotedReason: 'flarm', flarmidContested: true, margins: {pilotMargin: -7.55, flarmidMargin: -7.55, margin: -7.55}})],
            [snv, scored(6.25, {flarmidContested: true, margins: {pilotMargin: 6.25, flarmidMargin: 7.55, margin: 6.25}})]
        ]);
        const proposals = computeProposals([hm, snv], sm, new Map(), THIS_CLASS, NO_TWINS, [], GATES);
        expect(proposals.filter((p) => p.compno === ('HM' as Compno))).toEqual([]);
    });

    test('absolute floor: just below → nothing; just above (uncontested) → proposed', () => {
        const below = match({compno: 'AA', flarmid: 'F1'});
        const pBelow = computeProposals([below], scoreMapOf([[below, scored(1.9)]]), new Map(), THIS_CLASS, NO_TWINS, [], GATES);
        expect(pBelow).toEqual([]);

        const above = match({compno: 'AA', flarmid: 'F1'});
        const pAbove = computeProposals([above], scoreMapOf([[above, scored(2.1)]]), new Map(), THIS_CLASS, NO_TWINS, [], GATES);
        expect(pAbove).toHaveLength(1);
        expect(pAbove[0].addedIds).toEqual(['F1']);
        expect(pAbove[0].newTrackerid).toBe('F1');
    });

    test('contested pair additionally needs the margin gate', () => {
        const m = match({compno: 'AA', flarmid: 'F1'});
        const thin = scoreMapOf([[m, scored(4.0, {flarmidContested: true, margins: {pilotMargin: 4, flarmidMargin: 1.0, margin: 1.0}})]]);
        expect(computeProposals([m], thin, new Map(), THIS_CLASS, NO_TWINS, [], GATES)).toEqual([]);

        const wide = scoreMapOf([[m, scored(4.0, {flarmidContested: true, margins: {pilotMargin: 4, flarmidMargin: 2.5, margin: 2.5}})]]);
        const p = computeProposals([m], wide, new Map(), THIS_CLASS, NO_TWINS, [], GATES);
        expect(p).toHaveLength(1);
        expect(p[0].addedIds).toEqual(['F1']);
    });

    test('ambiguous rows are no longer skipped — strong score + margin still proposes', () => {
        const m = match({compno: 'AA', flarmid: 'F1', ambiguous: true});
        const sm = scoreMapOf([[m, scored(3.5, {pilotContested: true, margins: {pilotMargin: 2.6, flarmidMargin: 3.5, margin: 2.6}})]]);
        const p = computeProposals([m], sm, new Map(), THIS_CLASS, NO_TWINS, [], GATES);
        expect(p).toHaveLength(1);
        expect(p[0].addedIds).toEqual(['F1']);
    });

    test('assigned-good skip: an assigned pair clearing the floor stands, even against a higher-scoring alternative', () => {
        const assigned = match({compno: 'AA', flarmid: 'F1', currentTrackerid: 'F1', assigned: true});
        const alt = match({compno: 'AA', flarmid: 'F2'});
        const sm = scoreMapOf([
            [assigned, scored(2.5)],
            [alt, scored(4.0)]
        ]);
        expect(computeProposals([assigned, alt], sm, new Map(), THIS_CLASS, NO_TWINS, [], GATES)).toEqual([]);
    });

    test('replacement: weak assigned pair is removed in favour of a clearing alternative', () => {
        const assigned = match({compno: 'AA', flarmid: 'F1', currentTrackerid: 'F1', assigned: true, withinTolerance: false, deltaStart: null, deltaFinish: null, confidence: null});
        const alt = match({compno: 'AA', flarmid: 'F2'});
        const sm = scoreMapOf([
            [assigned, scored(0.6)],
            [alt, scored(3.0)]
        ]);
        const p = computeProposals([assigned, alt], sm, new Map(), THIS_CLASS, NO_TWINS, [], GATES);
        expect(p).toHaveLength(1);
        expect(p[0].addedIds).toEqual(['F2']);
        expect(p[0].removedIds).toEqual(['F1']);
        expect(p[0].newTrackerid).toBe('F2');
    });

    test('removal without replacement needs a strong-negative trigger: low score alone keeps the assignment', () => {
        const assigned = match({compno: 'AA', flarmid: 'F1', currentTrackerid: 'F1', assigned: true, withinTolerance: false, deltaStart: null, deltaFinish: null, confidence: null});
        const sm = scoreMapOf([[assigned, scored(0.3)]]);
        expect(computeProposals([assigned], sm, new Map(), THIS_CLASS, NO_TWINS, [], GATES)).toEqual([]);
    });

    test('bboxOnly assigned pair below the floor is removed → trackerid falls back to unknown', () => {
        const assigned = match({compno: 'AA', flarmid: 'F1', currentTrackerid: 'F1', assigned: true, withinTolerance: false, deltaStart: null, deltaFinish: null, confidence: null, bboxOnly: true});
        const sm = scoreMapOf([[assigned, scored(0.2)]]);
        const p = computeProposals([assigned], sm, new Map(), THIS_CLASS, NO_TWINS, [], GATES);
        expect(p).toHaveLength(1);
        expect(p[0].removedIds).toEqual(['F1']);
        expect(p[0].newTrackerid).toBe('unknown');
    });

    test('multi-id pilot: removing one weak id preserves the other', () => {
        const bad = match({compno: 'AA', flarmid: 'F1', currentTrackerid: 'F1,F2', assigned: true, withinTolerance: false, deltaStart: null, deltaFinish: null, confidence: null, bboxOnly: true});
        const quiet = match({compno: 'AA', flarmid: 'F2', currentTrackerid: 'F1,F2', assigned: true, withinTolerance: false, deltaStart: null, deltaFinish: null, confidence: null});
        const sm = scoreMapOf([
            [bad, scored(0.2)],
            [quiet, scored(0.6)]
        ]);
        const p = computeProposals([bad, quiet], sm, new Map(), THIS_CLASS, NO_TWINS, [], GATES);
        expect(p).toHaveLength(1);
        expect(p[0].removedIds).toEqual(['F1']);
        expect(p[0].newTrackerid).toBe('F2');
    });

    test('cross-class hit triggers removal of a weak assigned id', () => {
        const assigned = match({compno: 'AA', flarmid: 'F1', currentTrackerid: 'F1', assigned: true, withinTolerance: false, deltaStart: null, deltaFinish: null, confidence: null});
        const crossClass: CrossClassMap = new Map([['F1' as FlarmID, [crossHit({compno: 'ZZ', name: 'Someone Else'})]]]);
        const sm = scoreMapOf([[assigned, scored(0.4)]]);
        const p = computeProposals([assigned], sm, crossClass, THIS_CLASS, NO_TWINS, [], GATES);
        expect(p).toHaveLength(1);
        expect(p[0].removedIds).toEqual(['F1']);
        expect(p[0].reason).toContain('also matches ZZ');
    });

    test('same compno+name in another (non-twin) class is corroboration, not a conflict — no removal', () => {
        const assigned = match({compno: 'AA', flarmid: 'F1', name: 'José García', currentTrackerid: 'F1', assigned: true, withinTolerance: false, deltaStart: null, deltaFinish: null, confidence: null});
        // Accent/case differences must not defeat the same-pilot detection.
        const crossClass: CrossClassMap = new Map([['F1' as FlarmID, [crossHit({compno: 'AA', name: 'jose garcia'})]]]);
        const sm = scoreMapOf([[assigned, scored(0.4)]]);
        expect(computeProposals([assigned], sm, crossClass, THIS_CLASS, NO_TWINS, [], GATES)).toEqual([]);
    });

    test('confidence=null does not block replacement: Phase-2 assigned row clears score floor from identity only, replacement still proposed', () => {
        // Replicates the I|DF1855 pattern: ognddb-assigned, confidence=null,
        // score driven solely by presence+ddbCN+baseline (no crossing evidence).
        // A better-evidenced unassigned candidate (DDDC83) should still be proposed.
        const assigned = match({
            compno: 'I',
            flarmid: 'DF1855' as FlarmID,
            currentTrackerid: 'DF1855',
            assigned: true,
            withinTolerance: false,
            confidence: null,
            deltaStart: null,
            deltaFinish: null
        });
        const better = match({compno: 'I', flarmid: 'DDDC83' as FlarmID});
        const sm = scoreMapOf([
            [assigned, scored(3.0)], // high score, but confidence=null — identity only
            [better, scored(5.16, {pilotContested: true, margins: {pilotMargin: 2.16, flarmidMargin: 5.16, margin: 2.16}})]
        ]);
        const p = computeProposals([assigned, better], sm, new Map(), THIS_CLASS, NO_TWINS, [], GATES);
        expect(p).toHaveLength(1);
        expect(p[0].addedIds).toEqual(['DDDC83']);
        expect(p[0].removedIds).toEqual(['DF1855']);
    });

    test('confidence≠null AND score above floor still blocks replacement (the happy path)', () => {
        // Same setup but confidence is non-null — the already-good gate should fire.
        const assigned = match({
            compno: 'I',
            flarmid: 'DF1855' as FlarmID,
            currentTrackerid: 'DF1855',
            assigned: true,
            withinTolerance: true,
            confidence: 1,
            deltaStart: -1,
            deltaFinish: 0
        });
        const better = match({compno: 'I', flarmid: 'DDDC83' as FlarmID});
        const sm = scoreMapOf([
            [assigned, scored(3.0)],
            [better, scored(5.16, {pilotContested: true, margins: {pilotMargin: 2.16, flarmidMargin: 5.16, margin: 2.16}})]
        ]);
        expect(computeProposals([assigned, better], sm, new Map(), THIS_CLASS, NO_TWINS, [], GATES)).toEqual([]);
    });

    test('best unassigned candidate wins by score; the proposal carries its crossing deltas', () => {
        const weaker = match({compno: 'AA', flarmid: 'F1', deltaStart: -3, deltaFinish: -2});
        const stronger = match({compno: 'AA', flarmid: 'F2', deltaStart: 0, deltaFinish: 0});
        const sm = scoreMapOf([
            [weaker, scored(2.4, {pilotContested: true, margins: {pilotMargin: -1.0, flarmidMargin: 2.4, margin: -1.0}})],
            [stronger, scored(3.4, {pilotContested: true, margins: {pilotMargin: 1.0, flarmidMargin: 3.4, margin: 1.0}})]
        ]);
        // Both contested with margins under the gate → nothing proposed.
        expect(computeProposals([weaker, stronger], sm, new Map(), THIS_CLASS, NO_TWINS, [], GATES)).toEqual([]);

        // Widen the stronger pair's margin past the gate → it is the proposal.
        const sm2 = scoreMapOf([
            [weaker, scored(1.0, {pilotContested: true, margins: {pilotMargin: -2.4, flarmidMargin: 1.0, margin: -2.4}})],
            [stronger, scored(3.4, {pilotContested: true, margins: {pilotMargin: 2.4, flarmidMargin: 3.4, margin: 2.4}})]
        ]);
        const p = computeProposals([weaker, stronger], sm2, new Map(), THIS_CLASS, NO_TWINS, [], GATES);
        expect(p).toHaveLength(1);
        expect(p[0].addedIds).toEqual(['F2']);
        expect(p[0].deltaStart).toBe(0);
        expect(p[0].deltaFinish).toBe(0);
    });
});
