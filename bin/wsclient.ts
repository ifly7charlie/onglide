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
//   node dist/bin/wsclient.js --url wss://www.onglide.com/all
//

import yargs from 'yargs';
import WebSocket from 'ws';

import {OnglideWebSocketMessage} from '../lib/protobuf/onglide';

async function run() {
    const args = await yargs(process.argv.slice(2))
        .option('url', {type: 'string', description: 'full ws/wss URL (overrides host/port/channel)'})
        .option('host', {type: 'string', default: 'localhost', description: 'host:port (default localhost:WEBSOCKET_PORT or 8080)'})
        .option('channel', {type: 'string', default: 'all', description: 'channel name to subscribe to (default: /all landing-page feed)'})
        .option('tls', {type: 'boolean', default: false, description: 'use wss instead of ws'})
        .option('details', {type: 'boolean', default: false, description: 'after each summary, pretty-print the decoded message as JSON'})
        .help()
        .alias('help', 'h').argv;

    const url = args.url ?? buildUrl(args.host, args.channel, args.tls);
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
            const decoded = OnglideWebSocketMessage.decode(buf);
            console.log(`${ts} ${buf.byteLength}b ${summarise(decoded)}`);
            if (args.details) {
                // toJSON gives us the protobuf-friendly representation (bytes
                // fields become base64 strings) which is far more readable
                // than dumping the raw decoded object.
                console.log(JSON.stringify(OnglideWebSocketMessage.toJSON(decoded), null, 2));
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

function buildUrl(host: string, channel: string, tls: boolean): string {
    const proto = tls ? 'wss' : 'ws';
    const hp = host.includes(':') ? host : `${host}:${process.env.WEBSOCKET_PORT || 8080}`;
    return `${proto}://${hp}/${channel}`;
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
        if (t.taskJSON) sizes.push(`taskJSON=${t.taskJSON.length}b`);
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
