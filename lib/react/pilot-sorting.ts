import {SortKey, Compno} from '../types';

export interface ShortDisplayKeys {
    compno: Compno;
    sortKey: string | number;
    displayAs: string | number | null;
    units: string;
    icon: string | any;
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
