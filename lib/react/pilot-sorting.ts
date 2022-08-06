//
// Private

import {map as _map} from 'lodash';
import {convertHeight, convertClimb} from './displayunits';
import {delayToText, formatTime} from './timehelper.js';

import {Epoch, TZ, Compno, PilotScore, ScoreData, VarioData, TrackData} from '../types';
import {API_ClassName_Pilots_PilotDetail} from '../rest-api-types';

export interface ShortDisplayKeys {
    compno: Compno;
    sortKey: string | number;
    displayAs: string | number | null;
    units: string;
    icon: string;
}

export enum Units {
    metric = 0,
    british = 1
}

export type SortKey = 'speed' | 'aspeed' | 'fspeed' | 'climb' | 'remaining' | 'aremaining' | 'distance' | 'adistance' | 'height' | 'aheight' | 'start' | 'finish' | 'duration' | 'ald' | 'ld' | 'done' | 'auto';

export function updateSortKeys(pilots: API_ClassName_Pilots_PilotDetail, pilotScores: ScoreData, trackData: TrackData, sortKey: SortKey, units: Units, now: Epoch, tz: TZ) {
    //
    // Map function
    function pilotSortKey(compno: Compno, pilotScore: PilotScore, vario: VarioData, sortKey: SortKey, units: Units, now: Epoch, tz: TZ): ShortDisplayKeys {
        var newKey;
        var suffix = '';
        var displayAs = null;

        // Make sure we actually have data..
        if (!pilotScore || !vario) {
            return {compno, sortKey: '-', displayAs: '-', units: '', icon: 'question'};
        }

        // Update delay numbers
        const delay = now - (pilotScore.t || 0);

        let icon = delay > 300 ? 'nosignal' : 'question';
        if (pilotScore.utcStart) {
            if (pilotScore.utcFinish) {
                icon = 'trophy';
            }
            //        if( pilotScore.landBack ) {
            //              icon = 'home';
            //        }
            if (vario.agl < 100) {
                icon = 'question';
            } else if (vario.average > 1) {
                icon = 'upload';
            } else {
                icon = 'plane';
            }
            //            if (pilot.heightColour) {
            //                icon = icon + ` h${pilot.heightColour}`;
            //            }
        } else {
            icon = 'cloud-upload';
        }

        const remaining = (a) => Math.round((a.distanceRemaining || a.minPossible || 0) * 10) / 10;

        // data is in pilotScore.details.x
        switch (sortKey) {
            case 'speed':
                displayAs = Math.round((newKey = pilotScore.handicapped.taskSpeed));
                suffix = 'kph';
                break;
            case 'aspeed':
                displayAs = Math.round((newKey = pilotScore.actual.taskSpeed));
                suffix = 'kph';
                break;
            case 'fspeed':
                if (pilotScore.stationary && !pilotScore.utcFinish) {
                    displayAs = '-';
                } else {
                    newKey = pilotScore.utcStart ? remaining(pilotScore.actual) / ((pilotScore.t - pilotScore.utcStart) / 3600) : 0;
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
                newKey = Math.round(pilotScore.handicapped.taskDistance);
                suffix = 'km';
                break;
            case 'adistance':
                newKey = Math.round(pilotScore.actual.taskDistance);
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
                if (pilotScore.handicapped.grRemaining > 0) {
                    displayAs = Math.round(pilotScore.handicapped.grRemaining);
                    suffix = ':1';
                    newKey = -displayAs;
                } else {
                    displayAs = '-';
                    newKey = -99999;
                    suffix = '';
                }
                break;
            case 'ald':
                if (pilotScore.actual.grRemaining > 0) {
                    displayAs = Math.round(pilotScore.actual.grRemaining);
                    suffix = ':1';
                    newKey = -displayAs;
                } else {
                    displayAs = '-';
                    newKey = -99999;
                    suffix = '';
                }
                break;
            case 'done':
                newKey = pilotScore.handicapped.taskDistance;
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
                if (!pilotScore.utcStart) {
                    newKey = vario.agl / 10000;
                    [displayAs, suffix] = convertHeight(vario.agl || 0, units);
                } else if (!vario) {
                    newKey = -1;
                    displayAs = '-';
                }
                // After start but be
                else {
                    var speed = pilotScore.handicapped.taskSpeed;
                    var distance = pilotScore.handicapped.taskDistance;

                    if ((speed > 5 && delay < 3600) || pilotScore.utcFinish) {
                        newKey = 10000 + Math.round(speed * 10);
                        displayAs = Math.round(speed);
                        suffix = 'kph';
                    } else if (distance > 7.5) {
                        newKey = Math.round(distance * 10);
                        displayAs = Math.round(distance);
                        suffix = 'km';
                    } else {
                        newKey = vario.agl / 10000;
                        [displayAs, suffix] = convertHeight(vario.agl || 0, units);
                    }
                }
        }
        if (!newKey) {
            newKey = '';
            suffix = '';
        }

        if (displayAs !== undefined) {
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

    return _map(pilots, (pilot) => pilotSortKey(pilot.compno as Compno, pilotScores[pilot.compno], trackData[pilot.compno]?.vario, sortKey, units, now, tz));
}

// list of descriptions
const handicappedDescriptions = {
    auto: 'Handicapped speed, distance or height agl',
    speed: 'Current handicapped speed',
    aspeed: 'Current actual speed',
    fspeed: 'Fastest possible handicapped speed assuming finishing now',
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
    speed: ['speed', 'aspeed', 'fspeed'],
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
    faspeed: 'Fastest possible speed assuming finishing now',
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

export function getSortDescription(id, handicapped = false) {
    return handicapped ? handicappedDescriptions[id] : descriptions[id];
}

//
// This will figure out what the next sort order should be based on the current one
export function nextSortOrder(key, current, handicapped = false) {
    // Toggle through the options
    const orders = handicapped ? handicappedSortOrders[key] : sortOrders[key];
    const index = orders.indexOf(current);
    const order = orders[(index + 1) % orders.length];

    // And return
    return order;
}
