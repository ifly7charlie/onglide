//
// Private

import _foreach  from 'lodash.foreach'
import { convertHeight, convertClimb } from './displayunits.js';
import { delayToText, formatTime } from './timehelper.js';

export function updateSortKeys(trackers,sortKey,units,now,tz) {

    function updatePilotSortKey(tracker,sortKey,units,now,tz) {

        var newKey;
        var suffix = '';
        var displayAs = undefined;

		// Update delay numbers
		const delay = (now) - (tracker.lastUpdated||0);
		tracker.delay = delay;

        // data is in tracker.details.x
        switch( sortKey ) {
        case 'speed':
            displayAs = Math.round(newKey=tracker.hspeed); suffix = "kph";
            break;
        case 'aspeed':
            displayAs = Math.round(newKey=tracker.speed); suffix = "kph";
            break;
        case 'fspeed':
            if( tracker.stationary && ! tracker.utcfinish ) {
                displayAs = '-';
            } else {
                newKey = tracker.utcduration ? tracker.htaskdistance / (tracker.utcduration/3600) : 0;
                displayAs = Math.round(newKey*10)/10;
                suffix = "kph";
            }
            break;
        case 'climb':
            newKey = tracker.average; [displayAs,suffix] = convertClimb(newKey,units);
            break;
        case 'remaining':
            newKey = Math.round(tracker.hremainingdistance); suffix = "km";
            break;
        case 'aremaining':
            newKey = Math.round(tracker.remainingdistance); suffix = "km";
            break;
        case 'distance':
            newKey = Math.round(tracker.hdistancedone); suffix = "km";
            break;
        case 'adistance':
            newKey = Math.round(tracker.distancedone); suffix = "km";
            break;
        case 'height':
				newKey = Math.round(tracker.altitude); 
				[displayAs,suffix] = convertHeight(newKey,units);
            break;
        case 'aheight':
				newKey = Math.round(tracker.agl||0); 
				[displayAs,suffix] = convertHeight(newKey,units);
            break;
        case 'start':
            if( tracker.utcstart ) {
				[displayAs,suffix] = formatTime( tracker.utcstart, tz );
            }
            newKey = tracker.utcstart;
            break;
		case 'finish':
				if( tracker.utcfinish ) {
					[displayAs,suffix] = formatTime( tracker.utcfinish, tz );
				}
				newKey = tracker.utcfinish;
            break;
		case 'duration':
			if( tracker.finish && tracker.finish != '00:00:00' && ! tracker.utcduration ) {
				displayAs = '-';
				suffix = '';
				newKey = '';
			}
			else if( tracker.utcstart ) {
				if( tracker.duration != '00:00:00') {
					displayAs = tracker.duration.substr(0,5);
					suffix = tracker.duration.substr(5,2);
					newKey = -tracker.utcduration;
				}
				else {
					newKey = new Date(0);
					newKey.setSeconds( tracker.utcfinish ? tracker.utcfinish : (now - tracker.utcstart));
					const iso = newKey.toISOString();
					newKey = -newKey.getTime()/1000;
					displayAs = iso.substr(11,5);
					suffix = iso.substr(17,2);
				}
            }
            break;
        case 'ld':
            if( tracker.hgrremaining > 0 ) {
                displayAs = Math.round(tracker.hgrremaining); suffix = ":1";
                newKey = -displayAs;
            }
            else {
                displayAs = '-';
                newKey = -99999;
                suffix = '';
            }
            break;
        case 'ald':
            if( tracker.grremaining > 0 ) {
                displayAs = Math.round(tracker.grremaining); suffix = ":1";
                newKey = -displayAs;
            }
            else {
                displayAs = '-';
                newKey = -99999;
                suffix = '';
            }
            break;
        case 'done':
            newKey = tracker.hdistancedone; suffix = "km";
            break;
        case 'auto':
            // If it is scored then distance or speed
            if( tracker.datafromscoring == 'Y' || tracker.scoredstatus != 'S'  ) {
                if( tracker.scoredstatus == 'D' || tracker.dbstatus == 'D' ) {
                    newKey = -1; displayAs = '-';
                }
                else if( tracker.scoredstatus == 'F' ) {
                    newKey = 10000+Math.round(tracker.hspeed*10); displayAs = tracker.hspeed.toFixed(1); suffix = "kph";
                }
                else {
                    newKey = Math.round(tracker.hdistancedone*10); displayAs = tracker.hdistancedone.toFixed(1); suffix = "km";
                }
            }
            // Before they start show altitude, sort to the end of the list
            else if( tracker.dbstatus == 'G' ) {
                newKey = tracker.agl/10000;
				[displayAs,suffix] = convertHeight(tracker.agl||0,units);
            }
            else if( tracker.dbstatus == 'D' ) {
                newKey = -1; displayAs = '-';
            }
            // After start but be
            else {
                var speed = tracker.hspeed;
                var distance = tracker.hdistancedone;

                if( (speed > 5 && tracker.delay < 3600) || (tracker.utcfinish) ) {
                    newKey = 10000+Math.round(speed*10); displayAs = Math.round(speed); suffix = "kph";
                }
                else if( distance > 5 ) {
                    newKey = Math.round(distance*10); displayAs = Math.round(distance); suffix = "km";
                }
                else {
                    newKey = tracker.agl/10000; 
					[displayAs,suffix] = convertHeight(tracker.agl||0,units);
                }
            }
        }
        if( ! newKey ) {
            newKey = '';
            suffix = '';
        }

        if( displayAs !== undefined ) {
            if( ! displayAs ) {
                displayAs = '-';
            }
        }
        else {
            if( newKey != '' ) {
                displayAs = newKey;
            }
            else {
                displayAs = '-';
            }
        }

        tracker.sortKey = newKey;
        tracker.displayAs = displayAs;
        tracker.units = suffix;
    }

    _foreach( trackers, (tracker) => {
        updatePilotSortKey( tracker, sortKey, units, now, tz );
    });
}

// list of descriptions
const descriptions =    {
const handicappedDescriptions =    {
    "auto":"Handicapped speed, distance or height agl",
    "speed":"Current handicapped speed",
    "aspeed":"Current actual speed",
    "fspeed":"Fastest possible handicapped speed assuming finishing now",
    "height":"Current height above sea level",
    "aheight":"Current height above ground",
    "climb":"Recent average height change",
    "ld":"Handicapped L/D remaining",
    "ald":"Actual L/D remaining",
    "remaining":"Handicapped distance remaining",
    "distance":"Handicapped distance completed",
    "aremaining":"Actual distance remaining",
    "adistance":"Actual distance completed",
    "start":"Start time",
    "finish":"Finish time",
    "duration":"Task duration",
};

const sortOrders = {
const handicappedSortOrders = {
    "auto": [ "auto" ],
    "speed" : ['speed','aspeed','fspeed'],
    "height": ['aheight','height'],
    "climb": ['climb'],
    "ld": ['ld','ald'],
    "remaining": ['remaining','aremaining'],
    "distance": ['distance','adistance'],
    "times":['start','duration','finish'],
}

export function getSortDescription(id) {
    return descriptions[id];
    return handicapped ? handicappedDescriptions[id] : descriptions[id];
}

//
// This will figure out what the next sort order should be based on the current one
export function nextSortOrder(key,current) {
export function nextSortOrder(key,current,handicapped) {

    // Toggle through the options
    const orders = sortOrders[key];
    const orders = handicapped ? handicappedSortOrders[key] : sortOrders[key];
    const index = orders.indexOf( current );
    const order = orders[ (index+1) % orders.length ];

    // And return
    return order;
}
