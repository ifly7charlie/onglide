import {Html, Head, Main, NextScript} from 'next/document';

export default function Document() {
    return (
        <Html>
            <Head>
                <link rel="manifest" href="/manifest.json" />
                <link rel="icon" type="image/png" href="/logo16.png" sizes="16x16" />
                <link rel="icon" type="image/png" href="/logo32.png" sizes="32x32" />
                <link rel="icon" type="image/png" href="/logo128.png" sizes="128x128" />
                {/* iOS PWA: required for "Add to Home Screen" to launch in
                    standalone mode. Web Push (and Notification) are only
                    exposed in standalone — without this iOS launches the icon
                    as a Safari tab and the subscribe bell stays hidden. */}
                <meta name="apple-mobile-web-app-capable" content="yes" />
                <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
                <meta name="apple-mobile-web-app-title" content="Onglide" />
                <link rel="apple-touch-icon" href="/logo192.png" />
            </Head>
            <body>
                <Main />
                <NextScript />
            </body>
        </Html>
    );
}
