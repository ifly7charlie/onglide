'use client';

import Head from 'next/head';
import {appWithTranslation} from 'next-i18next/pages';

import '@fortawesome/fontawesome-svg-core/styles.css';
import {config} from '@fortawesome/fontawesome-svg-core';
config.autoAddCss = false;

import 'maplibre-gl/dist/maplibre-gl.css';
import '../styles/onglide.scss';

import {useState, useCallback, useEffect} from 'react';
import {Provider} from 'react-redux';

import type {Options} from '../lib/types';
import {PathLength, Units, MapType, TaskUp} from '../lib/types';
import store from '../lib/redux/store';
import {CompetitionsSocket} from '../lib/react/competitionsSocket';
import {AutoUpdateBanner} from '../lib/react/autoUpdate';

const defaultOptions: Options = {
    //
    rainRadar: false,
    rainRadarAdvance: 0,
    units: Units.metric,
    mapType: MapType.street,
    map2d: true,
    taskUp: TaskUp.north,
    follow: true,
    zoomTask: true,
    sortKey: 'auto',
    showOthers: true,
    showClimb: false,
    fullPaths: PathLength.selectedFull,
    options2d: {taskUp: TaskUp.north, mapType: MapType.street, follow: true},
    options3d: {taskUp: TaskUp.track, mapType: MapType.satellite, follow: true},
    constructionLines: false
};

export function useOptions() {
    const [value, set] = useState<Options | undefined>();
    useEffect(() => {
        const saved = window?.localStorage.getItem('options');
        if (saved) {
            try {
                set({...JSON.parse(saved), zoomTask: true, rainRadar: false});
            } catch (e) {
                set(defaultOptions);
            }
        } else {
            set(defaultOptions);
        }
    }, [set]);
    const setOptions = useCallback(
        (newOptions: Options) => {
            try {
                window?.localStorage.setItem('options', JSON.stringify(newOptions));
            } catch (e) {
                /**/
            }
            set(newOptions);
        },
        [set]
    );

    return [value, setOptions] as const;
}

// This default export is required in a new `pages/_app.js` file.
function MyApp({Component, pageProps}) {
    const [options, setOptions] = useOptions();
    return (
        <Provider store={store}>
            <CompetitionsSocket />
            <AutoUpdateBanner />
            <Head>
                <meta name="viewport" content="width=device-width, minimal-ui" />
            </Head>
            <Component {...pageProps} options={options} setOptions={setOptions} />
        </Provider>
    );
}

export default appWithTranslation(MyApp);
