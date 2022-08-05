import {BasePositionMessage} from '../types';

//
// https://en.wikibooks.org/wiki/Algorithm_Implementation/Geometry/Convex_hull/Monotone_chain
function cross(a, b, o) {
    return (a.lat - o.lat) * (b.lng - o.lng) - (a.lng - o.lng) * (b.lat - o.lat);
}

/**
 * @param points An array of [X, Y] coordinates
 */
export function convexHull(points: BasePositionMessage[]): BasePositionMessage[] {
    points.sort(function (a: BasePositionMessage, b: BasePositionMessage) {
        return a.lat == b.lat ? a.lng - b.lng : a.lat - b.lat;
    });

    if (points.length < 2) {
        return [].concat(...points);
    }

    var lower = [];
    for (var i = 0; i < points.length; i++) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], points[i]) <= 0) {
            lower.pop();
        }
        lower.push(points[i]);
    }

    var upper = [];
    for (var i = points.length - 1; i >= 0; i--) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], points[i]) <= 0) {
            upper.pop();
        }
        upper.push(points[i]);
    }

    upper.pop();
    lower.pop();
    return lower.concat(upper);
}
