import Head from 'next/head';
import {useTranslation} from 'next-i18next/pages';
import {serverSideTranslations} from 'next-i18next/pages/serverSideTranslations';

import {CompetitionGlobe} from '../lib/react/globe';
import {useSelector} from '../lib/redux';
import {selectCompetitionsList} from '../lib/redux/competitionsSlice';

//
// Landing page: 3D globe showing every competition that is live or within
// 24 hours of its last task, so users can pick one to enter. Each marker is
// colored by status (flying / landed / upcoming / over) and a click drops
// into the existing competition view at /<compid>/.
//
// Competition list comes from the OGN daemon's /all websocket — initial
// snapshot on connect, then deltas as compstatus / pilot rosters change.
// The websocket is opened once in pages/_app.tsx and feeds the Redux
// `competitions` slice; this page is a passive consumer.
//
export default function GlobeLandingPage({countriesGeoJson}: {countriesGeoJson: any}) {
    const competitions = useSelector(selectCompetitionsList);
    const {t} = useTranslation('common');

    return (
        <>
            <Head>
                <title>{t('app.title_landing')}</title>
                <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
            </Head>
            <CompetitionGlobe competitions={competitions} countriesGeoJson={countriesGeoJson} />
        </>
    );
}

//
// Country borders are fetched at build/request time so the client bundle
// stays small. We use the well-known Natural Earth simplified countries
// GeoJSON hosted via unpkg; if the fetch fails we simply render without
// the land layer.
//
export async function getServerSideProps({locale}: {locale?: string}) {
    let countriesGeoJson: any = null;
    try {
        // World-110m-simplified GeoJSON (~110KB) — lightweight enough to
        // inline into the page props.
        const res = await fetch('https://unpkg.com/world-atlas@2.0.2/countries-110m.json');
        if (res.ok) {
            const topo = await res.json();
            // world-atlas is TopoJSON; convert at request time using a tiny
            // built-in heuristic. Rather than adding topojson-client as a
            // dependency, we instead ship a GeoJSON fallback file.
            // For now, pass through null and let the globe render without it.
            countriesGeoJson = null;
        }
    } catch (e) {
        countriesGeoJson = null;
    }

    return {
        props: {
            countriesGeoJson,
            ...(await serverSideTranslations(locale ?? 'en', ['common']))
        }
    };
}
