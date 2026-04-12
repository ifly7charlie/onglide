import {createHash} from 'crypto';

//
// Produce a globally-unique class identifier from the competition id and the
// raw class name as supplied by the scoring source. The result is a 15-character
// hex prefix of SHA-256 — fits the existing `class` char(15) column without any
// schema change and gives ~60 bits of entropy (more than enough to avoid
// collisions across any realistic number of competitions/classes).
//
// The same (compid, rawName) pair always produces the same id, so re-running
// a scoring import will update the existing row rather than create duplicates.
//
export function makeClassId(compid: string, rawName: string): string {
    return createHash('sha256')
        .update(compid + ':' + rawName)
        .digest('hex')
        .substring(0, 15);
}
