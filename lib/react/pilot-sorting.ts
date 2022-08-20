//
// Private

import {map as _map} from 'lodash';
import {convertHeight, convertClimb} from './displayunits';
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
    icon: any;
}

export enum Units {
    metric = 0,
    british = 1
}

export type SortKey = 'speed' | 'aspeed' | 'fspeed' | 'climb' | 'remaining' | 'aremaining' | 'distance' | 'adistance' | 'height' | 'aheight' | 'start' | 'finish' | 'duration' | 'ald' | 'ld' | 'done' | 'auto';

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

        //        console.log(pilotScore);
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
                newKey = vario?.average;
                [displayAs, suffix] = convertClimb(newKey, units);
                break;
            case 'remaining':
                newKey = remaining(pilotScore.handicapped);
                suffix = 'km';
                break;
            case 'aremaining':
                newKey = remaining(pilotScore.actual);
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
            case 'ld':
                if (pilotScore.handicapped?.grRemaining > 0) {
                    displayAs = Math.round(pilotScore.handicapped?.grRemaining);
                    suffix = ':1';
                    newKey = -displayAs;
                } else {
                    displayAs = '-';
                    newKey = -99999;
                    suffix = '';
                }
                break;
            case 'ald':
                if (pilotScore.actual?.grRemaining > 0) {
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
                /*                if (pilotScore.utcStart) {
                        newKey = -1;
                        displayAs = '-';
                    } else if (pilotScore.scoredstatus == 'F') {
                        newKey = 10000 + Math.round(pilotScore.handicapped.speed * 10);
                        displayAs = pilotScore.handicapped.speed.toFixed(1);
                        suffix = 'kph';
                    } else {
                        newKey = Math.round(pilotScore.handicapped.distancedone * 10);
                        displayAs = pilotScore.handicapped.distancedone.toFixed(1);
                        suffix = 'km';
                    }
                }
                // Before they start show altitude, sort to the end of the list
                else */
                if (!pilotScore?.utcStart || pilotScore?.flightStatus == PositionStatus.Low) {
                    newKey = vario?.agl / 10000;
                    [displayAs, suffix] = convertHeight(vario?.agl || 0, units);
                } else if (!vario) {
                    newKey = -1;
                    displayAs = '-';
                }
                // After start but be
                else {
                    var speed = pilotScore?.handicapped?.taskSpeed || pilotScore?.actual?.taskSpeed;
                    var distance = pilotScore?.handicapped?.taskDistance || pilotScore?.actual?.taskDistance;

                    if ((speed > 5 && delay < 3600 && pilotScore.flightStatus == PositionStatus.Airborne) || pilotScore?.utcFinish) {
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
    duration: 'Task duration'
};

const handicappedSortOrders = {
    auto: ['auto'],
    speed: ['speed', 'aspeed', 'fspeed', 'faspeed'],
    height: ['aheight', 'height'],
    climb: ['climb'],
    ld: ['ld', 'ald'],
    remaining: ['remaining', 'aremaining'],
    distance: ['distance', 'adistance'],
    times: ['start', 'duration', 'finish']
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
    duration: 'Task duration'
};

const sortOrders = {
    auto: ['auto'],
    speed: ['aspeed', 'faspeed'],
    height: ['aheight', 'height'],
    climb: ['climb'],
    ld: ['ald'],
    remaining: ['aremaining'],
    distance: ['adistance'],
    times: ['start', 'duration', 'finish']
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
    finish: 'times'
};

export function getSortOrderType(key: string): string {
    return whichSortOrder[key] || key;
}

export function getSortDescription(id, handicapped) {
    return handicapped ? handicappedDescriptions[id] : descriptions[id];
}

//
// This will figure out what the next sort order should be based on the current one
export function nextSortOrder(key, current, handicapped) {
    // Toggle through the options
    const orders = handicapped ? handicappedSortOrders[key] : sortOrders[key];
    const index = orders.indexOf(current);
    const order = orders[(index + 1) % orders.length];

    // And return
    return order;
}
