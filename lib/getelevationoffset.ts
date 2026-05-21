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
let pending = [];

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

async function _getElevationOffset(lat, lng, cb) {
    // Figure out what tile it is (obvs same order as geojson)
    // zoom 12 gives ~9.5m/px at 40° — plenty for a per-point elevation query
    let tf = tilebelt.pointToTileFraction(lng, lat, 12);
    let tile = tf.map(Math.floor);
    let url = DEM_TILE_URL.replace('{z}', String(tile[2])).replace('{x}', String(tile[0])).replace('{y}', String(tile[1]));

    // Have we cached it
    let pixels = cache.get(url);

    // Convert to elevation
    function pixelsToElevation(npixels) {
        let xp = tf[0] - tile[0];
        let yp = tf[1] - tile[1];
        let x = Math.floor(xp * npixels.shape[0]);
        let y = Math.floor(yp * npixels.shape[1]);

        let R = npixels.get(x, y, 0);
        let G = npixels.get(x, y, 1);
        let B = npixels.get(x, y, 2);

        // Terrarium encoding: height = (R*256 + G + B/256) - 32768
        let height = R * 256 + G + B / 256 - 32768;
        return Math.floor(height);
    }

    // If it isn't in the cache then we need to fetch it, cache it
    // and do the CB with the elevation
    if (!pixels) {
        // Make sure we don't fetch same thing twice at the same time
        if (url in pending) {
            //            console.log('queued elevation request');
            pending[url].push(cb);
            return;
        } else {
            pending[url] = [cb];
        }

        // Tile is keyed by z/x/y on disk — independent of the (configurable) URL.
        const tilePath = `${DEM_CACHE_DIR}${tile[2]}-${tile[0]}-${tile[1]}.png`;

        // Decode a parsed PNG into the NDArray, cache it in RAM and service
        // every pending callback waiting on this tile.
        function deliver(img_data) {
            const npixels = ndarray(new Uint8Array(img_data.data), [img_data.width | 0, img_data.height | 0, 4], [4, (4 * img_data.width) | 0, 1], 0);
            cache.set(url, npixels);
            pending[url].forEach((cbp) => cbp(pixelsToElevation(npixels)));
            delete pending[url];
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
                    new PNG().parse(data, (err, img_data) => {
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
                    pending[url].forEach((cbp) => cbp(0));
                    delete pending[url];
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
                new PNG().parse(diskData, (err, img_data) => {
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
    } else {
        cb(pixelsToElevation(pixels));
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
