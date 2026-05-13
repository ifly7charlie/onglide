//
// This is responsible for creating and displaying the task map on the screen
//
// It loads GeoJSON from the next.js server API and renders it on the screen
//
// It will also expose the helper functions required to update the screen
//

import {useState, useMemo, useCallback, useEffect, memo} from 'react';
import {useRouter} from 'next/router';
import Link from 'next/link';
import {useTranslation} from 'next-i18next/pages';

import {usePilots} from './loaders';

import {Nbsp} from './htmlhelper';

import useWebSocket from 'react-use-websocket';

import equal from 'fast-deep-equal';

import type {Options, Epoch, TZ, Compno, ClassName, Datecode} from '../types';

import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faLinkSlash, faSpinner, faCaretDown, faCaretUp} from '@fortawesome/free-solid-svg-icons';

import {PilotList, Details} from './pilotlist';
import {TaskDetails} from './taskdetails';
import {OptionalDurationMM} from './optional';
import {Sorting} from './sorting';
import {Options as OptionsPanel} from './options';
import {getValidSortOrder} from './pilot-sorting';

import Sponsors from './sponsors';

import {SidePanel, SidePanelClassTabs, compShortName} from './sidepanel';
import {LanguageSwitcher} from './language-switcher';
import {faGlobe} from '@fortawesome/free-solid-svg-icons';

function useIsMobile() {
    const [m, setM] = useState(false);
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const mq = window.matchMedia('(max-width: 991.98px)');
        const u = () => setM(mq.matches);
        u();
        mq.addEventListener('change', u);
        return () => mq.removeEventListener('change', u);
    }, []);
    return m;
}

import {proposedUrl} from './fixupUrls';

import {useWebsocketDecoder} from './useWebsocketDecoder';

import PlaybackControls from './playbackcontrols';

import dynamic from 'next/dynamic';
import {selectAvailableScoreTimes} from '../redux/nowSlice';
import {useSelector, useDispatch} from '../redux';
import {offline} from '../redux/nowSlice';
import {selectCompByCompid} from '../redux/competitionsSlice';

const MApp = dynamic(() => import('./deckgl').then((mod) => mod), {
    ssr: false,
    loading: () => (
        <div style={{width: '100vw', marginTop: '20vh', position: 'absolute'}}>
            <div style={{display: 'block', margin: 'auto', width: '100px'}}>
                <img width="100" height="68" src="/ognlogo.png" alt="OGN Network" title="OGN Network" />
            </div>
        </div>
    )
});

interface WsStatus {
    listeners: number;
    airborne: number;
    timeStamp: number; // websocket message timestamp
    at: Epoch; // competition time
    state: 'connecting' | 'open' | 'retry' | 'closed';
    retry?: number;
}

export const OgnFeed = memo(
    //
    function OgnFeed({
        comp,
        compid,
        vc,
        datecode,
        tz,
        selectedCompno,
        setSelectedCompno,
        viewport,
        setViewport,
        options,
        setOptions,
        handicapped
    }: //
    {
        comp: any;
        compid: string;
        vc: ClassName;
        datecode: Datecode;
        tz: TZ;
        selectedCompno: Compno;
        setSelectedCompno: Function;
        viewport: any;
        setViewport: Function;
        options: Options;
        setOptions: Function;
        handicapped: any;
    }) {
        const {pilots, isPLoading} = usePilots(vc);
        const {t} = useTranslation('common');
        //        const [socketUrl, setSocketUrl] = useState(proposedUrl(vc, datecode)); //url for the socket
        const [wsStatus, setWsStatus] = useState<WsStatus>({listeners: 1, airborne: 0, timeStamp: 0, at: 0 as Epoch, state: 'connecting'});
        const [replayTime, setReplayTime] = useState<Epoch | undefined>(undefined);
        const [follow, setFollow] = useState(false);
        const router = useRouter();

        const mergeWsStatus = useCallback(
            (state: any) => {
                setWsStatus({...wsStatus, ...state});
            },
            [wsStatus, setWsStatus]
        );

        const {decoder} = useWebsocketDecoder({mergeWsStatus, className: vc, datecode});
        const dispatch = useDispatch();

        //        const now = useSelector(selectNow);
        const availableScores = useSelector(selectAvailableScoreTimes);
        const compSummary = useSelector(selectCompByCompid(compid));
        const officialDelay = compSummary?.officialDelay ?? 0;

        // Keep track of online/offline status of the page
        //        const [online] = useState(navigator.onLine);

        const socketUrl = useMemo(() => proposedUrl(vc, datecode), [vc, datecode]);

        // We are using a webSocket to update our data here
        const {sendMessage} = useWebSocket(socketUrl, {
            reconnectAttempts: 40,
            reconnectInterval: (lastAttemptNumber: number) => {
                mergeWsStatus({retry: lastAttemptNumber + 1});
                return (lastAttemptNumber < 4 ? 0.75 : lastAttemptNumber < 15 ? 4 : lastAttemptNumber) * (1 + Math.random()) * 1000;
            },
            retryOnError: true,
            shouldReconnect: () => true,
            onOpen: (_a) => {
                mergeWsStatus({state: 'open', retry: 0});
            },
            filter: (_message) => false, // never pass a message to react, decode webSocket will do it if required
            onMessage: (lastMessage) => {
                if (lastMessage.data === 'reload') {
                    // Force a page reload
                    const currentReloadCount = parseInt((router.query?.reloaded as string) ?? '0');
                    if (currentReloadCount == 0) {
                        const newParams = {
                            query: {...router.query, reloaded: currentReloadCount + 1}
                        };
                        setTimeout(() => router.replace(newParams), 30000 * Math.random());
                    }
                } else {
                    decoder(lastMessage.data);
                }
            },
            onClose: (_a) => {
                dispatch(offline());
                mergeWsStatus({state: 'retry'});
            },
            onError: (a) => {
                wsStatus.state != 'closed' ? mergeWsStatus({state: 'retry'}) : null;
            },
            onReconnectStop: (_numAttempts) => mergeWsStatus({listeners: 0, airborne: 0, timeStamp: 0, at: 0 as Epoch, state: 'closed'}), // clear status as offline
            heartbeat: {
                message: () => JSON.stringify({v: document?.hidden ? 0 : 1}),
                timeout: 31000,
                interval: 10000
            }
        });

        // Do we have a loaded set of details?
        const pilotKeys = pilots ? Object.keys(pilots) : [];
        const valid = !isPLoading && pilotKeys.length > 0;
        const connected = wsStatus.state == 'open' || (wsStatus.state == 'retry' && (wsStatus.retry ?? 0) < 16);

        // If only a single pilot is available, treat them as implicitly
        // selected. The user-explicit `selectedCompno` still wins so
        // click-to-toggle behaviour is preserved when there are more.
        const effectiveSelectedCompno = (selectedCompno ?? (pilotKeys.length === 1 ? (pilotKeys[0] as Compno) : undefined)) as Compno;

        const connectionStatus = useMemo(() => {
            const connectionStatusO = {
                connecting: [t('connection.connecting'), <FontAwesomeIcon icon={faSpinner} spin />],
                retry: (wsStatus.retry ?? 0) < 16 ? null : [t('connection.connecting'), <FontAwesomeIcon icon={faSpinner} spin />],
                closed: [t('connection.closed'), <FontAwesomeIcon icon={faLinkSlash} />]
            }[wsStatus.state ?? 'open'];

            if (connectionStatusO) {
                return (
                    <div className={'connectionStatus'}>
                        {connectionStatusO[1]}
                        <Nbsp />
                        {connectionStatusO[0]}
                    </div>
                );
            }
            return null;
        }, [wsStatus.state, wsStatus.retry, t]);

        const setCompno = useCallback(
            (cn) => {
                setSelectedCompno(cn);
                if (cn && pilots && pilots[cn]) {
                    setFollow(true);
                }
            },
            [setSelectedCompno, pilots]
        );

        // Cache the calculated times and only refresh every 60 seconds
        const status = useMemo(() => {
            const lang = router.locale ?? 'en';
            return (
                (wsStatus?.at ? t('connection.updated_at', {time: formatTimes(wsStatus.at, tz, lang, officialDelay)}) + ' | ' : '') + //
                ` <a href='#' title='${t('connection.viewers')}'>${wsStatus.listeners} 👥</a> | <a href='#' title='${t('connection.tracked_planes')}'>${wsStatus.airborne} ✈️  </a>`
            );
        }, [Math.trunc(wsStatus.at / 30), wsStatus.listeners, wsStatus.airborne, vc, t, router.locale, officialDelay]);

        // Scale map to fit the bounds
        const fitBounds = useCallback(() => {
            setOptions({...options, zoomTask: true});
        }, [vc, options]);

        // Zoom to a specific turnpoint (clicked from the task leg list).
        const zoomToTurnpoint = useCallback(
            (lat: number, lng: number, radius?: number) => {
                setOptions({...options, zoomTurnpoint: {lat, lng, radius}});
            },
            [options]
        );

        // Send the options to the server so we can keep an eye on what settings are
        // used by default, we don't record any identifiers. This is to try and work
        // around safari terminating websocket so frequently
        useEffect(() => {
            sendMessage(JSON.stringify({compno: effectiveSelectedCompno ?? 'none', ...options, zoomTask: false, options2d: undefined, options3d: undefined, replay: !!replayTime}));
        }, [JSON.stringify({...options, zoomTask: false, options2d: undefined, options3d: undefined}), !!replayTime, effectiveSelectedCompno, sendMessage]); //

        const onClassChange = useCallback(
            (nextClass: string) => {
                setSelectedCompno(null);
                router.push('/' + compid + '?className=' + nextClass, undefined, {shallow: true}).then(() => setOptions({...options, zoomTask: true}));
            },
            [compid, options, router, setOptions, setSelectedCompno]
        );

        const isMobile = useIsMobile();
        const [drawerOpen, setDrawerOpen] = useState(false);

        const sortOrder = getValidSortOrder(options.sortKey ?? 'auto', handicapped);
        const setSort = useCallback(
            (key: any) => {
                setOptions(structuredClone({...options, sortKey: key}));
            },
            [options, setOptions]
        );

        const map = (
            <div className={'resizingMap'}>
                <MApp //
                    key="map"
                    comp={comp}
                    vc={vc}
                    follow={follow}
                    setFollow={setFollow}
                    setSelectedCompno={setCompno}
                    options={options}
                    setOptions={setOptions}
                    tz={tz}
                    replayTime={replayTime}
                    setReplayTime={setReplayTime}
                    viewport={viewport}
                    setViewport={setViewport}
                    selectedCompno={effectiveSelectedCompno}
                    selectedHandicap={effectiveSelectedCompno ? pilots?.[effectiveSelectedCompno]?.handicap : undefined}
                    status={status}
                />
            </div>
        );

        const playback = (
            <div className="playbackbar">
                {valid && connected ? (
                    <PlaybackControls //
                        {...availableScores}
                        replayTime={replayTime}
                        setReplayTime={setReplayTime}
                        tz={tz}
                    />
                ) : null}
            </div>
        );

        if (isMobile) {
            return (
                <>
                    {map}
                    <div className="mobile-top-strip">
                        <div className="mobile-strip-header">
                            <Link href="/" className="mobile-back" title={t('app.back_to_globe')} aria-label={t('app.back_to_globe')}>
                                <FontAwesomeIcon icon={faGlobe} />
                            </Link>
                            <div className="mobile-comp-name">{compShortName(comp)}</div>
                            <button
                                className="drawer-toggle"
                                onClick={() => setDrawerOpen((o) => !o)}
                                aria-expanded={drawerOpen}
                                title={drawerOpen ? t('drawer.hide_menu') : t('drawer.show_menu')}
                            >
                                <FontAwesomeIcon icon={drawerOpen ? faCaretUp : faCaretDown} />
                            </button>
                        </div>
                        {valid && connected ? (
                            <PilotList //
                                key="pilotList"
                                pilots={pilots}
                                selectedPilot={effectiveSelectedCompno}
                                setSelectedCompno={setCompno}
                                now={replayTime}
                                live={availableScores.live}
                                tz={tz}
                                options={options}
                                sortOrder={sortOrder}
                                horizontal
                            />
                        ) : (
                            <div className="mobile-strip-placeholder">{connectionStatus}</div>
                        )}
                    </div>
                    {drawerOpen ? (
                        <div className="mobile-drawer">
                            {(comp?.classes?.length ?? 0) > 1 ? (
                                <div className="drawer-group">
                                    <div className="drawer-label">{t('drawer.class')}</div>
                                    <SidePanelClassTabs comp={comp} vc={vc} onClassChange={onClassChange} />
                                </div>
                            ) : null}
                            <div className="drawer-group">
                                <div className="drawer-label">{t('drawer.display')}</div>
                                <div className="sidepanel-tools sidepanel-tools-row">
                                    <OptionsPanel options={options} setOptions={setOptions} multipleClasses={(comp?.classes?.length ?? 0) > 1} />
                                    <LanguageSwitcher className="drawer-lang" />
                                </div>
                            </div>
                            <div className="drawer-group">
                                <div className="drawer-label">{t('drawer.sort_by')}</div>
                                <div className="sidepanel-section">
                                    <Sorting setSort={setSort} sortOrder={sortOrder} handicapped={handicapped || false} />
                                </div>
                            </div>
                            {/* notes block disabled — DB column not currently populated; restore wiring once it is.
                            {notes && notes != '' && (
                                <div className="sidepanel-section" style={{color: 'red'}}>
                                    {notes}
                                </div>
                            )}
                            */}
                            <div className="drawer-group">
                                <div className="sidepanel-section">
                                    <TaskDetails compid={compid} vc={vc} fitBounds={fitBounds} zoomToTurnpoint={zoomToTurnpoint} tz={tz} replayTime={replayTime} defaultOpen />
                                    {connectionStatus}
                                </div>
                            </div>
                        </div>
                    ) : null}
                    {effectiveSelectedCompno && pilots?.[effectiveSelectedCompno] ? (
                        <div className="mobile-pilot-details">
                            <Details compno={effectiveSelectedCompno} pilot={pilots[effectiveSelectedCompno]} units={options.units} tz={tz} replayTime={replayTime} officialDelay={officialDelay} />
                        </div>
                    ) : null}
                    {playback}
                </>
            );
        }

        return (
            <>
                {map}
                <SidePanel //
                    comp={comp}
                    vc={vc}
                    onClassChange={onClassChange}
                    options={options}
                    setOptions={setOptions}
                    head={
                        <>
                            {/* notes block disabled — DB column not currently populated; restore wiring once it is.
                            {notes && notes != '' && (
                                <div className="sidepanel-section" style={{color: 'red'}}>
                                    {notes}
                                </div>
                            )}
                            */}
                            <div className="sidepanel-section">
                                <TaskDetails compid={compid} vc={vc} fitBounds={fitBounds} zoomToTurnpoint={zoomToTurnpoint} tz={tz} replayTime={replayTime} />
                                {connectionStatus}
                            </div>
                        </>
                    }
                    footer={
                        effectiveSelectedCompno && pilots?.[effectiveSelectedCompno] ? ( //
                            <Details compno={effectiveSelectedCompno} pilot={pilots[effectiveSelectedCompno]} units={options.units} tz={tz} replayTime={replayTime} officialDelay={officialDelay} />
                        ) : (
                            <Sponsors at={wsStatus.at} />
                        )
                    }
                >
                    {valid && connected ? (
                        <div className="sidepanel-section">
                            <Sorting setSort={setSort} sortOrder={sortOrder} handicapped={handicapped || false} />
                            <PilotList //
                                key="pilotList"
                                pilots={pilots}
                                selectedPilot={effectiveSelectedCompno}
                                setSelectedCompno={setCompno}
                                now={replayTime}
                                live={availableScores.live}
                                tz={tz}
                                options={options}
                                sortOrder={sortOrder}
                                vertical
                            />
                        </div>
                    ) : null}
                </SidePanel>
                {playback}
            </>
        );
    },
    // Memo comparison, skip all the functions
    (o, n) =>
        o.selectedCompno === n.selectedCompno && //
        o.vc === n.vc &&
        o.datecode == n.datecode &&
        equal(o.viewport, n.viewport) &&
        equal(o.options, n.options) &&
        o.handicapped === n.handicapped
);

function formatTimes(time: number, tz: TZ, lang: string, officialDelay: number) {
    const competitionDelay = officialDelay
        ? `<a href="#" title="Tracking is officially delayed for this competition" className="tooltipicon">
                <span style={{color: 'grey'}}>
                 &nbsp;+&nbsp;↺&nbsp;${OptionalDurationMM('', officialDelay as Epoch, 'm')}
            </span>
          </a>`
        : '';

    const dt = new Date(time * 1000);
    const dtl = !officialDelay ? dt : new Date((time + officialDelay) * 1000);
    return (
        `<a href='#' title='competition time'>${dt.toLocaleTimeString(lang, {timeZone: tz, hour: '2-digit', minute: '2-digit'})} ${competitionDelay} ✈️ </a> | ` + //
        `<a href='#' title='your time'>${dtl.toLocaleTimeString(lang, {hour: '2-digit', minute: '2-digit'})} ⌚️</a>`
    );
}
