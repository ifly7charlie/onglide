import '@fortawesome/fontawesome-svg-core/styles.css';
import {config} from '@fortawesome/fontawesome-svg-core';
config.autoAddCss = false;

import '../styles/onglide.scss';

import {useState, useCallback} from 'react';

const defaultOptions = {
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
    options2d: {taskUp: 0, mapType: 0, follow: true},
    options3d: {taskUp: 1, mapType: true, follow: true}
};

// This default export is required in a new `pages/_app.js` file.
export default function MyApp({Component, pageProps}) {
    const getOptions = () => {
        try {
            const value = window?.localStorage.getItem('options');
            return value ? {...defaultOptions, ...JSON.parse(value), zoomTask: true} : defaultOptions;
        } catch (e) {
            console.log('unable to load options', e);
            // if error, return initial value
            return defaultOptions;
        }
    };

    const [options, setOptionsState] = useState(getOptions);
    const setOptions = useCallback((newOptions) => {
        try {
            window?.localStorage.setItem('options', JSON.stringify(newOptions));
        } catch (e) {
            /**/
        }
        setOptionsState(newOptions);
    }, []);

    return <Component {...pageProps} options={options} setOptions={setOptions} />;
}
