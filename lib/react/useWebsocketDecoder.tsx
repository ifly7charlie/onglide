import type {ClassName, Epoch, Datecode} from '../types';

import {useSelector, useDispatch} from '../redux';
import {updateTracks, updatePositions, selectTrackVersion, fetchOldTracks} from '../redux/tracksSlice';
import {updateTask} from '../redux/taskSlice';
import {updateScores} from '../redux/scoresSlice';
import {updateOtherPilotsPositions} from '../redux/otherPilotsSlice';

import {updateNow} from '../redux/nowSlice';

import {updateClassAction} from '../redux/actions';

import {OnglideWebSocketMessage} from '../protobuf/onglide';

import {reduce as _reduce, forEach as _foreach, cloneDeep as _cloneDeep, find as _find, map as _map, isEqual as _isEqual, sortedIndex as _sortedIndex} from 'lodash';

export function useWebsocketDecoder({mergeWsStatus, className, datecode}: {mergeWsStatus?: Function; className: ClassName; datecode: Datecode}) {
    const dispatch = useDispatch();
    const oldChecksums = useSelector(selectTrackVersion);

    const decoder = async (data: Buffer): Promise<void> => {
        return new Response(data).arrayBuffer().then(async (ab) => {
            const decoded = OnglideWebSocketMessage.decode(new Uint8Array(ab));
            if (!decoded) {
                console.log('unable to decode websocket message');
            }

            if (decoded.identifiers) {
                console.log('identifiers', decoded.identifiers, decoded.t);
                dispatch(updateClassAction({...decoded.identifiers, t: decoded.t as Epoch}));
            }

            // Merge in changed tracks
            if (decoded?.tracks) {
                dispatch(fetchOldTracks({baseTime: decoded.tracks.baseTime as Epoch, residual: decoded.tracks, className, datecode}));
                return;
            }

            if (decoded?.task) {
                dispatch(updateTask(decoded.task));
            }

            // If we have been sent scores then merge them in,
            // this will update what has changed so no need to send scores if they are unchanged since previous
            // message
            if (decoded?.scores) {
                dispatch(updateScores(decoded.scores));
            }

            // Merge in any new position reports, one update for all
            if (decoded.positions) {
                // Update the current class
                dispatch(updatePositions({positions: decoded.positions.class[className].positions, t: decoded.t as Epoch}));
                dispatch(updateOtherPilotsPositions({positions: decoded.positions, t: decoded.t as Epoch}));
            }

            if (decoded.ka) {
                mergeWsStatus({state: 'open', retry: 0, ...decoded.ka});
            }

            if (decoded.t) {
                dispatch(updateNow(decoded.t as Epoch));
            }
        });
    };

    return {decoder};
}
/*
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
*/
