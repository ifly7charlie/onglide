import {PositionMessage} from './positionmessage';
import {Epoch, ClassName_Compno} from '../types';
import {inOrderDelay} from '../constants';

import {sortedLastIndexBy as _sortedLastIndexBy} from 'lodash';
import {BroadcastChannel} from 'node:worker_threads';

// Helper in case we are overriding current time
const defaultEpochNow = (): Epoch => Math.trunc(Date.now() / 1000) as Epoch;

export type InOrderGeneratorFunction = () => Generator<PositionMessage, void, Epoch | void>;

//
// This subscribes to broadcast channel and ensures that the messages
// are returned in order, if it is unable to comply then it flags
// that a restart is required and replays the messages in the correct
// order

export function bindChannelForInOrderPackets(channelName: ClassName_Compno, initialPoints: PositionMessage[], getNow: () => Epoch = defaultEpochNow): InOrderGeneratorFunction {
    console.log(`bindChannelForInOrderPackets(${channelName}, ${initialPoints.length})`);
    //
    // And we need a way to notify and wake up our generator
    // that is not asynchronous. Once we have achieved this
    // all the rest of the logic can simply be reading from the
    // generator
    let notification = new Int32Array(new SharedArrayBuffer(4));

    // We need somewhere to store the unprocessed message queue
    let messageQueue: PositionMessage[] = initialPoints;
    let running: boolean = true;

    // Hook it up to the position messages so we can update our
    // displayed track we wrap the function with the class and
    // channel to simplify things
    const broadcastChannel = new BroadcastChannel(channelName);
    broadcastChannel.onmessage = (ev: MessageEvent<PositionMessage>) => {
        // Get the message
        let message = ev.data as PositionMessage;

        // Figure out where to insert (sorted by time)
        const insertIndex = _sortedLastIndexBy(messageQueue, message, (o) => o.t);

        // In dense coverage it's not uncommon to get a duplicate packet. We always take the first one we
        // have received. The packets may be very different and ideally we would identify problem receivers
        // and then choose when to accept their messages or not
        if (messageQueue[insertIndex]?.t != message.t) {
            // Actually insert the point into the array
            message._ = true;
            messageQueue.splice(insertIndex, 0, message);
            Atomics.store(notification, 0, messageQueue.length);
            Atomics.notify(notification, 0);
        }
    };

    // Generate the next item in the sequence this will block until
    // values are ready and have been waiting for 30 seconds
    const inOrderGenerator = function* (): Generator<PositionMessage, void, Epoch | void> {
        //
        // How far through are we
        let position = 0;
        console.log('start iterator iog', channelName);

        // Loop till we are told to stop
        while (running) {
            // Check to see if there is an eligible message in the queue
            // we won't forward it on until it's been there long enough
            const now: Epoch = getNow();
            if (messageQueue[position]?.t < now - inOrderDelay) {
                const message = messageQueue[position++];
                const nextPoint = yield message;
                message._ = false;

                // If we need to go backwards then do so
                while (nextPoint && nextPoint < messageQueue[position].t && position > 0) {
                    position--;
                }
            }

            // If we didn't have anything then sleep a second until we do
            // min interval for points is 1 second so this seems sensible
            else {
                return;
                /*                console.log(channelName, 'waiting for more');
                // Check to see if it was inserted before us, if it was
                // then we need to advance by the same amount so we don't
                // duplicate - this could cause a race condition as we aren't
                // locking the value
                if (Atomics.wait(notification, 0, 0) == 'ok') {
                    if (notification[0] < position && position < messageQueue.length) {
                        position++;
                    }
                } */
            }
        }

        console.log('iog', channelName, 'done loop');
    };

    return inOrderGenerator;
}
