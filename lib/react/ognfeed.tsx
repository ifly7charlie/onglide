//
// This is responsible for creating and displaying the task map on the screen
//
// It loads GeoJSON from the next.js server API and renders it on the screen
//
// It will also expose the helper functions required to update the screen
//

import {useState, useMemo, useRef, useCallback, useEffect, memo} from 'react';

import {usePilots, Spinner} from './loaders';

import {Nbsp, TooltipIcon} from './htmlhelper';

import useWebSocket, {ReadyState} from 'react-use-websocket';

import {reduce as _reduce, forEach as _foreach, cloneDeep as _cloneDeep, find as _find, map as _map, isEqual as _isEqual, sortedIndex as _sortedIndex} from 'lodash';

import {Epoch, TZ, Compno, ClassName, Datecode, TrackData, ScoreData, SelectedPilotDetails, PilotScoreDisplay, DeckData} from '../types';
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
import {UseMeasure} from './measure';

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
const httpsTest = new RegExp(/^(https|wss)/i, 'i');

function proposedUrl(vc: ClassName, datecode: Datecode) {
    const hn = process.env.NEXT_PUBLIC_WEBSOCKET_HOST || window.location.host;
    if (process.env.NEXT_PUBLIC_WEBSOCKET_PREFIX) {
        return process.env.NEXT_PUBLIC_WEBSOCKET_PREFIX + hn + '/' + (vc + datecode).toUpperCase();
    }
    return (httpsTest.test(window.location.protocol) || httpsTest.test(process.env.NEXT_PUBLIC_WEBSOCKET_HOST) ? 'wss://' : 'ws://') + hn + '/' + (vc + datecode).toUpperCase();
}

function oldTracksUrl(vc: ClassName, datecode: Datecode, baseTime: string) {
    const hn = process.env.NEXT_PUBLIC_HISTORY_HOST || window.location.host;
    return (httpsTest.test(window.location.protocol) || httpsTest.test(process.env.NEXT_PUBLIC_HISTORY_HOST) || httpsTest.test(process.env.NEXT_PUBLIC_WEBSOCKET_PREFIX) ? 'https://' : 'http://') + hn + '/tracks/' + (vc + datecode + '.' + baseTime).toUpperCase() + '.bin';
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
        measureFeatures,
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
        measureFeatures: UseMeasure;
        options: any;
        setOptions: Function;
        handicapped: any;
        notes: string;
    }) {
        const [trackData, setTrackData] = useState<TrackData>({});
        const [pilotScores, setPilotScores] = useState<ScoreData>({});
        const {pilots, isPLoading} = usePilots(vc);
        const [socketUrl, setSocketUrl] = useState(proposedUrl(vc, datecode)); //url for the socket
        const [wsStatus, setWsStatus] = useState({listeners: 1, airborne: 0, timeStamp: 0, at: 0});
        const [follow, setFollow] = useState(false);

        // For remote updating of the map
        const mapRef = useRef(null);

        // Keep track of online/offline status of the page
        //        const [online] = useState(navigator.onLine);

        // We are using a webSocket to update our data here
        const {lastMessage, readyState, sendMessage} = useWebSocket(socketUrl, {
            reconnectAttempts: 40,
            reconnectInterval: 16000,
            retryOnError: true
        });

        // Do we have a loaded set of details?
        const valid = !isPLoading && pilots && Object.keys(pilots).length > 0 && mapRef && mapRef.current && mapRef.current.getMap();

        // Have we had a websocket message, if it hasn't changed then ignore it!
        let updateMessage = null;
        if (lastMessage) {
            if (wsStatus.timeStamp != lastMessage.timeStamp) {
                wsStatus.timeStamp = lastMessage.timeStamp;
                decodeWebsocketMessage(vc, datecode, lastMessage.data, trackData, setTrackData, pilotScores, setPilotScores, wsStatus, setWsStatus);
            }
        }

        const connectionStatus = useMemo(() => {
            const connectionStatusO = {
                [ReadyState.CONNECTING]: ['Connecting to tracking..', faSpinner],
                [ReadyState.CLOSING]: ['Closing tracking connection', faSpinner],
                [ReadyState.CLOSED]: [`Connection to tracking is closed, please reload to reconnect`, faLinkSlash],
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
        }, [readyState]);

        useEffect(() => {
            if (socketUrl != proposedUrl(vc, datecode)) {
                //                console.log('change url');
                setPilotScores({});
                setTrackData({});
                setSocketUrl(proposedUrl(vc, datecode));
            }
        }, [vc, datecode, socketUrl]);

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

        // Send the options to the server so we can keep an eye on what settings are
        // used by default, we don't record any identifiers. This is to try and work
        // around safari terminating websocket so frequently
        const sendOptions = useMemo(() => {
            sendMessage(JSON.stringify({compno: selectedCompno ?? 'none', options}));
        }, [options, selectedCompno]);

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
                                setOptions={setOptions}
                                handicapped={handicapped}
                            />
                        )}
                    </div>
                </div>
                {selectedPilotData?.pilot ? <Details pilot={selectedPilotData?.pilot} score={selectedPilotData?.score} vario={selectedPilotData?.track?.vario} units={options.units} tz={tz} /> : <Sponsors at={wsStatus.at} />}
            </>
        );
    },
    // Memo comparison, skip all the functions
    (o, n) =>
        o.selectedCompno === n.selectedCompno && //
        o.vc === n.vc &&
        o.datecode == n.datecode &&
        _isEqual(o.viewport, n.viewport) &&
        _isEqual(o.measureFeatures[0], n.measureFeatures[0]) &&
        _isEqual(o.options, n.options) &&
        o.notes === n.notes &&
        o.handicapped === n.handicapped
    //    function OgnFeed({vc, datecode, tz, selectedCompno, setSelectedCompno, viewport, setViewport, options, setOptions, measureFeatures, handicapped, notes}) {
);

function formatTimes(t, tz: TZ) {
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

function updateTracks(decoded: OnglideWebSocketMessage, trackData: TrackData, setTrackData: (a: TrackData) => void, pilotScores: ScoreData) {
    setTrackData(
        _reduce(
            decoded.tracks?.pilots,
            (result, p, compno) => {
                if (!result[compno]) {
                    result[compno] = {compno: compno};
                }
                // Check if we have a deck already
                let existing = result[compno].deck;

                // If we have just received a baseTime 0 set then we should erase the old stuff
                if (existing && decoded.tracks.baseTime === 0) {
                    existing = null;
                }

                const ts = new Uint32Array(p.t.slice().buffer);
                const indexOfOverlap = existing ? _sortedIndex(ts, existing.t[existing.posIndex - 1]) : 0;
                //                if (existing) {
                //                    console.log(`${compno}: existing latest: ${existing?.t[existing.posIndex - 1]}, new range: ${ts[0]} to ${ts[p.posIndex - 1]}`);
                //                }
                //                console.log(`${compno}: existing length ${existing?.posIndex}, overlap index: ${indexOfOverlap}`);

                let deck: DeckData = {
                    compno: compno as Compno,
                    positions: new Float32Array(p.positions.slice(indexOfOverlap * 3 * Float32Array.BYTES_PER_ELEMENT).buffer),
                    t: new Uint32Array(p.t.slice(indexOfOverlap * Uint32Array.BYTES_PER_ELEMENT).buffer),
                    climbRate: new Int8Array(p.climbRate.slice(indexOfOverlap * Int8Array.BYTES_PER_ELEMENT).buffer),
                    agl: new Int16Array(p.agl.slice(indexOfOverlap * Int16Array.BYTES_PER_ELEMENT).buffer),
                    posIndex: p.posIndex - indexOfOverlap
                };

                if (existing) {
                    // Make the new structure it needs enough space for existing and new
                    const combined: DeckData = {
                        compno: compno as Compno,
                        positions: new Float32Array(deck.positions.length + existing?.positions.length || 0),
                        t: new Uint32Array(deck.t.length + existing?.t.length || 0),
                        climbRate: new Int8Array(deck.climbRate.length + existing?.climbRate.length || 0),
                        agl: new Int16Array(deck.agl.length + existing?.agl.length || 0),
                        posIndex: deck.posIndex + existing?.posIndex
                    };

                    // Figure out which order to put them in
                    const existingOlder = existing ? existing.t[0] < deck.t[0] : null;
                    const newPosition = existingOlder === true ? existing.posIndex : 0;
                    const existingPosition = existingOlder === false ? deck.posIndex : 0;

                    if (existing) {
                        combined.positions.set(existing.positions, existingPosition * 3);
                        combined.t.set(existing.t, existingPosition);
                        combined.climbRate.set(existing.climbRate, existingPosition);
                        combined.agl.set(existing.agl, existingPosition);
                    }

                    combined.positions.set(deck.positions, newPosition * 3);
                    combined.t.set(deck.t, newPosition);
                    combined.climbRate.set(deck.climbRate, newPosition);
                    combined.agl.set(deck.agl, newPosition);

                    deck = combined;
                }

                if (pilotScores[compno]?.utcStart) {
                    pruneStartline(deck, pilotScores[compno].utcStart);
                }

                //                console.log('create iterator ', existing ? 'merge' : 'set', 'tracks:', compno);
                deck.getData = getData(compno as Compno, deck);
                result[compno].deck = deck;
                [result[compno].t, result[compno].vario] = updateVarioFromDeck(deck, result[compno].vario);
                Object.assign(trackData[compno], result[compno]);
                return result;
            },
            trackData
        )
    );
}

async function decodeWebsocketMessage(
    vc: ClassName, //
    datecode: Datecode,
    data: Buffer,
    trackData: TrackData,
    setTrackData: (a: TrackData) => void,
    pilotScores: ScoreData,
    setPilotScores: (a: ScoreData) => void,
    wsStatus: any,
    setWsStatus: (a: any) => void
): Promise<void> {
    return new Response(data).arrayBuffer().then(async (ab) => {
        const decoded = OnglideWebSocketMessage.decode(new Uint8Array(ab));
        if (!decoded) {
            console.log('unable to decode websocket message');
        }
        // Merge in changed tracks
        if (decoded?.tracks) {
            const ourMostRecent = Object.values(trackData).reduce((oldest, track) => Math.max(oldest, track.t ?? 0), 0);
            console.log('ourMostRecent', ourMostRecent, 'basetime', decoded.tracks.baseTime);
            if (decoded.tracks.baseTime && ourMostRecent < decoded.tracks.baseTime) {
                // We get the initial URL and then decode it the same as if it is from the websocket as it is the same format (recursive)
                await fetch(oldTracksUrl(vc, datecode, decoded.tracks.baseTime.toString())) //
                    .then((res) => res.arrayBuffer())
                    .then(async (ab) => decodeWebsocketMessage(vc, datecode, Buffer.from(ab), trackData, setTrackData, pilotScores, setPilotScores, wsStatus, setWsStatus))
                    .then(() => {
                        console.log('updating track remainders (wss)');
                        updateTracks(decoded, trackData, setTrackData, pilotScores);
                    });
            } else {
                console.log('updating track starts', !decoded.tracks.baseTime ? 'https' : 'wss only');
                updateTracks(decoded, trackData, setTrackData, pilotScores);
            }
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

                        // If they have a more recent start then we need to prune and re-do the iterator
                        if (trackData[compno]?.deck && result[compno] && result[compno].utcStart < p.utcStart) {
                            if (pruneStartline(trackData[compno].deck, pilotScores[compno].utcStart)) {
                                //                                console.log('re create iterator (prune on new start time):', compno);
                                trackData[compno].getData = getData(compno as Compno, trackData[compno].deck);
                            }
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
async function* getData(compno: Compno, deck: DeckData) {
    let current = 1;
    //    console.log('starting iterator', compno, deck.posIndex);

    if (deck.dataPromiseResolve) {
        console.log('existing iterator found, closing');
        deck.dataPromiseResolve(true);
    }

    let abort: boolean | undefined = false;
    while (!abort) {
        // Wait for data

        // And send a segment or some
        const newData = [];
        while (current < deck.posIndex) {
            const previous = current - 1;

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

        // Send to deck
        if (newData.length) {
            yield newData;
        }

        // And wait for more data
        abort = await new Promise<undefined | boolean>((resolve) => {
            deck.dataPromiseResolve = resolve;
        });
    }
}
