import {lruMemoize, createSelector as cs, createSelectorCreator} from '@reduxjs/toolkit';

import {Units, SortKey, Epoch, TZ, Compno, PilotScore, ScoreData, VarioData, AltitudeAgl, TrackData, PositionStatus} from '../types';

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
    // hour12: false forces 24-hour even for locales that default to 12-hour.
    // Previously this used 'uk' (Ukrainian) as a side-effect; the new form
    // lets the user's actual locale dictate digit shape and ordering.
    const dt = new Date(i.value * 1000);
    return {...i, value: dt.toLocaleTimeString(undefined, {timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false}), suffix: (i.value % 60 < 10 ? '0' : '') + dt.toLocaleTimeString(undefined, {timeZone: tz, second: '2-digit'})};
}

import type {RootState} from './store';
import {selectAllScores} from './scoresSlice';
import {selectAllPositions, selectAllAverageClimb, selectAllAMSL} from './tracksSlice';

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
        (state: RootState, t: Epoch | undefined) => selectAllAMSL(state, t)
    ],
    (t: Epoch | undefined, scores: ScoreData, altitudes): AllDisplayKeys => {
        const nowIsh = t ? t : Object.values(scores).reduce((m, v) => (v.t && v.t > m ? v.t : m), 0);
        return Object.values(scores)
            .map((score) => {
                if (!score.compno) {
                    return undefined;
                }
                const amsl = altitudes[score.compno as Compno];

                let sortKey: number = Infinity;
                let value: any = undefined;
                let suffix: string = '';
                let converter: OptionalConverterFunction | null = null;

                // If it is scored then distance or speed
                // Before they start show altitude, sort to the end of the list
                if (!score || score.flightStatus == PositionStatus.Unknown) {
                    sortKey = -2;
                    value = '-';
                } else if (score.flightStatus == PositionStatus.Blocked) {
                    // Pilot is identified but DDB Permit-Livetracking is N
                    // (and no comp-level consent) — sort to the very end.
                    sortKey = -3;
                    value = '-';
                } else if (score.flightStatus == PositionStatus.Grid || (!score.utcStart && score.flightStatus == PositionStatus.Home)) {
                    sortKey = -1;
                    value = '-';
                } else if (!score.utcStart) {
                    sortKey = amsl / 10000;
                    value = amsl;
                    converter = convertHeight;
                } else {
                    // After start, it's speed if we have recent points and are airborne or finished
                    // or distance if they have distance, otherwise just height
                    var speed = score.handicapped?.taskSpeed || score.actual?.taskSpeed || 0;
                    var distance = score.handicapped?.taskDistance || score.actual?.taskDistance || 0;

                    //                    console.log(score.compno, score.utcFinish, speed, distance, nowIsh, score.t);
                    if (score.utcFinish || (speed > 5 && speed < 300 && score.flightStatus == PositionStatus.Airborne && nowIsh - score.t < 1800)) {
                        sortKey = 10000 + Math.round(speed * 10);
                        value = Math.round(speed);
                        suffix = 'kph';
                    } else if (distance > 7.5) {
                        sortKey = Math.round(distance * 10);
                        value = Math.round(distance);
                        suffix = 'km';
                    } else {
                        sortKey = amsl / 10000;
                        value = amsl;
                        converter = convertHeight;
                    }
                }
                return converter ? {compno: score.compno as Compno, sortKey, value, converter} : {compno: score.compno as Compno, sortKey, value, suffix};
            })
            .filter((t) => !!t);
    }
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
            if (!score.utcStart) {
                return {
                    compno: score.compno as Compno,
                    value: '-',
                    sortKey: -1
                };
            }

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
                return {compno: score.compno as Compno, value: '∞', sortKey: -gr};
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
                return {compno: score.compno as Compno, value: '∞', sortKey: -gr};
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
