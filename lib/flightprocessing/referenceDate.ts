const aFewDays = 3600 * 24 * 10;

import {getNow} from '../now';

export const referenceDate = getNow() - (getNow() % aFewDays);
/*    (process.env.NEXT_PUBLIC_REPLAY //
        ? parseInt(process.env.NEXT_PUBLIC_REPLAY) - (parseInt(process.env.NEXT_PUBLIC_REPLAY) % aFewDays)
        : new Date(Date.now() - (Date.now() % (aFewDays * 1000))).getTime() / 1000) - aFewDays;
*/
