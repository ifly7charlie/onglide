//
// Diagnostic: analyse message rate per flarm id across the APRS point log.
//

import {scanAll} from '../lib/webworkers/pointlog';

async function run() {
    const trackers: Record<string, {c: string; earliest: number; latest: number; count: number}> = {};

    for await (const msg of scanAll()) {
        const key = (msg.f ?? '??????') as string;
        const t = trackers[key] ??= {c: key, earliest: msg.t, latest: msg.t, count: 0};
        t.count++;
        if (msg.t < t.earliest) t.earliest = msg.t;
        if (msg.t > t.latest) t.latest = msg.t;
    }

    console.table(
        Object.values(trackers).map((t) => ({
            ...t,
            earliest: new Date(t.earliest * 1000).toISOString(),
            latest: new Date(t.latest * 1000).toISOString(),
            pps: t.latest - t.earliest ? (t.count / (t.latest - t.earliest)).toFixed(1) + 'msg/sec' : '-'
        }))
    );
}

run();
