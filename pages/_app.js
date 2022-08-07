import '@fortawesome/fontawesome-svg-core/styles.css';
import {config} from '@fortawesome/fontawesome-svg-core';
config.autoAddCss = false;

import '../styles/onglide.scss';

import {useState} from 'react';

// This default export is required in a new `pages/_app.js` file.
export default function MyApp({Component, pageProps}) {
    const [options, setOptions] = useState(pageProps.options);
    return <Component {...pageProps} options={options} setOptions={setOptions} />;
}
