import type {Task, Epoch} from '../types';
import type {API_ClassName_Task} from '../rest-api-types';

import {calculateTask, taskGeoJSON} from '../flightprocessing/taskhelper';
import {fromDateCode} from '../datecode';

// A working copy ready for scoring and display: calculateTask has run and
// the map geoJSON is derived
export interface PreparedTask {
    task: Task;
    geoJSON: ReturnType<typeof taskGeoJSON>;
}

// Prepare a task fetched from /api/[className]/task for use in the viewer.
// Always works on a fresh clone of the raw JSON — calculateTask mutates leg
// lengths destructively so it must run exactly once per task object, and the
// pristine raw copy is what a reset re-seeds from.
export function prepareApiTask(raw: API_ClassName_Task['task']): PreparedTask {
    const task = structuredClone(raw) as Task;
    calculateTask(task);
    return {task, geoJSON: taskGeoJSON(task)};
}

// Move the start gate onto the IGC file's calendar day, preserving UTC
// time-of-day (which already embeds the competition tzoffset). Without this a
// file from a different day than the task never scores a start — the task
// position generator drops every fix before the gate. No-op when the days
// match or the gate is 0 (open). epochBase is the file's UTC midnight, the
// same convention fromDateCode + Date.parse produce for the task's datecode.
export function rebaseTaskStart(task: Task, epochBase: Epoch): void {
    if (!task.rules.nostartutc) {
        return;
    }
    const taskDayUtc = Date.parse(fromDateCode(task.details.datecode)) / 1000;
    const delta = epochBase - taskDayUtc;
    if (delta) {
        task.rules.nostartutc = (task.rules.nostartutc + delta) as Epoch;
        task.details.nostartutc = (task.details.nostartutc + delta) as Epoch;
    }
}
