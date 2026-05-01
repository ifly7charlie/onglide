// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// ThrottledQueue — a tiny dedup + drain + jitter queue shared by the FAI
// ranking-lookup worker and the pilot-image download worker. Both paths
// need the same shape:
//
//   - fire-and-forget enqueue from hot paths (upsertPilot, fetchPilots)
//   - dedup by a stable key so re-entries during the drain window are
//     no-ops
//   - sequential drain by a single background worker, sleeping a
//     jittered interval between items so we don't hammer whatever
//     upstream the per-item handler talks to
//   - errors inside a handler are logged and do not stop the drain
//
// Generic over the request type; caller supplies `keyOf`, `handle`, and
// the throttle window.
//

export interface ThrottledQueueOptions<T> {
    // Stable dedup key — re-enqueues that map to the same key while the
    // item is still queued (or in-flight) are silently dropped.
    keyOf: (req: T) => string;
    // Per-item work. Errors are caught and logged; the loop keeps going.
    handle: (req: T) => Promise<void>;
    // Log sink. Only used for the "handler threw" breadcrumb.
    log: (msg: string, ...args: unknown[]) => void;
    // Jittered throttle window between successive items. The last item
    // in a batch skips the sleep (no point waiting if there's nothing
    // next), so a single isolated enqueue completes immediately.
    minMs: number;
    maxMs: number;
    // Tag used in the "handler threw" log line so both queues can be
    // told apart in output.
    name: string;
}

export class ThrottledQueue<T> {
    private readonly queue: T[] = [];
    private readonly inflight = new Set<string>();
    private running = false;

    constructor(private readonly opts: ThrottledQueueOptions<T>) {}

    enqueue(req: T): void {
        const key = this.opts.keyOf(req);
        if (this.inflight.has(key)) return;
        this.inflight.add(key);
        this.queue.push(req);
        if (!this.running) {
            void this.drain();
        }
    }

    private async drain(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            while (this.queue.length) {
                const req = this.queue.shift()!;
                this.inflight.delete(this.opts.keyOf(req));
                try {
                    await this.opts.handle(req);
                } catch (e) {
                    this.opts.log(`${this.opts.name}: handler threw:`, e);
                }
                if (this.queue.length) {
                    const span = this.opts.maxMs - this.opts.minMs;
                    const delay = this.opts.minMs + Math.random() * span;
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        } finally {
            this.running = false;
        }
    }
}
