/*
 *
 * This will return a GeoJSON object for the task with taskid specified
 *
 */

import {query, mysqlEnd} from '../../../lib/react/db';
import escape from 'sql-template-strings';

// Helpers to deal with sectors and tasks etc.
import {preprocessSector, sectorGeoJSON} from '../../../lib/flightprocessing/taskhelper';

import bbox from '@turf/bbox';
import along from '@turf/along';
import {lineString} from '@turf/helpers';

import _reduce from 'lodash/reduce';
import _map from 'lodash/map';

import {useRouter} from 'next/router';

export default async function taskHandler(req, res) {
    const {
        query: {className}
    } = req;

    if (!className) {
        console.log('no class');
        res.status(404).json({error: 'missing parameter(s)'});
        return;
    }

    let task = await query(
        process.env.REPLAY
            ? escape`
      SELECT tasks.*, c.Dm
      FROM tasks, compstatus cs, classes c
      WHERE (((${process.env.REPLAY || ''}) = '' AND tasks.datecode= cs.datecode) OR (${process.env.REPLAY || ''} != '' AND tasks.datecode=todcode(from_unixtime(${process.env.REPLAY}))))
        AND cs.class = ${className} AND tasks.class = cs.class AND c.class=${className}
        AND tasks.flown = 'Y'
                           `
            : escape`
      SELECT tasks.*, c.Dm
      FROM tasks, compstatus cs, classes c
      WHERE tasks.datecode= cs.datecode AND c.class=${className}
        AND cs.class = ${className} AND tasks.class = cs.class
        AND tasks.flown = 'Y'
                           `
    );

    if (!task.length || !task[0].taskid) {
        console.log(`geoTask: no task for ${className}`, task);
        res.setHeader('Cache-Control', 's-maxage=60');
        res.status(204).end();
        return;
    }

    let tasklegs = await query(escape`
      SELECT taskleg.*, nname name, 0 altitude
      FROM taskleg
      WHERE taskleg.taskid = ${task[0].taskid}
      ORDER BY legno`);

    if (!tasklegs?.length) {
        console.log(`geoTask: invalid task for ${className}`, task, tasklegs);
        res.setHeader('Cache-Control', 's-maxage=90');
        res.status(204).end();
        return;
    }

    // Get the legs ready for handling
    tasklegs.forEach((leg) => {
        preprocessSector(leg);
    });

    // Prep names and look for duplicates
    let names = {};
    tasklegs[0].text = 'S';
    tasklegs[tasklegs.length - 1].text = 'F';
    tasklegs.map((leg) => {
        if (!leg.text) {
            leg.text = leg.legno;
        }
        const n = leg.text;
        if (!names[leg.trigraph]) {
            names[leg.trigraph] = {point: leg.point, name: n};
        } else {
            names[leg.trigraph].name += '_' + n;
        }
    });

    // Check distances (not used at present)
    //    const taskLength = calculateTaskLength( tasklegs );

    // Now calculate the objects, they get added to each turnpoint
    tasklegs.forEach((leg) => {
        sectorGeoJSON(tasklegs, leg.legno);
    });

    let geoJSON = {
        type: 'FeatureCollection',
        features: []
    };

    tasklegs.forEach((leg) => {
        geoJSON.features = [].concat(geoJSON.features, [{type: 'Feature', properties: {leg: leg.legno}, geometry: leg.geoJSON}]);
    });

    let trackLineGeoJSON = {
        type: 'FeatureCollection',
        features: []
    };

    trackLineGeoJSON.features = _reduce(
        tasklegs,
        (accumulate, leg, index) => {
            if (index + 1 < tasklegs.length) {
                accumulate.push({
                    type: 'Feature',
                    properties: {leg: leg.legno + 1},
                    geometry: {
                        type: 'LineString',
                        coordinates: [
                            [leg.nlng, leg.nlat],
                            [tasklegs[index + 1].nlng, tasklegs[index + 1].nlat]
                        ]
                    }
                });
            }
            return accumulate;
        },
        []
    );

    const taskPath = lineString(_map(tasklegs, (leg) => [leg.nlng, leg.nlat]));

    // How long should it be cached
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=300');

    const Dm = task[0].Dm && task[0].type == 'S' ? {Dm: along(taskPath, task[0].Dm)} : {};

    // And we succeeded - here is the json
    res.status(200).json({tp: geoJSON, track: trackLineGeoJSON, ...Dm});

    // Done
    mysqlEnd();
}
