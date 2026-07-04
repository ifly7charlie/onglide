//
// Diagnostic websocket client for the OGN daemon.
//
// Connects to a channel and prints one line per inbound frame summarising
// what kind of OnglideWebSocketMessage it was. Useful for verifying that
// status changes / score updates / the /all CompetitionsList feed are
// landing on the wire.
//
//   node dist/bin/wsclient.js                       # default: ws://localhost:8080/all
//   node dist/bin/wsclient.js --channel BLUE070
//   node dist/bin/wsclient.js --group sgp            # ws://localhost:8080/all/sgp
//   node dist/bin/wsclient.js --url wss://www.onglide.com/all/sgp
//

import yargs from 'yargs';
import WebSocket from 'ws';

import {OnglideWebSocketMessage} from '../lib/protobuf/onglide';
import {unscaleFromWire} from '../lib/protobuf/wireScaling';

async function run() {
    const args = await yargs(process.argv.slice(2))
        .option('url', {type: 'string', description: 'full ws/wss URL (overrides host/port/channel)'})
        .option('host', {type: 'string', default: 'localhost', description: 'host:port (default localhost:WEBSOCKET_PORT or 8080)'})
        .option('channel', {type: 'string', default: 'all', description: 'channel name to subscribe to (default: /all landing-page feed)'})
        .option('group', {type: 'string', description: 'restrict the /all feed to a competition group -> /all/<group>'})
        .option('messages', {type: 'number', default: '0', description: 'how many messages to wait for'})
        .option('tls', {type: 'boolean', default: false, description: 'use wss instead of ws'})
        .option('details', {type: 'boolean', default: false, description: 'after each summary, pretty-print the decoded message as JSON'})
        .help()
        .alias('help', 'h').argv;

    const url = args.url ?? buildUrl(args.host, args.channel, args.group, args.tls);
    console.log(`connecting to ${url}`);

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    let frames = 0;
    const startedAt = Date.now();

    ws.on('open', () => {
        console.log(`open`);
    });

    ws.on('close', (code, reason) => {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`close code=${code} reason=${reason || '-'} after ${elapsed}s, ${frames} frames`);
        process.exit(0);
    });

    ws.on('error', (e) => {
        console.log(`error: ${(e as Error).message}`);
    });

    ws.on('message', (data, isBinary) => {
        frames++;
        const ts = new Date().toISOString().slice(11, 23);
        if (!isBinary) {
            console.log(`${ts} text "${data.toString().slice(0, 80)}"`);
            return;
        }
        try {
            const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as Buffer);
            const decoded = unscaleFromWire(OnglideWebSocketMessage.decode(buf));
            console.log(`${ts} ${buf.byteLength}b ${summarise(decoded)}`);
            if (args.details) {
                // toJSON gives us the protobuf-friendly representation (bytes
                // fields become base64 strings) which is far more readable
                // than dumping the raw decoded object.
                console.log(JSON.stringify(OnglideWebSocketMessage.toJSON(decoded), null, 2));
            }
            if (args.messages && frames == args.messages) {
                ws.close();
            }
        } catch (e) {
            console.log(`${ts} decode-error: ${(e as Error).message}`);
        }
    });

    process.on('SIGINT', () => {
        try {
            ws.close();
        } catch {
            /**/
        }
    });
}

function buildUrl(host: string, channel: string, group: string | undefined, tls: boolean): string {
    const proto = tls ? 'wss' : 'ws';
    const hp = host.includes(':') ? host : `${host}:${process.env.WEBSOCKET_PORT || 8080}`;
    // Build the path from slash-trimmed segments so a stray leading/trailing
    // slash on --channel or --group can't produce `//` (which the daemon
    // strips to a different channel name than intended). --group is appended
    // verbatim, so `--channel all/sgp` and `--channel all --group sgp` are
    // equivalent.
    const trim = (s: string) => s.replace(/^\/+|\/+$/g, '');
    const path = [trim(channel), group ? trim(group) : ''].filter(Boolean).join('/');
    return `${proto}://${hp}/${path}`;
}

// Build a one-line summary of the populated fields on the message. Order
// roughly matches frequency of arrival in normal operation.
function summarise(m: OnglideWebSocketMessage): string {
    const parts: string[] = [];
    if (m.competitions) {
        const c = m.competitions;
        const tag = c.full ? `full=${c.competitions.length}` : `delta changed=${c.competitions.length} removed=${c.removed.length}`;
        const totalPilots = c.competitions.reduce((a, s) => a + s.classes.reduce((aa, cl) => aa + cl.pilotCount, 0), 0);
        const statusCounts = new Map<string, number>();
        for (const s of c.competitions) statusCounts.set(s.displayStatus, (statusCounts.get(s.displayStatus) ?? 0) + 1);
        const statusStr = [...statusCounts.entries()].map(([k, v]) => `${k}=${v}`).join(',');
        parts.push(`competitions ${tag} pilots=${totalPilots}${statusStr ? ` [${statusStr}]` : ''}`);
        if (!c.full && c.competitions.length) {
            parts.push(c.competitions.map((s) => `${s.compid}:${s.displayStatus}`).join(','));
        }
    }
    if (m.identifiers) {
        const i = m.identifiers;
        parts.push(`ident ${i.competition}/${i.className}@${i.datecode} score=${i.scoreId ?? '-'}`);
    }
    if (m.task) {
        const t = m.task;
        const sizes: string[] = [];
        if (t.geoJSON) sizes.push(`geoJSON=${t.geoJSON.length}b`);
        if (t.legs?.length) sizes.push(`legs=${t.legs.length}`);
        if (t.rules) sizes.push('rules');
        if (t.details) sizes.push(`details(${t.details.type ?? '?'})`);
        parts.push(`task${t.startOpen ? ' startOpen' : ''}${sizes.length ? ' ' + sizes.join(' ') : ''}`);
    }
    if (m.scores) {
        const pilots = Object.keys(m.scores.pilots ?? {});
        parts.push(`scores n=${pilots.length} id=${m.scores.scoreId}${pilots.length <= 4 ? ` (${pilots.join(',')})` : ''}`);
    }
    if (m.positions) {
        const classes = Object.entries(m.positions.class ?? {});
        const total = classes.reduce((a, [, p]) => a + (p.positions?.length ?? 0), 0);
        parts.push(`positions n=${total} classes=${classes.length}`);
    }
    if (m.stats) {
        const classes = Object.entries(m.stats.class ?? {});
        let pilots = 0;
        let segs = 0;
        const baseTimes = new Set<number>();
        for (const [, u] of classes) {
            baseTimes.add(u.baseTime);
            for (const p of Object.values(u.pilots ?? {})) {
                pilots++;
                segs += p.segments?.length ?? 0;
            }
        }
        parts.push(`stats classes=${classes.length} pilots=${pilots} segs=${segs} baseTime=${[...baseTimes].join(',')}`);
    }
    if (m.tracks) {
        const pilots = Object.keys(m.tracks.pilots ?? {});
        parts.push(`tracks n=${pilots.length} baseTime=${m.tracks.baseTime}`);
    }
    if (m.ka) {
        parts.push(`ka listeners=${m.ka.listeners} airborne=${m.ka.airborne}`);
    }
    if (parts.length === 0) {
        parts.push(`empty${m.t ? ` t=${m.t}` : ''}`);
    } else if (m.t && !m.ka) {
        parts.push(`t=${m.t}`);
    }
    return parts.join(' | ');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
