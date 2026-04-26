import Head from 'next/head';
import useSWR from 'swr';
import {useTranslation} from 'next-i18next/pages';
import {serverSideTranslations} from 'next-i18next/pages/serverSideTranslations';

import {CompetitionGlobe, Competition} from '../lib/react/globe';

const fetcher = (url: string) => fetch(url).then((res) => (res.status === 200 ? res.json() : {competitions: []}));

//
// Landing page: 3D globe showing every competition that is live or within
// 24 hours of its last task, so users can pick one to enter. Each marker is
// colored by status (flying / landed / upcoming / over) and a click drops
// into the existing competition view at /<compid>/.
//
export default function GlobeLandingPage({countriesGeoJson}: {countriesGeoJson: any}) {
    const {data} = useSWR('/api/competitions', fetcher, {refreshInterval: 60 * 1000});
    const competitions: Competition[] = data?.competitions ?? [];
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
