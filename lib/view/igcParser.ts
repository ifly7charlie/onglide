import type {Compno, Epoch, AltitudeAMSL, AltitudeAgl, PositionMessage} from '../types';

export interface OZParams {
    style: number; // 0=fixed, 1=symmetrical, 2=np(next), 3=pp(previous)
    r1: number; // metres
    a1: number; // half-angle degrees
    r2: number; // metres
    a2: number; // half-angle degrees
    a12: number; // direction angle (bisector of sector) in degrees, 0 = not set
    line: boolean;
    aat: boolean;
    reduce: boolean;
}

export interface IGCData {
    pilot: {name: string; compno: Compno; gliderType: string};
    date: {epochBase: Epoch; day: number; month: number; year: number};
    tzOffset: number; // timezone offset in hours (e.g. 2 for UTC+2)
    fixes: PositionMessage[];
    taskDeclaration: {lat: number; lng: number; name: string}[] | null;
    ozParams: Map<number, OZParams>;
    taskParams: {noStartUTC: string | null; taskTimeSecs: number | null};
}

// B record regex - matches the standard IGC fix format
const bRecordRegex = /^B(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})([NS])(\d{3})(\d{2})(\d{3})([EW])A([\d-]{5})(\d{5})/;

// C record regex for turnpoints (not the header or takeoff/landing lines)
const cRecordRegex = /^C(\d{2})(\d{2})(\d{3})([NS])(\d{3})(\d{2})(\d{3})([EW])(.*)/;

// H record patterns
const hdteRegex = /^HFDTE(?:DATE:)?(\d{2})(\d{2})(\d{2})/i;
const hpltRegex = /^HFPLT[^:]*:\s*(.*)/i;
const hcidRegex = /^HFCID[^:]*:\s*(.*)/i;
const hgtyRegex = /^HFGTY[^:]*:\s*(.*)/i;
const hgidRegex = /^HFGID[^:]*:\s*(.*)/i;

// Timezone offset (from H record or LCU:: comment)
const tzRegex = /^(?:LCU::)?H[FP]TZN.*TIMEZONE:\s*(-?[\d.]+)/i;

// LSEEYOU / LLXV OZ line (LSEEYOU takes precedence, LLXV used as fallback)
const lseeyouOZRegex = /^LSEEYOU OZ=(-?\d+),(.*)/;
const llxvOZRegex = /^LLXVOZ=(-?\d+),(.*)/;

// LSEEYOU / LLXV TSK line
const lseeyouTSKRegex = /^LSEEYOU TSK,(.*)/;
const llxvTSKRegex = /^LLXVTSK,(.*)/;

function parseTimeToSecs(timeStr: string): number {
    const parts = timeStr.split(':');
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + (parts[2] ? parseInt(parts[2]) : 0);
}

function parseLSEEYOUKeyValues(str: string): Record<string, string> {
    const result: Record<string, string> = {};
    // Split on comma but handle values that might contain commas inside quotes
    const parts = str.split(',');
    for (const part of parts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx >= 0) {
            result[part.substring(0, eqIdx).trim()] = part.substring(eqIdx + 1).trim();
        }
    }
    return result;
}

function parseMetres(val: string | undefined): number {
    if (!val) return 0;
    // Strip unit suffix like 'm' or 'ft'
    return parseFloat(val.replace(/[a-z]+$/i, '')) || 0;
}

export function parseIGC(text: string, defaultCompno?: Compno): IGCData {
    const lines = text.split(/\r?\n/);

    let pilotName = '';
    let compno = (defaultCompno || '') as Compno;
    let gliderId = '';
    let gliderType = '';
    let epochBase: Epoch = 0 as Epoch;
    let day = 0,
        month = 0,
        year = 0;

    const fixes: PositionMessage[] = [];
    const cRecords: {lat: number; lng: number; name: string}[] = [];
    const lcuCRecords: {lat: number; lng: number; name: string}[] = []; // SeeYou LCU:: task override
    const ozParams = new Map<number, OZParams>();
    const llxvOZParams = new Map<number, OZParams>(); // fallback if no LSEEYOU lines
    let taskParams: {noStartUTC: string | null; taskTimeSecs: number | null} = {noStartUTC: null, taskTimeSecs: null};
    let llxvTaskParams: {noStartUTC: string | null; taskTimeSecs: number | null} = {noStartUTC: null, taskTimeSecs: null};
    let tzOffset = 0; // timezone offset in hours
    let isFirstCRecord = true;

    for (const line of lines) {
        const first = line[0];

        // B record - fix
        if (first === 'B') {
            const m = bRecordRegex.exec(line);
            if (!m) continue;

            const hours = parseInt(m[1]);
            const minutes = parseInt(m[2]);
            const seconds = parseInt(m[3]);

            const latDeg = parseInt(m[4]);
            const latMin = parseInt(m[5]);
            const latMinDec = parseInt(m[6]);
            const latSign = m[7] === 'S' ? -1 : 1;
            const lat = latSign * (latDeg + (latMin + latMinDec / 1000) / 60);

            const lngDeg = parseInt(m[8]);
            const lngMin = parseInt(m[9]);
            const lngMinDec = parseInt(m[10]);
            const lngSign = m[11] === 'W' ? -1 : 1;
            const lng = lngSign * (lngDeg + (lngMin + lngMinDec / 1000) / 60);

            const pressAlt = parseInt(m[12]) as AltitudeAMSL;
            const gpsAlt = parseInt(m[13]) as AltitudeAMSL;

            const t = (epochBase + hours * 3600 + minutes * 60 + seconds) as Epoch;
            const alt = (gpsAlt > 0 ? gpsAlt : pressAlt) as AltitudeAMSL;

            fixes.push({
                t,
                lat,
                lng,
                a: alt,
                g: 0 as AltitudeAgl, // will be estimated later
                c: compno,
                _: false
            });
            continue;
        }

        // H record - header
        if (first === 'H') {
            let m = hdteRegex.exec(line);
            if (m) {
                day = parseInt(m[1]);
                month = parseInt(m[2]);
                year = parseInt(m[3]);
                // Convert 2-digit year
                const fullYear = year < 80 ? 2000 + year : 1900 + year;
                epochBase = (Date.UTC(fullYear, month - 1, day) / 1000) as Epoch;
                continue;
            }

            m = tzRegex.exec(line);
            if (m) {
                tzOffset = parseFloat(m[1]);
                continue;
            }

            m = hpltRegex.exec(line);
            if (m) {
                pilotName = m[1].trim();
                continue;
            }

            m = hcidRegex.exec(line);
            if (m) {
                compno = m[1].trim() as Compno;
                continue;
            }

            m = hgidRegex.exec(line);
            if (m) {
                gliderId = m[1].trim();
                continue;
            }

            m = hgtyRegex.exec(line);
            if (m) {
                gliderType = m[1].trim();
                continue;
            }
            continue;
        }

        // C record - task declaration
        if (first === 'C') {
            // Skip the first C record (declaration header)
            if (isFirstCRecord) {
                isFirstCRecord = false;
                continue;
            }

            const m = cRecordRegex.exec(line);
            if (!m) continue;

            const latDeg = parseInt(m[1]);
            const latMin = parseInt(m[2]);
            const latMinDec = parseInt(m[3]);
            const latSign = m[4] === 'S' ? -1 : 1;
            const lat = latSign * (latDeg + (latMin + latMinDec / 1000) / 60);

            const lngDeg = parseInt(m[5]);
            const lngMin = parseInt(m[6]);
            const lngMinDec = parseInt(m[7]);
            const lngSign = m[8] === 'W' ? -1 : 1;
            const lng = lngSign * (lngDeg + (lngMin + lngMinDec / 1000) / 60);

            const name = m[9].trim();

            // Skip takeoff/landing lines (all zeros)
            if (latDeg === 0 && latMin === 0 && latMinDec === 0 && lngDeg === 0 && lngMin === 0 && lngMinDec === 0) {
                continue;
            }

            cRecords.push({lat, lng, name});
            continue;
        }

        // L record - comment (LSEEYOU lines, LCU:: overrides)
        if (first === 'L') {
            // LCU::C record - SeeYou task override (takes precedence over original C records)
            if (line.startsWith('LCU::C')) {
                const cLine = line.substring(5); // strip 'LCU::' to get 'C...'
                const cm = cRecordRegex.exec(cLine);
                if (cm) {
                    const latDeg = parseInt(cm[1]);
                    const latMin = parseInt(cm[2]);
                    const latMinDec = parseInt(cm[3]);
                    const latSign = cm[4] === 'S' ? -1 : 1;
                    const lat = latSign * (latDeg + (latMin + latMinDec / 1000) / 60);

                    const lngDeg = parseInt(cm[5]);
                    const lngMin = parseInt(cm[6]);
                    const lngMinDec = parseInt(cm[7]);
                    const lngSign = cm[8] === 'W' ? -1 : 1;
                    const lng = lngSign * (lngDeg + (lngMin + lngMinDec / 1000) / 60);

                    const name = cm[9].trim();

                    if (latDeg !== 0 || latMin !== 0 || latMinDec !== 0 || lngDeg !== 0 || lngMin !== 0 || lngMinDec !== 0) {
                        lcuCRecords.push({lat, lng, name});
                    }
                }
                continue;
            }

            // LCU::H record - SeeYou pilot/glider overrides
            if (line.startsWith('LCU::H')) {
                const hLine = line.substring(5); // strip 'LCU::' to get 'H...'
                const hm = /^HPCID[^:]*:\s*(.*)/i.exec(hLine);
                if (hm) {
                    const cid = hm[1].trim();
                    if (cid) compno = cid as Compno;
                    continue;
                }
                const hpm = /^HPPLT[^:]*:\s*(.*)/i.exec(hLine);
                if (hpm) {
                    const n = hpm[1].trim();
                    if (n) pilotName = n;
                    continue;
                }
                const hgm = /^HPGTY[^:]*:\s*(.*)/i.exec(hLine);
                if (hgm) {
                    const g = hgm[1].trim();
                    if (g) gliderType = g;
                    continue;
                }
            }

            // LCU::HPTZNTIMEZONE:N - SeeYou appended timezone (takes precedence over HFTZN)
            let m = tzRegex.exec(line);
            if (m) {
                tzOffset = parseFloat(m[1]);
                continue;
            }

            m = lseeyouOZRegex.exec(line);
            if (m) {
                const ozIndex = parseInt(m[1]);
                const kv = parseLSEEYOUKeyValues(m[2]);
                ozParams.set(ozIndex, {
                    style: parseInt(kv['Style'] ?? '1'),
                    r1: parseMetres(kv['R1']),
                    a1: parseFloat(kv['A1'] ?? '180'),
                    r2: parseMetres(kv['R2']),
                    a2: parseFloat(kv['A2'] ?? '0'),
                    a12: parseFloat(kv['A12'] ?? '0'),
                    line: kv['Line'] === '1',
                    aat: kv['AAT'] === '1',
                    reduce: kv['Reduce'] === '1'
                });
                continue;
            }

            m = lseeyouTSKRegex.exec(line);
            if (m) {
                const kv = parseLSEEYOUKeyValues(m[1]);
                taskParams = {
                    noStartUTC: kv['NoStart'] ?? null,
                    taskTimeSecs: kv['TaskTime'] ? parseTimeToSecs(kv['TaskTime']) : null
                };
                continue;
            }

            // LLXV OZ/TSK lines (fallback when no LSEEYOU lines present)
            m = llxvOZRegex.exec(line);
            if (m) {
                const ozIndex = parseInt(m[1]);
                const kv = parseLSEEYOUKeyValues(m[2]);
                llxvOZParams.set(ozIndex, {
                    style: parseInt(kv['Style'] ?? '1'),
                    r1: parseMetres(kv['R1']),
                    a1: parseFloat(kv['A1'] ?? '180'),
                    r2: parseMetres(kv['R2']),
                    a2: parseFloat(kv['A2'] ?? '0'),
                    a12: parseFloat(kv['A12'] ?? '0'),
                    line: kv['Line'] === '1',
                    aat: kv['AAT'] === '1',
                    reduce: kv['Reduce'] === '1'
                });
                continue;
            }

            m = llxvTSKRegex.exec(line);
            if (m) {
                const kv = parseLSEEYOUKeyValues(m[1]);
                // LLXV TaskTime can be in seconds format (e.g. "9000s") or HH:MM:SS
                const taskTimeStr = kv['TaskTime'] ?? '';
                const taskTimeSecs = taskTimeStr.endsWith('s') ? parseInt(taskTimeStr) : taskTimeStr.includes(':') ? parseTimeToSecs(taskTimeStr) : parseInt(taskTimeStr) || null;
                llxvTaskParams = {
                    noStartUTC: kv['NoStart'] ?? null,
                    taskTimeSecs
                };
                continue;
            }
            continue;
        }
    }

    // LCU::C records override original C records (SeeYou convention)
    // Strip home airfield: if first and last LCU C records have the same coordinates
    // they are takeoff/landing (like zero-coordinate lines in standard IGC)
    if (lcuCRecords.length >= 3) {
        const first = lcuCRecords[0];
        const last = lcuCRecords[lcuCRecords.length - 1];
        if (Math.abs(first.lat - last.lat) < 0.0001 && Math.abs(first.lng - last.lng) < 0.0001) {
            lcuCRecords.shift();
            lcuCRecords.pop();
        }
    }
    const finalCRecords = lcuCRecords.length > 0 ? lcuCRecords : cRecords;

    // Use LLXV as fallback if no LSEEYOU OZ/TSK lines were found
    const finalOZParams = ozParams.size > 0 ? ozParams : llxvOZParams;
    const finalTaskParams = taskParams.noStartUTC !== null || taskParams.taskTimeSecs !== null ? taskParams : llxvTaskParams;

    // Use glider ID as compno if it's shorter than the competition ID
    if (gliderId && compno && gliderId.length < compno.length) {
        compno = gliderId as Compno;
    }

    // Truncate long compnos to last 2 characters
    if (compno.length > 3) {
        compno = compno.slice(-2) as Compno;
    }

    // Mark last fix as "live" to trigger score emission
    if (fixes.length > 0) {
        fixes[fixes.length - 1]._ = true;
        // Update all fixes with the resolved compno
        if (compno) {
            for (const fix of fixes) {
                fix.c = compno;
            }
        }
    }

    // Estimate AGL using minimum altitude from first few minutes as ground level
    if (fixes.length > 0) {
        const firstFiveMinutes = fixes[0].t + 300;
        let groundAlt = Infinity;
        for (const fix of fixes) {
            if (fix.t > firstFiveMinutes) break;
            if (fix.a < groundAlt) groundAlt = fix.a;
        }
        if (groundAlt < Infinity) {
            for (const fix of fixes) {
                fix.g = Math.max(0, fix.a - groundAlt) as AltitudeAgl;
            }
        }
    }

    return {
        pilot: {name: pilotName, compno, gliderType},
        tzOffset,
        date: {epochBase, day, month, year},
        fixes,
        taskDeclaration: finalCRecords.length > 0 ? finalCRecords : null,
        ozParams: finalOZParams,
        taskParams: finalTaskParams
    };
}
