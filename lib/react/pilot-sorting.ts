//
// Private

import {map as _map} from 'lodash';
import {Units, convertHeight, convertClimb} from './displayunits';
import {delayToText, formatTime} from './timehelper.js';

import {Epoch, TZ, Compno, PilotScore, ScoreData, VarioData, TrackData, PositionStatus} from '../types';
import {API_ClassName_Pilots} from '../rest-api-types';

import {sortBy as _sortBy} from 'lodash';

import {faCircleQuestion} from '@fortawesome/free-regular-svg-icons';
import {faCloudArrowUp, faCow, faHouse, faCirclePause, faPaperPlane, faSignal, faClock, faTrophy} from '@fortawesome/free-solid-svg-icons';

export interface ShortDisplayKeys {
    compno: Compno;
    sortKey: string | number;
    displayAs: string | number | null;
    units: string;
    icon: string | any;
}

export type SortKey = 'speed' | 'aspeed' | 'fspeed' | 'climb' | 'remaining' | 'aremaining' | 'distance' | 'adistance' | 'height' | 'aheight' | 'start' | 'finish' | 'duration' | 'delay' | 'ald' | 'ld' | 'done' | 'auto' | 'times';

export function updateSortKeys(pilots: API_ClassName_Pilots, pilotScores: ScoreData, trackData: TrackData, sortKey: SortKey, units: Units, now: Epoch, tz: TZ) {
    //
    // Map function
    function pilotSortKey(compno: Compno, pilotScore: PilotScore, vario: VarioData, t: Epoch): ShortDisplayKeys {
        var newKey;
        var suffix = '';
        var displayAs = null;

        // Make sure we actually have data..
        if (!pilotScore && !vario) {
            return {compno, sortKey: -9999999999999, displayAs: '-', units: '', icon: faCircleQuestion};
        }

        // Update delay numbers
        const delay = now - (t || 0);
        if (vario) {
            vario.delay = delay;
        }

        let icon = faCircleQuestion;

        if (!pilotScore) {
        } else if (pilotScore?.flightStatus == PositionStatus.Landed) {
            icon = faCow;
        } else if (pilotScore?.flightStatus == PositionStatus.Home) {
            icon = faHouse;
        } else if (pilotScore?.flightStatus == PositionStatus.Grid) {
            icon = faCirclePause;
        } else if (delay > 100) {
            icon = delay > 300 ? faSignal : faClock;
        }

        if (pilotScore?.utcFinish) {
            icon = faTrophy;
        } else if (vario?.agl < 50) {
            // noop - done above
        } else if (vario?.average > 1) {
            icon = faCloudArrowUp;
        } else {
            icon = faPaperPlane;
        }

        if (!pilotScore && sortKey != 'height' && sortKey != 'aheight' && sortKey != 'auto') {
            return {compno, sortKey: -9999999999999, displayAs: '-', units: '', icon};
        }

        const remaining = (a) => Math.round((a?.distanceRemaining || a?.minPossible || 0) * 10) / 10;

        // data is in pilotScore.details.x
        switch (sortKey) {
            case 'speed':
                displayAs = Math.round((newKey = pilotScore.handicapped?.taskSpeed || pilotScore.actual?.taskSpeed));
                suffix = 'kph';
                break;
            case 'aspeed':
                displayAs = Math.round((newKey = pilotScore.actual?.taskSpeed));
                suffix = 'kph';
                break;
            case 'fspeed':
                if (pilotScore?.stationary && !pilotScore?.utcFinish) {
                    displayAs = '-';
                } else {
                    newKey = pilotScore?.utcStart ? remaining(pilotScore?.actual) / ((pilotScore?.t - pilotScore?.utcStart) / 3600) : 0;
                    displayAs = Math.round(newKey * 10) / 10;
                    suffix = 'kph';
                }
                break;
            case 'climb':
                if (
                    pilotScore?.utcFinish ||
                    pilotScore?.stationary || //
                    (pilotScore?.flightStatus != PositionStatus.Airborne && pilotScore?.flightStatus != PositionStatus.Low)
                ) {
                    displayAs = '';
                    newKey = -99999;
                    suffix = '';
                } else {
                    newKey = vario?.average;
                    [displayAs, suffix] = convertClimb(newKey, units);
                }
                break;
            case 'remaining':
                displayAs = pilotScore?.utcFinish ? 'finished' : '-';
                newKey = pilotScore?.utcFinish ? 0 : -(displayAs = remaining(pilotScore.handicapped)) || -9999;
                suffix = 'km';
                break;
            case 'aremaining':
                displayAs = pilotScore?.utcFinish ? 'finished' : '-';
                newKey = pilotScore?.utcFinish ? 0 : -(displayAs = remaining(pilotScore.actual)) || -9999;
                suffix = 'km';
                break;
            case 'distance':
                newKey = Math.round(pilotScore.handicapped?.taskDistance || pilotScore.actual?.taskDistance);
                suffix = 'km';
                break;
            case 'adistance':
                newKey = Math.round(pilotScore.actual?.taskDistance);
                suffix = 'km';
                break;
            case 'height':
                newKey = Math.round(vario?.altitude);
                [displayAs, suffix] = convertHeight(newKey, units);
                break;
            case 'aheight':
                newKey = Math.round(vario?.agl || 0);
                [displayAs, suffix] = convertHeight(newKey, units);
                break;
            case 'start':
                if (pilotScore.utcStart) {
                    [displayAs, suffix] = formatTime(pilotScore.utcStart, tz);
                }
                newKey = pilotScore.utcStart;
                break;
            case 'finish':
                if (pilotScore.utcFinish) {
                    [displayAs, suffix] = formatTime(pilotScore.utcFinish, tz);
                }
                newKey = pilotScore.utcFinish;
                break;
            case 'duration':
                if (!pilotScore.utcStart) {
                    displayAs = '-';
                    suffix = '';
                    newKey = '';
                } else {
                    newKey = new Date(0);
                    newKey.setSeconds((pilotScore.utcFinish ? pilotScore.utcFinish : now) - pilotScore.utcStart);
                    const iso = newKey.toISOString();
                    newKey = -newKey.getTime() / 1000;
                    displayAs = iso.substr(11, 5);
                    suffix = iso.substr(17, 2);
                }
                break;
            case 'delay':
                // Delay not relevant if home or finished
                if (pilotScore.flightStatus == PositionStatus.Home || pilotScore?.utcFinish) {
                    displayAs = '-';
                    suffix = '';
                    newKey = '0';
                } else {
                    newKey = delay;
                    [displayAs] = delayToText(delay).split(' ');
                }
                break;
            case 'ld':
                if (pilotScore?.utcFinish) {
                    displayAs = 'finished';
                    newKey = 99999;
                    suffix = '';
                } else if (pilotScore.handicapped?.grRemaining > 200) {
                    displayAs = '∞';
                    newKey = -9999;
                    suffix = '';
                } else if (pilotScore.handicapped?.grRemaining > 0) {
                    displayAs = Math.round(pilotScore.handicapped?.grRemaining);
                    suffix = ':1';
                    newKey = -displayAs;
                } else {
                    displayAs = '-';
                    newKey = -99998;
                    suffix = '';
                }
                break;
            case 'ald':
                if (pilotScore?.utcFinish) {
                    displayAs = 'finished';
                    newKey = 99999;
                    suffix = '';
                } else if (pilotScore.actual?.grRemaining > 200) {
                    displayAs = '∞';
                    newKey = -9999;
                    suffix = '';
                } else if (pilotScore.actual?.grRemaining > 0) {
                    displayAs = Math.round(pilotScore.actual?.grRemaining);
                    suffix = ':1';
                    newKey = -displayAs;
                } else {
                    displayAs = '-';
                    newKey = -99999;
                    suffix = '';
                }
                break;
            case 'done':
                newKey = pilotScore.handicapped?.taskDistance;
                suffix = 'km';
                break;
            case 'auto':
                // If it is scored then distance or speed
                // Before they start show altitude, sort to the end of the list
                if (!pilotScore?.utcStart) {
                    newKey = vario?.agl / 10000;
                    [displayAs, suffix] = convertHeight(vario?.agl || 0, units);
                } else if (!vario) {
                    newKey = -1;
                    displayAs = '-';
                }
                // After start, it's speed if we have recent points and are airborne or finished
                // or distance if they have distance, otherwise just height
                else {
                    var speed = pilotScore?.handicapped?.taskSpeed || pilotScore?.actual?.taskSpeed;
                    var distance = pilotScore?.handicapped?.taskDistance || pilotScore?.actual?.taskDistance;

                    if ((speed > 5 && delay < 900 && pilotScore.flightStatus == PositionStatus.Airborne) || pilotScore?.utcFinish) {
                        newKey = 10000 + Math.round(speed * 10);
                        displayAs = Math.round(speed);
                        suffix = 'kph';
                    } else if (distance > 7.5) {
                        newKey = Math.round(distance * 10);
                        displayAs = Math.round(distance);
                        suffix = 'km';
                    } else {
                        newKey = vario?.agl / 10000;
                        [displayAs, suffix] = convertHeight(vario?.agl || 0, units);
                    }
                }
        }
        if (!newKey) {
            newKey = 0;
            suffix = '';
        }

        if (displayAs !== null) {
            if (!displayAs) {
                displayAs = '-';
            }
        } else {
            if (newKey != '') {
                displayAs = newKey;
            } else {
                displayAs = '-';
            }
        }

        return {
            compno,
            sortKey: newKey,
            displayAs,
            units: suffix,
            icon
        };
    }

    return _sortBy(
        _map(pilots, (pilot) => pilotSortKey(pilot.compno as Compno, pilotScores[pilot.compno], trackData[pilot.compno]?.vario, trackData[pilot.compno]?.t)),
        ['sortKey', 'compno']
    );
}

// list of descriptions
const handicappedDescriptions = {
    auto: 'Handicapped or height agl',
    speed: 'Current handicapped speed',
    aspeed: 'Current actual speed',
    fspeed: 'Handicapped speed if finishing now',
    faspeed: 'Speed assuming finishing now',
    height: 'Current height above sea level',
    aheight: 'Current height above ground',
    climb: 'Recent average height change',
    ld: 'Handicapped L/D remaining',
    ald: 'Actual L/D remaining',
    remaining: 'Handicapped distance remaining',
    distance: 'Handicapped distance completed',
    aremaining: 'Actual distance remaining',
    adistance: 'Actual distance completed',
    start: 'Start time',
    finish: 'Finish time',
    duration: 'Task duration',
    delay: 'Tracking delay'
};

const handicappedSortOrders = {
    auto: ['auto'],
    speed: ['speed', 'aspeed', 'fspeed', 'faspeed'],
    height: ['aheight', 'height'],
    climb: ['climb'],
    ld: ['ld', 'ald'],
    remaining: ['remaining', 'aremaining'],
    distance: ['distance', 'adistance'],
    times: ['start', 'duration', 'finish', 'delay']
};

// list of descriptions
const descriptions = {
    auto: 'Speed, distance or height agl',
    aspeed: 'Current actual speed',
    faspeed: 'Actual speed assuming finishing now',
    height: 'Current height above sea level',
    aheight: 'Current height above ground',
    climb: 'Recent average height change',
    ald: 'Actual L/D remaining',
    aremaining: 'Actual distance remaining',
    adistance: 'Actual distance completed',
    start: 'Start time',
    finish: 'Finish time',
    duration: 'Task duration',
    delay: 'Tracking delay'
};

const sortOrders = {
    auto: ['auto'],
    speed: ['aspeed', 'faspeed'],
    height: ['aheight', 'height'],
    climb: ['climb'],
    ld: ['ald'],
    remaining: ['aremaining'],
    distance: ['adistance'],
    times: ['start', 'duration', 'finish', 'delay']
};

const whichSortOrder = {
    auto: 'auto',
    speed: 'speed',
    aspeed: 'speed',
    fspeed: 'speed',
    faspeed: 'speed',
    aheight: 'height',
    height: 'height',
    climb: 'climb',
    ld: 'ld',
    ald: 'ld',
    remaining: 'remaining',
    aremaining: 'remaining',
    distance: 'distance',
    adistance: 'distance',
    start: 'times',
    duration: 'times',
    finish: 'times',
    delay: 'times'
};

export function getSortOrderType(key: SortKey): SortKey {
    return whichSortOrder[key] || key;
}

export function getSortDescription(id: SortKey, handicapped: boolean) {
    return handicapped ? handicappedDescriptions[id] : descriptions[id];
}

export function isValidSortOrder(type: SortKey, handicapped: boolean): boolean {
    return !!getSortDescription(type, handicapped);
}

export function getValidSortOrder(type: SortKey, handicapped: boolean): SortKey {
    if (isValidSortOrder(type, handicapped)) {
        return type;
    } else {
        const key = getSortOrderType(type);
        const orders = handicapped ? handicappedSortOrders[key] : sortOrders[key];
        return orders[0];
    }
}

//
// This will figure out what the next sort order should be based on the current one
export function nextSortOrder(key: SortKey, current: SortKey, handicapped: boolean) {
    // Toggle through the options
    const orders = handicapped ? handicappedSortOrders[key] : sortOrders[key];
    const index = orders.indexOf(current) || 0;
    const order = orders[(index + 1) % orders.length];

    // And return
    return order;
}
