//
// Taken from:
//   https://github.com/scijs/get-pixels/blob/master/node-pixels.js
//   https://github.com/mcwhittemore/mapbox-elevation/blob/master/index.js
//
// Modules not used because they include a LOAD of things we don't need, some of which
// sound more like a rootkit than something useful.
//

let tilebelt = require('@mapbox/tilebelt');
let ndarray = require('ndarray');
let PNG = require('pngjs').PNG;

import {existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, utimesSync, readdirSync, statSync} from 'fs';

// Track duplicate requests for the same time and service them together from one response
const pending: Record<string, Array<(npixels: any) => void>> = {};

// Terrarium-encoded PNG DEM tiles. AWS Open Data public bucket is the default; override
// via NEXT_PUBLIC_DEM_TILE_URL to front it through your own CDN.
const DEM_TILE_URL = process.env.NEXT_PUBLIC_DEM_TILE_URL || 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

// On-disk tile cache. DEM tiles are immutable raw PNG bytes keyed by z/x/y, so a
// restarted daemon (or a second process sharing DB_PATH) can read them back from
// disk instead of re-fetching from S3. Reuses the DB_PATH env var that the DDB
// disk cache already uses.
const DEM_CACHE_DIR = `${process.env.DB_PATH ?? './db/'}/dem-tiles/`;

// Tiles untouched (mtime not refreshed) for this long are pruned at shutdown.
const DEM_CACHE_MAX_AGE_MS = 10 * 24 * 3600 * 1000;

try {
    mkdirSync(DEM_CACHE_DIR, {recursive: true});
} catch (e) {
    console.error(`unable to create DEM tile cache directory ${DEM_CACHE_DIR}`, e);
}

import {LRUCache} from 'lru-cache';

const options = {
    max: 40000,
    //    dispose: function (key, n) {
    //        console.log('flushed ' + key + ' from cache');
    //    },
    updateAgeOnGet: true,
    allowStale: true,
    ttl: 72 * 3600 * 1000
};

const cache = new LRUCache(options);

//    module.exports = function(tk) {
//      return function(p, cb) {

export function getCacheSize(): number {
    return cache.size;
}

//
// For a given lat, lng lookup the elevation
// NOTE: there is a race condition here - as we are async we could have two requests for the same
//       point at the same time and do more work.  It won't cause it to fail it just wastes CPU and
//       memory as we keep fetching the same item
//
export async function getElevationOffset(lat: number, lng: number): Promise<number>;
export async function getElevationOffset(lat: number, lng: number, cb: Function): Promise<void>;
export async function getElevationOffset(lat: number, lng: number, cb: Function | undefined = undefined) {
    if (!cb) {
        return new Promise<number>((r) => _getElevationOffset(lat, lng, r));
    }
    return _getElevationOffset(lat, lng, cb);
}

//
// Local relief: max elevation minus min elevation in a (2r+1)x(2r+1) pixel
// window centred on the point. At zoom 12 each pixel is ~25-29m depending on
// latitude, so the default radius=10 samples a ~525m square — wide enough to
// tolerate hundred-metre positional error in the input coords. Useful as a
// "is this point on a hill?" classifier — flatland reads single-digit metres,
// foothills tens of metres, mountains hundreds. Near a tile edge the window
// is shifted inward rather than fetching a neighbour tile.
// Returns -1 if the DEM tile can't be loaded — distinguishable from a
// legitimate 0 (perfectly flat). Callers using relief as a safety check
// (e.g. "high relief → don't land glider out") should treat the failure case
// the same as high relief, so a DEM outage doesn't change the verdict.
//
export async function getLocalRelief(lat: number, lng: number, radiusPixels?: number): Promise<number>;
export async function getLocalRelief(lat: number, lng: number, radiusPixels: number, cb: Function): Promise<void>;
export async function getLocalRelief(lat: number, lng: number, radiusPixels: number = 10, cb: Function | undefined = undefined) {
    if (!cb) {
        return new Promise<number>((r) => _getLocalRelief(lat, lng, radiusPixels, r));
    }
    return _getLocalRelief(lat, lng, radiusPixels, cb);
}

// Terrarium-decode a single pixel at integer (x, y) in the tile.
function decodeHeight(npixels: any, x: number, y: number): number {
    const R = npixels.get(x, y, 0);
    const G = npixels.get(x, y, 1);
    const B = npixels.get(x, y, 2);
    // Terrarium encoding: height = (R*256 + G + B/256) - 32768
    return R * 256 + G + B / 256 - 32768;
}

// Map a (lat, lng, tile, tf) to the integer pixel coordinate inside the tile.
function pixelCoord(npixels: any, tile: number[], tf: number[]): [number, number] {
    const xp = tf[0] - tile[0];
    const yp = tf[1] - tile[1];
    return [Math.floor(xp * npixels.shape[0]), Math.floor(yp * npixels.shape[1])];
}

function _getElevationOffset(lat: number, lng: number, cb: Function): void {
    loadTile(lat, lng, (npixels, tile, tf) => {
        if (!npixels) {
            cb(0);
            return;
        }
        const [x, y] = pixelCoord(npixels, tile, tf);
        cb(Math.floor(decodeHeight(npixels, x, y)));
    });
}

function _getLocalRelief(lat: number, lng: number, radiusPixels: number, cb: Function): void {
    loadTile(lat, lng, (npixels, tile, tf) => {
        if (!npixels) {
            cb(-1);
            return;
        }
        const w = npixels.shape[0];
        const h = npixels.shape[1];
        // Clamp radius so the window always fits inside one tile.
        const r = Math.max(1, Math.min(radiusPixels | 0, Math.floor(Math.min(w, h) / 2) - 1));
        const [cx, cy] = pixelCoord(npixels, tile, tf);

        // Shift the window inward at edges instead of crossing the tile boundary.
        let x0 = cx - r;
        let y0 = cy - r;
        if (x0 < 0) x0 = 0;
        if (y0 < 0) y0 = 0;
        if (x0 + 2 * r > w - 1) x0 = w - 1 - 2 * r;
        if (y0 + 2 * r > h - 1) y0 = h - 1 - 2 * r;
        const x1 = x0 + 2 * r;
        const y1 = y0 + 2 * r;

        let min = Infinity;
        let max = -Infinity;
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const e = decodeHeight(npixels, x, y);
                if (e < min) min = e;
                if (e > max) max = e;
            }
        }
        cb(Math.floor(max - min));
    });
}

// Shared tile loader. Resolves the (lat, lng) to a zoom-12 tile, returns its
// pixel ndarray via cb(npixels, tile, tf). Hits RAM cache first, then on-disk
// cache, then network. Concurrent requests for the same tile are coalesced via
// `pending`; the queued thunks each bind their own (tile, tf) so callers
// looking up different points in the same tile each get their own coordinates.
// On any fetch/decode failure cb is called with (null, tile, tf) so the caller
// can decide what to return — callers must not drop the request.
function loadTile(lat: number, lng: number, cb: (npixels: any, tile: number[], tf: number[]) => void): void {
    // zoom 12 gives ~29m/px at 40° — plenty for a per-point elevation query,
    // and roughly matches the native SRTM (~30m) resolution of the DEM source
    const tf = tilebelt.pointToTileFraction(lng, lat, 12);
    const tile = tf.map(Math.floor);
    const url = DEM_TILE_URL.replace('{z}', String(tile[2])).replace('{x}', String(tile[0])).replace('{y}', String(tile[1]));

    const pixels = cache.get(url);
    if (pixels) {
        cb(pixels, tile, tf);
        return;
    }

    // Bind tile/tf per-caller so coalesced callbacks each see their own coords.
    const thunk = (npixels: any) => cb(npixels, tile, tf);

    if (url in pending) {
        pending[url].push(thunk);
        return;
    }
    pending[url] = [thunk];

    // Tile is keyed by z/x/y on disk — independent of the (configurable) URL.
    const tilePath = `${DEM_CACHE_DIR}${tile[2]}-${tile[0]}-${tile[1]}.png`;

    // Decode a parsed PNG into the NDArray, cache it in RAM and service every
    // pending callback waiting on this tile.
    function deliver(img_data: any) {
        const npixels = ndarray(new Uint8Array(img_data.data), [img_data.width | 0, img_data.height | 0, 4], [4, (4 * img_data.width) | 0, 1], 0);
        cache.set(url, npixels);
        const callbacks = pending[url];
        delete pending[url];
        callbacks.forEach((cbp) => cbp(npixels));
    }

    function failAll() {
        const callbacks = pending[url];
        delete pending[url];
        callbacks.forEach((cbp) => cbp(null));
    }

    // Fetch the tile from the (S3) DEM endpoint, persist it to the disk
    // cache, decode and deliver.
    function fetchFromS3() {
        fetch(url)
            .then((res) => {
                if (res.status != 200) {
                    throw `DEM tile fetch returned ${res.status}: ${res.statusText} for ${url}`;
                } else {
                    return res.arrayBuffer();
                }
            })
            .then((data) => {
                // Persist the raw PNG to the disk cache. Best-effort: write to a
                // temp file then rename so a concurrent reader (another daemon
                // sharing DB_PATH) never sees a partial PNG.
                try {
                    const tmp = `${tilePath}.${process.pid}.tmp`;
                    writeFileSync(tmp, Buffer.from(data));
                    renameSync(tmp, tilePath);
                } catch (e) {
                    console.error(`unable to persist DEM tile ${tilePath}: ${e}`);
                }
                new PNG().parse(data, (err: any, img_data: any) => {
                    if (err) {
                        throw err;
                    }
                    deliver(img_data);
                });
            })
            .catch((err) => {
                // We still call the callback on an error as we don't want to drop the packet
                // Node's fetch wraps the real network error on err.cause (ENOTFOUND, ECONNRESET,
                // ETIMEDOUT, UND_ERR_*, TLS errors, etc.) — surface it so the log is actionable.
                const cause = err && err.cause;
                const causeStr = cause ? ` (cause: ${cause.code || cause.name || ''} ${cause.message || cause})`.trimEnd() : '';
                console.error(`unable to read elevation for ${url}: ${err}${causeStr}`);
                failAll();
            });
    }

    // Check the disk cache before going to the network.
    if (existsSync(tilePath)) {
        try {
            const diskData = readFileSync(tilePath);
            // Refresh mtime so the 10-day pruner treats this tile as recently
            // used (atime is unreliable under noatime/relatime mounts).
            const now = new Date();
            utimesSync(tilePath, now, now);
            new PNG().parse(diskData, (err: any, img_data: any) => {
                if (err) {
                    // Corrupt cache file — drop it and fall back to S3.
                    console.error(`corrupt DEM tile cache ${tilePath}, re-fetching: ${err}`);
                    try {
                        unlinkSync(tilePath);
                    } catch (e) {
                        /* already gone */
                    }
                    fetchFromS3();
                    return;
                }
                deliver(img_data);
            });
        } catch (e) {
            console.error(`unable to read DEM tile cache ${tilePath}, re-fetching: ${e}`);
            fetchFromS3();
        }
    } else {
        fetchFromS3();
    }
}

//
// Prune the on-disk DEM tile cache: delete any tile untouched (mtime not
// refreshed) for DEM_CACHE_MAX_AGE_MS. Every disk cache hit bumps the tile's
// mtime, so this removes only genuinely cold tiles. Best-effort — wired into
// the daemon's graceful-shutdown path; failures must not disturb shutdown.
//
export function shutdownElevationCache(): void {
    try {
        const cutoff = Date.now() - DEM_CACHE_MAX_AGE_MS;
        let pruned = 0;
        for (const name of readdirSync(DEM_CACHE_DIR)) {
            if (!name.endsWith('.png')) continue;
            const file = `${DEM_CACHE_DIR}${name}`;
            try {
                if (statSync(file).mtimeMs < cutoff) {
                    unlinkSync(file);
                    pruned++;
                }
            } catch (e) {
                /* file vanished or unreadable — skip */
            }
        }
        if (pruned) {
            console.log(`pruned ${pruned} stale DEM tile(s) from ${DEM_CACHE_DIR}`);
        }
    } catch (e) {
        console.error(`unable to prune DEM tile cache ${DEM_CACHE_DIR}: ${e}`);
    }
}
