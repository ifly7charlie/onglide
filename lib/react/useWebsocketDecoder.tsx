import type {
    ClassName,
    SortKey,
    PositionMessage,
    Datecode,
    TrackData, //
    DisplayPilotTrackData,
    ScoreData,
    OtherPilotData,
    PilotScoreDisplay,
    DeckData,
    Compno
} from '../types';
import {makeClassname_Compno} from '../types';

import {useState} from 'react';

import {oldTracksUrl} from './fixupUrls';

import {PilotPosition, OnglideWebSocketMessage, Identifiers} from '../protobuf/onglide';

import {assembleLabeledLine} from './distanceLine';
import {mergePoint, pruneStartline, updateVarioFromDeck, generateIndices} from '../flightprocessing/incremental';

import {reduce as _reduce, forEach as _foreach, cloneDeep as _cloneDeep, find as _find, map as _map, isEqual as _isEqual, sortedIndex as _sortedIndex} from 'lodash';
import {mergeVHPoint, initaliseVH, pruneVHStartline} from './deckvh';

export function useWebsocketDecoder({mergeWsStatus}: {mergeWsStatus?: Function}) {
    const [trackData, setTrackData] = useState<TrackData>({});
    const [pilotScores, setPilotScores] = useState<ScoreData>({});
    const [otherPilots, setOtherPilots] = useState<OtherPilotData>({});
    const [identifiers, setIdentifiers] = useState<Identifiers>({class: '', datecode: '', competition: ''});

    const updateSortKey = (sortKey: SortKey) => {
        setTrackData(
            _reduce(
                trackData ?? {},
                (result, p) => {
                    initaliseVH(p, sortKey);
                    return result;
                },
                trackData ?? {}
            )
        );
    };

    const decoder = async (data: Buffer): Promise<void> => {
        return new Response(data).arrayBuffer().then(async (ab) => {
            const decoded = OnglideWebSocketMessage.decode(new Uint8Array(ab));
            if (!decoded) {
                console.log('unable to decode websocket message');
            }

            if (decoded.identifiers) {
                console.log('identifiers', decoded.identifiers);
                if (decoded.identifiers.datecode != identifiers.datecode || decoded.identifiers.class != identifiers.class) {
                    identifiers.class = decoded.identifiers.class as ClassName;
                    identifiers.datecode = decoded.identifiers.datecode as Datecode;
                    Object.keys(trackData).forEach((key) => delete trackData[key]);
                    Object.keys(pilotScores).forEach((key) => delete pilotScores[key]);
                    setTrackData({});
                    setPilotScores({});
                    setIdentifiers(decoded.identifiers);
                }
                return;
            }

            if (!identifiers.class || !identifiers.datecode) {
                console.error('protocol ordering problem');
                return;
            }

            // Merge in changed tracks
            if (decoded?.tracks) {
                const ourMostRecent = Object.values(trackData).reduce((oldest, track) => Math.max(oldest, track.t ?? 0), 0);
                const numberOfUpdates = Object.keys(decoded?.tracks?.pilots ?? {}).length;
                const newChecksums =
                    numberOfUpdates <= 1
                        ? ''
                        : Object.values(decoded?.tracks?.pilots ?? {})
                              .map((g) => g.trackVersion.toString(16))
                              .join(',');
                const oldChecksums =
                    numberOfUpdates <= 1
                        ? ''
                        : Object.values(trackData)
                              .map((g) => g.deck?.trackVersion.toString(16) ?? g.compno)
                              .join(',');

                console.log(`ourMostRecent ${new Date((ourMostRecent ?? 0) * 1000).toISOString()}, basetime:${new Date((decoded.tracks.baseTime ?? 0) * 1000).toISOString()}`);
                //                const tracksToUse = newChecksums != oldChecksums ? {} : trackData;
                //                const scoresToUse = newChecksums != oldChecksums ? {} : pilotScores;

                if (newChecksums != oldChecksums) {
                    console.log('version checksum changed, fetching all');
                }

                if (decoded.tracks.baseTime && (ourMostRecent < decoded.tracks.baseTime || newChecksums != oldChecksums)) {
                    // We get the initial URL and then decode it the same as if it is from the websocket as it is the same format (recursive)
                    await fetch(oldTracksUrl(identifiers.class as ClassName, identifiers.datecode as Datecode, decoded.tracks.baseTime.toString())) //
                        .then((res) => res.arrayBuffer())
                        .then(async (ab) => decoder(Buffer.from(ab)))
                        .then(() => {
                            console.log('updating track remainders (wss)');
                            updateTracks(decoded, trackData, setTrackData, pilotScores);
                            mergeWsStatus({state: 'open', retry: 0});
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
                                const pruneTo = pruneStartline(trackData[compno].deck, pilotScores[compno].utcStart);
                                if (pruneTo) {
                                    pruneVHStartline(trackData[compno], pruneTo);
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
                // Update the current class
                decoded.positions.class[identifiers.class]?.positions?.forEach((p) => mergePointToPilot(p, trackData));

                // And now update our other pilots list
                Object.entries(decoded.positions.class).forEach(
                    (
                        [className, {positions}] //
                    ) => positions.forEach((pos) => (otherPilots[makeClassname_Compno(className as ClassName, pos.c as Compno)] = pos as PositionMessage))
                );

                setOtherPilots(otherPilots);
            }

            if (decoded.ka) {
                mergeWsStatus(decoded.ka);
            }

            if (decoded.t) {
                mergeWsStatus({at: decoded.t});
            }
        });
    };

    return {trackData, pilotScores, otherPilots, decoder, updateSortKey};
}

function updateTracks(decoded: OnglideWebSocketMessage, trackData: TrackData, setTrackData: (a: TrackData) => void, pilotScores: ScoreData) {
    if (!decoded.tracks) {
        return;
    }
    setTrackData(
        _reduce(
            decoded.tracks.pilots ?? {},
            (result, p, compno) => {
                if (!result[compno]) {
                    result[compno] = {compno: compno};
                }
                // Check if we have a deck already
                let existing = result[compno].deck;

                // If we have just received a baseTime 0 set then we should erase the old stuff
                if (existing && decoded.tracks!.baseTime === 0) {
                    existing = null;
                }

                // If it's a new version of the track then we need to ignore the old one
                if (existing && existing.trackVersion != p.trackVersion) {
                    console.log(`${compno}:replacing track as version changed ${existing.trackVersion} != ${p.trackVersion}`);
                    existing = null;
                }

                const ts = new Uint32Array(p.t.slice().buffer);
                const indexOfOverlap = existing ? _sortedIndex(ts, existing.t[existing.posIndex - 1]) : 0;
                if (existing) {
                    console.log(`${compno}: existing latest: ${existing?.t[existing.posIndex - 1]}, new range: ${ts[0]} to ${ts[p.posIndex - 1]}`);
                }
                console.log(`${compno}: existing length ${existing?.posIndex}, overlap index: ${indexOfOverlap}`);

                let deck: DeckData = {
                    compno: compno as Compno,
                    positions: new Float32Array(p.positions.slice(indexOfOverlap * 3 * Float32Array.BYTES_PER_ELEMENT).buffer),
                    t: new Uint32Array(p.t.slice(indexOfOverlap * Uint32Array.BYTES_PER_ELEMENT).buffer),
                    climbRate: new Int8Array(p.climbRate.slice(indexOfOverlap * Int8Array.BYTES_PER_ELEMENT).buffer),
                    agl: new Int16Array(p.agl.slice(indexOfOverlap * Int16Array.BYTES_PER_ELEMENT).buffer),
                    posIndex: p.posIndex - indexOfOverlap,
                    trackVersion: p.trackVersion
                };

                if (existing) {
                    // Make the new structure it needs enough space for existing and new
                    const combined: DeckData = {
                        compno: compno as Compno,
                        positions: new Float32Array(deck.positions.length + existing?.positions.length || 0),
                        t: new Uint32Array(deck.t.length + existing?.t.length || 0),
                        climbRate: new Int8Array(deck.climbRate.length + existing?.climbRate.length || 0),
                        agl: new Int16Array(deck.agl.length + existing?.agl.length || 0),
                        posIndex: deck.posIndex + existing?.posIndex,
                        trackVersion: p.trackVersion
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

                generateIndices(deck);

                if (pilotScores[compno]?.utcStart) {
                    pruneStartline(deck, pilotScores[compno].utcStart);
                }

                // Save the version
                deck.trackVersion = p.trackVersion;

                // Store away and update the vario
                result[compno].deck = deck;
                [result[compno].t, result[compno].vario] = updateVarioFromDeck(deck, result[compno].vario);
                initaliseVH(result[compno], 'unknown' as SortKey);
                Object.assign(trackData[compno], result[compno]);
                return result;
            },
            trackData
        )
    );
}

function mergePointToPilot(point: PilotPosition, trackData: TrackData) {
    if (!point) {
        return;
    }
    // We need to do a deep clone for the change detection to work
    const compno = point.c;
    const cp: DisplayPilotTrackData | undefined = trackData[compno];

    // If we don't no the pilot we'll discard - this could mean we miss a point or
    // two when connecting but eliminates ghosts when changing channel
    if (!cp) {
        return;
    }

    // Merge into the deck objects
    const result = mergePoint(point, cp, false);
    if (result !== false) {
        mergeVHPoint(point, cp, result.start);
        if (result.start + 1 != result.end) {
            mergeVHPoint(point, cp, result.start + 1);
        }
    }
}
