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
    byComp: Map<string, {tracked: number; flying: number; landed: number; viewers: number}>;
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
    const byComp = new Map<string, {tracked: number; flying: number; landed: number; viewers: number}>();

    for (const k in data) {
        const ch = data[k];
        const tracked = ch.gliders.total;
        const flying = ch.gliders.airborne;
        const landed = ch.gliders.finished + ch.gliders.home;
        const viewers = ch.viewers.total;
        totals.pilots += tracked;
        totals.flying += flying;
        totals.landed += landed;
        totals.viewers += viewers;

        const ck = classKey(ch.compid, ch.className);
        const cls = byClass.get(ck);
        if (cls) {
            cls.tracked += tracked;
            cls.flying += flying;
            cls.landed += landed;
        } else {
            byClass.set(ck, {tracked, flying, landed});
        }

        const cmp = byComp.get(ch.compid);
        if (cmp) {
            cmp.tracked += tracked;
            cmp.flying += flying;
            cmp.landed += landed;
            cmp.viewers += viewers;
        } else {
            byComp.set(ch.compid, {tracked, flying, landed, viewers});
        }
    }

    return {channels: data, totals, byClass, byComp};
}
