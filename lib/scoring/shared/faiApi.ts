// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// Thin wrappers around the FAI ranking REST API at
// https://rankingdata.fai.org/rest/api/rlpilot. Factored out of fai.ts
// so that images.ts can reuse the types + detail fetcher without a
// circular import between the two files.
//

// Synthetic "unresolved pilot" id floor used throughout the scoring
// pipeline. Any pilot whose `fai` column is >= this value has not yet
// been matched against the FAI ranking list.
export const FAI_SYNTHETIC_FLOOR = 3_000_000;

// Hostname the FAI ranking site serves pilot portraits from. Both the
// search detail (`photo` field) and the legacy "guess the filename"
// fallback point here.
const FAI_IMAGE_HOST = 'https://rankingdata.fai.org/PilotImages';

// Subset of the per-pilot detail row returned by
// `rest/api/rlpilot?id=N`. Only the fields onglide actually consumes
// are typed — the rest of the response (homeclub, sponsor*, quest*,
// etc.) is intentionally ignored.
export interface FaiPilotDetail {
    pilotid: number;
    firstname?: string;
    surname?: string;
    nationality?: string;
    rankingpts?: number;
    rankingpos?: number;
    lastcomp?: number;
    // Authoritative image filename as the FAI ranking site exposes it.
    // Value is either a real filename (e.g. "12345.jpg") or the sentinel
    // "noimage.jpg" for pilots who have never uploaded a portrait. Callers
    // should treat "noimage.jpg" as "do not bother downloading".
    photo?: string;
}

//
// faiPilotImageUrl — compose the portrait URL from the FAI detail row's
// `photo` field. Pass the filename as-is; the function handles the
// noimage sentinel by returning `null` so the caller can skip the
// download entirely instead of eating a guaranteed 404.
//
export function faiPilotImageUrl(photoFilename: string | null | undefined): string | null {
    if (!photoFilename) return null;
    if (photoFilename === 'noimage.jpg') return null;
    return `${FAI_IMAGE_HOST}/${photoFilename}`;
}

//
// fetchFaiPilotDetail — single-pilot lookup against the by-id endpoint.
// Used for:
//   - disambiguating multi-candidate name/country matches (rankingpts)
//   - resolving the authoritative `photo` filename once we've chosen a
//     pilotid to commit to
// Errors are logged and swallowed — the caller treats `undefined` as
// "no detail available, fall back to whatever guess was in scope".
//
export async function fetchFaiPilotDetail(
    log: (msg: string, ...args: unknown[]) => void, //
    pilotid: number
): Promise<FaiPilotDetail | undefined> {
    try {
        const res = await fetch(`https://rankingdata.fai.org/rest/api/rlpilot?id=${pilotid}`);
        if (res.status !== 200) {
            log(`FAI detail: ${pilotid} returned ${res.status}`);
            return undefined;
        }
        const json = await res.json();
        if (json?.status !== 200 || !Array.isArray(json?.data) || !json.data.length) {
            return undefined;
        }
        return json.data[0] as FaiPilotDetail;
    } catch (e) {
        log(`FAI detail fetch failed for ${pilotid}:`, e);
        return undefined;
    }
}
