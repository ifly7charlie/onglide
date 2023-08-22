//
// This is responsible for creating and displaying the task map on the screen
//
// It loads GeoJSON from the next.js server API and renders it on the screen
//
// It will also expose the helper functions required to update the screen
//

import {useState, useMemo, useRef, useCallback} from 'react';

import {usePilots, Spinner} from './loaders';

import {Nbsp, TooltipIcon} from './htmlhelper';

import useWebSocket, {ReadyState} from 'react-use-websocket';

import {reduce as _reduce, forEach as _foreach, cloneDeep as _cloneDeep, find as _find, map as _map} from 'lodash';

import {Epoch, Compno, TrackData, ScoreData, SelectedPilotDetails, PilotScoreDisplay, DeckData} from '../types';
import {mergePoint, pruneStartline, updateVarioFromDeck} from '../flightprocessing/incremental';
import {assembleLabeledLine} from './distanceLine';

import {faLinkSlash, faSpinner} from '@fortawesome/free-solid-svg-icons';

import Alert from 'react-bootstrap/Alert';
import Button from 'react-bootstrap/Button';

import {PilotList, Details} from './pilotlist';
import {TaskDetails} from './taskdetails';
import {OptionalDurationMM} from './optional';

import {gapLength} from '../constants';
import {PilotPosition, OnglideWebSocketMessage} from '../protobuf/onglide';
import Sponsors from './sponsors';

import dynamic from 'next/dynamic';
const MApp = dynamic(() => import('./deckgl').then((mod) => mod), {
    ssr: false,
    loading: () => (
        <div style={{width: '100vw', marginTop: '20vh', position: 'absolute'}}>
            <div style={{display: 'block', margin: 'auto', width: '100px'}}>
                <img width="100" height="100" src="http://ognproject.wdfiles.com/local--files/logos/ogn-logo-150x150.png" alt="OGN Network" title="OGN Network" />
            </div>
        </div>
    )
});

//let mutateTimer = 0;
const httpsTest = new RegExp(/^https/i, 'i');

function proposedUrl(vc, datecode) {
    const hn = process.env.NEXT_PUBLIC_WEBSOCKET_HOST || window.location.host;
    if (process.env.NEXT_PUBLIC_WEBSOCKET_PREFIX) {
        return process.env.NEXT_PUBLIC_WEBSOCKET_PREFIX + hn + '/' + (vc + datecode).toUpperCase();
    }
    return (httpsTest.test(window.location.protocol) || httpsTest.test(process.env.NEXT_PUBLIC_WEBSOCKET_HOST) ? 'wss://' : 'ws://') + hn + '/' + (vc + datecode).toUpperCase();
}

export function OgnFeed({vc, datecode, tz, selectedCompno, setSelectedCompno, viewport, setViewport, options, setOptions, measureFeatures, handicapped, notes}) {
    const [trackData, setTrackData] = useState<TrackData>({});
    const [pilotScores, setPilotScores] = useState<ScoreData>({});
    const {pilots, isPLoading} = usePilots(vc);
    const [socketUrl, setSocketUrl] = useState(proposedUrl(vc, datecode)); //url for the socket
    const [wsStatus, setWsStatus] = useState({listeners: 1, airborne: 0, timeStamp: 0, at: 0});
    const [follow, setFollow] = useState(false);
    const [attempt, setAttempt] = useState(0);

    // For remote updating of the map
    const mapRef = useRef(null);

    // Keep track of online/offline status of the page
    const [online] = useState(navigator.onLine);

    // We are using a webSocket to update our data here
    const {lastMessage, readyState, sendMessage} = useWebSocket(socketUrl, {
        reconnectAttempts: 40,
        reconnectInterval: 16000,
        //        onReconnectStop: () => {
        //            setAttempt(-100);
        //        },
        retryOnError: true
    });

    // Do we have a loaded set of details?
    const valid = !isPLoading && pilots && Object.keys(pilots).length > 0 && mapRef && mapRef.current && mapRef.current.getMap();

    // Have we had a websocket message, if it hasn't changed then ignore it!
    let updateMessage = null;
    if (lastMessage) {
        if (wsStatus.timeStamp != lastMessage.timeStamp) {
            wsStatus.timeStamp = lastMessage.timeStamp;
            decodeWebsocketMessage(lastMessage.data, trackData, setTrackData, pilotScores, setPilotScores, wsStatus, setWsStatus, selectedCompno, follow);
        }
    }

    const connectionStatus = useMemo(() => {
        const connectionStatusO = {
            [ReadyState.CONNECTING]: ['Connecting to tracking..', faSpinner],
            [ReadyState.CLOSING]: ['Closing tracking connection', faSpinner],
            [ReadyState.CLOSED]: [`Connection to tracking is closed, ${attempt < Infinity ? 'please reload to reconnect' : 'retrying shortly'}`, faLinkSlash],
            [ReadyState.UNINSTANTIATED]: ['Messed Up', faSpinner]
        }[readyState];

        if (connectionStatusO) {
            setWsStatus({listeners: 1, airborne: 0, timeStamp: 0, at: 0}); // clear status will update eventually
            return (
                <div>
                    <TooltipIcon icon={connectionStatusO[1]} tooltip={connectionStatusO[0]} />
                    <Nbsp />
                    {connectionStatusO[0]}
                    <br style={{clear: 'both'}} />
                    <hr />
                </div>
            );
        }
        return null;
    }, [readyState, attempt]);

    if (socketUrl != proposedUrl(vc, datecode)) {
        setPilotScores({});
        setTrackData({});
        setSocketUrl(proposedUrl(vc, datecode));
    }

    const setCompno = useCallback(
        (cn) => {
            setSelectedCompno(cn);
            if (cn && pilots && pilots[cn]) {
                setFollow(true);
            }
        },
        [setSelectedCompno, pilots]
    );

    // And the pilot object
    const selectedPilotData: SelectedPilotDetails | null = useMemo(
        () =>
            pilots
                ? {
                      pilot: pilots[selectedCompno],
                      score: pilotScores[selectedCompno],
                      track: trackData[selectedCompno]
                  }
                : null,
        [pilots, selectedCompno]
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
    }, [vc]);

    return (
        <>
            <div className={'resizingMap'}>
                <MApp
                    key="map"
                    vc={vc}
                    follow={follow}
                    setFollow={setFollow}
                    selectedPilotData={selectedPilotData}
                    setSelectedCompno={setCompno}
                    mapRef={mapRef} //
                    pilots={pilots}
                    pilotScores={pilotScores}
                    options={options}
                    setOptions={setOptions}
                    tz={tz}
                    t={wsStatus.at as Epoch}
                    viewport={viewport}
                    setViewport={setViewport}
                    trackData={trackData}
                    selectedCompno={selectedCompno}
                    measureFeatures={measureFeatures}
                    status={status}
                />
            </div>
            <div className="resultsOverlay" key="results">
                <div className="resultsUnderlay">
                    {connectionStatus}
                    {notes && notes != '' && (
                        <>
                            <br />
                            <span style={{clear: 'both', color: 'red'}}>{notes}</span>
                            <br />
                        </>
                    )}
                    <TaskDetails vc={vc} fitBounds={fitBounds} />
                    {valid && (
                        <PilotList
                            key="pilotList"
                            pilots={pilots}
                            pilotScores={pilotScores} //
                            trackData={trackData}
                            selectedPilot={selectedCompno}
                            setSelectedCompno={setCompno}
                            now={wsStatus.at as Epoch}
                            tz={tz}
                            options={options}
                            handicapped={handicapped}
                        />
                    )}
                </div>
            </div>
            {selectedPilotData?.pilot ? <Details pilot={selectedPilotData?.pilot} score={selectedPilotData?.score} vario={selectedPilotData?.track?.vario} units={options.units} tz={tz} /> : <Sponsors at={wsStatus.at} />}
        </>
    );
}

function formatTimes(t, tz) {
    // Figure out what the local language is for international date strings
    const lang = navigator.languages != undefined ? navigator.languages[0] : navigator.language;

    let competitionDelay = process.env.NEXT_PUBLIC_COMPETITION_DELAY
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

function mergePointToPilot(point: PilotPosition, trackData: TrackData) {
    if (!point) {
        return;
    }
    // We need to do a deep clone for the change detection to work
    const compno = point.c;
    let cp = trackData?.[compno];

    // If we don't no the pilot we'll discard - this could mean we miss a point or
    // two when connecting but eliminates ghosts when changing channel
    if (!cp) {
        return;
    }

    // Merge into the geoJSON objects as needed
    mergePoint(point, cp, false);
    cp.deck?.dataPromiseResolve?.();
}

export function AlertDisconnected({mutatePilots, attempt}) {
    const [show, setShow] = useState(attempt);
    const [pending, setPending] = useState(attempt);

    if (show == attempt) {
        return (
            <Alert variant="danger" onClose={() => setShow(attempt + 1)} dismissible>
                <Alert.Heading>Disconnected</Alert.Heading>
                <p>Your streaming connection has been disconnected, you can reconnect or just look at the results without live tracking</p>
                <hr />
                <Button
                    variant="success"
                    onClick={() => {
                        mutatePilots();
                        setPending(attempt + 1);
                    }}
                >
                    Reconnect{pending == attempt + 1 ? <Spinner /> : null}
                </Button>
            </Alert>
        );
    }
    return null;
}

function decodeWebsocketMessage(data: Buffer, trackData: TrackData, setTrackData, pilotScores: ScoreData, setPilotScores, wsStatus, setWsStatus, selectedCompno: Compno, follow: boolean) {
    new Response(data).arrayBuffer().then((ab) => {
        const decoded = OnglideWebSocketMessage.decode(new Uint8Array(ab));
        // Merge in changed tracks
        if (decoded?.tracks) {
            setTrackData(
                _reduce(
                    decoded.tracks?.pilots,
                    (result, p, compno) => {
                        if (!result[compno]) {
                            result[compno] = {compno: compno};
                        }
                        const deck: DeckData = (result[compno].deck = {
                            compno: compno as Compno,
                            //                            indices: new Uint32Array(p.indices.slice().buffer),
                            positions: new Float32Array(p.positions.slice().buffer),
                            t: new Uint32Array(p.t.slice().buffer),
                            climbRate: new Int8Array(p.climbRate.slice().buffer),
                            //                            recentIndices: new Uint32Array(p.recentIndices.slice().buffer),
                            agl: new Int16Array(p.agl.slice().buffer),
                            posIndex: p.posIndex,
                            partial: p.partial
                            //                            segmentIndex: p.segmentIndex
                        });

                        console.log('create iterator:', compno);
                        deck.getData = getData(compno as Compno, deck, true);

                        //                        result[compno].colors = new Uint8Array(_map(result[compno].t, (_) => [Math.floor(Math.random() * 255), 128, 128]).flat());
                        if (pilotScores[compno]?.utcStart) {
                            pruneStartline(deck, pilotScores[compno].utcStart);
                        }
                        [result[compno].t, result[compno].vario] = updateVarioFromDeck(deck, result[compno].vario);
                        return result;
                    },
                    trackData
                )
            );
        }

        // If we have been sent scores then merge them in,
        // this will update what has changed so no need to send scores if they are unchanged since previous
        // message
        if (decoded?.scores) {
            setPilotScores(
                _reduce(
                    decoded.scores.pilots,
                    (result, p: PilotScoreDisplay, compno) => {
                        // Update the geoJSON with the scored trackline so we can easily display
                        // what the pilot has been scored for
                        delete p.minGeoJSON;
                        delete p.maxGeoJSON;
                        if (p.scoredPoints && p.scoredPoints.length > 3) {
                            p.scoredGeoJSON = assembleLabeledLine(p.scoredPoints);
                        }
                        if (p.minDistancePoints && p.minDistancePoints.length > 2) {
                            p.minGeoJSON = assembleLabeledLine(p.minDistancePoints);
                        }
                        if (p.maxDistancePoints && p.maxDistancePoints.length > 2) {
                            p.maxGeoJSON = assembleLabeledLine(p.maxDistancePoints);
                        }
                        if (p.taskGeoJSON) {
                            p.taskGeoJSON = JSON.parse(p.taskGeoJSON);
                        }

                        // Save into the pilot structure
                        result[compno] = p;
                        return result;
                    },
                    pilotScores
                )
            );
        }

        // Merge in any new position reports, one update for all
        if (decoded.positions) {
            _foreach(decoded.positions.positions, (p) => {
                mergePointToPilot(p, trackData);
            });
            setTrackData(trackData);
        }

        if (decoded.ka) {
            wsStatus = {...wsStatus, ...decoded.ka};
            setWsStatus(wsStatus);
        }

        if (decoded.t) {
            wsStatus = {...wsStatus, at: decoded.t};
            setWsStatus(wsStatus);
        }
    });
}

// Create an async iterable
async function* getData(compno: Compno, deck: DeckData, map2d: boolean) {
    let current = 0;
    console.log('starting iterator', compno, deck.posIndex);

    while (true) {
        // Wait for data
        await new Promise<void>((resolve) => {
            deck.dataPromiseResolve = resolve;
        });

        // And send a segment or some
        const newData = [];
        while (current < deck.posIndex) {
            const previous = current ? current - 1 : 0;

            // No gap, use previous point
            if (deck.t[current] - deck.t[previous] < gapLength) {
                newData.push({
                    p: [[...deck.positions.subarray(previous * 3, previous * 3 + 3)], [...deck.positions.subarray(current * 3, current * 3 + 3)]],
                    t: deck.t[current],
                    v: deck.climbRate[current],
                    g: deck.agl[current]
                });
            }
            // gap, use current point twice
            else {
                newData.push({
                    p: [[...deck.positions.subarray(current * 3, current * 3 + 3)], [...deck.positions.subarray(current * 3, current * 3 + 3)]],
                    t: deck.t[current],
                    v: deck.climbRate[current],
                    g: deck.agl[current]
                });
            }
            current++;
        }

        //        console.log(compno, newData);
        yield newData;
    }
}
