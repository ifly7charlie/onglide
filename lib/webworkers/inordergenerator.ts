import {Epoch, Datecode, ClassName, Compno, PositionMessage, InOrderGeneratorFunction, InOrderGenerator} from '../types';

import {sortedLastIndexBy, sortedIndexBy} from '../util/binarySearch';
import {BroadcastChannel} from 'node:worker_threads';

import {d, getNow} from '../now';

import {inorderAdditionalDelay} from '../constants';

//
// This subscribes to broadcast channel and ensures that the messages
// are returned in order, if it is unable to comply then it flags
// that a restart is required and replays the messages in the correct
// order
// NOTE: ONLY ONE EXECUTION OF GENERATOR ALLOWED!

export function bindChannelForInOrderPackets(
    className: ClassName,
    datecode: Datecode,
    compno: Compno,
    initialPoints: PositionMessage[],
    tick: boolean = false,
    once: boolean = false,
    log?: Function
): InOrderGeneratorFunction {
    //
    // And we need a way to notify and wake up our generator
    // that is not asynchronous. Once we have achieved this
    // all the rest of the logic can simply be reading from the
    // generator
    type ResolveNotificationFunction = (arg0: boolean) => void;
    let resolveNotifications: ResolveNotificationFunction[] = [];

    // We need somewhere to store the unprocessed message queue
    let messageQueue: PositionMessage[] = initialPoints;
    let messageQueueId = Math.random();

    //
    // Make sure we have some logging
    if (!log) {
        log = () => {
            /**/
        };
    }

    // Hook it up to the position messages so we can update our
    // displayed track we wrap the function with the class and
    // channel to simplify things
    const channelName = (className + datecode).toUpperCase();
    const broadcastChannel = new BroadcastChannel(channelName);

    const resolveAll = () => {
        const toNotify = resolveNotifications.slice();
        resolveNotifications.length = 0;
        toNotify.forEach((resolveFunction) => resolveFunction(false));
    };

    broadcastChannel.onmessage = (ev) => {
        // Get the message, and make sure it's for us
        let message = ev.data as PositionMessage;
        if (message.c != compno) {
            return;
        }

        // Reset on timestamp 0
        if (message.t == 0 && messageQueue.length) {
            log(`${message.c}: IOG: reset on t=0`);
            messageQueue = [];
            messageQueueId = Math.random();
            resolveAll();
            return;
        }

        // Figure out where to insert (sorted by time)
        const insertIndex = sortedLastIndexBy(messageQueue, message, (o) => o.t);

        // Sanity check, this should never happen
        if (messageQueue[insertIndex]?.t == message.t) {
            log(`${message.c}: IOG: unexpected duplicate packet`);
            return;
        }

        if (messageQueue.length != insertIndex) {
            log(
                `${message.c} IOG: ${message.t} inserting out of order ${insertIndex}/${messageQueue.length} ${d(message.t)} now: ${d(getNow())}, end: ${d(messageQueue.at(-1)?.t ?? 0)}/${JSON.stringify(messageQueue.at(-1))}`
            );
        }

        log(`${message.t}, live: ${message._}`);

        // Actually insert the point into the array
        messageQueue.splice(insertIndex, 0, message);

        resolveAll();
    };

    // Generate the next item in the sequence this will block until
    // values are ready and have been waiting for 30 seconds
    const inOrderGenerator = async function* (getNow: () => Epoch): InOrderGenerator {
        //
        // How far through are we
        let position = 0;
        let hiccup: Epoch = 0 as Epoch;
        const currentMessageQueueId = messageQueueId;

        log(`${className}/${compno}: IOG started ${messageQueue.length} initial messages`);

        //
        // Replay all before we start blocking, we will flag that it's a live message
        // when we get to the end which will result downstream events emitting a score
        while ((!messageQueue.length || !messageQueue[position]?._) && currentMessageQueueId == messageQueueId) {
            if (position >= messageQueue.length) {
                log(`${className}/${compno}: end of queue ${position} of ${messageQueue.length} messages, waiting...`);
                await new Promise((resolve) => resolveNotifications.push(resolve));
                continue;
            }

            const message = messageQueue[position];

            // Anchor the tick clock to the first message so we don't backfill from epoch 0.
            if (!hiccup) {
                hiccup = message.t;
            }

            // Emit a synthetic tick for every ~60s of gap between messages, before
            // yielding the position, so the EPG's gap-based landout/home detection runs
            // at the live tick cadence and stamps the Landed status (and its score) at
            // the time it occurred rather than at the next received position.
            let rewound = false;
            while (message.t - hiccup > 60) {
                hiccup = (hiccup + 60) as Epoch;
                const tickRewind = yield {c: compno, _: false, tick: true, t: hiccup};
                if (messageQueueId !== currentMessageQueueId) return;
                if (tickRewind) {
                    log(`${className}/${compno}: rewind to ${tickRewind} (hiccup)`);
                    for (; tickRewind && position > 0 && position < messageQueue.length && tickRewind < messageQueue[position].t; position--) {}
                    rewound = true;
                    break;
                }
            }
            if (rewound) {
                continue;
            }

            // Now yield the actual position message
            position++;
            const nextPoint = yield message;
            if (messageQueueId !== currentMessageQueueId) return;

            // If we need to go backwards then do so
            if (nextPoint) {
                for (position--; nextPoint && position > 0 && position < messageQueue.length && nextPoint < messageQueue[position].t; position--) {}
            }
        }

        let now: Epoch = getNow();
        log(`${className}/${compno}: initial replay done ${position}/${messageQueue.length} points, now: ${d(now)}, replayed to: ${d(messageQueue.at(-1)?.t ?? 0)} <${messageQueueId},${currentMessageQueueId}>`);

        // Bridge tick between replay and live: gives EPG a chance to fire
        // gap-based home/landout detection on the gap from the last replayed
        // point up to "now", before TPG starts emitting live-marked scores.
        // Without this, a rescore (or any restart that walks the persistent
        // queue) emits its first post-replay score with whatever cruise-state
        // flightStatus the last airborne fix had — even if the pilot has been
        // sat on the airfield for hours.
        {
            const bridgeNext = yield {c: compno, _: true, tick: true, t: (getNow() - inorderAdditionalDelay) as Epoch};
            if (messageQueueId !== currentMessageQueueId) return;
            if (bridgeNext) {
                position = sortedIndexBy(messageQueue, {t: bridgeNext} as any, (o) => o.t);
            }
        }

        // Find the position of the message we got up to, should always be increasing but better safe than sorry
        // as we may have had a reset of the message
        //        let position = sortedIndexBy(messageQueue, {t: now} as any, (o) => o.t);

        // Loop till we are told to stop (an exception on yield)
        while (messageQueueId === currentMessageQueueId) {
            // If we don't have a message we wait first; only emit a tick if the
            // wait expired without a message. This keeps the tick useful for EPG's
            // gap-based landout detection without firing one on every real fix.
            if (position >= messageQueue.length) {
                const timeout = setTimeout(() => resolveAll(), 60_000);
                await new Promise<boolean>((resolve) => resolveNotifications.push(resolve));
                clearTimeout(timeout);
                if (messageQueueId !== currentMessageQueueId) return;

                // >= (not ==) because the t=0 reset handler can clear messageQueue
                // while we're awaiting, leaving position stale and > length.
                if (position >= messageQueue.length) {
                    const nextPoint = yield {c: compno, _: true, tick: true, t: (getNow() - inorderAdditionalDelay) as Epoch};
                    if (messageQueueId !== currentMessageQueueId) return;
                    if (nextPoint) {
                        position = sortedIndexBy(messageQueue, {t: nextPoint} as any, (o) => o.t);
                    }
                    continue;
                }
            }

            // If we have a real message then process it
            const message = messageQueue[position++];
            now = message.t;
            log(` normal loop ${position}/${messageQueue.length}, ${now} < ${getNow()}`);
            const nextPoint = yield {...message, _: position == messageQueue.length};
            if (messageQueueId !== currentMessageQueueId) return;
            if (nextPoint) {
                position = sortedIndexBy(messageQueue, {t: nextPoint} as any, (o) => o.t);
            }
        }

        console.log(`Closing message loop for ${className}:${compno}, ${messageQueueId}<>${currentMessageQueueId}`);
    };

    return inOrderGenerator;
}
