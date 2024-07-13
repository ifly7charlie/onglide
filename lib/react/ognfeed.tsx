//
// This is responsible for creating and displaying the task map on the screen
//
// It loads GeoJSON from the next.js server API and renders it on the screen
//
// It will also expose the helper functions required to update the screen
//

import {useState, useMemo, useCallback, useEffect, memo} from 'react';
import {useRouter} from 'next/router';

import {usePilots} from './loaders';

import {Nbsp} from './htmlhelper';

import useWebSocket from 'react-use-websocket';

import {reduce as _reduce, forEach as _foreach, cloneDeep as _cloneDeep, find as _find, map as _map, isEqual as _isEqual, sortedIndex as _sortedIndex} from 'lodash';

import type {Options, Epoch, TZ, Compno, ClassName, Datecode} from '../types';

import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {solid} from '@fortawesome/fontawesome-svg-core/import.macro';
//import {faLinkSlash, faSpinner} from '@fortawesome/free-solid-svg-icons';

import {PilotList, Details} from './pilotlist';
import {TaskDetails} from './taskdetails';
import {OptionalDurationMM} from './optional';

import Sponsors from './sponsors';

import {proposedUrl} from './fixupUrls';

import {useWebsocketDecoder} from './useWebsocketDecoder';

import PlaybackControls from './playbackcontrols';

import dynamic from 'next/dynamic';
import {selectAvailableScoreTimes} from '../redux/nowSlice';
import {useSelector, useDispatch} from '../redux';
import {online, offline} from '../redux/nowSlice';

const MApp = dynamic(() => import('./deckgl').then((mod) => mod), {
    ssr: false,
    loading: () => (
        <div style={{width: '100vw', marginTop: '20vh', position: 'absolute'}}>
            <div style={{display: 'block', margin: 'auto', width: '100px'}}>
                <img width="100" height="100" src="https://ognproject.wdfiles.com/local--files/logos/ogn-logo-150x150.png" alt="OGN Network" title="OGN Network" />
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
        vc,
        datecode,
        tz,
        selectedCompno,
        setSelectedCompno,
        viewport,
        setViewport,
        options,
        setOptions,
        handicapped,
        notes
    }: //
    {
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
        notes: string;
    }) {
        const {pilots, isPLoading} = usePilots(vc);
        const [socketUrl, setSocketUrl] = useState(proposedUrl(vc, datecode)); //url for the socket
        const [wsStatus, setWsStatus] = useState<WsStatus>({listeners: 1, airborne: 0, timeStamp: 0, at: 0 as Epoch, state: 'connecting'});
        const [replayTime, setReplayTime] = useState<Epoch | undefined>(undefined);
        const [follow, setFollow] = useState(false);
        const router = useRouter();

        const mergeWsStatus = useCallback(
            (state: any) => {
                console.log(new Date().toISOString(), 'WS:', state);
                setWsStatus({...wsStatus, ...state});
            },
            [wsStatus, setWsStatus]
        );

        const {decoder} = useWebsocketDecoder({mergeWsStatus, className: vc, datecode});
        const dispatch = useDispatch();

        //        const now = useSelector(selectNow);
        const availableScores = useSelector(selectAvailableScoreTimes);

        // Keep track of online/offline status of the page
        //        const [online] = useState(navigator.onLine);

        /*        useEffect(() => {
            console.log('VC URL EFFECT', socketUrl, vc, datecode);
            if (socketUrl != proposedUrl(vc, datecode)) {
                setSocketUrl(proposedUrl(vc, datecode));
            }
        }, [vc, datecode, !!socketUrl]);
*/
        // We are using a webSocket to update our data here
        const {sendMessage} = useWebSocket(socketUrl, {
            reconnectAttempts: 15,
            reconnectInterval: (lastAttemptNumber: number) => {
                mergeWsStatus({retry: lastAttemptNumber + 1});
                return (1 << Math.max(lastAttemptNumber, 4)) * 1000 + Math.random() * 1200;
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
                    console.log('reloading', currentReloadCount, (1 << currentReloadCount) * 1000);
                    const newParams = {
                        query: {...router.query, reloaded: currentReloadCount + 1}
                    };
                    setTimeout(() => router.replace(newParams), (1 << currentReloadCount) * 1000);
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
                timeout: 30_000,
                interval: 13_000
            }
        });

        // Do we have a loaded set of details?
        const valid = !isPLoading && pilots && Object.keys(pilots).length > 0;

        const connectionStatus = useMemo(() => {
            const connectionStatusO = {
                connecting: ['Connecting to live feed...', <FontAwesomeIcon icon={solid('spinner')} spin />],
                retry: (wsStatus.retry ?? 0) < 4 && wsStatus.at ? null : [(wsStatus.at ? 'Rec' : 'C') + 'onnecting to live feed...', <FontAwesomeIcon icon={solid('spinner')} spin />],
                closed: ['Connection to tracking is closed, please reload to reconnect', <FontAwesomeIcon icon={solid('link-slash')} />]
            }[wsStatus.state ?? 'open'];

            console.log('last timestamp on status change', wsStatus.at, connectionStatusO?.[0]);

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
        }, [wsStatus.state, wsStatus.retry]);

        const setCompno = useCallback(
            (cn) => {
                setSelectedCompno(cn);
                if (cn && pilots && pilots[cn]) {
                    console.log('setFollow,setCompno');
                    setFollow(true);
                }
            },
            [setSelectedCompno, pilots]
        );

        // Cache the calculated times and only refresh every 60 seconds
        const status = useMemo(() => {
            return (
                (wsStatus?.at ? 'Updated at ' + formatTimes(wsStatus.at, tz) + ' | ' : '') + //
                ` <a href='#' title='number of viewers'>${wsStatus.listeners} 👥</a> | <a href='#' title='number of planes currently tracked'>${wsStatus.airborne} ✈️  </a>`
            );
        }, [Math.trunc(wsStatus.at / 30), wsStatus.listeners, wsStatus.airborne, vc]);

        // Scale map to fit the bounds
        const fitBounds = useCallback(() => {
            setOptions({...options, zoomTask: true});
        }, [vc, options]);

        // Send the options to the server so we can keep an eye on what settings are
        // used by default, we don't record any identifiers. This is to try and work
        // around safari terminating websocket so frequently
        useEffect(() => {
            sendMessage(JSON.stringify({compno: selectedCompno ?? 'none', options}));
        }, [options, selectedCompno, sendMessage]);

        return (
            <>
                <div className={'resizingMap'}>
                    <MApp //
                        key="map"
                        vc={vc}
                        follow={follow}
                        setFollow={setFollow}
                        setSelectedCompno={setCompno}
                        options={options}
                        setOptions={setOptions}
                        tz={tz}
                        replayTime={replayTime}
                        viewport={viewport}
                        setViewport={setViewport}
                        selectedCompno={selectedCompno}
                        status={status}
                    />
                </div>
                <div className="resultsOverlay" key="results">
                    {connectionStatus}
                    <div className="resultsUnderlay">
                        {notes && notes != '' && (
                            <>
                                <br />
                                <span style={{clear: 'both', color: 'red'}}>{notes}</span>
                                <br />
                            </>
                        )}
                        <TaskDetails vc={vc} fitBounds={fitBounds} />
                        {valid ? (
                            <PilotList
                                key="pilotList"
                                pilots={pilots}
                                selectedPilot={selectedCompno}
                                setSelectedCompno={setCompno}
                                now={replayTime}
                                tz={tz}
                                options={options}
                                setOptions={setOptions}
                                handicapped={handicapped}
                            />
                        ) : null}
                        {valid ? (
                            <PlaybackControls //
                                className={vc}
                                datecode={datecode}
                                firstStart={availableScores.earliestScore}
                                replayTime={replayTime}
                                setReplayTime={setReplayTime}
                                tz={tz}
                            />
                        ) : null}
                    </div>
                </div>
                {selectedCompno ? ( //
                    <Details compno={selectedCompno} pilot={pilots[selectedCompno]} units={options.units} tz={tz} replayTime={replayTime} />
                ) : (
                    <Sponsors at={wsStatus.at} />
                )}
            </>
        );
    },
    // Memo comparison, skip all the functions
    (o, n) =>
        o.selectedCompno === n.selectedCompno && //
        o.vc === n.vc &&
        o.datecode == n.datecode &&
        _isEqual(o.viewport, n.viewport) &&
        _isEqual(o.options, n.options) &&
        o.notes === n.notes &&
        o.handicapped === n.handicapped
    //    function OgnFeed({vc, datecode, tz, selectedCompno, setSelectedCompno, viewport, setViewport, options, setOptions, measureFeatures, handicapped, notes}) {
);

function formatTimes(t, tz: TZ) {
    // Figure out what the local language is for international date strings
    const lang = navigator.languages != undefined ? navigator.languages[0] : navigator.language;

    const competitionDelay = process.env.NEXT_PUBLIC_COMPETITION_DELAY
        ? `<a href="#" title="Tracking is officially delayed for this competition" className="tooltipicon">
                <span style={{color: 'grey'}}>
                 &nbsp;+&nbsp;↺&nbsp;${OptionalDurationMM('', parseInt(process.env.NEXT_PUBLIC_COMPETITION_DELAY || '0') as Epoch, 'm')}
            </span>
          </a>`
        : '';

    // And then produce a string to display it locally
    const dt = new Date(t * 1000);
    const dtl = !process.env.NEXT_PUBLIC_COMPETITION_DELAY ? dt : new Date((t + parseInt(process.env.NEXT_PUBLIC_COMPETITION_DELAY || '0')) * 1000);
    return (
        `<a href='#' title='competition time'>${dt.toLocaleTimeString('uk', {timeZone: tz, hour: '2-digit', minute: '2-digit'})} ${competitionDelay} ✈️ </a>` + //
        `<a href='#' title='your time'>${dtl.toLocaleTimeString(lang, {hour: '2-digit', minute: '2-digit'})} ⌚️</a>`
    );
}
