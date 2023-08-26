import '@fortawesome/fontawesome-svg-core/styles.css';
import {config} from '@fortawesome/fontawesome-svg-core';
config.autoAddCss = false;

import '../styles/onglide.scss';

import {useState, useCallback} from 'react';

const defaultOptions = {rainRadar: 1, rainRadarAdvance: 0, units: 0, mapType: 3, taskUp: 0, follow: true, sortOrder: 'auto'};

// This default export is required in a new `pages/_app.js` file.
export default function MyApp({Component, pageProps}) {
    const getOptions = () => {
        try {
            return value ? JSON.parse(value) : defaultOptions;
        } catch (e) {
            // if error, return initial value
            return defaultOptions;
        }
    };

    const [options, setOptionsState] = useState(getOptions);
    const setOptions = useCallback((newOptions) => {
        console.log('setOptions', newOptions);
        try {
            window?.localStorage.setItem('options', JSON.stringify(newOptions));
        } catch (e) {
            // catch possible errors:
            // https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API/Using_the_Web_Storage_API
        }
        setOptionsState(newOptions);
    }, []);

    return <Component {...pageProps} options={options} setOptions={setOptions} />;
}
