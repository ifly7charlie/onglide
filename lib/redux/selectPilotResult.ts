import {lruMemoize, createSelector as cs, createSelectorCreator} from '@reduxjs/toolkit';

import {map as _map, values} from 'lodash';

import {Units, SortKey, Epoch, TZ, Compno, PilotScore, ScoreData, VarioData, AltitudeAgl, TrackData, PositionStatus} from '../types';

import {sortBy as _sortBy, reduce as _reduce} from 'lodash';

import type {IconDefinition} from '@fortawesome/free-regular-svg-icons';
import {faCircleQuestion} from '@fortawesome/free-regular-svg-icons';
import {faCloudArrowUp, faCow, faHouse, faCirclePause, faPaperPlane, faSignal, faClock, faTrophy} from '@fortawesome/free-solid-svg-icons';

export type DisplayKeys = ConvertedDisplayKeys | NormalDisplayKeys;

type NormalDisplayKeys = BaseDisplayKeys & {
    value: string | number | null;
    suffix?: string;
};

type ConvertedDisplayKeys = BaseDisplayKeys & {
    value: number | null;
    converter: OptionalConverterFunction;
};

type BaseDisplayKeys = {
    compno: Compno;
    sortKey: number;
};

type OptionalConverterFunction = (i: ConvertedDisplayKeys, units: Units, tz: TZ) => NormalDisplayKeys;

function convertClimb(i: ConvertedDisplayKeys, units: Units, _tz: TZ): NormalDisplayKeys {
    return i.value ? {...i, value: Math.round(i.value * (units ? 19.43844 : 10)) / 10, suffix: units ? 'kt' : 'm/s'} : i;
}

function convertHeight(i: ConvertedDisplayKeys, units: Units, _tz: TZ): NormalDisplayKeys {
    return i.value ? {...i, value: Math.round(i.value * (units ? 3.28084 : 1)), suffix: units ? 'ft' : 'm'} : i;
}

function convertTime(i: ConvertedDisplayKeys, _units: Units, tz: TZ): NormalDisplayKeys {
    if (!i.value) {
        return i;
    }
    // Figure out what the local language is for international date strings
    const lang = navigator.languages != undefined ? navigator.languages[0] : navigator.language;

    // And then produce a string to display it locally
    const dt = new Date(i.value * 1000);
    return {...i, value: dt.toLocaleTimeString('uk', {timeZone: tz, hour: '2-digit', minute: '2-digit'}), suffix: (i.value % 60 < 10 ? '0' : '') + dt.toLocaleTimeString(lang, {timeZone: tz, second: '2-digit'})};
}

import type {RootState} from './store';
import {selectAllScores} from './scoresSlice';
import {selectAllPositions, selectAllAverageClimb, selectAllAGL} from './tracksSlice';

export type AllDisplayKeys = DisplayKeys[];
export type AllNormalDisplayKeys = NormalDisplayKeys[];

export function sortKeyEqualityCheck(a?: NormalDisplayKeys[], b?: NormalDisplayKeys[]) {
    return b && a && a.length === b.length && !a.some((v, i) => v.sortKey !== b.at(i)?.sortKey);
}

export function valueEqualityCheck(a?: NormalDisplayKeys[], b?: NormalDisplayKeys[]) {
    return b && a && a.length === b.length && !a.some((v, i) => v.value !== b.at(i)?.value);
}

const createSelector = createSelectorCreator({
    memoize: lruMemoize, // Function to be used to memoize `resultFunc`
    memoizeOptions: [{resultEqualityCheck: sortKeyEqualityCheck}]
});

export const selectAuto = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllScores(state, t) ?? [], //
        (state: RootState, t: Epoch | undefined) => selectAllAGL(state, t)
    ],
    (_t: Epoch | undefined, scores: ScoreData, altitudes): AllDisplayKeys =>
        Object.values(scores).map((score) => {
            const agl = altitudes[score.compno as Compno];

            let sortKey: number = Infinity;
            let value: any = undefined;
            let suffix: string = '';
            let converter: OptionalConverterFunction | null = null;

            // If it is scored then distance or speed
            // Before they start show altitude, sort to the end of the list
            if (!score || score.flightStatus == PositionStatus.Unknown) {
                sortKey = -2;
                value = '-';
            } else if (score.flightStatus == PositionStatus.Grid || (!score.utcStart && score.flightStatus == PositionStatus.Home)) {
                sortKey = -1;
                value = '-';
            } else if (!score.utcStart) {
                sortKey = agl / 10000;
                value = agl;
                converter = convertHeight;
            } else {
                // After start, it's speed if we have recent points and are airborne or finished
                // or distance if they have distance, otherwise just height
                var speed = score.handicapped?.taskSpeed || score.actual?.taskSpeed || 0;
                var distance = score.handicapped?.taskDistance || score.actual?.taskDistance || 0;

                if ((speed > 5 && speed < 300 && score.flightStatus == PositionStatus.Airborne) || score?.utcFinish) {
                    sortKey = 10000 + Math.round(speed * 10);
                    value = Math.round(speed);
                    suffix = 'kph';
                } else if (distance > 7.5) {
                    sortKey = Math.round(distance * 10);
                    value = Math.round(distance);
                    suffix = 'km';
                } else {
                    sortKey = agl / 10000;
                    value = agl;
                    converter = convertHeight;
                }
            }
            return converter ? {compno: score.compno as Compno, sortKey, value, converter} : {compno: score.compno as Compno, sortKey, value, suffix};
        })
);

export const selectSpeed = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllScores(state, t) //
    ],
    (_t: Epoch | undefined, scores: ScoreData): AllDisplayKeys =>
        Object.values(scores).map((score) => {
            const sortKey = score?.handicapped?.taskSpeed || score?.actual?.taskSpeed || 0;
            return {compno: score.compno as Compno, value: Math.round(sortKey), suffix: 'kph', sortKey};
        })
);

export const selectActualSpeed = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllScores(state, t) //
    ],
    (_t: Epoch | undefined, scores: ScoreData): AllDisplayKeys =>
        Object.values(scores).map((score) => {
            const sortKey = score.actual?.taskSpeed || 0;
            return {compno: score.compno as Compno, value: Math.round(sortKey), suffix: 'kph', sortKey};
        })
);

export const selectFastestSpeed = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllScores(state, t) //
    ],
    (_t: Epoch | undefined, scores: ScoreData): AllDisplayKeys =>
        Object.values(scores).map((score) => {
            let sortKey: number = Infinity;
            let value: any = undefined;
            let suffix: string = '';
            if (!score.utcStart || (score?.stationary && !score?.utcFinish)) {
                value = '-';
                sortKey = 0;
            } else {
                if (score.handicapped?.maxPossible && score.taskTimeRemaining && score.taskDuration && score.taskTimeRemaining > 0) {
                    // AAT and not time expired
                    sortKey = score.handicapped.maxPossible / ((score.taskTimeRemaining + score.taskDuration) / 3600);
                } else {
                    sortKey = (score.handicapped?.distanceRemaining || score.handicapped?.minPossible || 0) / ((score?.t - score?.utcStart) / 3600);
                }
                value = Math.round(sortKey * 10) / 10;
                suffix = 'kph';
            }
            return {compno: score.compno as Compno, value, sortKey, suffix};
        })
);

export const selectFastestActualSpeed = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllScores(state, t) //
    ],
    (_t: Epoch | undefined, scores: ScoreData): AllDisplayKeys =>
        Object.values(scores).map((score) => {
            let sortKey: number = Infinity;
            let value: any = undefined;
            let suffix: string = '';
            if (!score.utcStart || (score?.stationary && !score?.utcFinish)) {
                value = '-';
                sortKey = 0;
            } else {
                if (score.actual?.maxPossible && score.taskTimeRemaining && score.taskDuration && score.taskTimeRemaining > 0) {
                    // AAT and not time expired
                    sortKey = score.actual.maxPossible / ((score.taskTimeRemaining + score.taskDuration) / 3600);
                } else {
                    sortKey = (score.actual?.distanceRemaining || score.actual?.minPossible || 0) / ((score?.t - score?.utcStart) / 3600);
                }
                value = Math.round(sortKey * 10) / 10;
                suffix = 'kph';
            }
            return {compno: score.compno as Compno, value, sortKey, suffix};
        })
);

const remaining = (a) => Math.round(a?.distanceRemaining || a?.minPossible || 0);

export const selectRemaining = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllScores(state, t) //
    ],
    (_t: Epoch | undefined, scores: ScoreData): AllDisplayKeys =>
        Object.values(scores).map((score) => {
            const value = remaining(score.handicapped);
            return {
                compno: score.compno as Compno,
                value: score?.utcFinish ? 'finished' : value,
                sortKey: score?.utcFinish ? 0 : value || -Infinity,
                suffix: 'km'
            };
        })
);

export const selectActualRemaining = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllScores(state, t) //
    ],
    (_t: Epoch | undefined, scores: ScoreData): AllDisplayKeys =>
        Object.values(scores).map((score) => {
            const value = remaining(score.actual);
            return {
                compno: score.compno as Compno,
                value: score?.utcFinish ? 'finished' : value,
                sortKey: score?.utcFinish ? 0 : value || -Infinity,
                suffix: 'km'
            };
        })
);

export const selectDistance = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllScores(state, t) //
    ],
    (_t: Epoch | undefined, scores: ScoreData): AllDisplayKeys =>
        Object.values(scores).map((score) => {
            const value = Math.round(score.handicapped?.taskDistance || score.actual?.taskDistance || 0);
            return {
                compno: score.compno as Compno,
                value: value,
                sortKey: value,
                suffix: 'km'
            };
        })
);

export const selectActualDistance = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllScores(state, t) //
    ],
    (_t: Epoch | undefined, scores: ScoreData): AllDisplayKeys =>
        Object.values(scores).map((score) => {
            const value = Math.round(score.actual?.taskDistance || 0);
            return {
                compno: score.compno as Compno,
                value: value,
                sortKey: value,
                suffix: 'km'
            };
        })
);

export const selectStart = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllScores(state, t) //
    ],
    (_t: Epoch | undefined, scores: ScoreData): AllDisplayKeys =>
        Object.values(scores).map((score) => ({
            compno: score.compno as Compno,
            value: score.utcStart ?? null,
            sortKey: score.utcStart,
            converter: convertTime
        }))
);

export const selectFinish = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllScores(state, t) //
    ],
    (_t: Epoch | undefined, scores: ScoreData): AllDisplayKeys =>
        Object.values(scores).map((score) => ({
            compno: score.compno as Compno,
            value: score.utcFinish ?? null,
            sortKey: score.utcFinish,
            converter: convertTime
        }))
);

export const selectDuration = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllScores(state, t) //
    ],
    (_t: Epoch | undefined, scores: ScoreData): AllDisplayKeys =>
        Object.values(scores).map((score) => {
            const date = new Date(0);
            date.setSeconds(score.taskDuration);
            const iso = date.toISOString();
            return {
                compno: score.compno as Compno,
                value: iso.substring(11, 11 + 5),
                suffix: iso.substring(17, 17 + 2),
                sortKey: score.taskDuration
            };
        })
);

export const selectLD = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllScores(state, t) //
    ],
    (_t: Epoch | undefined, scores: ScoreData): AllDisplayKeys =>
        Object.values(scores).map((score) => {
            const gr = score.handicapped?.grRemaining ?? 0;
            if (score?.utcFinish) {
                return {compno: score.compno as Compno, value: 'finished', sortKey: 10000 + score.handicapped?.taskSpeed};
            } else if (gr > 200) {
                return {compno: score.compno as Compno, value: '∞', sortKey: gr};
            } else if (gr > 0) {
                return {compno: score.compno as Compno, value: Math.round(gr), suffix: ':1', sortKey: -gr};
            } else {
                return {compno: score.compno as Compno, value: '-', sortKey: -Infinity};
            }
        })
);

const selectActualLD = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllScores(state, t) //
    ],
    (_t: Epoch | undefined, scores: ScoreData): AllDisplayKeys =>
        Object.values(scores).map((score) => {
            const gr = score.actual?.grRemaining ?? 0;
            if (score?.utcFinish) {
                return {compno: score.compno as Compno, value: 'finished', sortKey: 10000 + score.actual?.taskSpeed};
            } else if (gr > 200) {
                return {compno: score.compno as Compno, value: '∞', sortKey: gr};
            } else if (gr > 0) {
                return {compno: score.compno as Compno, value: Math.round(gr), suffix: ':1', sortKey: -gr};
            } else {
                return {compno: score.compno as Compno, value: '-', sortKey: -Infinity};
            }
        })
);

const selectClimb = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllAverageClimb(state, t) //
    ],
    (_t: Epoch | undefined, climbs: Record<Compno, number | null>): AllDisplayKeys => {
        return Object.entries(climbs).map(([compno, average]: [Compno, number | null]) => {
            if (average === null) {
                return {compno, value: '-', sortKey: -Infinity, suffix: ''};
            }
            return {compno, sortKey: average, value: average, converter: convertClimb};
        });
    }
);

const selectHeight = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllPositions(state, t) //
    ],
    (_t: Epoch | undefined, positions): AllDisplayKeys => {
        return positions.map((p) => {
            if (!p.t) {
                return {compno: p.compno, value: '-', sortKey: -Infinity, suffix: ''};
            }
            return {compno: p.compno, sortKey: p.a, value: p.a, converter: convertHeight};
        });
    }
);

const selectHeightAgl = createSelector(
    [
        (_state: RootState, t: Epoch | undefined) => t,
        (state: RootState, t: Epoch | undefined) => selectAllPositions(state, t) //
    ],
    (_t: Epoch | undefined, positions): AllDisplayKeys => {
        return positions.map((p) => {
            if (!p.t) {
                return {compno: p.compno, value: '-', sortKey: -Infinity, suffix: ''};
            }
            return {compno: p.compno, sortKey: p.g, value: p.g, converter: convertHeight};
        });
    }
);

/*
export const selectPilotResult = createSelector(
    [
        (_state: RootState, _sortKey: SortKey, t: Epoch | undefined, units: Units, tz: TZ) => t,
        (_state: RootState, sortKey: SortKey, _t: Epoch | undefined) => sortKey,
        (_state: RootState, _sortKey: SortKey, t: Epoch | undefined, units: number, tz: string) => t,
        (state: RootState, _sortKey: SortKey, _t: Epoch | undefined) => selectAllScores(state ),
        (state: RootState, _sortKey: SortKey, t: Epoch | undefined) => selectAllVarios(state, t)
    ],
    (t: Epoch | undefined, sortKey: SortKey, scores: ScoreData, varios: VarioData) => {
        //
        // Map function
        function pilotSortKey(compno: Compno, score: PilotScore, vario: VarioData, t: Epoch | undefined): ShortDisplayKeys {
            var newKey;
            var suffix = '';
            var displayAs: number | string | null = null;

            // Make sure we actually have data..
            if (!score && !vario) {
                return {compno, sortKey: -9999999999999, displayAs: '-', units: '', icon: faCircleQuestion};
            }

            // Update delay numbers
            const delay = t === undefined ? vario.delay : null;

            let icon: IconDefinition | null = faCircleQuestion;

            if (!score) {
            } else if (score?.flightStatus == PositionStatus.Landed) {
                icon = faCow;
            } else if (score?.flightStatus == PositionStatus.Home) {
                icon = faHouse;
            } else if (score?.flightStatus == PositionStatus.Grid) {
                icon = faCirclePause;
            } else if (delay === null) {
                icon = null;
            } else if (delay > 100) {
                icon = delay > 300 ? faSignal : faClock;
            }

            if (score?.utcFinish) {
                icon = faTrophy;
            } else if (vario?.agl < 50) {
                // noop - done above
            } else if (vario?.average > 1) {
                icon = faCloudArrowUp;
            } else {
                icon = faPaperPlane;
            }

            if (!score && sortKey != 'height' && sortKey != 'aheight' && sortKey != 'auto') {
                return {compno, sortKey: -9999999999999, displayAs: '-', units: '', icon};
            }

            const remaining = (a) => Math.round((a?.distanceRemaining || a?.minPossible || 0) * 10) / 10;

            // data is in score.details.x
            switch (sortKey) {
                case 'start':
                    if (score.utcStart) {
                        [displayAs, suffix] = formatTime(score.utcStart, tz);
                    }
                    newKey = score.utcStart;
                    break;
                case 'finish':
                    if (score.utcFinish) {
                        [displayAs, suffix] = formatTime(score.utcFinish, tz);
                    }
                    newKey = score.utcFinish;
                    break;
                case 'duration':
                    if (!score.utcStart) {
                        displayAs = '-';
                        suffix = '';
                        newKey = '';
                    } else {
                        newKey = new Date(0);
                        newKey.setSeconds((score.utcFinish ? score.utcFinish : t) - score.utcStart);
                        const iso = newKey.toISOString();
                        newKey = -newKey.getTime() / 1000;
                        displayAs = iso.substr(11, 5);
                        suffix = iso.substr(17, 2);
                    }
                    break;
                case 'delay':
                    // Delay not relevant if home or finished
                    if (score.flightStatus == PositionStatus.Home || score?.utcFinish || delay === null) {
                        displayAs = '-';
                        suffix = '';
                        newKey = '0';
                    } else {
                        newKey = delay;
                        [displayAs] = delayToText(delay).split(' ');
                    }
                    break;
                case 'ld':
                    if (score?.utcFinish) {
                        displayAs = 'finished';
                        newKey = 99999;
                        suffix = '';
                    } else if ((score.handicapped?.grRemaining ?? 0) > 200) {
                        displayAs = '∞';
                        newKey = -9999;
                        suffix = '';
                    } else if ((score.handicapped?.grRemaining ?? 0) > 0) {
                        displayAs = Math.round(score.handicapped!.grRemaining!);
                        suffix = ':1';
                        newKey = -displayAs;
                    } else {
                        displayAs = '-';
                        newKey = -99998;
                        suffix = '';
                    }
                    break;
                case 'ald':
                    if (score?.utcFinish) {
                        displayAs = 'finished';
                        newKey = 99999;
                        suffix = '';
                    } else if ((score.actual?.grRemaining ?? 0) > 200) {
                        displayAs = '∞';
                        newKey = -9999;
                        suffix = '';
                    } else if ((score.actual?.grRemaining ?? 0) > 0) {
                        displayAs = Math.round(score.actual!.grRemaining!);
                        suffix = ':1';
                        newKey = -displayAs;
                    } else {
                        displayAs = '-';
                        newKey = -99999;
                        suffix = '';
                    }
                    break;
                case 'done':
                    newKey = score.handicapped?.taskDistance;
                    suffix = 'km';
                    break;
                case 'auto':
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
            _map(scores, (score, compno: Compno) => pilotSortKey(compno, score, varios[compno], t)),
            ['sortKey', 'compno']
        );
    }
);
*/

export const sortOrders = {
    auto: selectAuto,
    speed: selectSpeed,
    aspeed: selectActualSpeed,
    fspeed: selectFastestSpeed,
    faspeed: selectFastestActualSpeed,
    remaining: selectRemaining,
    aremaining: selectActualRemaining,
    climb: selectClimb,
    distance: selectDistance,
    adistance: selectActualDistance,
    height: selectHeight,
    aheight: selectHeightAgl,
    ld: selectLD,
    ald: selectActualLD,
    start: selectStart,
    finish: selectFinish,
    duration: selectDuration
};
