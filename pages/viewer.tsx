import {useState, useCallback, useRef, useMemo, useEffect} from 'react';
import Head from 'next/head';
import {useTranslation} from 'next-i18next/pages';
import {serverSideTranslations} from 'next-i18next/pages/serverSideTranslations';

import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faFileArrowUp, faPlane, faMagnifyingGlassLocation, faCaretUp, faCaretDown, faCopy, faRotateLeft, faArrowsRotate} from '@fortawesome/free-solid-svg-icons';

import {Options} from '../lib/react/options';
import {MeasureContext} from '../lib/react/measure';

import dynamic from 'next/dynamic';
import {Provider} from 'react-redux';
import {configureStore} from '@reduxjs/toolkit';

import tracksReducer from '../lib/redux/tracksSlice';
import taskReducer from '../lib/redux/taskSlice';
import nowReducer from '../lib/redux/nowSlice';
import scoresReducer from '../lib/redux/scoresSlice';
import otherPilotsReducer from '../lib/redux/otherPilotsSlice';

import {selectAvailableScoreTimes} from '../lib/redux/nowSlice';
import {selectTask} from '../lib/redux/taskSlice';
import {selectAllScores} from '../lib/redux/scoresSlice';
import {selectLatestUpdate} from '../lib/redux/tracksSlice';
import {useSelector, useDispatch} from '../lib/redux';

import type {Options as OptionsType, Epoch, TZ, Compno, ClassName, DistanceKM, SpeedKPH} from '../lib/types';
import type {API_ClassName_Pilots, API_ClassName_Pilots_PilotDetail} from '../lib/rest-api-types';

import {parseIGC, type IGCData} from '../lib/view/igcParser';
import {buildTask} from '../lib/view/taskBuilder';
import {scoreIGCFlight} from '../lib/view/clientScoringPipeline';
import {dispatchClass, dispatchTask, dispatchTrack, dispatchScores, dispatchPilotStats, dispatchTimeRange} from '../lib/view/populateStore';
import {setReferenceDate} from '../lib/flightprocessing/referenceDate';

import {PilotList, Details} from '../lib/react/pilotlist';
import {getValidSortOrder} from '../lib/react/pilot-sorting';

import * as React from 'react';
import {styled} from '@mui/material/styles';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Slider from '@mui/material/Slider';

const MApp = dynamic(() => import('../lib/react/deckgl').then((mod) => mod), {
    ssr: false,
    loading: () => (
        <div style={{width: '100vw', marginTop: '20vh', position: 'absolute'}}>
            <div style={{display: 'block', margin: 'auto', width: '100px'}}>Loading map...</div>
        </div>
    )
});

export async function getStaticProps({locale}: {locale?: string}) {
    return {
        props: {
            ...(await serverSideTranslations(locale ?? 'en', ['common']))
        }
    };
}

const VC = 'View' as ClassName;
const TZ_DEFAULT = 'Etc/UTC' as TZ;

interface LoadedFlight {
    compno: Compno;
    pilotName: string;
    gliderType: string;
    fileName: string;
    fixes: number;
    igcData: IGCData;
}

function createViewStore() {
    return configureStore({
        reducer: {
            task: taskReducer,
            tracks: tracksReducer,
            scores: scoresReducer,
            otherPilots: otherPilotsReducer,
            now: nowReducer
        },
        middleware: (getDefaultMiddleware) =>
            getDefaultMiddleware({
                immutableCheck: false,
                serializableCheck: false
            })
    });
}

// Simplified playback controls that don't try to fetch scores from server
const Widget = styled('div')(({theme}) => ({
    padding: 24,
    paddingBottom: 8,
    borderRadius: 16,
    width: '85%',
    maxWidth: '100%',
    margin: 'auto',
    marginBottom: 8,
    position: 'relative',
    zIndex: 1,
    backgroundColor: theme.palette.mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.8)',
    backdropFilter: 'blur(40px)'
}));

const TinyText = styled(Typography)({fontSize: '0.75rem', opacity: 0.38, fontWeight: 500, letterSpacing: 0.2});
const SliderContainer = styled(Box)({width: '100%', overflow: 'hidden', bottom: '0'});
const BoxAfter = styled(Box)({display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '-1rem'});
const BoxBefore = styled(Box)({display: 'flex', alignItems: 'right', justifyContent: 'space-between', marginTop: '-1rem'});
const TimeSlider = styled(Slider)({color: 'rgba(0,128,0,0.87)', height: 4, '& .MuiSlider-thumb': {width: 8, height: 8}});

function ViewPlaybackControls({
    earliestScore,
    latestScore,
    replayTime,
    setReplayTime,
    tz
}: {
    earliestScore: Epoch;
    latestScore: Epoch;
    replayTime: Epoch | undefined;
    setReplayTime: (t: Epoch | undefined) => void;
    tz: TZ;
}) {
    const {t} = useTranslation('common');
    const latestTrackUpdate = useSelector(selectLatestUpdate, (a, b) => a >> 4 == b >> 4);
    const replayEndTime = latestTrackUpdate || latestScore;

    const doSetTime = useCallback(
        (t: Epoch | undefined) => {
            const inReplay = !t || t >= replayEndTime - 60 ? false : true;
            setReplayTime(inReplay ? t : undefined);
        },
        [replayEndTime, setReplayTime]
    );

    function formatTimes(t) {
        const dt = new Date(t * 1000);
        return `${dt.toLocaleTimeString('uk', {timeZone: tz, hour: '2-digit', minute: '2-digit'})}`;
    }

    function formatDuration(value: number) {
        const minute = Math.floor(value / 60);
        const secondLeft = value - minute * 60;
        return `${minute}:${secondLeft < 10 ? `0${secondLeft}` : secondLeft}`;
    }

    if (earliestScore > replayEndTime) {
        return null;
    }

    return (
        <SliderContainer>
            <Widget>
                <BoxBefore>
                    <TinyText>{formatTimes(earliestScore)}</TinyText>
                    {replayTime ? <TinyText>{formatTimes(replayTime)}</TinyText> : null}
                    <TinyText>{formatTimes(replayEndTime)}</TinyText>
                </BoxBefore>
                <TimeSlider
                    aria-label="time-indicator"
                    size="small"
                    value={replayTime ?? replayEndTime}
                    min={earliestScore}
                    step={1}
                    max={replayEndTime}
                    onChange={(_, value) => doSetTime(value as Epoch)}
                />
                <BoxAfter>
                    {replayTime ? <TinyText>+{formatDuration(replayTime - earliestScore)}</TinyText> : <TinyText sx={{opacity: 1}}>{t('connection.end')}</TinyText>}
                    <TinyText>+{formatDuration(replayEndTime - earliestScore)}</TinyText>
                </BoxAfter>
            </Widget>
        </SliderContainer>
    );
}

export default function ViewPage(props) {
    const [store] = useState(createViewStore);
    const {t} = useTranslation('common');

    return (
        <Provider store={store}>
            <MeasureContext>
                <Head>
                    <title>{t('app.viewer_title')}</title>
                </Head>
                <ViewPageInner options={props.options} setOptions={props.setOptions} />
            </MeasureContext>
        </Provider>
    );
}

function ViewPageInner({options, setOptions}: {options: OptionsType; setOptions: Function}) {
    const dispatch = useDispatch();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const {t} = useTranslation('common');

    const [flights, setFlights] = useState<LoadedFlight[]>([]);
    const [taskBuilt, setTaskBuilt] = useState(false);
    const [processing, setProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedCompno, setSelectedCompno] = useState<Compno | undefined>(undefined);
    const [replayTime, setReplayTime] = useState<Epoch | undefined>(undefined);
    const [taskOpen, setTaskOpen] = useState(false);

    // Handicaps stored in localStorage, keyed by compno
    const [handicaps, setHandicaps] = useState<Record<string, number>>(() => {
        try {
            const stored = localStorage.getItem('viewerHandicaps');
            return stored ? JSON.parse(stored) : {};
        } catch {
            return {};
        }
    });
    const handicapsRef = useRef(handicaps);

    // Override options to disable weather radar (no live data in viewer)
    const viewOptions = useMemo(() => (options ? {...options, rainRadar: false} : options), [options]);

    const [viewport, setViewport] = useState({
        latitude: 52,
        longitude: -1,
        zoom: 8.5,
        minZoom: 6.5,
        maxZoom: 14.5,
        bearing: 0,
        minPitch: 0,
        maxPitch: 80,
        pitch: !options?.map2d ? 70 : 0
    });

    const availableScores = useSelector(selectAvailableScoreTimes);
    const allScores = useSelector((state) => selectAllScores(state, replayTime));
    const task = useSelector((state) => selectTask(state, VC));

    const taskRef = useRef<any>(null);

    // Build synthetic pilots data for PilotList
    const pilots: API_ClassName_Pilots = useMemo(() => {
        const p: API_ClassName_Pilots = {} as API_ClassName_Pilots;
        for (const f of flights) {
            p[f.compno] = {
                class: VC,
                compno: f.compno,
                name: f.pilotName || f.fileName,
                gliderType: f.gliderType || '',
                handicap: handicaps[f.compno] ?? 100,
                country: '',
                image: '',
                forceTP: 0,
                dataFromScoring: 'Y',
                scoredStatus: 'L' as any,
                utcStart: 0 as Epoch,
                utcFinish: 0 as Epoch,
                distance: 0 as DistanceKM,
                speed: 0 as SpeedKPH
            } as API_ClassName_Pilots_PilotDetail;
        }
        return p;
    }, [flights, handicaps]);

    const processFiles = useCallback(
        async (fileList: FileList) => {
            setProcessing(true);
            setError(null);

            const newFlights: LoadedFlight[] = [];
            let runningEarliest = availableScores.earliestScore;
            let runningLatest = availableScores.latestScore;

            try {
                for (const file of Array.from(fileList)) {
                    const text = await file.text();
                    const igcData = parseIGC(text);

                    if (!igcData.fixes.length) {
                        setError(t('viewer.no_fixes', {file: file.name}));
                        continue;
                    }

                    const compno = igcData.pilot.compno || (file.name.replace(/\.igc$/i, '').substring(0, 6) as Compno);
                    igcData.pilot.compno = compno;
                    for (const fix of igcData.fixes) {
                        fix.c = compno;
                    }

                    if (!taskBuilt && !taskRef.current && igcData.taskDeclaration) {
                        const result = buildTask(igcData);
                        if (result) {
                            taskRef.current = result.task;
                            setReferenceDate(igcData.date.epochBase);

                            const earliest = igcData.fixes[0].t;
                            const latest = igcData.fixes[igcData.fixes.length - 1].t;
                            runningEarliest = Math.min(runningEarliest, earliest) as Epoch;
                            runningLatest = Math.max(runningLatest, latest) as Epoch;
                            dispatchClass(dispatch, runningEarliest, runningLatest);
                            dispatchTask(dispatch, result.task, result.geoJSON);
                            setTaskBuilt(true);

                            setViewport((v) => ({
                                ...v,
                                latitude: result.task.legs[0].nlat,
                                longitude: result.task.legs[0].nlng
                            }));
                            if (setOptions && options) {
                                setOptions({...options, zoomTask: true});
                            }
                        }
                    }

                    if (taskRef.current) {
                        const h = handicapsRef.current[compno] ?? 100;
                        const anyHandicapped = Object.values(handicapsRef.current).some((v) => v !== 100);
                        taskRef.current.rules.handicapped = anyHandicapped;
                        taskRef.current.details.handicapped = anyHandicapped ? 'Y' : 'N';

                        const {scores: allScores, stats} = await scoreIGCFlight(
                            taskRef.current,
                            igcData.fixes,
                            compno,
                            h,
                            0 as Epoch
                        );

                        // Find the earliest start time from scores and drop pre-start fixes from track display
                        const earliestStart = allScores.reduce((min, s) => (s.utcStart && s.utcStart < min ? s.utcStart : min), Infinity) as Epoch;
                        const trackFixes = earliestStart < Infinity ? igcData.fixes.filter((f) => f.t >= earliestStart - 30) : igcData.fixes;

                        dispatchTrack(dispatch, compno, igcData.pilot.name, trackFixes);
                        if (allScores.length) {
                            dispatchScores(dispatch, allScores);
                        }
                        dispatchPilotStats(dispatch, compno, stats);

                        // Use full fix range (not clipped) for the time slider
                        runningEarliest = Math.min(runningEarliest, igcData.fixes[0].t) as Epoch;
                        runningLatest = Math.max(runningLatest, igcData.fixes[igcData.fixes.length - 1].t) as Epoch;
                        dispatchTimeRange(dispatch, runningEarliest, runningLatest);
                    }

                    newFlights.push({
                        compno,
                        pilotName: igcData.pilot.name,
                        gliderType: igcData.pilot.gliderType,
                        fileName: file.name,
                        fixes: igcData.fixes.length,
                        igcData
                    });
                }

                setFlights((prev) => [...prev, ...newFlights]);

                if (!selectedCompno && newFlights.length > 0) {
                    setSelectedCompno(newFlights[0].compno);
                }
            } catch (e) {
                setError(e instanceof Error ? e.message : t('viewer.error_processing'));
                console.error(e);
            } finally {
                setProcessing(false);
            }
        },
        [dispatch, taskBuilt, selectedCompno, availableScores, options, setOptions, t]
    );

    const handleFileInput = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            if (e.target.files?.length) {
                processFiles(e.target.files);
                e.target.value = '';
            }
        },
        [processFiles]
    );

    const handleDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            if (e.dataTransfer.files?.length) {
                processFiles(e.dataTransfer.files);
            }
        },
        [processFiles]
    );

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
    }, []);

    const setCompno = useCallback(
        (cn) => {
            setSelectedCompno(cn);
            // Selecting a pilot re-engages follow/orientation after a manual pan.
            if (cn && options?.viewSuspended) setOptions({...options, viewSuspended: false});
        },
        [setSelectedCompno, options, setOptions]
    );

    const handleReset = useCallback(() => {
        setFlights([]);
        setTaskBuilt(false);
        taskRef.current = null;
        setSelectedCompno(undefined);
        setReplayTime(undefined);
        setError(null);
        dispatchClass(dispatch, Infinity as Epoch, 0 as Epoch, true);
    }, [dispatch]);

    const handleRescore = useCallback(async () => {
        if (!taskRef.current || flights.length === 0) return;

        const anyHandicapped = Object.values(handicapsRef.current).some((v) => v !== 100);
        taskRef.current.rules.handicapped = anyHandicapped;
        taskRef.current.details.handicapped = anyHandicapped ? 'Y' : 'N';

        setProcessing(true);
        setError(null);
        try {
            for (const flight of flights) {
                const h = handicapsRef.current[flight.compno] ?? 100;
                const {scores, stats} = await scoreIGCFlight(taskRef.current, flight.igcData.fixes, flight.compno, h, 0 as Epoch);
                const earliestStart = scores.reduce((min, s) => (s.utcStart && s.utcStart < min ? s.utcStart : min), Infinity) as Epoch;
                const trackFixes = earliestStart < Infinity ? flight.igcData.fixes.filter((f) => f.t >= earliestStart - 30) : flight.igcData.fixes;
                dispatchTrack(dispatch, flight.compno, flight.pilotName, trackFixes);
                if (scores.length) {
                    dispatchScores(dispatch, scores);
                }
                dispatchPilotStats(dispatch, flight.compno, stats);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : t('viewer.error_rescoring'));
            console.error(e);
        } finally {
            setProcessing(false);
        }
    }, [dispatch, flights, t]);

    const handleSetHandicap = useCallback((compno: Compno, handicap: number) => {
        setHandicaps((prev) => {
            const next = {...prev};
            if (handicap === 100) {
                delete next[compno];
            } else {
                next[compno] = handicap;
            }
            handicapsRef.current = next;
            if (Object.keys(next).length > 0) {
                localStorage.setItem('viewerHandicaps', JSON.stringify(next));
            } else {
                localStorage.removeItem('viewerHandicaps');
            }
            return next;
        });
    }, []);

    // Rescore all flights when handicaps change
    const handicapsInitial = useRef(true);
    useEffect(() => {
        if (handicapsInitial.current) {
            handicapsInitial.current = false;
            return;
        }
        handleRescore();
    }, [handicaps, handleRescore]);

    const fitBounds = useCallback(() => {
        if (options) {
            setOptions({...options, zoomTask: true});
        }
    }, [options, setOptions]);

    const hasFlights = flights.length > 0;
    const hasPilots = Object.keys(pilots).length > 0;

    if (!options) {
        return (
            <div className="loading">
                <div className="loadinginner" />
            </div>
        );
    }

    return (
        <>
            <input ref={fileInputRef} type="file" multiple accept=".igc" onChange={handleFileInput} style={{display: 'none'}} />

            {!hasFlights ? (
                <div
                    className="resizingContainer"
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    style={{display: 'flex', justifyContent: 'center', alignItems: 'center', flexDirection: 'column', width: '100%', height: '100vh', cursor: 'pointer'}}
                    onClick={() => fileInputRef.current?.click()}
                >
                    <FontAwesomeIcon icon={faFileArrowUp} size="3x" style={{opacity: 0.3, marginBottom: 16}} />
                    <p style={{fontSize: '1.2rem', opacity: 0.6}}>{t('viewer.drop_or_browse')}</p>
                    {processing && <p>{t('viewer.processing')}</p>}
                    {error && <p style={{color: 'red'}}>{error}</p>}
                </div>
            ) : (
                <div className="resizingContainer" onDrop={handleDrop} onDragOver={handleDragOver}>
                    <div className="resizingMap">
                        <MApp
                            key="map"
                            vc={VC}
                            setSelectedCompno={setCompno}
                            options={viewOptions}
                            setOptions={setOptions}
                            tz={TZ_DEFAULT}
                            replayTime={replayTime}
                            setReplayTime={setReplayTime}
                            viewport={viewport}
                            setViewport={setViewport}
                            selectedCompno={selectedCompno}
                            selectedHandicap={selectedCompno ? (handicaps[selectedCompno] ?? 100) : 100}
                            status={t('viewer.flights_loaded', {count: flights.length})}
                        />
                    </div>
                    <aside className="sidepanel" key="results">
                        <div className="sidepanel-header">
                            <FontAwesomeIcon icon={faPlane} />
                            <div className="sidepanel-title">
                                <div className="sidepanel-comp-name">{t('app.viewer_title')}</div>
                                <div className="sidepanel-comp-dates">{t('viewer.flights_loaded', {count: flights.length})}</div>
                            </div>
                        </div>
                        <div className="sidepanel-tools">
                            <Options options={viewOptions} setOptions={setOptions} multipleClasses={false} />
                        </div>
                        <div className="sidepanel-fixed-head">
                            {error && (
                                <div className="sidepanel-section" style={{color: 'red'}}>
                                    {error}
                                </div>
                            )}
                            {processing && <div className="sidepanel-section">{t('viewer.processing_files')}</div>}
                            {task && (
                                <div className="sidepanel-section">
                                    <h5 className="task-heading">
                                        <button title={t('task.zoom_to_task')} onClick={fitBounds as any}>
                                            <FontAwesomeIcon icon={faMagnifyingGlassLocation} />
                                        </button>
                                        <span className="task-title">
                                            {task.rules.aat
                                                ? task.details.duration?.substring(1, 5) !== '0:00'
                                                    ? t('task.aat_with_duration', {duration: task.details.duration?.substring(1, 5)})
                                                    : t('task.aat')
                                                : t('task.speed_with_distance', {distance: task.details.distance})}
                                        </span>
                                        <button onClick={() => setTaskOpen(!taskOpen)} title={taskOpen ? t('task.hide_details') : t('task.show_details')} aria-controls="view-task-collapse" aria-expanded={taskOpen}>
                                            <FontAwesomeIcon icon={taskOpen ? faCaretUp : faCaretDown} />
                                        </button>
                                    </h5>
                                    {taskOpen ? (
                                        <div id="view-task-collapse">
                                            <table className="legs-mini" style={{marginBottom: 0}}>
                                                <thead>
                                                    <tr>
                                                        <td colSpan={2}>{t('task.turnpoint')}</td>
                                                        <td>{t('task.bearing')}</td>
                                                        <td>{t('task.leg_length')}</td>
                                                        <td>{t('task.tp_radius')}</td>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {task.legs.map((leg) => (
                                                        <tr key={leg.legno}>
                                                            <td>
                                                                {leg.legno}:{leg.ntrigraph}
                                                            </td>
                                                            <td>{leg.name}</td>
                                                            <td>{leg.legno !== 0 ? leg.bearing + String.fromCharCode(176) : ''}</td>
                                                            <td>{leg.legno !== 0 ? Math.round(leg.length * 10) / 10 + ' km' : ''}</td>
                                                            <td>{leg.r1 !== 0 ? Math.round(leg.r1 * 10) / 10 + ' km' : ''}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    ) : null}
                                </div>
                            )}
                        </div>
                        <div className="sidepanel-body">
                            {hasPilots && (
                                <div className="sidepanel-section">
                                    <PilotList
                                        key="pilotList"
                                        pilots={pilots}
                                        selectedPilot={selectedCompno}
                                        setSelectedCompno={setCompno}
                                        now={replayTime}
                                        live={false}
                                        tz={TZ_DEFAULT}
                                        options={viewOptions}
                                        sortOrder={getValidSortOrder(viewOptions.sortKey ?? 'auto', Object.keys(handicaps).length > 0)}
                                    />
                                </div>
                            )}
                            {selectedCompno && pilots[selectedCompno] ? (
                                <div className="sidepanel-section">
                                    <Details compno={selectedCompno} pilot={pilots[selectedCompno]} units={viewOptions.units} tz={TZ_DEFAULT} replayTime={replayTime} onEditHandicap={handleSetHandicap} />
                                </div>
                            ) : null}
                        </div>
                        <div className="sidepanel-footer" style={{display: 'flex', justifyContent: 'center', gap: '16px', flexWrap: 'wrap'}}>
                            <span style={{cursor: 'pointer', opacity: 0.7}} onClick={() => fileInputRef.current?.click()}>
                                <FontAwesomeIcon icon={faFileArrowUp} /> {t('viewer.add_more')}
                            </span>
                            <span style={{cursor: processing ? 'default' : 'pointer', opacity: processing ? 0.3 : 0.7}} onClick={processing ? undefined : handleRescore} title={t('viewer.rescore_title')}>
                                <FontAwesomeIcon icon={faArrowsRotate} /> {t('viewer.rescore')}
                            </span>
                            <span style={{cursor: 'pointer', opacity: 0.7}} onClick={handleReset} title={t('viewer.reset_title')}>
                                <FontAwesomeIcon icon={faRotateLeft} /> {t('viewer.reset')}
                            </span>
                            {allScores && Object.keys(allScores).length > 0 && (
                                <span
                                    style={{cursor: 'pointer', opacity: 0.7}}
                                    onClick={() => {
                                        const dump = Object.entries(allScores).reduce((acc, [compno, s]: [string, any]) => {
                                            acc[compno] = s;
                                            return acc;
                                        }, {});
                                        navigator.clipboard.writeText(JSON.stringify(dump, null, 2));
                                    }}
                                    title={t('viewer.copy_scores_title')}
                                >
                                    <FontAwesomeIcon icon={faCopy} /> {t('viewer.copy_scores')}
                                </span>
                            )}
                        </div>
                    </aside>
                    <div className="playbackbar">
                        <ViewPlaybackControls //
                            {...availableScores}
                            replayTime={replayTime}
                            setReplayTime={setReplayTime}
                            tz={TZ_DEFAULT}
                        />
                    </div>
                </div>
            )}
        </>
    );
}
