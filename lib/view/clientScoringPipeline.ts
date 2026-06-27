import type {Compno, Epoch, PositionMessage, AirfieldLocation, Task, TZ, AltitudeAMSL} from '../types';
import type {PilotScore, Stats} from '../protobuf/onglide';

import {point as turfPoint} from '@turf/helpers';

import {bindClientInOrderGenerator} from './clientInOrderGenerator';

import {enrichedPositionGenerator} from '../webworkers/enrichedPositionGenerator';
import {taskPositionGenerator} from '../webworkers/taskpositiongenerator';
import {racingScoringGenerator} from '../webworkers/racingScoringGenerator';
import {assignedAreaScoringGenerator} from '../webworkers/assignedAreaScoringGenerator';
import {taskScoresGenerator} from '../webworkers/taskScoresGenerator';
import {createFlightStatistics} from '../webworkers/flightStatistics';
import {noopGliderLog} from '../webworkers/gliderLog';

import {PreparedTurnpoint} from '../flightprocessing/preparedTurnpoint';

function deriveAirfield(task: Task, fixes: PositionMessage[]): AirfieldLocation {
    // Use the glider's initial position as airfield location (not task start point)
    // This is critical: the enrichedPositionGenerator uses distance from airfield
    // to distinguish "Grid" (near airfield) from "Landed" (far from airfield).
    // If we use the task start TP, a glider sitting on a distant airfield grid
    // would be detected as "landed out" before the flight even begins.
    const firstFix = fixes[0];
    const firstFixAlt = firstFix?.a ?? 0;

    return {
        name: 'IGC Airfield',
        tz: 'Etc/UTC' as TZ,
        tzoffset: 0,
        sunset: ((fixes.at(-1)?.t ?? 0) + 7200) as Epoch, // 2 hours after last fix
        lat: firstFix?.lat ?? task.legs[0].nlat,
        lng: firstFix?.lng ?? task.legs[0].nlng,
        start: '',
        end: '',
        officialDelay: 0 as Epoch,
        altitude: firstFixAlt as AltitudeAMSL,
        point: turfPoint([firstFix?.lng ?? task.legs[0].nlng, firstFix?.lat ?? task.legs[0].nlat])
    };
}

export interface IGCScoreResult {
    scores: PilotScore[];
    stats: Stats | undefined;
}

export async function scoreIGCFlight(
    task: Task,
    fixes: PositionMessage[],
    compno: Compno,
    handicap: number = 100,
    utcStart: Epoch = 0 as Epoch
): Promise<IGCScoreResult> {
    if (!fixes.length || !task.legs.length) {
        return {scores: [], stats: undefined};
    }

    // Ensure preparedLegs exist
    if (!task.preparedLegs) {
        task.preparedLegs = task.legs.map((_leg, i) => new PreparedTurnpoint(task.legs, i));
    }

    const airfield = deriveAirfield(task, fixes);

    // Create the getNow function for the inorder generator
    const lastFixTime = fixes[fixes.length - 1].t;
    const getNow = () => lastFixTime;

    // Build the scoring chain (same pattern as getScoringChain in scoring.ts).
    // No per-glider log file client-side — use the no-op logger.
    const log = noopGliderLog;
    const stats = createFlightStatistics();
    const inorder = bindClientInOrderGenerator(compno, fixes);
    const epg = enrichedPositionGenerator(airfield, inorder(getNow), log);
    const tpg = taskPositionGenerator(task, utcStart, epg, log);
    const distances = task.rules.aat //
        ? assignedAreaScoringGenerator(task, tpg, log)
        : racingScoringGenerator(task, tpg, log);
    const scores = taskScoresGenerator(task, compno, handicap, distances, log);

    // Feed the (sorted) IGC fixes into the incremental stats unit in step with
    // score emission, so each score carries the wind known up to its own time
    // and the full Stats are returned alongside.
    const allScores: PilotScore[] = [];
    let fi = 0;
    for await (const score of scores) {
        if (!score) continue;
        while (fi < fixes.length && fixes[fi].t <= score.t) stats.addPosition(fixes[fi++]);
        const wind = stats.getWind();
        if (wind) score.wind = wind;
        allScores.push(score);
    }
    // Drain any trailing fixes so the returned Stats cover the whole flight.
    while (fi < fixes.length) stats.addPosition(fixes[fi++]);

    return {scores: allScores, stats: stats.getStats()};
}
