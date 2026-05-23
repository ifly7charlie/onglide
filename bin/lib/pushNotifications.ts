//
// Web Push sender for competition class-status notifications.
//
// Lives in the daemon build (tsconfig-bin) — never imported by the front-end.
// The daemon already diffs per-class displayStatus in broadcastCompetitionsDelta;
// notifyCompetitionDelta() turns those diffs into pushes to every browser
// subscribed (pushsubscription table) to the competition.
//
// Notified transitions, per class:
//   task set / task changed   displayStatus enters/changes within task states
//   launching                 displayStatus -> launching
//   started                   displayStatus -> started  (gated, see below)
//   finishing                 displayStatus -> finishing
//
// The "started" push is gated: if a start-open time (taskRules.nostartutc) is
// known and still in the future it is deferred — held in deferredStarts and
// released by sweepDeferredStarts() once that time passes — so the user is told
// when the start line actually opens, not when the daemon flips status early.
//

import {readFileSync} from 'fs';
import {join} from 'path';

import escape from 'sql-template-strings';
import webpush from 'web-push';

import type {CompetitionSummary, CompetitionClassStatus, TaskDetails} from '../../lib/protobuf/onglide';

let enabled = false;

// Notification text is localised: each subscription stores the subscriber's UI
// language, and the body is rendered in that language. Templates are read from
// the same public/locales/<lang>/common.json files the front-end uses (the
// `notification` section); FALLBACK is the English last resort if a file or key
// is missing so the daemon never sends a blank notification.
const NOTIFICATION_LOCALES = ['cs', 'da', 'de', 'en', 'es', 'fi', 'fr', 'hu', 'it', 'nb', 'nl', 'pl', 'sk', 'sl', 'sv'];

const FALLBACK: Record<string, string> = {
    task_set: '{{classname}}: new task set',
    task_changed: '{{classname}}: task changed',
    launching: '{{classname}}: launching',
    racing: '{{classname}}: gliders racing',
    finishing: '{{classname}}: finishers due'
};

// lang -> { notification key -> template string with {{classname}} }
const notificationStrings = new Map<string, Record<string, string>>();

function loadNotificationStrings(): void {
    for (const lang of NOTIFICATION_LOCALES) {
        try {
            const raw = readFileSync(join(process.cwd(), 'public', 'locales', lang, 'common.json'), 'utf8');
            const json = JSON.parse(raw);
            if (json.notification) notificationStrings.set(lang, json.notification);
        } catch {
            // Missing/unreadable locale file — FALLBACK (or 'en') covers it.
        }
    }
    console.log(`pushNotifications: loaded notification text for ${notificationStrings.size}/${NOTIFICATION_LOCALES.length} locales`);
}

// Pending "started" notifications whose nostartutc is still in the future.
// Keyed `${compid}:${className}`.
interface DeferredStart {
    compid: string;
    compName: string;
    className: string;
    classname: string;
    nostartutc: number;
    officialDelay: number;
}
const deferredStarts = new Map<string, DeferredStart>();

// Read VAPID config and arm the sender. Absent keys disable the feature — the
// daemon must still run — logged once.
export function initPushNotifications(): void {
    const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT;
    if (!publicKey || !privateKey || !subject) {
        console.log('pushNotifications: VAPID keys not configured — push notifications disabled');
        return;
    }
    try {
        webpush.setVapidDetails(subject, publicKey, privateKey);
        enabled = true;
        loadNotificationStrings();
        console.log('pushNotifications: enabled');
    } catch (e) {
        console.log('pushNotifications: setVapidDetails failed — disabled', e);
    }
}

type EventKind = 'taskSet' | 'taskChanged' | 'launching' | 'started' | 'finishing';

interface NotifyEvent {
    kind: EventKind;
    className: string;
    classname: string;
}

const TASK_OR_LATER = new Set(['task_set', 'launching', 'started', 'finishing']);

// Stable identity of a task — used to detect "task changed". Prefers the
// diagnostic taskid/hash, falls back to the shape fields.
function taskFingerprint(td?: TaskDetails): string {
    if (!td) return '';
    if (td.taskid) return 'id:' + td.taskid;
    if (td.hash) return 'h:' + td.hash;
    return [td.type, td.distance, td.duration].join('|');
}

// EventKind -> notification-string key (the keys used in common.json).
const KIND_KEY: Record<EventKind, string> = {
    taskSet: 'task_set',
    taskChanged: 'task_changed',
    launching: 'launching',
    started: 'racing',
    finishing: 'finishing'
};

// Render the notification body in the subscriber's language. Falls back
// lang -> en -> hardcoded English so a missing locale never blanks the text.
function bodyText(ev: NotifyEvent, lang: string): string {
    const key = KIND_KEY[ev.kind];
    const template = notificationStrings.get(lang)?.[key] ?? notificationStrings.get('en')?.[key] ?? FALLBACK[key];
    return template.replace('{{classname}}', ev.classname);
}

// Diff one class between the previous and current summary into at most one
// event. Returns null when nothing notifiable changed. The caller handles the
// start-time gate for 'started'.
function diffClass(prevClass: CompetitionClassStatus | undefined, cls: CompetitionClassStatus): NotifyEvent | null {
    const prevDS = prevClass?.displayStatus ?? '';
    const newDS = cls.displayStatus;
    const base = {className: cls.class, classname: cls.classname || cls.class};

    if (newDS === 'finishing' && prevDS !== 'finishing') return {...base, kind: 'finishing'};
    if (newDS === 'started' && prevDS !== 'started') return {...base, kind: 'started'};
    if (newDS === 'launching' && prevDS !== 'launching') return {...base, kind: 'launching'};
    if (newDS === 'task_set' && !TASK_OR_LATER.has(prevDS)) return {...base, kind: 'taskSet'};
    // Task changed while already in a task state — the "if easy" extra.
    if (TASK_OR_LATER.has(prevDS) && TASK_OR_LATER.has(newDS) && taskFingerprint(prevClass?.taskDetails) !== taskFingerprint(cls.taskDetails) && taskFingerprint(cls.taskDetails) !== '') {
        return {...base, kind: 'taskChanged'};
    }
    return null;
}

// Detect notifiable transitions for one competition and send pushes. Called
// fire-and-forget from broadcastCompetitionsDelta. `prev === undefined` is the
// baseline observation — usually we record current state and emit nothing
// (a restart must not re-fire every comp's transitions), but a class already
// at 'started' whose nostartutc is still in the future is the one exception:
// the start-gate moment hasn't actually happened yet, so we defer it and let
// sweepDeferredStarts fire the 'racing' push when the clock crosses the gate.
export async function notifyCompetitionDelta(prev: CompetitionSummary | undefined, next: CompetitionSummary, getNow: () => number, db: any): Promise<void> {
    if (!enabled) return;

    const officialDelay = next.officialDelay ?? 0;
    const viewerNow = getNow() - officialDelay;

    if (!prev) {
        // Baseline-defer: classes already at 'started' but whose start-open
        // time is still in the future — the gate is yet to come, so it's a
        // legitimate fire moment, not a missed past one.
        for (const cls of next.classes) {
            if (cls.displayStatus !== 'started') continue;
            const nostartutc = cls.taskRules?.nostartutc ?? 0;
            if (nostartutc <= viewerNow) continue;
            const key = `${next.compid}:${cls.class}`;
            const classname = cls.classname || cls.class;
            deferredStarts.set(key, {compid: next.compid, compName: next.name, className: cls.class, classname, nostartutc, officialDelay});
            console.log(`pushNotifications: ${key} 'started' deferred at baseline — start opens ${nostartutc}, viewerNow ${viewerNow} (${nostartutc - viewerNow}s to go)`);
        }
        return;
    }

    const prevByClass = new Map(prev.classes.map((c) => [c.class, c]));

    const toSend: NotifyEvent[] = [];
    for (const cls of next.classes) {
        const key = `${next.compid}:${cls.class}`;
        // A class that has left the started-pending state drops its deferral.
        if (cls.displayStatus !== 'started') deferredStarts.delete(key);

        const ev = diffClass(prevByClass.get(cls.class), cls);
        if (!ev) continue;
        console.log(`pushNotifications: ${next.compid} ${cls.class} ${ev.kind} detected (${prevByClass.get(cls.class)?.displayStatus ?? '-'} -> ${cls.displayStatus})`);

        if (ev.kind === 'started') {
            const nostartutc = cls.taskRules?.nostartutc ?? 0;
            if (nostartutc > viewerNow) {
                // Start line not open yet — defer until sweepDeferredStarts.
                deferredStarts.set(key, {compid: next.compid, compName: next.name, className: cls.class, classname: ev.classname, nostartutc, officialDelay});
                console.log(`pushNotifications: ${key} 'started' deferred — start opens ${nostartutc}, viewerNow ${viewerNow} (${nostartutc - viewerNow}s to go)`);
                continue;
            }
        }
        toSend.push(ev);
    }

    if (toSend.length) await sendEvents(next.compid, next.name, toSend, db);
}

// Release any deferred "started" notifications whose start time has now passed.
// Called on the daemon's 15s keepalive interval — no bespoke timer.
export async function sweepDeferredStarts(getNow: () => number, db: any): Promise<void> {
    if (!enabled || deferredStarts.size === 0) return;
    const now = getNow();
    // Group released starts by comp so each comp's subscriptions load once.
    const byComp = new Map<string, {compName: string; events: NotifyEvent[]}>();
    for (const [key, d] of deferredStarts) {
        if (d.nostartutc > now - d.officialDelay) continue;
        deferredStarts.delete(key);
        console.log(`pushNotifications: releasing deferred 'started' ${key} (nostartutc ${d.nostartutc}, now ${now})`);
        const entry = byComp.get(d.compid) ?? {compName: d.compName, events: []};
        entry.events.push({kind: 'started', className: d.className, classname: d.classname});
        byComp.set(d.compid, entry);
    }
    for (const [compid, {compName, events}] of byComp) {
        await sendEvents(compid, compName, events, db).catch((e) => console.log('pushNotifications: deferred send failed', e));
    }
}

interface SubRow {
    id: number;
    endpoint: string;
    p256dh: string;
    auth: string;
    targetclass: string;
    lang: string;
}

// Load this comp's subscriptions once, then push every event to the matching
// rows. targetclass '' is a whole-competition subscription; a non-empty value
// (future per-class) only receives its own class. The body is rendered per
// subscription in that subscriber's stored language. The competition join
// enforces the per-competition opt-in (competition.pushnotifications) at send
// time, so clearing the flag stops notifications even for existing subscribers.
async function sendEvents(compid: string, compName: string, events: NotifyEvent[], db: any): Promise<void> {
    let subs: SubRow[];
    try {
        subs = await db.query(escape`
            SELECT s.id, s.endpoint, s.p256dh, s.auth, s.targetclass, s.lang
            FROM pushsubscription s JOIN competition c ON c.compid = s.compid
            WHERE s.compid = ${compid} AND c.pushnotifications = 'Y'
        `);
    } catch (e) {
        console.log('pushNotifications: subscription query failed', e);
        return;
    }
    if (!subs || !subs.length) {
        console.log(`pushNotifications: ${compid} ${events.map((e) => e.kind).join(',')} — no eligible subscriptions (check competition.pushnotifications = 'Y' and that a browser is subscribed)`);
        return;
    }

    // Flatten to one (subscription, payload) task per send. The body is
    // rendered here in each subscriber's language. Each task carries its
    // event's stats object so the worker can tally per-event failures.
    interface EventStats {
        ev: NotifyEvent;
        matched: number;
        failed: number;
    }
    const stats: EventStats[] = [];
    const tasks: {sub: SubRow; payload: string; stat: EventStats}[] = [];
    for (const ev of events) {
        const tag = `${compid}:${ev.className}`;
        const url = `/${compid}?className=${ev.className}`;
        const stat: EventStats = {ev, matched: 0, failed: 0};
        stats.push(stat);
        for (const sub of subs) {
            if (sub.targetclass && sub.targetclass !== ev.className) continue;
            tasks.push({sub, payload: JSON.stringify({title: compName, body: bodyText(ev, sub.lang || 'en'), tag, url}), stat});
            stat.matched++;
        }
    }

    // Send with bounded concurrency. webpush.sendNotification() encrypts the
    // payload synchronously before returning its HTTP promise; a pool of
    // workers spreads those encryptions across the I/O timeline (each worker
    // encrypts one, then awaits its request) instead of running all of them as
    // one uninterrupted burst — so the event loop stays responsive — while the
    // HTTP requests still overlap, keeping wall-clock time down.
    const CONCURRENCY = 16;
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < tasks.length) {
            const {sub, payload, stat} = tasks[next++];
            try {
                await webpush.sendNotification({endpoint: sub.endpoint, keys: {p256dh: sub.p256dh, auth: sub.auth}}, payload);
            } catch (err: any) {
                stat.failed++;
                // 404/410 — the browser dropped the subscription. Reap it.
                if (err?.statusCode === 404 || err?.statusCode === 410) {
                    await db.query(escape`DELETE FROM pushsubscription WHERE id = ${sub.id}`).catch(() => {});
                } else {
                    console.log(`pushNotifications: send failed (${err?.statusCode ?? '?'}) for sub ${sub.id}`);
                }
            }
        }
    };
    await Promise.all(Array.from({length: Math.min(CONCURRENCY, tasks.length)}, worker));

    // One summary line per event, now that delivery results are known.
    for (const s of stats) {
        console.log(`pushNotifications: ${compid} ${s.ev.kind} ${s.ev.className} -> ${s.matched} subscription(s), ${s.failed} failed`);
    }
}

// Drop every subscription for a competition — called when the comp's context is
// destroyed (rollover after its final local day).
export async function purgeSubscriptionsForComp(compid: string, db: any): Promise<void> {
    try {
        await db.query(escape`DELETE FROM pushsubscription WHERE compid = ${compid}`);
        for (const key of deferredStarts.keys()) {
            if (key.startsWith(compid + ':')) deferredStarts.delete(key);
        }
    } catch (e) {
        console.log('pushNotifications: purge failed', e);
    }
}

// Safety net for comps removed without a clean context teardown.
export async function sweepExpiredSubscriptions(db: any): Promise<void> {
    try {
        await db.query(escape`DELETE FROM pushsubscription WHERE expiresat < NOW()`);
    } catch (e) {
        console.log('pushNotifications: expiry sweep failed', e);
    }
}
