// Binary-search helpers replacing lodash sortedIndex / sortedIndexBy / sortedLastIndexBy.
// ArrayLike so typed arrays (Uint32Array.subarray) work without copying.

export function sortedIndexBy<T>(arr: ArrayLike<T>, value: T, key: (x: T) => number): number {
    const target = key(value);
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (key(arr[mid]) < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export function sortedLastIndexBy<T>(arr: ArrayLike<T>, value: T, key: (x: T) => number): number {
    const target = key(value);
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (key(arr[mid]) <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export function sortedIndexNumber(arr: ArrayLike<number>, value: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] < value) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
