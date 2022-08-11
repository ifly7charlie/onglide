//
// This is responsible for creating and displaying the task map on the screen
//
// It loads GeoJSON from the next.js server API and renders it on the screen
//
// It will also expose the helper functions required to update the screen
//

import {useState, useMemo, useRef} from 'react';

import {useTaskGeoJSON, usePilots, Spinner, Error} from './loaders';

import {Nbsp, Icon} from './htmlhelper';

import useWebSocket, {ReadyState} from 'react-use-websocket';

import {reduce as _reduce, forEach as _foreach, cloneDeep as _cloneDeep, find as _find, map as _map, chunk as _chunk} from 'lodash';

import {Epoch, Compno, TrackData, ScoreData, SelectedPilotDetails, PilotScoreDisplay, DeckData} from '../types';
import {mergePoint, pruneStartline, updateVarioFromDeck} from '../flightprocessing/incremental';

import Alert from 'react-bootstrap/Alert';
import Button from 'react-bootstrap/Button';

import {PilotList, Details} from './pilotlist';
import {TaskDetails} from './taskdetails';

import {lineString} from '@turf/helpers';

import {PilotPosition, OnglideWebSocketMessage} from '../protobuf/onglide';

import MApp from './deckgl';

let mutateTimer = 0;
const httpsTest = new RegExp(/^https/i, 'i');

function proposedUrl(vc, datecode) {
    const hn = process.env.NEXT_PUBLIC_WEBSOCKET_HOST || window.location.host;
    return (httpsTest.test(window.location.protocol) || httpsTest.test(process.env.NEXT_PUBLIC_WEBSOCKET_HOST) ? 'wss://' : 'ws://') + hn + '/' + (vc + datecode).toUpperCase();
}

export function OgnFeed({vc, datecode, tz, selectedCompno, setSelectedCompno, viewport, setViewport, options, setOptions}) {
    const [trackData, setTrackData] = useState<TrackData>({});
    const [pilotScores, setPilotScores] = useState<ScoreData>({});
    const {pilots, isPLoading} = usePilots(vc);
    const [socketUrl, setSocketUrl] = useState(proposedUrl(vc, datecode)); //url for the socket
    const [wsStatus, setWsStatus] = useState({c: 1, p: 0, timeStamp: 0, at: 0});
    const [follow, setFollow] = useState(false);
    const [attempt, setAttempt] = useState(0);

    // For remote updating of the map
    const mapRef = useRef(null);

    // Keep track of online/offline status of the page
    const [online] = useState(navigator.onLine);

    // We are using a webSocket to update our data here
    const {lastMessage, readyState, sendMessage} = useWebSocket(socketUrl, {
        reconnectAttempts: 3,
        reconnectInterval: 30000,
        shouldReconnect: (closeEvent) => {
            console.log(closeEvent);
            return online;
        },
        onOpen: () => {
            setAttempt(attempt + 1);
        }
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

    const connectionStatus = {
        [ReadyState.CONNECTING]: '<span style="color:\'orange\'">Connecting</span>',
        [ReadyState.OPEN]: "Connected <Icon type='time'/>",
        [ReadyState.CLOSING]: '<span style="color:\'red\'">Closed</span>',
        [ReadyState.CLOSED]: '<span style="color:\'red\'">Closed</span>',
        [ReadyState.UNINSTANTIATED]: '<span style="color:\'orange\'">Preparing</span>'
    }[readyState];

    if (socketUrl != proposedUrl(vc, datecode)) {
        setPilotScores({});
        setTrackData({});
        setSocketUrl(proposedUrl(vc, datecode));
    }

    function setCompno(cn) {
        setSelectedCompno(cn);
        if (cn && pilots && pilots[cn]) {
            setFollow(true);
            console.log(cn, trackData[cn]?.deck?.partial);
            if (!trackData[cn]?.deck || trackData[cn]?.deck?.partial) {
                sendMessage(cn);
            }
        }
    }

    // And the pilot object
    const selectedPilotData: SelectedPilotDetails | null = pilots
        ? {
              pilot: pilots[selectedCompno],
              score: pilotScores[selectedCompno],
              track: trackData[selectedCompno]
          }
        : null;

    // Cache the calculated times and only refresh every 60 seconds
    const status = useMemo(
        () =>
            `${connectionStatus} @ ${wsStatus && wsStatus.at ? formatTimes(wsStatus.at, tz) : ''}` + //
            ` | <a href='#' title='number of viewers'>${wsStatus.c} 👥</a> | <a href='#' title='number of planes currently tracked'>${wsStatus.p} ✈️  </a>`,
        [connectionStatus, Math.round(wsStatus.at / 60), wsStatus.p, wsStatus.c]
    );

    return (
        <>
            <div className={'resizingMap'}>
                <MApp
                    vc={vc}
                    follow={follow}
                    setFollow={setFollow}
                    selectedPilotData={selectedPilotData}
                    setSelectedCompno={(x) => setCompno(x)}
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
                    status={status}
                />
            </div>
            <div className="resultsOverlay">
                <div className="resultsUnderlay">
                    <TaskDetails vc={vc} />
                    <PilotList
                        pilots={pilots}
                        pilotScores={pilotScores} //
                        trackData={trackData}
                        selectedPilot={selectedCompno}
                        setSelectedCompno={(x) => setCompno(x)}
                        now={wsStatus.at as Epoch}
                        tz={tz}
                        options={options}
                        setOptions={setOptions}
                    />
                </div>
            </div>
            <Details pilot={selectedPilotData?.pilot} score={selectedPilotData?.score} vario={selectedPilotData?.track?.vario} units={options.units} tz={tz} />
        </>
    );
}

function formatTimes(t, tz) {
    // Figure out what the local language is for international date strings
    const lang = navigator.languages != undefined ? navigator.languages[0] : navigator.language;

    // And then produce a string to display it locally
    const dt = new Date(t * 1000);
    return `<a href='#' title='competition time'>${dt.toLocaleTimeString(lang, {timeZone: tz, hour: '2-digit', minute: '2-digit'})} ✈️ </a>` + `<a href='#' title='your time'>${dt.toLocaleTimeString(lang, {hour: '2-digit', minute: '2-digit'})} ⌚️</a>`;
}

function mergePointToPilot(point: PilotPosition, trackData: TrackData) {
    if (!point) {
        return;
    }
    // We need to do a deep clone for the change detection to work
    const compno = point.c;
    let cp = trackData?.[compno];

    if (!cp) {
        cp = trackData[compno] = {};
    }

    // Merge into the geoJSON objects as needed - allow it to create
    // a new deck it will be incompleted so clicking on pilot will
    // cause a reload
    mergePoint(point, cp, false);
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
                            indices: new Uint32Array(p.indices.slice().buffer),
                            positions: new Float32Array(p.positions.slice().buffer),
                            t: new Uint32Array(p.t.slice().buffer),
                            climbRate: new Int8Array(p.climbRate.slice().buffer),
                            recentIndices: new Uint32Array(p.recentIndices.slice().buffer),
                            agl: new Int16Array(p.agl.slice().buffer),
                            posIndex: p.posIndex,
                            partial: p.partial,
                            segmentIndex: p.segmentIndex
                        });
                        //                        result[compno].colors = new Uint8Array(_map(result[compno].t, (_) => [Math.floor(Math.random() * 255), 128, 128]).flat());
                        console.log(`track  for ${compno}, ${p.climbRate.length} points, partial: ${p.partial}`);
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
                        console.log(compno, p);

                        // Update the geoJSON with the scored trackline so we can easily display
                        // what the pilot has been scored for
                        delete p.minGeoJSON;
                        delete p.maxGeoJSON;
                        if (p.scoredPoints && p.scoredPoints.length > 2) {
                            p.scoredGeoJSON = lineString(_chunk(p.scoredPoints, 2), {});
                        }
                        if (p.minDistancePoints && p.minDistancePoints.length > 2) {
                            p.minGeoJSON = lineString(_chunk(p.minDistancePoints, 2), {});
                        }
                        if (p.maxDistancePoints && p.maxDistancePoints.length > 2) {
                            p.maxGeoJSON = lineString(_chunk(p.maxDistancePoints, 2), {});
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
