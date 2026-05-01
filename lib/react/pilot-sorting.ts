import {SortKey, Compno} from '../types';

export interface ShortDisplayKeys {
    compno: Compno;
    sortKey: string | number;
    displayAs: string | number | null;
    units: string;
    icon: string | any;
}
// Translation keys (under `sort.*` in common.json) for the sort tooltip
// shown when the column is interpreted in handicapped mode.
const handicappedDescriptions: Record<string, string> = {
    auto: 'sort.auto_handicap',
    speed: 'sort.speed_handicap',
    aspeed: 'sort.speed_actual',
    fspeed: 'sort.speed_finish_handicap',
    faspeed: 'sort.speed_finish_actual',
    height: 'sort.height_amsl',
    aheight: 'sort.height_agl',
    climb: 'sort.climb',
    ld: 'sort.ld_handicap',
    ald: 'sort.ld_actual',
    remaining: 'sort.remaining_handicap',
    distance: 'sort.distance_handicap',
    aremaining: 'sort.remaining_actual',
    adistance: 'sort.distance_actual',
    start: 'sort.start',
    finish: 'sort.finish',
    duration: 'sort.duration'
};

export const handicappedSortOrders: Record<string, SortKey[]> = {
    auto: ['auto'],
    speed: ['speed', 'aspeed', 'fspeed', 'faspeed'],
    height: ['height', 'aheight'],
    climb: ['climb'],
    ld: ['ld', 'ald'],
    remaining: ['remaining', 'aremaining'],
    distance: ['distance', 'adistance'],
    times: ['start', 'duration', 'finish']
};

// Translation keys for the non-handicapped tooltip variant. Some keys are
// only valid in handicapped mode (e.g. fspeed) and so are absent here.
const descriptions: Record<string, string> = {
    auto: 'sort.auto_actual',
    aspeed: 'sort.speed_actual',
    faspeed: 'sort.speed_finish_actual_alt',
    height: 'sort.height_amsl',
    aheight: 'sort.height_agl',
    climb: 'sort.climb',
    ald: 'sort.ld_actual',
    aremaining: 'sort.remaining_actual',
    adistance: 'sort.distance_actual',
    start: 'sort.start',
    finish: 'sort.finish',
    duration: 'sort.duration'
};

export const nonHandicappedSortOrders: Record<string, SortKey[]> = {
    auto: ['auto'],
    speed: ['aspeed', 'faspeed'],
    height: ['height', 'aheight'],
    climb: ['climb'],
    ld: ['ald'],
    remaining: ['aremaining'],
    distance: ['adistance'],
    times: ['start', 'duration', 'finish']
};

// Translation keys for the short button label in the sort sub-menu (e.g.
// "Hcap" / "Actual"). These resolve to entries under `sort.*` in common.json.
const shortLabelKeys: Record<string, string> = {
    auto: 'sort.label_auto',
    speed: 'sort.label_hcap',
    aspeed: 'sort.label_actual',
    fspeed: 'sort.label_finish_hcap',
    faspeed: 'sort.label_finish_actual',
    height: 'sort.label_amsl',
    aheight: 'sort.label_agl',
    climb: 'sort.label_avg',
    ld: 'sort.label_hcap',
    ald: 'sort.label_actual',
    remaining: 'sort.label_hcap',
    aremaining: 'sort.label_actual',
    distance: 'sort.label_hcap',
    adistance: 'sort.label_actual',
    start: 'sort.label_start',
    finish: 'sort.label_finish',
    duration: 'sort.label_duration'
};

export function getShortLabel(id: SortKey): string | undefined {
    return shortLabelKeys[id];
}

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
        const orders = handicapped ? handicappedSortOrders[key] : nonHandicappedSortOrders[key];
        return orders[0];
    }
}

//
// This will figure out what the next sort order should be based on the current one
export function nextSortOrder(key: SortKey, current: SortKey, handicapped: boolean) {
    // Toggle through the options
    const orders = handicapped ? handicappedSortOrders[key] : nonHandicappedSortOrders[key];
    const index = orders.indexOf(current) || 0;
    const order = orders[(index + 1) % orders.length];

    // And return
    return order;
}
