import {Epoch, Datecode, ClassName, Compno, PositionMessage, InOrderGeneratorFunction, InOrderGenerator} from '../types';

import {sortedLastIndexBy as _sortedLastIndexBy, sortedIndexBy as _sortedIndexBy} from 'lodash';
import {BroadcastChannel} from 'node:worker_threads';

import {d} from '../now';

//
// This subscribes to broadcast channel and ensures that the messages
// are returned in order, if it is unable to comply then it flags
// that a restart is required and replays the messages in the correct
// order
// NOTE: ONLY ONE EXECUTION OF GENERATOR ALLOWED!

export function bindChannelForInOrderPackets(className: ClassName, datecode: Datecode, compno: Compno, initialPoints: PositionMessage[], tick: boolean = false, once: boolean = false): InOrderGeneratorFunction {
    //
    // And we need a way to notify and wake up our generator
    // that is not asynchronous. Once we have achieved this
    // all the rest of the logic can simply be reading from the
    // generator
    type ResolveNotificationFunction = (boolean) => void;
    let resolveNotifications: ResolveNotificationFunction[] = [];

    // We need somewhere to store the unprocessed message queue
    let messageQueue: PositionMessage[] = initialPoints;
    let messageQueueId = Math.random();

    const log = compno == '!TJ' ? (...a) => console.log(compno + ':', ...a) : () => {};

    // Hook it up to the position messages so we can update our
    // displayed track we wrap the function with the class and
    // channel to simplify things
    const channelName = (className + datecode).toUpperCase();
    const broadcastChannel = new BroadcastChannel(channelName);
    broadcastChannel.onmessage = (ev: MessageEvent<PositionMessage>) => {
        // Get the message, and make sure it's for us
        let message = ev.data as PositionMessage;
        if (message.c != compno) {
            return;
        }

        // Reset on timestamp 0
        if (message.t == 0 && messageQueue.length) {
            console.log(`${message.c}: IOG: reset on t=0`);
            messageQueue = [];
            messageQueueId = Math.random();
            return;
        }

        // Figure out where to insert (sorted by time)
        const insertIndex = _sortedLastIndexBy(messageQueue, message, (o) => o.t);

        // Sanity check, this should never happen
        if (messageQueue[insertIndex]?.t == message.t) {
            console.log(`${message.c}: IOG: unexpected duplicate packet`);
            return;
        }

        if (messageQueue.length != insertIndex) {
            console.log(`${message.c} IOG: ${message.t} inserting out of order ${insertIndex}/${messageQueue.length} ${d(message.t)} end: ${d(messageQueue.at(-1)?.t ?? 0)}`);
        }

        log(`${message.t}, live: ${message._}`);

        // Actually insert the point into the array
        messageQueue.splice(insertIndex, 0, message);

        const toNotify = resolveNotifications.slice();
        resolveNotifications.length = 0;
        toNotify.forEach((resolveFunction) => resolveFunction(false));
    };

    // Generate the next item in the sequence this will block until
    // values are ready and have been waiting for 30 seconds
    const inOrderGenerator = async function* (getNow: () => Epoch): InOrderGenerator {
        //
        // How far through are we
        let position = 0;
        let hiccup: Epoch = 0 as Epoch;
        const currentMessageQueueId = messageQueueId;

        console.log(`${className}/${compno}: IOG started ${messageQueue.length}`);
        if (!messageQueue.length) {
            await new Promise((resolve) => resolveNotifications.push(resolve));
        }
        console.log(`${className}/${compno}: IOG first message ${messageQueue.length}`);

        //
        // Replay all before we start blocking, we will flag that it's a live message
        // when we get to the end which will result downstream events emitting a score
        while (!messageQueue[position]?._ && currentMessageQueueId == messageQueueId) {
            if (position == messageQueue.length) {
                log('end of queue', position, messageQueue.length);
                // Skip all the ticks, they shouldn't happen but don't wait forever
                let count = 0;
                for (; count < 10 && (await new Promise<boolean>((resolve) => resolveNotifications.push(resolve))); count++) {}
                log(` more messages found... ${count} waits`);
                // don't process it now as we need the while clause to evaluate the _
                continue;
            }

            const message = messageQueue[position++];
            const nextPoint = yield message;

            // If we need to go backwards then do so
            if (nextPoint) {
                for (position--; nextPoint && nextPoint < messageQueue[position].t && position > 0; position--) {}
            } else {
                if (message.t - hiccup > 60) {
                    hiccup = message.t;
                    const nextPoint = yield {c: compno, _: false, tick: true, t: hiccup};
                    if (nextPoint) {
                        log(`rewind to ${nextPoint} (hiccup)`);

                        for (position--; nextPoint && nextPoint < messageQueue[position].t && position > 0; position--) {}
                        continue;
                    }
                }
            }
        }

        let now: Epoch = getNow();
        console.log(
            `${className}/${compno}: initial replay done ${position}/${messageQueue.length} points, now: ${new Date(now * 1000).toISOString()}, replayed to: ${new Date(
                (messageQueue.at(-1)?.t ?? 0) * 1000
            ).toISOString()} <${messageQueueId},${currentMessageQueueId}>`
        );

        // Find the position of the message we got up to, should always be increasing but better safe than sorry
        // as we may have had a reset of the message
        //        let position = _sortedIndexBy(messageQueue, {t: now} as any, (o) => o.t);

        // Loop till we are told to stop (an exception on yield)
        while (messageQueueId === currentMessageQueueId) {
            // If we don't have a message we should wait
            if (position == messageQueue.length) {
                await new Promise<boolean>((resolve) => resolveNotifications.push(resolve));
            }

            log(` normal loop ${position}/${messageQueue.length}, ${now} < ${getNow()}`);

            //            if (position < messageQueue.length && messageQueue[position]?.t < nowCutoff) {
            const message = messageQueue[position++];
            const nextPoint = yield {...message, _: position == messageQueue.length};
            if (nextPoint) {
                position = _sortedIndexBy(messageQueue, {t: nextPoint} as any, (o) => o.t);
            }
        }

        console.log(`Closing message loop for ${className}:${compno}, ${messageQueueId}<>${currentMessageQueueId}`);
    };

    return inOrderGenerator;
}
