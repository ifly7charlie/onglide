import {useState, useCallback, useRef} from 'react';

export interface ElementSize {
    width: number;
    height: number;
}

// Tracks an element's rendered size via a ResizeObserver. Returns a callback
// ref to attach to the element and its current size. Using a callback ref (vs a
// plain ref + effect) means the observer is (re)wired exactly when the element
// mounts/unmounts — no dependency array to keep in sync with conditional
// rendering. The size is read synchronously on attach so consumers get a real
// value before the first ResizeObserver callback fires.
export function useElementSize<T extends HTMLElement>(): [(node: T | null) => void, ElementSize] {
    const [size, setSize] = useState<ElementSize>({width: 0, height: 0});
    const roRef = useRef<ResizeObserver | null>(null);
    const ref = useCallback((node: T | null) => {
        roRef.current?.disconnect();
        if (!node) return;
        const update = () => {
            const r = node.getBoundingClientRect();
            setSize((prev) => (prev.width === r.width && prev.height === r.height ? prev : {width: r.width, height: r.height}));
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(node);
        roRef.current = ro;
    }, []);
    return [ref, size];
}
