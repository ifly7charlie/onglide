import {promises as fsp, mkdirSync} from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

import type {PositionMessage, FlarmID} from '../types';

// LoggedMessage is what callers serialize / deserialize. The on-disk row is
// columnar (no JSON blob), so reconstruction sets `c` from `f` and `l` to
// null — both are caller-context fields that the writer never had reason to
// persist (c is always equal to f at appendPoint time; l is always null).
export type LoggedMessage = PositionMessage & {f: FlarmID; o: string; ad?: number; d?: number};

// ---------- module state ----------
// Two connections: better-sqlite3 marks a connection "busy" for the lifetime
// of an open iterator, and our reader generators (loadPoints*) yield to the
// event loop mid-iteration. If the writer/purge shared the connection, those
// yields would let appendPoint or the purge DELETE land while an iterator is
// open and throw "database connection is busy". WAL lets independent
// connections read+write concurrently, so we keep them split.
let writerDb: Database.Database | undefined;
let readerDb: Database.Database | undefined;
let insertStmt: Database.Statement | undefined;
let purgeTimer: NodeJS.Timeout | undefined;
let retainMs = 24 * 3600 * 1000;

const dbPath = (): string => path.join((process.env.DB_PATH ?? './db/').replace(/\/$/, '') + '/', 'aprs.sqlite');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS points (
    t   INTEGER NOT NULL,
    f   TEXT    NOT NULL,
    o   TEXT    NOT NULL,
    lat REAL    NOT NULL,
    lng REAL    NOT NULL,
    a   INTEGER NOT NULL,
    g   INTEGER NOT NULL,
    b   REAL,
    s   REAL,
    d   INTEGER,
    ad  REAL,
    PRIMARY KEY (t, f, o)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_points_f_t ON points (f, t);
`;

function reloadConfig(): void {
    const hours = Number(process.env.APRS_LOG_RETAIN_HOURS);
    retainMs = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3600 * 1000;
}

// Apply pragmas + schema. Used by both openLog (writer) and ensureReaderDb
// (reader-only lazy open) so the table exists for fresh installs that
// haven't run ogn yet, and SQLite knows the file is WAL-mode.
function configureDb(d: Database.Database): void {
    d.pragma('journal_mode = WAL');
    d.pragma('synchronous = NORMAL');
    d.pragma('temp_store = MEMORY');
    d.exec(SCHEMA);
}

// Lazy reader open. CLI tools (dumptracks/findtrackers/exporttrack) don't
// call openLog — they just iterate. ensureReaderDb opens a dedicated reader
// connection on demand. In the live ogn process this is a second handle
// alongside the writer; in CLI tools it's the only handle.
// Returns undefined if the DB file can't be opened (path inaccessible);
// callers should treat that as "no points" and yield nothing.
function ensureReaderDb(): Database.Database | undefined {
    if (readerDb) return readerDb;
    try {
        mkdirSync(path.dirname(dbPath()), {recursive: true});
        readerDb = new Database(dbPath());
        configureDb(readerDb);
        return readerDb;
    } catch (e) {
        console.log(`pointlog: cannot open reader ${dbPath()}: ${e}`);
        return undefined;
    }
}

// ---------- public API ----------

export async function openLog(): Promise<void> {
    reloadConfig();
    try {
        await fsp.mkdir(path.dirname(dbPath()), {recursive: true});
        writerDb = new Database(dbPath());
        // WAL: concurrent readers + 1 writer across processes (CLIs can read
        // while ogn is up). synchronous=NORMAL is the standard durability/
        // speed tradeoff for WAL — the OS may lose the last few packets in a
        // power cut, which is fine for APRS traffic.
        configureDb(writerDb);
        insertStmt = writerDb.prepare(
            `INSERT OR REPLACE INTO points (t, f, o, lat, lng, a, g, b, s, d, ad)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
    } catch (e) {
        console.log(`pointlog: openLog failed (${dbPath()}): ${e}`);
        // Leave writerDb/insertStmt undefined so appendPoint becomes a no-op.
        // Readers will lazy-open their own connection via ensureReaderDb. The
        // APRS worker still functions; we just don't persist or backfill.
        try {
            writerDb?.close();
        } catch {}
        writerDb = undefined;
        insertStmt = undefined;
        return;
    }

    const tick = () => {
        try {
            purge();
        } catch (e) {
            console.log(`pointlog purge: ${e}`);
        }
        // Keep ticking even if a purge throws — transient locks during
        // a checkpoint mustn't disable retention.
        purgeTimer = setTimeout(tick, PURGE_TICK_MS);
    };
    purgeTimer = setTimeout(tick, PURGE_TICK_MS);

    console.log(`pointlog: opened ${dbPath()} (WAL, retain ${retainMs / 3600000}h)`);
}

export async function closeLog(): Promise<void> {
    if (purgeTimer) {
        clearTimeout(purgeTimer);
        purgeTimer = undefined;
    }
    if (writerDb) {
        try {
            writerDb.close();
        } catch (e) {
            console.log(`pointlog: writer close failed: ${e}`);
        }
        writerDb = undefined;
        insertStmt = undefined;
        bulkInsertStmt = undefined;
    }
    if (readerDb) {
        try {
            readerDb.close();
        } catch (e) {
            console.log(`pointlog: reader close failed: ${e}`);
        }
        readerDb = undefined;
    }
}

export function appendPoint(m: LoggedMessage): void {
    if (!insertStmt || typeof m.t !== 'number' || !m.f) return;
    try {
        insertStmt.run(
            m.t,
            m.f,
            m.o ?? '',
            m.lat,
            m.lng,
            m.a,
            m.g,
            m.b ?? null,
            m.s ?? null,
            (m as any).d ?? null,
            (m as any).ad ?? null
        );
    } catch (e) {
        // A constraint failure (PK collision after a clock-rewind) shouldn't
        // crash the worker — log and move on.
        console.log(`pointlog: insert failed (${m.t}/${m.f}/${m.o}): ${e}`);
    }
}

// Begin bulk-load mode. Caller is expected to be a one-shot migration /
// replay tool (not the live APRS worker). Three knobs at once:
//   - drop the secondary index so we don't pay random b-tree maintenance
//     on every insert; we'll rebuild it sequentially in endBulkLoad.
//     Index inserts dominate cost once the index outgrows the page cache.
//   - boost cache_size and mmap_size so the PK b-tree pages stay hot.
//   - clear the hourly purge timer so a checkpoint can't fire mid-migration.
// Pair with endBulkLoad() before closeLog().
export function beginBulkLoad(opts: {cacheBytes?: number; mmapBytes?: number} = {}): void {
    if (!writerDb) return;
    if (purgeTimer) {
        clearTimeout(purgeTimer);
        purgeTimer = undefined;
    }
    const cacheBytes = opts.cacheBytes ?? 200 * 1024 * 1024;
    const mmapBytes = opts.mmapBytes ?? 256 * 1024 * 1024;
    // negative cache_size = KB rather than pages
    writerDb.pragma(`cache_size = ${-Math.floor(cacheBytes / 1024)}`);
    writerDb.pragma(`mmap_size = ${mmapBytes}`);
    writerDb.exec('DROP INDEX IF EXISTS idx_points_f_t');
    console.log(`pointlog: bulk-load mode (cache ${(cacheBytes / 1024 / 1024).toFixed(0)}MB, mmap ${(mmapBytes / 1024 / 1024).toFixed(0)}MB, dropped idx_points_f_t)`);
}

// Recreate the secondary index (single sequential build, much cheaper than
// maintaining it during inserts), checkpoint the WAL.
export function endBulkLoad(): void {
    if (!writerDb) return;
    const start = Date.now();
    writerDb.exec('CREATE INDEX IF NOT EXISTS idx_points_f_t ON points (f, t)');
    console.log(`pointlog: rebuilt idx_points_f_t (${Date.now() - start}ms)`);
    try {
        writerDb.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) {
        console.log(`pointlog: post-bulk checkpoint failed: ${e}`);
    }
}

// Latest stored row's t (epoch seconds), or undefined if the DB is empty
// or unreachable. Used by incremental migrations to find the existing tail.
export function latestTimestamp(): number | undefined {
    const conn = ensureReaderDb();
    if (!conn) return undefined;
    try {
        const row = conn.prepare('SELECT MAX(t) AS t FROM points').get() as {t: number | null} | undefined;
        return row?.t ?? undefined;
    } catch (e) {
        console.log(`pointlog latestTimestamp: ${e}`);
        return undefined;
    }
}

// Best-effort WAL checkpoint. Use periodically inside a long migration
// loop so the WAL file doesn't balloon. PASSIVE: doesn't block readers.
export function checkpointWal(): void {
    if (!writerDb) return;
    try {
        writerDb.pragma('wal_checkpoint(PASSIVE)');
    } catch (e) {
        console.log(`pointlog: passive checkpoint failed: ${e}`);
    }
}

// Bulk insert variant for migrations / replays. Wraps the writes in a
// single SQLite transaction so the WAL fsync amortizes across the batch
// (~100× faster than per-row autocommit at 10K-row batches).
//
// Uses INSERT OR IGNORE (not OR REPLACE like the live writer's appendPoint)
// so we can distinguish a fresh insert from a duplicate (PK collision):
// info.changes is 1 for a new row, 0 for a duplicate. The data is the same
// either way (same t/f/o ⇒ same packet), so ignoring vs replacing makes no
// observable difference, but the count split lets the caller report
// "X new, Y already there" — useful for re-runs of a migration.
let bulkInsertStmt: Database.Statement | undefined;
export function bulkAppend(messages: LoggedMessage[]): {inserted: number; duplicates: number; skipped: number} {
    if (!writerDb) return {inserted: 0, duplicates: 0, skipped: messages.length};
    if (!bulkInsertStmt) {
        bulkInsertStmt = writerDb.prepare(
            `INSERT OR IGNORE INTO points (t, f, o, lat, lng, a, g, b, s, d, ad)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
    }
    let inserted = 0;
    let duplicates = 0;
    let skipped = 0;
    const stmt = bulkInsertStmt;
    const tx = writerDb.transaction((batch: LoggedMessage[]) => {
        for (const m of batch) {
            if (typeof m.t !== 'number' || !m.f) {
                skipped++;
                continue;
            }
            try {
                const info = stmt.run(
                    m.t,
                    m.f,
                    m.o ?? '',
                    m.lat,
                    m.lng,
                    m.a,
                    m.g,
                    m.b ?? null,
                    m.s ?? null,
                    (m as any).d ?? null,
                    (m as any).ad ?? null
                );
                if (info.changes > 0) inserted++;
                else duplicates++;
            } catch {
                skipped++;
            }
        }
    });
    try {
        tx(messages);
    } catch (e) {
        console.log(`pointlog: bulkAppend transaction failed: ${e}`);
        skipped += messages.length - inserted - duplicates;
        inserted = 0;
        duplicates = 0;
    }
    return {inserted, duplicates, skipped};
}

// Per-flarmId rotating purge. Each tick deletes one flarmId's expired rows
// (`WHERE f = ? AND t < ?` — leading-key range delete via idx_points_f_t)
// rather than one big bulk DELETE. A pass = one full sweep through every
// flarmId currently in the table; pass-level totals are logged when the
// queue refills, along with the size of the next pass.
const PURGE_TICK_MS = 10 * 1000;
let purgeQueue: string[] = [];
let purgePassChanges = 0;
let purgePassFlarms = 0;
let purgePassStartMs = 0;

function purge(): void {
    // purge runs writes; never touches the reader connection.
    const conn = writerDb;
    if (!conn) return;
    if (purgeQueue.length === 0) {
        let nextQueue: string[];
        try {
            const rows = conn.prepare('SELECT DISTINCT f FROM points').all() as {f: string}[];
            nextQueue = rows.map((r) => r.f);
        } catch (e) {
            console.log(`pointlog: purge enumeration failed: ${e}`);
            return;
        }
        if (purgePassStartMs > 0) {
            // Opportunistic passive checkpoint — only if we actually deleted
            // something this pass, and only PASSIVE so readers aren't blocked.
            if (purgePassChanges > 0) {
                try {
                    conn.pragma('wal_checkpoint(PASSIVE)');
                } catch (e) {
                    console.log(`pointlog: passive checkpoint failed: ${e}`);
                }
            }
            console.log(
                `pointlog: pass purged ${purgePassChanges} rows across ${purgePassFlarms} flarmIds in ${Date.now() - purgePassStartMs}ms; next pass ${nextQueue.length} flarmIds`
            );
        }
        purgeQueue = nextQueue;
        purgePassChanges = 0;
        purgePassFlarms = 0;
        purgePassStartMs = Date.now();
        if (purgeQueue.length === 0) return;
    }
    const f = purgeQueue.shift()!;
    const cutoff = Math.floor((Date.now() - retainMs) / 1000);
    try {
        const changes = (conn.prepare(`DELETE FROM points WHERE f = ? AND t < ?`).run(f, cutoff).changes ?? 0) as number;
        if (changes > 0) {
            purgePassChanges += changes;
            purgePassFlarms++;
        }
    } catch (e) {
        console.log(`pointlog: purge DELETE failed (${f}, cutoff ${cutoff}): ${e}`);
    }
}

// Row → LoggedMessage. `c` is set from `f` (callers like loadHistorical
// override with the glider's compno after the load). `l` is always null on
// disk.
function rowToMessage(r: any): LoggedMessage {
    return {
        t: r.t,
        f: r.f,
        o: r.o,
        c: r.f,
        lat: r.lat,
        lng: r.lng,
        a: r.a,
        g: r.g,
        b: r.b ?? undefined,
        s: r.s ?? undefined,
        l: null,
        d: r.d ?? undefined,
        ad: r.ad ?? undefined
    } as LoggedMessage;
}

// ---------- readers ----------

export interface LoadPointsQuery {
    flarmId: FlarmID;
    since: number; // epoch seconds (inclusive)
    until?: number; // epoch seconds (inclusive)
}

export interface LoadPointsForIdsQuery {
    flarmIds?: Set<string>;
    since: number;
    until?: number;
}

const COLS = `t, f, o, lat, lng, a, g, b, s, d, ad`;

// Walk a prepared statement defensively. SQLite errors during prepare or
// iterate (table missing, corrupt page, schema mismatch, malformed row) are
// logged and turned into "no more rows" rather than propagating up to the
// caller — pointlog readers feed long-running pipelines (scoring backfills,
// CLI scans) where one bad packet shouldn't kill the run.
async function* iterateStmt(stmt: Database.Statement, params: any[], label: string): AsyncGenerator<LoggedMessage> {
    let it: IterableIterator<any>;
    try {
        it = stmt.iterate(...params) as IterableIterator<any>;
    } catch (e) {
        console.log(`pointlog ${label}: iterate failed: ${e}`);
        return;
    }
    let yielded = 0;
    while (true) {
        let next: IteratorResult<any>;
        try {
            next = it.next();
        } catch (e) {
            console.log(`pointlog ${label}: row read failed after ${yielded} rows: ${e}`);
            return;
        }
        if (next.done) return;
        try {
            yield rowToMessage(next.value);
        } catch (e) {
            console.log(`pointlog ${label}: bad row skipped: ${e}`);
            continue;
        }
        if (++yielded % 1000 === 0) await new Promise<void>((r) => setImmediate(r));
    }
}

export async function* loadPoints(q: LoadPointsQuery): AsyncGenerator<LoggedMessage> {
    const conn = ensureReaderDb();
    if (!conn) return;
    // Uses idx_points_f_t — index seek on (f, t).
    let stmt: Database.Statement;
    try {
        stmt = conn.prepare(
            `SELECT ${COLS} FROM points WHERE f = ? AND t >= ?` +
            (q.until != null ? ` AND t <= ?` : ``) +
            ` ORDER BY t`
        );
    } catch (e) {
        console.log(`pointlog loadPoints(${q.flarmId}): prepare failed: ${e}`);
        return;
    }
    const params: any[] = q.until != null ? [q.flarmId, q.since, q.until] : [q.flarmId, q.since];
    yield* iterateStmt(stmt, params, `loadPoints(${q.flarmId})`);
}

export async function* loadPointsForIds(q: LoadPointsForIdsQuery): AsyncGenerator<LoggedMessage> {
    const conn = ensureReaderDb();
    if (!conn) return;
    let stmt: Database.Statement;
    let params: any[];
    try {
        if (q.flarmIds && q.flarmIds.size > 0) {
            const ph = Array(q.flarmIds.size).fill('?').join(',');
            stmt = conn.prepare(
                `SELECT ${COLS} FROM points WHERE t >= ?` +
                (q.until != null ? ` AND t <= ?` : ``) +
                ` AND f IN (${ph}) ORDER BY t`
            );
            params = q.until != null ? [q.since, q.until, ...q.flarmIds] : [q.since, ...q.flarmIds];
        } else {
            stmt = conn.prepare(
                `SELECT ${COLS} FROM points WHERE t >= ?` +
                (q.until != null ? ` AND t <= ?` : ``) +
                ` ORDER BY t`
            );
            params = q.until != null ? [q.since, q.until] : [q.since];
        }
    } catch (e) {
        console.log(`pointlog loadPointsForIds: prepare failed: ${e}`);
        return;
    }
    yield* iterateStmt(stmt, params, 'loadPointsForIds');
}

export async function* scanAll(opts: {since?: number; until?: number} = {}): AsyncGenerator<LoggedMessage> {
    yield* loadPointsForIds({since: opts.since ?? 0, until: opts.until});
}

export interface PointSummaryRow {
    flarmId: string;
    count: number;
    oldest: number;
    newest: number;
}

// Per-flarmid aggregation done server-side. dumptracks --summary previously
// iterated every row through JS just to feed COUNT/MIN/MAX — pushing the
// aggregation into SQLite turns a multi-million-row scan + per-row object
// allocation into a single GROUP BY scan. Empty array on error / missing DB.
export function summarize(opts: {flarmId?: FlarmID; since?: number; until?: number} = {}): PointSummaryRow[] {
    const conn = ensureReaderDb();
    if (!conn) return [];
    const since = opts.since ?? 0;
    const conds: string[] = ['t >= ?'];
    const params: any[] = [since];
    if (opts.until != null) {
        conds.push('t <= ?');
        params.push(opts.until);
    }
    if (opts.flarmId) {
        conds.push('f = ?');
        params.push(opts.flarmId);
    }
    const sql = `SELECT f, COUNT(*) AS count, MIN(t) AS oldest, MAX(t) AS newest
                 FROM points
                 WHERE ${conds.join(' AND ')}
                 GROUP BY f
                 ORDER BY f`;
    try {
        const rows = conn.prepare(sql).all(...params) as Array<{f: string; count: number; oldest: number; newest: number}>;
        return rows.map((r) => ({flarmId: r.f, count: r.count, oldest: r.oldest, newest: r.newest}));
    } catch (e) {
        console.log(`pointlog summarize: ${e}`);
        return [];
    }
}
