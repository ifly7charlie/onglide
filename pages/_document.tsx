import {Html, Head, Main, NextScript} from 'next/document';

export default function Document() {
    return (
        <Html>
            <Head>
                <link rel="manifest" href="/manifest.json" />
                <link rel="icon" type="image/png" href="/logo16.png" sizes="16x16" />
                <link rel="icon" type="image/png" href="/logo32.png" sizes="32x32" />
                <link rel="icon" type="image/png" href="/logo128.png" sizes="128x128" />
            </Head>
            <body>
                <Main />
                <NextScript />
            </body>
        </Html>
    );
}
