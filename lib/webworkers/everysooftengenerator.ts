import {Epoch, TimeStampType} from '../types';

export type SoftenGenerator<Type extends TimeStampType> = Generator<Type, Type | void, void>;
export type SoftenGeneratorFunction<Type extends TimeStampType> = () => SoftenGenerator<Type>;

//
// This subscribes to broadcast channel and ensures that the messages
// are returned in order, if it is unable to comply then it flags
// that a restart is required and replays the messages in the correct
// order

//export function everySoOftenGenerator<Type extends TimeStampType> *(interval: Epoch, input: SoftenGenerator<Type>): SoftenGenerator<Type> {
export const everySoOftenGenerator = function* <Type extends TimeStampType>(interval: Epoch, input: SoftenGenerator<Type>): SoftenGenerator<Type> {
    // Generate the next item in the sequence this will block until
    // values are ready and have been waiting for 30 seconds
    //    const soOftenGenerator = function* (): SoftenGenerator<Type> {
    //
    // How far through are we
    let lastTime: Epoch = 0 as Epoch;

    // Loop till we are told to stop
    for (const item of input) {
        if (item.t - lastTime > interval) {
            yield item;
            lastTime = item.t;
        }
    }
    //    };

    return;
    //    return soOftenGenerator;
};
