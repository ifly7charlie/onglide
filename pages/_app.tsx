'use client';

import Head from 'next/head';

import '@fortawesome/fontawesome-svg-core/styles.css';
import {config} from '@fortawesome/fontawesome-svg-core';
config.autoAddCss = false;

import '../styles/onglide.scss';

import {useState, useCallback, useEffect} from 'react';

import type {Options} from '../lib/types';
import {PathLength, Units, MapType, TaskUp} from '../lib/types';

const defaultOptions: Options = {
    //
    rainRadar: true,
    rainRadarAdvance: 0,
    units: Units.metric,
    mapType: MapType.satellite,
    map2d: true,
    taskUp: TaskUp.north,
    follow: true,
    zoomTask: true,
    sortKey: 'auto',
    showOthers: true,
    fullPaths: PathLength.selectedFull,
    options2d: {taskUp: TaskUp.north, mapType: MapType.street, follow: true},
    options3d: {taskUp: TaskUp.track, mapType: MapType.satellite, follow: true}
};

export function useOptions() {
    const [value, set] = useState<Options | undefined>();
    useEffect(() => {
        const saved = window?.localStorage.getItem('options');
        if (saved) {
            try {
                set({...JSON.parse(saved), zoomTask: true});
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
                console.log('set options', newOptions);
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
export default function MyApp({Component, pageProps}) {
    const [options, setOptions] = useOptions();
    return (
        <>
            <Head>
                <meta name="viewport" content="width=device-width, minimal-ui" />
            </Head>
            <Component {...pageProps} options={options} setOptions={setOptions} />
        </>
    );
}
