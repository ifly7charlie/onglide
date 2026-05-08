import {useRouter} from 'next/router';
import Head from 'next/head';
import {useTranslation} from 'next-i18next/pages';
import {serverSideTranslations} from 'next-i18next/pages/serverSideTranslations';

import {useState, useMemo} from 'react';

// And connect to websockets...
import {OgnFeed} from '../../lib/react/ognfeed';
import {CompetitionGlobe} from '../../lib/react/globe';

import {query} from '../../lib/react/db';
import escape from 'sql-template-strings';

import {MeasureContext} from '../../lib/react/measure';
import {ClassName, Datecode} from '../../lib/types';

import {useSelector} from '../../lib/redux';
import {selectCompByCompid} from '../../lib/redux/competitionsSlice';

//
// Main page rendering :)
export default function CombinePage(props) {
    // First step is to extract the class from the query, we use
    // query because that stops page reload when switching between the
    // classes. If no class is set then assume the first one
    const router = useRouter();
    const {t} = useTranslation('common');
    const compid = props.compid;
    let {className} = router.query;
    if (!className) {
        className = props.defaultClass;
    }
    if (Array.isArray(className)) {
        className = className[0];
    }

    // Comp metadata + per-class status comes from the /all websocket via
    // Redux. summary === null means the snapshot hasn't arrived yet OR this
    // compid isn't in the live list — both render the loading spinner.
    const compByCompid = useMemo(() => selectCompByCompid(compid), [compid]);
    const summary = useSelector(compByCompid);

    // And keep track of who is selected
    const [selectedCompno, setSelectedCompno] = useState();

    // What the map is looking at
    const [viewport, setViewport] = useState({
        latitude: props.lat,
        longitude: props.lng,
        zoom: 8.5,
        minZoom: 6.5,
        maxZoom: 14.5,
        bearing: 0,
        minPitch: 0,
        maxPitch: 80,
        pitch: !props?.options?.map2d ? 70 : 0
    });

    //
    // /all hasn't delivered the snapshot yet (or the websocket is down) —
    // show the same rotating-globe placeholder the landing page uses
    // instead of a blank screen, so the page reads as loading rather than
    // broken when the connection is unavailable.
    if (!summary || !props.options) return <CompetitionGlobe competitions={[]} countriesGeoJson={null} />;

    // Make sure we have the class object
    const selectedClass = summary.classes.find((c) => c.class === className);

    if (!selectedClass) {
        return (
            <>
                <Head>
                    <title>{summary.name}</title>
                </Head>
                <h1>{t('competition.no_class_selected')}</h1>
            </>
        );
    }

    return (
        <>
            <MeasureContext>
                <Head>
                    <title>
                        {summary.name}
                        {selectedClass?.classname ? ' - ' + selectedClass.classname : ''}
                    </title>
                </Head>
                {selectedClass?.datecode ? (
                    <div className="resizingContainer">
                        <OgnFeed
                            comp={summary}
                            compid={compid}
                            vc={className as ClassName} //
                            tz={props.tz}
                            datecode={selectedClass.datecode as Datecode}
                            selectedCompno={selectedCompno}
                            setSelectedCompno={setSelectedCompno}
                            viewport={viewport}
                            setViewport={setViewport}
                            options={props.options}
                            setOptions={props.setOptions}
                            handicapped={selectedClass?.taskRules?.handicapped === true}
                        />
                    </div>
                ) : (
                    <div
                        className="resizingContainer"
                        style={{
                            display: 'flex',
                            justifyContent: 'center', // horizontal
                            alignItems: 'center', // vertical
                            width: '100%', // or fixed width
                            height: '100vh' // or fixed height
                        }}
                    >
                        {t('competition.no_tasks_yet')}
                    </div>
                )}
            </MeasureContext>
        </>
    );
}

//
// Determine the default class for this competition
export async function getServerSideProps(context) {
    const compid = context.params.compid as string;
    const locale: string = context.locale ?? 'en';
    try {
        const location = (
            await query(escape`
                SELECT
                    lt,
                    lg,
                    tzoffset,
                    tz
                FROM
                    competition
                WHERE
                    compid = ${compid}
            `)
        )?.[0];

        if (!location) {
            return {notFound: true};
        }

        const classes = await query(escape`
            SELECT
                class
            FROM
                classes
            WHERE
                compid = ${compid}
            ORDER BY
                class
        `);

        return {
            props: {
                compid,
                lat: location?.lt || 51,
                lng: location?.lg || 0,
                tzoffset: location?.tzoffset || 0,
                tz: location?.tz || 'Etc/UTC',
                defaultClass: classes && classes.length > 0 ? classes[0].class : '',
                ...(await serverSideTranslations(locale, ['common']))
            }
        };
    } catch (e) {
        console.log(e);
        return {
            props: {
                compid,
                lat: 51,
                lng: 0,
                tzoffset: 0,
                tz: 'Etc/UTC',
                defaultClass: '',
                ...(await serverSideTranslations(locale, ['common']))
            }
        };
    }
}
