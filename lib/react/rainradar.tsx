//
// This is responsible for creating and displaying rain radar on screen
//

import {useEffect, useState} from 'react';
import {useTranslation} from 'next-i18next/pages';
//import Source from '../lib/source';
import {Source, Layer, LayerProps} from 'react-map-gl/maplibre';

import type {Options, TZ} from '../types';

export function RadarOverlay({options, tz}: {options: Options; tz: TZ}) {
    const {t, i18n} = useTranslation('common');
    const lang = i18n.language;
    const [radarTileURL, setURL] = useState<string>();
    const [radarTime, setTime] = useState<string>();

    useEffect(() => {
        let timer: NodeJS.Timeout | undefined = undefined;

        function loadRadar() {
            clearTimeout(timer);
            setURL(undefined);
            setTime(undefined);
            if (options.rainRadar) {
                fetch('https://api.rainviewer.com/public/weather-maps.json', {
                    credentials: 'omit'
                })
                    .catch((e) => {
                        console.log(new Date(), 'unable to fetch radar data, will try again in two minutes', e);
                        timer = setTimeout(
                            () => {
                                loadRadar();
                            },
                            2 * 1000 * 60
                        );
                    })
                    .then((res) => {
                        try {
                            return res ? res?.json() : null;
                        } catch (e) {
                            console.log(e);
                            return null;
                        }
                    })
                    .catch((e) => {
                        console.log(new Date(), 'unable to fetch radar data, will try again in two minutes', e);
                        timer = setTimeout(
                            () => {
                                loadRadar();
                            },
                            2 * 1000 * 60
                        );
                    })
                    .then((apiData) => {
                        if (!apiData) {
                            console.log(new Date(), 'no radar data, will try again in two minutes');
                            timer = setTimeout(() => {
                                loadRadar();
                            }, 60000);
                            return;
                        }
                        var imageMeta;
                        if (options.rainRadarAdvance) {
                            imageMeta = apiData.radar.nowcast[options.rainRadarAdvance - 1];
                        } else {
                            imageMeta = apiData.radar.past.reduce((a, b) => (a.time >= b.time ? a : b));
                        }
                        setURL(apiData.host + imageMeta.path + '/256/{z}/{x}/{y}/2/1_1.png');

                        // And then produce a string to display it locally
                        const dt = new Date(imageMeta.time * 1000);
                        setTime(`✈️ ${dt.toLocaleTimeString(lang, {timeZone: tz, hour: '2-digit', minute: '2-digit'})}`);

                        // Figure out when to run next, API updates in 10 minutes
                        const interval = parseInt(apiData?.generated) + 600 - Date.now() / 1000;
                        timer = setTimeout(
                            () => {
                                loadRadar();
                            },
                            Math.max(interval || 0, 60) * 1000
                        );
                    })
                    .catch((e) => {
                        console.log(new Date(), 'unable to fetch radar data, will try again in two minutes', e);
                        timer = setTimeout(
                            () => {
                                loadRadar();
                            },
                            2 * 1000 * 60
                        );
                    });
            }
        }
        loadRadar();
        return () => clearTimeout(timer);
    }, [options.rainRadarAdvance, options.rainRadar]);

    // If it's to be displayed then make sure it is
    // note this is also used for refreshing the display - we will briefly set URL and Time to undefined
    // and update rainRadarAdvance. By setting to undefined first the components will be removed from
    // the built tree and a new one can be rebuilt. This gets around an issue in mapbox-gl2 where
    // the raster source layer is unable to update tiles, and the fact that react-mapbox-gl doesn't
    // know anything about rasters so doesn't deal with it either
    if (options.rainRadar && radarTileURL && radarTime) {
        const attribution = `<a href="https://www.rainviewer.com/">Rain Viewer</a> @ <a href='#' title='competition time for weather radar'>${radarTime}</a>`;
        return {
            attribution: attribution,
            key: 'rainradar',
            layer: (
                <Source type="raster" tiles={[radarTileURL]} key="rainmap">
                    <Layer {...rainviewerLayer} />
                </Source>
            )
        };
    } else {
        return {
            attribution: 'OGN',
            layer: null,
            key: 'ogn'
        };
    }
}

let rainviewerLayer: LayerProps = {
    id: 'rainRadar',
    type: 'raster',
    paint: {
        'raster-opacity': 0.6
    }
    //    source: 'rainmap'
    //    minzoom: 0,
    //    maxzoom: 12
};
