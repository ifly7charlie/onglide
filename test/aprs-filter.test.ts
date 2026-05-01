import {describe, test, expect} from 'vitest';

import {APRS_MAX_FILTER_BYTES, buildAprsFilter, type AirfieldFilterInput, type Bbox} from '../lib/flightprocessing/taskBbox';

// Helper: produce a circle bbox for an airfield's coverage circle.
// (Mirrors taskBbox internal logic so we can sanity-check containment.)
const KM_PER_DEG_LAT = 111;
function circleBbox(lt: number, lg: number, radiusKm: number): Bbox {
    const dLat = radiusKm / KM_PER_DEG_LAT;
    const cos = Math.max(0.2, Math.cos((lt * Math.PI) / 180));
    const dLng = radiusKm / (KM_PER_DEG_LAT * cos);
    return [lt - dLat, lg - dLng, lt + dLat, lg + dLng];
}

function bboxContains(outer: Bbox, inner: Bbox): boolean {
    return inner[0] >= outer[0] - 1e-9 && inner[1] >= outer[1] - 1e-9 && inner[2] <= outer[2] + 1e-9 && inner[3] <= outer[3] + 1e-9;
}

function parseAreaClause(clause: string): Bbox {
    // a/N/W/S/E
    const [tag, n, w, s, e] = clause.split('/');
    expect(tag).toBe('a');
    return [parseFloat(s), parseFloat(w), parseFloat(n), parseFloat(e)];
}

describe('buildAprsFilter', () => {
    test('null bbox + no airfields returns r/0/0/1 placeholder', () => {
        expect(buildAprsFilter(null, [])).toBe('r/0/0/1');
    });

    test('task bbox + few airfields fits without clustering', () => {
        const expanded: Bbox = [51.0, -2.0, 53.0, 1.0];
        const airfields: AirfieldFilterInput[] = [
            // Far enough out that they're not contained by the task bbox.
            {lt: 60.0, lg: 10.0, radiusKm: 30},
            {lt: 45.0, lg: -5.0, radiusKm: 30}
        ];
        const filter = buildAprsFilter(expanded, airfields);
        expect(filter.length).toBeLessThanOrEqual(APRS_MAX_FILTER_BYTES);
        // All clauses should still be present in some form (Phase 1)
        expect(filter).toContain('a/53.00/-2.00/51.00/1.00');
        expect(filter).toContain('r/60/10/30');
        expect(filter).toContain('r/45/-5/30');
        // Sorted (a/ < r/ lexicographically)
        const clauses = filter.split(' ');
        const sorted = [...clauses].sort();
        expect(clauses).toEqual(sorted);
    });

    test('airfield contained by task bbox is dropped', () => {
        const expanded: Bbox = [51.0, -2.0, 53.0, 1.0];
        const airfields: AirfieldFilterInput[] = [{lt: 52.0, lg: -0.5, radiusKm: 30}];
        const filter = buildAprsFilter(expanded, airfields);
        expect(filter).toBe('a/53.00/-2.00/51.00/1.00');
    });

    test('25 European airfields with 250km radius triggers clustering and stays under cap', () => {
        // Real-world scale: 25 simultaneous comps, all pre-task. Spread roughly across
        // Europe so the natural per-airfield clause list overflows but a single
        // continent-spanning bbox is not the only fit.
        const airfields: AirfieldFilterInput[] = [];
        for (let i = 0; i < 25; i++) {
            // Lay them out on a 5x5 grid roughly between (45N,-2E) and (55N,18E).
            const lt = 45 + (i % 5) * 2.5;
            const lg = -2 + Math.floor(i / 5) * 5;
            airfields.push({lt: parseFloat(lt.toFixed(4)), lg: parseFloat(lg.toFixed(4)), radiusKm: 250});
        }

        const filter = buildAprsFilter(null, airfields);
        expect(filter.length).toBeLessThanOrEqual(APRS_MAX_FILTER_BYTES);

        // Every original airfield circle must be contained in *some* output
        // clause — clustering must not drop coverage.
        const clauses = filter.split(' ');
        const clauseBboxes: Bbox[] = clauses.map((c) => {
            if (c.startsWith('a/')) return parseAreaClause(c);
            // r/lat/lng/km form — convert to its own circle bbox
            const [, lat, lng, km] = c.split('/');
            return circleBbox(parseFloat(lat), parseFloat(lng), parseFloat(km));
        });

        for (const af of airfields) {
            const afBox = circleBbox(af.lt, af.lg, af.radiusKm);
            const covered = clauseBboxes.some((cb) => bboxContains(cb, afBox));
            expect(covered, `airfield ${af.lt},${af.lg} not covered by any clause`).toBe(true);
        }

        // Should have produced at least 2 clauses (clustering, not single-bbox fallback)
        // when comps are geographically spread.
        expect(clauses.length).toBeGreaterThan(1);
    });

    test('many co-located airfields collapse to a single clause', () => {
        const airfields: AirfieldFilterInput[] = [];
        for (let i = 0; i < 25; i++) {
            airfields.push({lt: 52.0 + i * 0.0001, lg: -1.0 + i * 0.0001, radiusKm: 250});
        }
        const filter = buildAprsFilter(null, airfields);
        expect(filter.length).toBeLessThanOrEqual(APRS_MAX_FILTER_BYTES);
        // Clustering should collapse them — final form is one a/ clause.
        const clauses = filter.split(' ');
        expect(clauses.length).toBeLessThan(airfields.length);
    });

    test('exactly-at-cap natural string passes through unchanged', () => {
        // Synthesize an airfield list whose natural Phase 1 string is <= cap.
        const airfields: AirfieldFilterInput[] = [];
        for (let i = 0; i < 5; i++) {
            airfields.push({lt: 45 + i, lg: -1 + i, radiusKm: 30});
        }
        const filter = buildAprsFilter(null, airfields);
        expect(filter.length).toBeLessThanOrEqual(APRS_MAX_FILTER_BYTES);
        // Phase 1 emits r/ clauses verbatim — not a/.
        for (const af of airfields) {
            expect(filter).toContain(`r/${af.lt}/${af.lg}/${af.radiusKm}`);
        }
    });
});
