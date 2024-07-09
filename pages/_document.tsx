import {Html, Head, Main, NextScript} from 'next/document';

export default function Document() {
    return (
        <Html>
            <Head>
                <link rel="manifest" href="/manifest.json" />
                <link href="//api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css" rel="stylesheet" />
            </Head>
            <body>
                <Main />
                <NextScript />
            </body>
        </Html>
    );
}
