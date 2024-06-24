'use client';

import '@fortawesome/fontawesome-svg-core/styles.css';
import {config} from '@fortawesome/fontawesome-svg-core';
config.autoAddCss = false;

import '../styles/onglide.scss';

import {useState, useCallback, useEffect} from 'react';

import type {Options} from '../lib/types';

const defaultOptions: Options = {
    //
    rainRadar: 1,
    rainRadarAdvance: 0,
    units: 0,
    mapType: 0,
    map2d: false,
    taskUp: 0,
    follow: true,
    zoomTask: true,
    sortOrder: 'auto',
    showOthers: true,
    options2d: {taskUp: 0, mapType: 0, follow: true},
    options3d: {taskUp: 1, mapType: 1, follow: true}
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
    return <Component {...pageProps} options={options} setOptions={setOptions} />;
}
