import {Epoch, Datecode, ClassName, Compno, PositionMessage, InOrderGeneratorFunction, InOrderGenerator} from '../types';
import {inOrderDelay} from '../constants';

import {sortedLastIndexBy as _sortedLastIndexBy} from 'lodash';
import {BroadcastChannel} from 'node:worker_threads';

// Helper in case we are overriding current time
const defaultEpochNow = (): Epoch => Math.trunc(Date.now() / 1000) as Epoch;

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
    type ResolveNotificationFunction = (number) => void;
    let resolveNotifications: ResolveNotificationFunction[] = [];

    // We need somewhere to store the unprocessed message queue
    let messageQueue: PositionMessage[] = initialPoints;

    console.log(`bound ${initialPoints.length} points to ${compno}/${className}`);

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

        // Figure out where to insert (sorted by time)
        const insertIndex = _sortedLastIndexBy(messageQueue, message, (o) => o.t);

        // In dense coverage it's not uncommon to get a duplicate packet. We always take the first one we
        // have received. The packets may be very different and ideally we would identify problem receivers
        // and then choose when to accept their messages or not
        if (messageQueue[insertIndex]?.t != message.t) {
            // Actually insert the point into the array
            messageQueue.splice(insertIndex, 0, message);

            const toNotify = resolveNotifications.slice();
            resolveNotifications.length = 0;
            toNotify.forEach((resolveFunction) => resolveFunction(insertIndex));
        }
    };

    // We may want to check regularily for replay
    if (tick) {
        setInterval(() => {
            const toNotify = resolveNotifications.slice();
            resolveNotifications.length = 0;
            toNotify.forEach((resolveFunction) => resolveFunction(messageQueue.length + 1));
        }, 1000);
    }

    // Generate the next item in the sequence this will block until
    // values are ready and have been waiting for 30 seconds
    const inOrderGenerator = async function* (getNow: () => Epoch): InOrderGenerator {
        //
        // How far through are we
        let position = 0;

        //
        // Replay all before we start blocking, we will flag that it's a live message
        // when we get to the end which will result downstream events emitting a score
        const now: Epoch = getNow();
        while (position < messageQueue.length && !messageQueue[position]?._ && messageQueue[position]?.t < now - inOrderDelay) {
            const message = messageQueue[position++];
            const nextPoint = yield {...message, _: position == messageQueue.length || messageQueue[position]?.t >= now - inOrderDelay};

            // If we need to go backwards then do so
            if (nextPoint) {
                for (position--; nextPoint && nextPoint < messageQueue[position].t && position > 0; position--) {}
            }
        }

        console.log(`${className}/${compno}: initial replay done ${position}/${messageQueue.length} points, now: ${new Date(now * 1000).toISOString()}, replayed to: ${new Date((messageQueue[position]?.t ?? 0) * 1000).toISOString()}`);

        // Loop till we are told to stop (an exception on yield)
        while (true) {
            // Check to see if there is an eligible message in the queue
            // we won't forward it on until it's been there long enough
            const now: Epoch = getNow();

            if (position < messageQueue.length && messageQueue[position]?.t < now - inOrderDelay) {
                const message = messageQueue[position++];
                const nextPoint = yield {...message, _: position == messageQueue.length || messageQueue[position]?.t >= now - inOrderDelay};

                // If we need to go backwards then do so
                if (nextPoint) {
                    for (position--; nextPoint && nextPoint < messageQueue[position].t && position > 0; position--) {}
                }
            }

            // If we didn't have anything then sleep a second until we do
            // min interval for points is 1 second so this seems sensible
            else {
                if (once) {
                    break;
                }

                // As we do out of order if it's inserted before us then
                // we just skip forward
                const insertIndex = await new Promise<number>((resolve) => resolveNotifications.push(resolve));
                if (insertIndex < position && position < messageQueue.length) {
                    position++;
                }
            }
        }

        console.log(`Closing message loop for ${className}:${compno}`);
    };

    return inOrderGenerator;
}
