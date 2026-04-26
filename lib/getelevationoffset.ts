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

// Track duplicate requests for the same time and service them together from one response
let pending = [];

// Terrarium-encoded PNG DEM tiles. AWS Open Data public bucket is the default; override
// via NEXT_PUBLIC_DEM_TILE_URL to front it through your own CDN.
const DEM_TILE_URL = process.env.NEXT_PUBLIC_DEM_TILE_URL || 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

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

        // With a PNG from fetch we can create the NDArray we need
        // to calculate the elevation
        function parsePNG(err, img_data) {
            if (err) {
                throw err;
            }
            // Save it away
            const npixels = ndarray(new Uint8Array(img_data.data), [img_data.width | 0, img_data.height | 0, 4], [4, (4 * img_data.width) | 0, 1], 0);

            cache.set(url, npixels);
            pending[url].forEach((cbp) => cbp(pixelsToElevation(npixels)));
            delete pending[url];
        }

        // Go and get the URL
        fetch(url)
            .then((res) => {
                if (res.status != 200) {
                    throw `DEM tile fetch returned ${res.status}: ${res.statusText} for ${url}`;
                } else {
                    return res.arrayBuffer();
                }
            })
            .then((data) => {
                new PNG().parse(data, parsePNG);
            })
            .catch((err) => {
                // We still call the callback on an error as we don't want to drop the packet
                console.error('unable to read elevation: ' + err);
                pending[url].forEach((cbp) => cbp(0));
                delete pending[url];
            });
    } else {
        cb(pixelsToElevation(pixels));
    }
}
