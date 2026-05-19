// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// Tracker (FLARM id) upsert — source-agnostic. Adapters that learn a
// pilot's FLARM id from their upstream (SoaringSpot's live_track_id,
// robocontrol's feed) hand it in here and let this file own the SQL +
// trackerhistory bookkeeping.
//
// The `tracker` table's primary key is (class, compno); compno alone is
// not unique once a DB holds more than one competition (competition
// groups), so every update is scoped to the class. The caller is
// expected to always know it — robocontrol resolves it via compid +
// compno since a pilot is unique within a competition.
//

import escape from 'sql-template-strings';

import type {ClassId, CompNo} from '../source';

// Feeds that own a tracker row. Must be a subset of trackerhistory.method.
export type TrackerFeed = 'robocontrol' | 'soaringspot';

//
// updateTracker — point one (class, compno) row at a new set of FLARM
// ids. The `feedid = feed OR feedid IS NULL` guard means a row claimed
// by a different feed is left alone, so feeds don't fight over a pilot.
//
// MySQL only counts a row in affectedRows when it actually changed a
// value, so affectedRows == 0 means the tracker already matched — that
// is also the signal for whether a trackerhistory row is warranted, so
// a poll that observes no change writes nothing.
//
// Returns true when the tracker row changed.
//
export async function updateTracker(
    db: any, //
    log: (msg: string, ...args: unknown[]) => void,
    classid: ClassId,
    compno: CompNo,
    trackerIds: string,
    feed: TrackerFeed
): Promise<boolean> {
    let changed = false;
    try {
        changed = !!(
            await db.query(escape`
                UPDATE tracker
                SET
                    trackerid = ${trackerIds},
                    feedid = ${feed}
                WHERE
                    class = ${classid}
                    AND compno = ${compno}
                    AND (
                        feedid = ${feed}
                        OR feedid IS NULL
                    )
            `)
        ).affectedRows;
    } catch (e) {
        log(`tracker update failed for ${classid}/${compno}:`, e);
        return false;
    }

    if (changed) {
        log(`${feed}: updated tracker ${classid}/${compno} to ${trackerIds}`);
        try {
            await db.query(escape`
                INSERT INTO
                    trackerhistory (compno, class, changed, flarmid, greg, launchtime, method)
                VALUES
                    (
                        ${compno},
                        ${classid},
                        now(),
                        ${trackerIds},
                        '',
                        NULL,
                        ${feed}
                    )
            `);
        } catch (e) {
            log(`trackerhistory insert failed for ${classid}/${compno}:`, e);
        }
    }

    return changed;
}
