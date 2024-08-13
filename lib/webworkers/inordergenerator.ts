import {Epoch, Datecode, ClassName, Compno, PositionMessage, InOrderGeneratorFunction, InOrderGenerator} from '../types';
import {inOrderDelay} from '../constants';

import {sortedLastIndexBy as _sortedLastIndexBy, sortedIndexBy as _sortedIndexBy} from 'lodash';
import {BroadcastChannel} from 'node:worker_threads';

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
        if (message.t == 0) {
            messageQueue = [];
            return;
        }

        // If it's a inbound tick (ie change of place in the queue we just mark it as such and move on
        if ('tick' in message) {
            console.log('TICK MSG', message);
            const toNotify = resolveNotifications.slice();
            resolveNotifications.length = 0;
            toNotify.forEach((resolveFunction) => resolveFunction(true));
            return;
        }

        if (!message.lat) {
            console.log('hmmm, malformed', message);
        }

        // Figure out where to insert (sorted by time)
        const insertIndex = _sortedLastIndexBy(messageQueue, message, (o) => o.t);

        // Sanity check, this should never happen
        if (messageQueue[insertIndex]?.t == message.t) {
            console.log(`${message.c}: unexpected duplicate packet`);
            return;
        }

        if (messageQueue.length != insertIndex) {
            console.log(message.c, message.t, 'inserting out of order', messageQueue.length, insertIndex);
        }

        if (message.c == '212') {
            console.log(message.c, message.t, message._);
        }

        // Actually insert the point into the array
        messageQueue.splice(insertIndex, 0, message);

        const toNotify = resolveNotifications.slice();
        resolveNotifications.length = 0;
        toNotify.forEach((resolveFunction) => resolveFunction(false));
    };

    // And slower for when we are not getting coordinates
    const tickSlowInterval = setInterval(() => {
        // only tick if we have had some messages
        if (messageQueue.length) {
            const toNotify = resolveNotifications.slice();
            resolveNotifications.length = 0;
            toNotify.forEach((resolveFunction) => resolveFunction(true));
        }
    }, 60_000);

    // Generate the next item in the sequence this will block until
    // values are ready and have been waiting for 30 seconds
    const inOrderGenerator = async function* (getNow: () => Epoch): InOrderGenerator {
        //
        // How far through are we
        let position = 0;
        let hiccup: Epoch = 0 as Epoch;

        console.log('InOrderGenerator', compno, '2', messageQueue.length);
        if (!messageQueue.length) {
            await new Promise((resolve) => resolveNotifications.push(resolve));
        }

        //
        // Replay all before we start blocking, we will flag that it's a live message
        // when we get to the end which will result downstream events emitting a score
        while (!messageQueue[position]?._) {
            if (position == messageQueue.length) {
                console.log(compno, 'end of queue', position, messageQueue.length);
                // Skip all the ticks, they shouldn't happen but don't wait forever
                let count = 0;
                for (; count < 10 && (await new Promise<boolean>((resolve) => resolveNotifications.push(resolve))); count++) {}
                console.log(compno, 'more messages found', count);
                // don't process it now as we need the while clause to evaluate the _
                continue;
            }

            const message = messageQueue[position++];
            const nextPoint = yield {...message};

            // If we need to go backwards then do so
            if (nextPoint) {
                for (position--; nextPoint && nextPoint < messageQueue[position].t && position > 0; position--) {}
            } else {
                if (message.t - hiccup > 60) {
                    hiccup = message.t;
                    const nextPoint = yield {c: compno, _: false, tick: true, t: hiccup};
                    if (nextPoint) {
                        for (position--; nextPoint && nextPoint < messageQueue[position].t && position > 0; position--) {}
                        continue;
                    }
                }
            }
        }

        let now: Epoch = getNow();
        console.log(
            `${className}/${compno}: initial replay done ${position}/${messageQueue.length} points, now: ${new Date(now * 1000).toISOString()}, replayed to: ${new Date((messageQueue.at(-1)?.t ?? 0) * 1000).toISOString()}`
        );

        // Loop till we are told to stop (an exception on yield)
        while (true) {
            // Find the position of the message we got up to, should always be increasing but better safe than sorry
            // as we may have had a reset of the message
            let position = _sortedIndexBy(messageQueue, {t: now} as any, (o) => o.t);

            // Check to see if there is an eligible message in the queue
            // we won't forward it on until it's been there long enough
            const nowCutoff: Epoch = (getNow() - inOrderDelay) as Epoch;

            if (compno == 'MX') {
                console.log('MX', position, messageQueue.length, now, nowCutoff);
            }

            if (position < messageQueue.length && messageQueue[position]?.t < nowCutoff) {
                const message = messageQueue[position++];
                const nextPoint = yield message;
                now = nextPoint ? nextPoint : message.t;
            }

            // If we didn't have anything then sleep a second until we do
            // min interval for points is 1 second so this seems sensible
            else {
                if (once) {
                    break;
                }

                // As we do out of order if it's inserted before us then
                // we just skip forward
                const tick = await new Promise<boolean>((resolve) => resolveNotifications.push(resolve));

                // If we were woken without a message (ie a tick) then we need to just call with no data
                if (tick) {
                    const nextPoint = yield {c: compno, _: true, tick: true, t: messageQueue.at(-1)?.t ?? getNow()};

                    // If we need to go backwards then do so (the iterator returns the time it wants to rewind to)
                    if (nextPoint) {
                        now = nextPoint;
                    }
                }
            }
        }

        console.log(`Closing message loop for ${className}:${compno}`);
        clearInterval(tickSlowInterval);
    };

    return inOrderGenerator;
}
