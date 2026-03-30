export type ShortestResult<T> = {distance: number; path: T[]};

export class DistanceOptimiser<T> {
    private readonly L: number;
    private weight: (a: T, b: T) => number;
    private groups: T[][];

    // |Gi| x |Gi+1| edge weight caches
    private pairWeights: (number[][] | null)[];

    // Suffix DP (for shortestFromStart)
    private suffixCost: (number[] | null)[];
    private suffixNext: (number[] | null)[];

    // Prefix DP (for shortestAnyToAny)
    private prefixCost: (number[] | null)[];
    private prefixPrev: (number[] | null)[];

    constructor(weightFn: (a: T, b: T) => number, numGroups: number, initialGroups: T[][] = []) {
        if (numGroups <= 0) throw new Error('numGroups must be > 0');
        this.L = numGroups;
        this.weight = weightFn;
        if (initialGroups.length && initialGroups.length !== this.L) {
            throw new Error('initialGroups length must equal numGroups');
        }
        this.groups = Array.from({length: this.L}, (_, i) => (initialGroups[i] ?? []).slice());

        this.pairWeights = Array(Math.max(0, this.L - 1)).fill(null);
        this.suffixCost = Array(this.L).fill(null);
        this.suffixNext = Array(this.L).fill(null);
        this.prefixCost = Array(this.L).fill(null);
        this.prefixPrev = Array(this.L).fill(null);
    }

    // ----- group management (fixed L) -----

    getGroups(): readonly (readonly T[])[] {
        return this.groups;
    }

    resetAllGroups(groups: T[][]): void {
        if (groups.length !== this.L) throw new Error('groups length mismatch');
        this.groups = groups.map((g) => g.slice());
        this.invalidateAll();
    }

    replaceGroup(index: number, points: Iterable<T>): void {
        this.assertIndex(index);
        this.groups[index] = Array.from(points);
        if (index > 0) this.pairWeights[index - 1] = null;
        if (index < this.L - 1) this.pairWeights[index] = null;
        this.invalidatePrefixFrom(index);
        this.invalidateSuffixThrough(index);
    }

    clearGroup(index: number): void {
        this.replaceGroup(index, []);
    }

    /** Add many points to an existing group. Returns the new group size. */
    addPointsToGroup(groupIndex: number, points: Iterable<T>): number {
        this.assertIndex(groupIndex);
        const toAdd = Array.from(points);
        if (toAdd.length === 0) return this.groups[groupIndex].length;

        const g = this.groups[groupIndex];
        // Extend edge caches incrementally if present
        // (groupIndex-1) -> groupIndex : add new COLUMNS
        if (groupIndex > 0) {
            const M = this.pairWeights[groupIndex - 1];
            if (M) {
                const left = this.groups[groupIndex - 1];
                // For each new point, append a column value to each row
                for (const p of toAdd) {
                    for (let i = 0; i < left.length; i++) {
                        if (!M[i]) M[i] = [];
                        M[i].push(this.weight(left[i], p));
                    }
                }
            }
        }
        // groupIndex -> (groupIndex+1) : add new ROWS
        if (groupIndex < this.L - 1) {
            const M = this.pairWeights[groupIndex];
            if (M) {
                const right = this.groups[groupIndex + 1];
                for (const p of toAdd) {
                    const row = new Array(right.length);
                    for (let j = 0; j < right.length; j++) row[j] = this.weight(p, right[j]);
                    M.push(row);
                }
            }
        }

        g.push(...toAdd);
        this.invalidatePrefixFrom(groupIndex);
        this.invalidateSuffixThrough(groupIndex);
        return g.length;
    }

    /** Filter a group by predicate: keep points where predicate(p) === true.
     * Returns the new size of the group.
     */
    filterGroup(groupIndex: number, predicate: (p: T) => boolean): number {
        this.assertIndex(groupIndex);
        const old = this.groups[groupIndex];
        const n = old.length;
        if (n === 0) return 0;

        const keep: boolean[] = new Array(n);
        const next: T[] = [];
        let removed = 0;
        for (let i = 0; i < n; i++) {
            const k = !!predicate(old[i]);
            keep[i] = k;
            if (k) next.push(old[i]);
            else removed++;
        }
        if (removed === 0) return n;

        // Update group contents
        this.groups[groupIndex] = next;

        // Update cached edge matrices if present
        // Left adjacency (groupIndex-1) -> groupIndex : remove COLUMNS for keep==false
        if (groupIndex > 0) {
            const ML = this.pairWeights[groupIndex - 1];
            if (ML) {
                for (let r = 0; r < ML.length; r++) {
                    const row = ML[r];
                    let w = 0;
                    for (let c = 0; c < n; c++) {
                        if (keep[c]) row[w++] = row[c];
                    }
                    row.length = w; // truncate to new column count
                }
            }
        }
        // Right adjacency groupIndex -> (groupIndex+1): remove ROWS for keep==false
        if (groupIndex < this.L - 1) {
            const MR = this.pairWeights[groupIndex];
            if (MR) {
                let w = 0;
                for (let r = 0; r < n; r++) {
                    if (keep[r]) MR[w++] = MR[r];
                }
                MR.length = w; // truncate to new row count
            }
        }

        // Invalidate DP caches touching this group; rebuild lazily when needed
        this.prefixCost[groupIndex] = null;
        this.prefixPrev[groupIndex] = null;
        this.suffixCost[groupIndex] = null;
        this.suffixNext[groupIndex] = null;
        this.invalidatePrefixFrom(groupIndex);
        this.invalidateSuffixThrough(groupIndex);

        return next.length;
    }

    /** Remove a set of points from a group using a comparator.
     * Returns the new size of the group.
     */
    removePointsFromGroup(groupIndex: number, points: Iterable<T>, equals: (a: T, b: T) => boolean): number {
        this.assertIndex(groupIndex);
        const removeList = Array.from(points);
        if (removeList.length === 0) return this.groups[groupIndex].length;

        const g = this.groups[groupIndex];
        if (g.length === 0) return 0;

        // Build keep mask: keep[i] = true if NOT removed
        const keep: boolean[] = new Array(g.length);
        let removed = 0;
        for (let i = 0; i < g.length; i++) {
            let rm = false;
            for (const p of removeList) {
                if (equals(g[i], p)) {
                    rm = true;
                    break;
                }
            }
            keep[i] = !rm;
            if (rm) removed++;
        }
        if (removed === 0) return g.length;

        // Update group contents
        this.groups[groupIndex] = g.filter((_, i) => keep[i]);

        // Update cached edge matrices if present
        // (groupIndex-1) -> groupIndex : remove COLUMNS
        if (groupIndex > 0) {
            const ML = this.pairWeights[groupIndex - 1];
            if (ML) {
                for (let r = 0; r < ML.length; r++) {
                    const row = ML[r];
                    let w = 0;
                    for (let c = 0; c < row.length; c++) {
                        if (keep[c]) row[w++] = row[c];
                    }
                    row.length = w;
                }
            }
        }
        // groupIndex -> (groupIndex+1) : remove ROWS
        if (groupIndex < this.L - 1) {
            const MR = this.pairWeights[groupIndex];
            if (MR) {
                let w = 0;
                for (let r = 0; r < MR.length; r++) {
                    if (keep[r]) MR[w++] = MR[r];
                }
                MR.length = w;
            }
        }

        // Invalidate DP caches touching this group
        this.prefixCost[groupIndex] = null;
        this.prefixPrev[groupIndex] = null;
        this.suffixCost[groupIndex] = null;
        this.suffixNext[groupIndex] = null;
        this.invalidatePrefixFrom(groupIndex);
        this.invalidateSuffixThrough(groupIndex);

        return this.groups[groupIndex].length;
    }

    // ----- queries -----

    /** Any in first → any in last. Uses prefix cache. */
    shortestAll(): ShortestResult<T> {
        if (this.L === 0) return {distance: 0, path: []};
        this.ensureAllGroupsNonEmpty();
        this.ensurePrefix();

        const last = this.L - 1;
        const costs = this.prefixCost[last]!;
        let bestJ = 0,
            best = costs[0];
        for (let j = 1; j < costs.length; j++)
            if (costs[j] < best) {
                best = costs[j];
                bestJ = j;
            }

        // Reconstruct without exposing indices externally
        const idx: number[] = new Array(this.L);
        idx[last] = bestJ;
        for (let g = last; g >= 1; g--) idx[g - 1] = this.prefixPrev[g]![idx[g]];
        const path = idx.map((i, g) => this.groups[g][i]);
        return {distance: best, path};
    }

    /** From external start → groups… → last. Uses suffix cache. */
    shortestFrom(start: T, afterGroup: number = 0): ShortestResult<T> {
        const next = afterGroup + 1;

        if (this.L === 0) return {distance: 0, path: [start]};
        this.assertIndex(next);
        this.ensureAllGroupsNonEmpty();
        this.ensureSuffixFrom(afterGroup);

        const g = next;
        const candidates = this.groups[g];
        const suf = this.suffixCost[g]!;

        let bestJ = 0,
            best = this.weight(start, candidates[0]) + suf[0];
        for (let j = 1; j < candidates.length; j++) {
            const v = this.weight(start, candidates[j]) + suf[j];
            if (v < best) {
                best = v;
                bestJ = j;
            }
        }
        const path: T[] = [start];
        let curGroup = g;
        let curIdx = bestJ;
        path.push(this.groups[curGroup][curIdx]);
        while (curGroup < this.L - 1) {
            curIdx = this.suffixNext[curGroup]![curIdx];
            curGroup++;
            path.push(this.groups[curGroup][curIdx]);
        }
        return {distance: best, path};
    }

    /** From external start → groups… → last. Uses suffix cache. */
    shortestFromGroup(afterGroup: number): ShortestResult<T> {
        const next = afterGroup + 1;

        if (this.L === 0) return {distance: 0, path: []};
        this.assertIndex(next);
        this.ensureAllGroupsNonEmpty();
        this.ensureSuffixFrom(afterGroup);

        const g = next;
        const candidates = this.groups[g];
        const suf = this.suffixCost[g]!;

        let bestJ = 0,
            best = suf[afterGroup];
        for (let j = 1; j < candidates.length; j++) {
            if (suf[j] < best) {
                best = suf[j];
                bestJ = j;
            }
        }
        const path: T[] = [];
        let curGroup = g;
        let curIdx = bestJ;
        path.push(this.groups[curGroup][curIdx]);
        while (curGroup < this.L - 1) {
            curIdx = this.suffixNext[curGroup]![curIdx];
            curGroup++;
            path.push(this.groups[curGroup][curIdx]);
        }
        return {distance: best, path};
    }

    /** Any in G0 → ... → Gg (filtered) → target (external).
     * Returns { distance, path } where path is [G0..GgChosen, target].
     */
    shortestAnyToGroupThenToPoint(target: T, groupIndex: number, allow: (p: T) => boolean = () => true): ShortestResult<T> {
        this.assertIndex(groupIndex);
        this.ensureAllGroupsNonEmpty();

        // Build prefix DP only up to groupIndex
        this.ensurePrefixTo(groupIndex);

        const costs = this.prefixCost[groupIndex]!;
        const Gg = this.groups[groupIndex];

        let bestJ = -1;
        let best = Number.POSITIVE_INFINITY;
        for (let j = 0; j < Gg.length; j++) {
            if (!allow(Gg[j])) continue;
            const v = costs[j] + this.weight(Gg[j], target);
            if (v < best) {
                best = v;
                bestJ = j;
            }
        }
        if (bestJ < 0) throw new Error(`No candidate in groupIndex ${groupIndex} passed the filter. target: ${JSON.stringify(target)}`);

        // Reconstruct path G0..Gg without exposing indices
        const path: T[] = [];
        let curIdx = bestJ;
        for (let g = groupIndex; g >= 1; g--) {
            path.push(this.groups[g][curIdx]);
            curIdx = this.prefixPrev[g]![curIdx];
        }
        path.push(this.groups[0][curIdx]);
        path.reverse();
        path.push(target);

        return {distance: best, path};
    }

    /** Any in G0 → ... → Gg (filtered) → target (external).
     * Returns { distance, path } where path is [G0..GgChosen, target].
     */
    shortestAnyToGroup(groupIndex: number, allow: (p: T) => boolean = () => true): ShortestResult<T> {
        this.assertIndex(groupIndex);
        this.ensureAllGroupsNonEmpty();

        // Build prefix DP only up to groupIndex
        this.ensurePrefixTo(groupIndex);

        const costs = this.prefixCost[groupIndex]!;
        const Gg = this.groups[groupIndex];

        let bestJ = -1;
        let best = Number.POSITIVE_INFINITY;
        for (let j = 0; j < Gg.length; j++) {
            if (!allow(Gg[j])) continue;
            const v = costs[j];
            if (v < best) {
                best = v;
                bestJ = j;
            }
        }
        if (bestJ < 0) throw new Error(`No candidate in groupIndex ${groupIndex} passed the filter.`);

        // Reconstruct path G0..Gg without exposing indices
        const path: T[] = [];
        let curIdx = bestJ;
        for (let g = groupIndex; g >= 1; g--) {
            path.push(this.groups[g][curIdx]);
            curIdx = this.prefixPrev[g]![curIdx];
        }
        path.push(this.groups[0][curIdx]);
        path.reverse();

        return {distance: best, path};
    }

    // ----- cloning -----

    /** Make a copy of the current state. If weightFn is provided and differs, caches are reset. */
    clone(weightFn?: (a: T, b: T) => number): DistanceOptimiser<T> {
        const newWeight = weightFn ?? this.weight;
        const copy = new DistanceOptimiser<T>(newWeight, this.L);
        // groups
        copy.groups = this.groups.map((g) => g.slice());
        // caches
        if (newWeight === this.weight) {
            copy.pairWeights = this.pairWeights.map((M) => (M ? M.map((r) => r.slice()) : null));
            copy.prefixCost = this.prefixCost.map((a) => (a ? a.slice() : null));
            copy.prefixPrev = this.prefixPrev.map((a) => (a ? a.slice() : null));
            copy.suffixCost = this.suffixCost.map((a) => (a ? a.slice() : null));
            copy.suffixNext = this.suffixNext.map((a) => (a ? a.slice() : null));
        } else {
            copy.pairWeights = Array(Math.max(0, this.L - 1)).fill(null);
            copy.prefixCost = Array(this.L).fill(null);
            copy.prefixPrev = Array(this.L).fill(null);
            copy.suffixCost = Array(this.L).fill(null);
            copy.suffixNext = Array(this.L).fill(null);
        }
        return copy;
    }

    // ----- summary / visualization -----

    /** Print a concise summary to console: sizes, edges, min/max/avg edge weights. */
    printSummary(log: Function = console.log): void {
        // Ensure edge matrices so stats are meaningful
        for (let i = 0; i < this.L - 1; i++) this.ensurePairWeights(i);

        const sizes = this.groups.map((g) => g.length);
        const totalEdges = sizes.slice(0, -1).reduce((acc, n, i) => acc + n * sizes[i + 1], 0);
        console.log(`Groups: ${this.L}`);
        console.log(`Sizes: [${sizes.join(', ')}]`);
        console.log(`Total links (edges across adjacencies): ${totalEdges}`);

        let globalMin = Number.POSITIVE_INFINITY;
        let globalMax = Number.NEGATIVE_INFINITY;
        let globalSum = 0,
            globalCount = 0;

        for (let i = 0; i < this.L - 1; i++) {
            const M = this.pairWeights[i]!;
            let min = Number.POSITIVE_INFINITY,
                max = Number.NEGATIVE_INFINITY,
                sum = 0,
                cnt = 0;
            for (const row of M)
                for (const v of row) {
                    if (v < min) min = v;
                    if (v > max) max = v;
                    sum += v;
                    cnt++;
                }
            const avg = cnt ? sum / cnt : NaN;
            log(`Adjacency G${i}→G${i + 1}: edges=${cnt}, min=${min}, max=${max}, avg=${avg}`);
            globalMin = Math.min(globalMin, min);
            globalMax = Math.max(globalMax, max);
            globalSum += sum;
            globalCount += cnt;
        }
        const globalAvg = globalCount ? globalSum / globalCount : NaN;
        log(`All adjacencies: edges=${globalCount}, min=${globalMin}, max=${globalMax}, avg=${globalAvg}`);

        // If prefix ready, show current any→any distance (no indices)
        const last = this.L - 1;
        if (this.prefixCost[last] && this.prefixCost[last]!.length === this.groups[last].length) {
            const costs = this.prefixCost[last]!;
            let best = costs[0];
            for (let j = 1; j < costs.length; j++) if (costs[j] < best) best = costs[j];
            log(`Current shortest ANY→ANY distance: ${best}`);
        }
    }

    // ----- internals -----

    private assertIndex(i: number): void {
        if (i < 0 || i >= this.L) throw new RangeError('group index');
    }
    private ensureAllGroupsNonEmpty(): void {
        if (!this.groups.every((g) => g.length > 0)) {
            throw new Error('All groups must be non-empty to compute a path.');
        }
    }
    private invalidateAll(): void {
        this.pairWeights = Array(Math.max(0, this.L - 1)).fill(null);
        this.prefixCost = Array(this.L).fill(null);
        this.prefixPrev = Array(this.L).fill(null);
        this.suffixCost = Array(this.L).fill(null);
        this.suffixNext = Array(this.L).fill(null);
    }
    private invalidateSuffixThrough(idxInclusive: number): void {
        for (let g = Math.min(idxInclusive, this.L - 1); g >= 0; g--) {
            this.suffixCost[g] = null;
            this.suffixNext[g] = null;
        }
        if (idxInclusive >= this.L - 1) {
            this.suffixCost[this.L - 1] = null;
            this.suffixNext[this.L - 1] = null;
        }
    }
    private invalidatePrefixFrom(idxInclusive: number): void {
        for (let g = Math.max(0, idxInclusive); g < this.L; g++) {
            this.prefixCost[g] = null;
            this.prefixPrev[g] = null;
        }
    }
    private ensurePairWeights(i: number): number[][] {
        let M = this.pairWeights[i];
        if (M) return M;
        const left = this.groups[i],
            right = this.groups[i + 1];
        M = new Array(left.length);
        for (let a = 0; a < left.length; a++) {
            const row = new Array(right.length);
            for (let b = 0; b < right.length; b++) row[b] = this.weight(left[a], right[b]);
            M[a] = row;
        }
        this.pairWeights[i] = M;
        return M;
    }
    private ensureSuffixFrom(from: number): void {
        // Base for last group
        if (!this.suffixCost[this.L - 1] || this.suffixCost[this.L - 1]!.length !== this.groups[this.L - 1].length) {
            this.suffixCost[this.L - 1] = new Array(this.groups[this.L - 1].length).fill(0);
            this.suffixNext[this.L - 1] = new Array(this.groups[this.L - 1].length).fill(-1);
        }
        for (let g = this.L - 2; g >= from; g--) {
            if (this.suffixCost[g] && this.suffixCost[g]!.length === this.groups[g].length && this.suffixNext[g] && this.suffixNext[g]!.length === this.groups[g].length) continue;
            const M = this.ensurePairWeights(g);
            const rightCost = this.suffixCost[g + 1]!;
            const n = this.groups[g].length,
                m = this.groups[g + 1].length;
            const cost = new Array(n),
                nxt = new Array(n);
            for (let i = 0; i < n; i++) {
                let best = Number.POSITIVE_INFINITY,
                    arg = -1;
                const row = M[i];
                for (let j = 0; j < m; j++) {
                    const v = row[j] + rightCost[j];
                    if (v < best) {
                        best = v;
                        arg = j;
                    }
                }
                cost[i] = best;
                nxt[i] = arg;
            }
            this.suffixCost[g] = cost;
            this.suffixNext[g] = nxt;
        }
    }

    /** Build/refresh prefix DP only through 'to' (0..L-1). */
    private ensurePrefix() {
        return this.ensurePrefixTo(Infinity);
    }

    private ensurePrefixTo(to: number = Infinity): void {
        if (!this.prefixCost[0] || this.prefixCost[0]!.length !== this.groups[0].length) {
            this.prefixCost[0] = new Array(this.groups[0].length).fill(0);
            this.prefixPrev[0] = new Array(this.groups[0].length).fill(-1);
        }
        const limit = Math.min(this.L - 1, to);
        for (let g = 0; g < limit; g++) {
            if (this.prefixCost[g + 1] && this.prefixCost[g + 1]!.length === this.groups[g + 1].length && this.prefixPrev[g + 1] && this.prefixPrev[g + 1]!.length === this.groups[g + 1].length) {
                continue;
            }
            const M = this.ensurePairWeights(g);
            const leftCost = this.prefixCost[g]!;
            const n = this.groups[g].length,
                m = this.groups[g + 1].length;
            const next = new Array(m).fill(Number.POSITIVE_INFINITY);
            const argmin = new Array(m).fill(-1);
            for (let i = 0; i < n; i++) {
                const base = leftCost[i],
                    row = M[i];
                for (let j = 0; j < m; j++) {
                    const v = base + row[j];
                    if (v < next[j]) {
                        next[j] = v;
                        argmin[j] = i;
                    }
                }
            }
            this.prefixCost[g + 1] = next;
            this.prefixPrev[g + 1] = argmin;
        }
    }
    /*
    private ensurePrefix(): void {
        if (!this.prefixCost[0] || this.prefixCost[0]!.length !== this.groups[0].length) {
            this.prefixCost[0] = new Array(this.groups[0].length).fill(0);
            this.prefixPrev[0] = new Array(this.groups[0].length).fill(-1);
        }
        for (let g = 0; g < this.L - 1; g++) {
            if (this.prefixCost[g + 1] && this.prefixCost[g + 1]!.length === this.groups[g + 1].length && this.prefixPrev[g + 1] && this.prefixPrev[g + 1]!.length === this.groups[g + 1].length) continue;
            const M = this.ensurePairWeights(g);
            const leftCost = this.prefixCost[g]!;
            const n = this.groups[g].length,
                m = this.groups[g + 1].length;
            const next = new Array(m).fill(Number.POSITIVE_INFINITY);
            const argmin = new Array(m).fill(-1);
            for (let i = 0; i < n; i++) {
                const base = leftCost[i],
                    row = M[i];
                for (let j = 0; j < m; j++) {
                    const v = base + row[j];
                    if (v < next[j]) {
                        next[j] = v;
                        argmin[j] = i;
                    }
                }
            }
            this.prefixCost[g + 1] = next;
            this.prefixPrev[g + 1] = argmin;
        }
        }*/
}
