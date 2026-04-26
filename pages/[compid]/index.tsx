import {useRouter} from 'next/router';
import Head from 'next/head';
import {useTranslation} from 'next-i18next/pages';
import {serverSideTranslations} from 'next-i18next/pages/serverSideTranslations';

import {useState} from 'react';

// Helpers for loading contest information etc
import {useContest, Spinner} from '../../lib/react/loaders';

// And connect to websockets...
import {OgnFeed} from '../../lib/react/ognfeed';

import {query} from '../../lib/react/db';
import escape from 'sql-template-strings';

import {MeasureContext} from '../../lib/react/measure';
import {ClassName} from '../../lib/types';

import {find as _find} from 'lodash';

import {Provider} from 'react-redux';
import store from '../../lib/redux/store';

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

    // Next up load the contest and the pilots, we can use defaults for pilots
    // if the className matches
    const {comp, isLoading, isError} = useContest(compid);

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
    // And display in progress until they are loaded
    if (isLoading || !props.options)
        return (
            <div className="loading">
                <div className="loadinginner" />
            </div>
        );

    if (isError || !comp?.competition) return <Spinner />;

    // Make sure we have the class object
    const selectedClass = _find(comp.classes, {class: className});

    if (!selectedClass) {
        return (
            <>
                <Head>
                    <title>{comp.competition.name}</title>
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
                        {comp.competition.name}
                        {selectedClass?.classname ? ' - ' + selectedClass.classname : ''}
                    </title>
                </Head>
                {selectedClass?.datecode ? (
                    <div className="resizingContainer">
                        <Provider store={store}>
                            <OgnFeed
                                comp={comp}
                                compid={compid}
                                vc={className as ClassName} //
                                tz={props.tz}
                                datecode={selectedClass.datecode}
                                selectedCompno={selectedCompno}
                                setSelectedCompno={setSelectedCompno}
                                viewport={viewport}
                                setViewport={setViewport}
                                options={props.options}
                                setOptions={props.setOptions}
                                handicapped={selectedClass?.handicapped == 'Y'}
                                notes={selectedClass?.notes}
                            />
                        </Provider>
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
