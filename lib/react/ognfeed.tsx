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
import {offline} from '../redux/nowSlice';

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
        //        const [socketUrl, setSocketUrl] = useState(proposedUrl(vc, datecode)); //url for the socket
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
        const valid = !isPLoading && pilots && Object.keys(pilots).length > 0;
        const connected = wsStatus.state == 'open' || (wsStatus.state == 'retry' && (wsStatus.retry ?? 0) < 16);

        const connectionStatus = useMemo(() => {
            const connectionStatusO = {
                connecting: ['Connecting to live feed...', <FontAwesomeIcon icon={solid('spinner')} spin />],
                retry: (wsStatus.retry ?? 0) < 16 ? null : ['Connecting to live feed...', <FontAwesomeIcon icon={solid('spinner')} spin />],
                closed: ['Connection to tracking is closed, please change the selected class to retry', <FontAwesomeIcon icon={solid('link-slash')} />]
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
            sendMessage(JSON.stringify({compno: selectedCompno ?? 'none', ...options, zoomTask: false, options2d: undefined, options3d: undefined, replay: !!replayTime}));
        }, [JSON.stringify({...options, zoomTask: false, options2d: undefined, options3d: undefined}), !!replayTime, selectedCompno, sendMessage]); //

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
                        setReplayTime={setReplayTime}
                        viewport={viewport}
                        setViewport={setViewport}
                        selectedCompno={selectedCompno}
                        status={status}
                    />
                </div>
                <div className="resultsOverlay" key="results">
                    <div className="resultsUnderlay">
                        {notes && notes != '' && (
                            <>
                                <span style={{clear: 'both', color: 'red'}}>{notes}</span>
                                <br />
                            </>
                        )}
                        <TaskDetails vc={vc} fitBounds={fitBounds} tz={tz} />
                        {connectionStatus}
                        {valid && connected ? (
                            <PilotList
                                key="pilotList"
                                pilots={pilots}
                                selectedPilot={selectedCompno}
                                setSelectedCompno={setCompno}
                                now={replayTime}
                                live={availableScores.live}
                                tz={tz}
                                options={options}
                                setOptions={setOptions}
                                handicapped={handicapped}
                            />
                        ) : null}
                    </div>
                </div>
                <div className="details" style={{paddingTop: '5px'}}>
                    {valid && connected && (replayTime || !selectedCompno) ? (
                        <PlaybackControls //
                            {...availableScores}
                            replayTime={replayTime}
                            setReplayTime={setReplayTime}
                            tz={tz}
                        />
                    ) : null}
                    {selectedCompno ? ( //
                        <Details compno={selectedCompno} pilot={pilots[selectedCompno]} units={options.units} tz={tz} replayTime={replayTime} />
                    ) : (
                        <Sponsors at={wsStatus.at} />
                    )}
                </div>
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
        `<a href='#' title='competition time'>${dt.toLocaleTimeString('uk', {timeZone: tz, hour: '2-digit', minute: '2-digit'})} ${competitionDelay} ✈️ </a> | ` + //
        `<a href='#' title='your time'>${dtl.toLocaleTimeString(lang, {hour: '2-digit', minute: '2-digit'})} ⌚️</a>`
    );
}
