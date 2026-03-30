// DistanceOptimiser.test.ts
import {DistanceOptimiser} from '../lib/flightprocessing/distanceOptimiser';
import {describe, test, expect, vi} from 'vitest';

type Pt = {x: number; y: number};
const w = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const eq = (a: Pt, b: Pt) => a.x === b.x && a.y === b.y;

const makeBasePoints = () => {
    // Reuse object identities for equality tests
    const A = {x: 0, y: 0},
        B = {x: 2, y: 0};
    const C = {x: 3, y: 0},
        D = {x: 0, y: 3};
    const E = {x: 4, y: 0},
        F = {x: 5, y: 5};
    const G = {x: 6, y: 0},
        H = {x: 6, y: 6};
    return {A, B, C, D, E, F, G, H};
};

const makeBaseOptimiser = () => {
    const {A, B, C, D, E, F, G, H} = makeBasePoints();
    // L = 4 groups: G0=[A,B], G1=[C,D], G2=[E,F], G3=[G,H]
    return new DistanceOptimiser<Pt>(w, 4, [
        [A, B],
        [C, D],
        [E, F],
        [G, H]
    ]);
};

describe('DistanceOptimiser (fixed L) – public API', () => {
    test('constructor + getGroups', () => {
        const opt = makeBaseOptimiser();
        const groups = opt.getGroups();
        expect(groups.length).toBe(4);
        expect(groups[0].length).toBe(2);
        expect(groups[3].length).toBe(2);
    });

    test('shortestAll baseline distance and path', () => {
        const opt = makeBaseOptimiser();
        const {distance, path} = opt.shortestAll();
        // Expected: B(2,0) -> C(3,0) -> E(4,0) -> G(6,0): 1 + 1 + 2 = 4
        expect(distance).toBeCloseTo(4, 10);
        expect(path.length).toBe(4);
        expect(path[0]).toEqual({x: 2, y: 0});
        expect(path[path.length - 1]).toEqual({x: 6, y: 0});
    });

    test('shortestFrom with default afterGroup=0 and with explicit values', () => {
        const opt = makeBaseOptimiser();
        const start = {x: 1, y: 0};

        const r0 = opt.shortestFrom(start); // afterGroup=0 -> enter G1..G3
        // Best: start->C (2) + C->E (1) + E->G(2) = 5
        expect(r0.distance).toBeCloseTo(5, 10);
        expect(r0.path[0]).toEqual(start);
        expect(r0.path.length).toBe(1 + 3); // start + G1,G2,G3

        const r1 = opt.shortestFrom(start, 1); // enter G2..G3
        // Best: start->E (3) + E->G (2) = 5
        expect(r1.distance).toBeCloseTo(5, 10);
        expect(r1.path.length).toBe(1 + 2);

        expect(() => opt.shortestFrom(start, 3)).toThrow(RangeError); // after last group

        // Range check
        expect(() => opt.shortestFrom(start, -2)).toThrow(RangeError);
    });

    test('shortestFromStart alias (if present) matches shortestFrom(start, -1)', () => {
        const opt = makeBaseOptimiser();
        const start = {x: -1, y: 0};
        // @ts-expect-no-error runtime guard
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((opt as any).shortestFromStart) {
            // alias implies enter G0..G3
            const rAlias = (opt as any).shortestFromStart(start);
            const rDirect = opt.shortestFrom(start, -1);
            expect(rAlias.distance).toBeCloseTo(rDirect.distance, 10);
            expect(rAlias.path).toEqual(rDirect.path);
        }
    });

    test('addPointsToGroup (batch) updates size and affects shortestAll', () => {
        const opt = makeBaseOptimiser();
        // Add point Q to last group to create a shorter path
        const Q = {x: 5, y: 0};
        const newSize = opt.addPointsToGroup(3, [Q]);
        expect(newSize).toBe(3);
        const {distance, path} = opt.shortestAll();
        // Now: B->C->E->Q => 1 + 1 + 1 = 3
        expect(distance).toBeCloseTo(3, 10);
        expect(path[path.length - 1]).toEqual(Q);
    });

    test('replaceGroup modifies graph and recomputes distances', () => {
        const opt = makeBaseOptimiser();
        // Replace G1 with a far-away point only
        const P = {x: 0, y: 10};
        opt.replaceGroup(1, [P]);
        const {distance} = opt.shortestAll();
        expect(distance).toBeGreaterThan(4); // must be worse than baseline
    });

    test('clearGroup empties a group; queries throw until repopulated', () => {
        const opt = makeBaseOptimiser();
        opt.clearGroup(2);
        expect(() => opt.shortestAll()).toThrow();
        // repopulate and succeed
        const {E, F} = makeBasePoints();
        opt.replaceGroup(2, [E, F]);
        expect(() => opt.shortestAll()).not.toThrow();
    });

    test('removePointsFromGroup removes by comparator and affects distances', () => {
        const opt = makeBaseOptimiser();
        // First make a very short path by adding Q to last group
        const Q = {x: 5, y: 0};
        opt.addPointsToGroup(3, [Q]);
        expect(opt.shortestAll().distance).toBeCloseTo(3, 10);

        // Now remove Q
        const sizeAfter = opt.removePointsFromGroup(3, [Q], eq);
        expect(sizeAfter).toBe(2);
        expect(opt.shortestAll().distance).toBeCloseTo(4, 10);
    });

    test('filterGroup keeps only matching points', () => {
        const opt = makeBaseOptimiser();
        // Keep only points with x <= 4 in group 3 (removes H at (6,6))
        const newSize = opt.filterGroup(3, (p) => p.x <= 4);
        expect(newSize).toBe(0); // both G(6,0) and H(6,6) are removed
        // Now queries should fail until group 3 has something
        expect(() => opt.shortestAll()).toThrow();
    });

    test('resetAllGroups resets everything', () => {
        const opt = makeBaseOptimiser();
        // mutate
        const Q = {x: 5, y: 0};
        opt.addPointsToGroup(3, [Q]);
        // reset
        const {A, B, C, D, E, F, G, H} = makeBasePoints();
        opt.resetAllGroups([
            [A, B],
            [C, D],
            [E, F],
            [G, H]
        ]);
        const {distance, path} = opt.shortestAll();
        expect(distance).toBeCloseTo(4, 10);
        expect(path[path.length - 1]).toEqual({x: 6, y: 0});
    });

    test('clone deep-copies state; modifying clone does not affect original', () => {
        const opt = makeBaseOptimiser();
        const clone = opt.clone();
        // Modify the clone
        const Q = {x: 5, y: 0};
        clone.addPointsToGroup(3, [Q]);
        expect(clone.shortestAll().distance).toBeCloseTo(3, 10);

        // Original remains at baseline
        const {distance} = opt.shortestAll();
        expect(distance).toBeCloseTo(4, 10);
    });

    test('clone with different weight function recomputes with new weights', () => {
        const opt = makeBaseOptimiser();
        const w2 = (a: Pt, b: Pt) => 2 * w(a, b); // scaled distance
        const opt2 = opt.clone(w2);
        // Distances should scale by ~2
        expect(opt2.shortestAll().distance).toBeCloseTo(2 * opt.shortestAll().distance, 10);
    });

    test('printSummary logs stats and current any→any if prefix is ready', () => {
        const opt = makeBaseOptimiser();
        // Build prefix first
        const d = opt.shortestAll().distance;
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        opt.printSummary();
        const calls = spy.mock.calls.flat().join('\n');
        expect(calls).toEqual(expect.stringContaining('Groups: 4'));
        expect(calls).toEqual(expect.stringContaining('Adjacency G0→G1'));
        expect(calls).toEqual(expect.stringContaining('Total links'));
        expect(calls).toEqual(expect.stringContaining('Current shortest ANY→ANY distance'));
        expect(calls).toEqual(expect.stringContaining(d.toString()));
        spy.mockRestore();
    });

    test('shortestAnyToGroupThenToPoint with filter', () => {
        const opt = makeBaseOptimiser();
        const {E} = makeBasePoints();
        const target = {x: 7, y: 0};
        // Only allow E in group 2
        const {distance, path} = opt.shortestAnyToGroupThenToPoint(target, 2, (p) => eq(p, E));
        // Best path: B->C->E then to target: 1 + 1 + 3 = 5
        expect(distance).toBeCloseTo(5, 10);
        expect(path[path.length - 1]).toEqual(target);
        // Path begins in group 0, not an external start
        expect(path[0]).toEqual({x: 2, y: 0});
    });
});

// ---- helpers for counting weight calls ----
const makeCountingWeight = (scale = 1) => {
    let count = 0;
    const wf = (a: Pt, b: Pt) => {
        count++;
        return scale * Math.hypot(a.x - b.x, a.y - b.y);
    };
    return {
        wf,
        get: () => count,
        reset: () => {
            count = 0;
        }
    };
};

const baseGroups = () => {
    // 4 groups, 2 pts each → 3 adjacencies × (2×2)=4 = 12 edge weights when cold
    const A = {x: 0, y: 0},
        B = {x: 2, y: 0};
    const C = {x: 3, y: 0},
        D = {x: 0, y: 3};
    const E = {x: 4, y: 0},
        F = {x: 5, y: 5};
    const G = {x: 6, y: 0},
        H = {x: 6, y: 6};
    return [
        [A, B],
        [C, D],
        [E, F],
        [G, H]
    ] as Pt[][];
};

describe('Cache reuse: same instance, clone(without), clone(with new weight)', () => {
    test('same instance: reuses pairWeights and DP caches across calls', () => {
        const cw = makeCountingWeight();
        const opt = new DistanceOptimiser<Pt>(cw.wf, 4, baseGroups());

        // Cold: first any→any builds 12 edge weights
        expect(cw.get()).toBe(0);
        opt.shortestAll();
        expect(cw.get()).toBe(12);

        // Warm: second any→any should not call weight again
        opt.shortestAll();
        expect(cw.get()).toBe(12);

        // shortestFrom(start, 1) should only add |G2| (=2) start→G2 evals
        opt.shortestFrom({x: 1, y: 0}, 1);
        expect(cw.get()).toBe(14);

        // Another different start adds another 2
        opt.shortestFrom({x: -3, y: 1}, 1);
        expect(cw.get()).toBe(16);

        // Mutate: add a point to group 2 (index 2) increments caches in-place:
        // left (G1→G2): add 1 new column → |G1|=2 calls
        // right (G2→G3): add 1 new row → |G3|=2 calls
        opt.addPointsToGroup(2, [{x: 4, y: 0}]);
        expect(cw.get()).toBe(20);

        // Now any→any recomputes prefix but should NOT call weight again
        opt.shortestAll();
        expect(cw.get()).toBe(20);
    });

    test('clone() without new weight: deep-copied caches avoid recomputation', () => {
        const cw = makeCountingWeight();
        const opt = new DistanceOptimiser<Pt>(cw.wf, 4, baseGroups());

        // Build caches on the original
        opt.shortestAll();
        expect(cw.get()).toBe(12);

        const clone = opt.clone(); // same weight fn identity → caches copied
        const before = cw.get();

        // Warm on clone: should NOT call weight (uses copied caches)
        clone.shortestAll();
        expect(cw.get()).toBe(before);

        // If we only query any→any, still no extra calls
        clone.shortestAll();
        expect(cw.get()).toBe(before);
    });

    test('clone(newWeight): caches reset; rebuild occurs once then reused', () => {
        // Original builds its own caches (for isolation)
        const cw1 = makeCountingWeight();
        const opt = new DistanceOptimiser<Pt>(cw1.wf, 4, baseGroups());
        opt.shortestAll();
        expect(cw1.get()).toBe(12);

        // New counting weight for the clone
        const cw2 = makeCountingWeight(/* scale = */ 2); // scaled distance to differentiate if desired
        const opt2 = opt.clone(cw2.wf);

        // First call on clone should rebuild all adjacencies: 12 calls
        expect(cw2.get()).toBe(0);
        opt2.shortestAll();
        expect(cw2.get()).toBe(12);

        // Second call reuses caches: no additional calls
        opt2.shortestAll();
        expect(cw2.get()).toBe(12);

        // shortestFrom on clone with afterGroup=1 adds |G2|=2 start→G2 evals
        opt2.shortestFrom({x: 0, y: 0}, 1);
        expect(cw2.get()).toBe(14);
    });

    test('clone(newWeight) also changes numeric result consistently (scaled)', () => {
        // Prove that a different weight function impacts distances,
        // while still benefiting from caching on subsequent calls.
        const base = new DistanceOptimiser<Pt>((a, b) => Math.hypot(a.x - b.x, a.y - b.y), 4, baseGroups());
        const d1 = base.shortestAll().distance; // builds base caches

        const cwScaled = makeCountingWeight(3); // triple distances
        const scaled = base.clone(cwScaled.wf);
        const d2 = scaled.shortestAll().distance; // rebuild with new weight
        expect(d2).toBeCloseTo(3 * d1, 10);

        // Reuse on scaled clone: no extra weight calls for another any→any
        const callsAfter = cwScaled.get();
        scaled.shortestAll();
        expect(cwScaled.get()).toBe(callsAfter);
    });
});
