import useSWR from 'swr';

import {statusSummaryUrl} from './fixupUrls';

// Live OGN status from the scorehistory host's /status/summary endpoint
// (defined in bin/ogn.ts). Refreshes every 60s alongside the competitions
// list. CORS-open on the OGN side, so a plain fetch from the front page
// works.

export type ChannelSummary = {
    className: string;
    datecode: string;
    compid: string;
    gliders: {started: number; finished: number; home: number; airborne: number; total: number};
    viewers: {total: number; visible: number; interacting: number};
};

export type StatusSummary = {
    channels: Record<string, ChannelSummary>;
    totals: {pilots: number; flying: number; landed: number; viewers: number};
    // Aggregated per (compid, className), so a class with multi-day
    // history (multiple datecodes / channels) sums cleanly.
    byClass: Map<string, {tracked: number; flying: number; landed: number}>;
    // Aggregated per compid for the row-level rollup case.
    byComp: Map<string, {tracked: number; flying: number; landed: number}>;
};

export function classKey(compid: string, className: string): string {
    return `${compid}::${className}`;
}

const fetcher = (url: string): Promise<Record<string, ChannelSummary>> =>
    fetch(url).then((r) => (r.ok ? r.json() : {}));

export function useStatusSummary(): StatusSummary | null {
    const url = typeof window === 'undefined' ? null : statusSummaryUrl();
    const {data} = useSWR(url, fetcher, {refreshInterval: 60 * 1000, dedupingInterval: 30 * 1000});
    if (!data) return null;

    const totals = {pilots: 0, flying: 0, landed: 0, viewers: 0};
    const byClass = new Map<string, {tracked: number; flying: number; landed: number}>();
    const byComp = new Map<string, {tracked: number; flying: number; landed: number}>();

    const bump = (m: Map<string, {tracked: number; flying: number; landed: number}>, k: string, t: number, f: number, l: number) => {
        const prev = m.get(k);
        if (prev) {
            prev.tracked += t;
            prev.flying += f;
            prev.landed += l;
        } else {
            m.set(k, {tracked: t, flying: f, landed: l});
        }
    };

    for (const k in data) {
        const ch = data[k];
        const tracked = ch.gliders.total;
        const flying = ch.gliders.airborne;
        const landed = ch.gliders.finished + ch.gliders.home;
        totals.pilots += tracked;
        totals.flying += flying;
        totals.landed += landed;
        totals.viewers += ch.viewers.total;
        bump(byClass, classKey(ch.compid, ch.className), tracked, flying, landed);
        bump(byComp, ch.compid, tracked, flying, landed);
    }

    return {channels: data, totals, byClass, byComp};
}
