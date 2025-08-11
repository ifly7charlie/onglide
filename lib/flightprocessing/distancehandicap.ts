/* this is from original site, being taken to pieces */
/* Copyright(c)2007-2020, Melissa Jenkins.  All rights reserved */

import type {Task, TaskLeg, DistanceKM} from '../types';
import {calculateTask} from './taskhelper';

import _clonedeep from 'lodash.clonedeep';

// Make a copy of the task reduced for the specified handicap
export function adjustDistanceHandicapTask(task: Task, handicap: number): Task {
    // Make a new array for it
    var newTask = _clonedeep(task);

    const eligibletps = task.legs.filter((leg) => leg.type == 'sector' && leg.r2 >= 0.5 && leg.a2 == 180)?.length ?? 0;
    if (!eligibletps) {
        console.error('no eligible legs found in task', task);
        return task;
    }
    // reduction amount (%ish)
    var maxhtaskLength = task.details.distance * (100 / task.rules.maxHandicap);
    const targetActualDistance = maxhtaskLength * (handicap / 100);

    var sectorSize = 0.5 + (task.details.distance - targetActualDistance) / (2 * eligibletps);

    // how far we need to move the radius in to achieve this reduction

    console.log(
        `dh ${task.details.class}: td: ${task.details.distance} handicaps: ${handicap}/${task.rules.maxHandicap}: maxhtaskLength:${maxhtaskLength}, targetActualDistance: ${targetActualDistance}, sectorSize: ${sectorSize}`
    );

    // Now copy over the points reducing all symmetric
    newTask.legs.slice(1, newTask.legs.length - 1).forEach((leg: TaskLeg) => {
        if (leg.type == 'sector' && leg.direction == 'symmetrical' && leg.r2 >= 0.5 && leg.a2 == 180) {
            leg.r2 = sectorSize as DistanceKM;
        }
    });

    // Calculate the sectors for the adjusted task
    calculateTask(newTask);
    console.log(`dh: adjust ${handicap}: actual distance: ${newTask.details.distance}, hcap distance: ${newTask.details.distance * (handicap / 100)}`);
    return newTask;
}
