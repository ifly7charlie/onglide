import {createHash} from 'crypto';

//
// Produce a globally-unique class identifier from the competition id and a
// class-name string. The result is a 15-character hex prefix of SHA-256 —
// fits the existing `class` char(15) column without any schema change and
// gives ~60 bits of entropy (more than enough to avoid collisions across
// any realistic number of competitions/classes).
//
// Callers must agree on which string they hash so the same class always
// produces the same id. Today:
//   - SoaringSpot OAuth (bin/soaringspot.ts) and RST (bin/rst.ts) pass the
//     raw upstream name (their upstream keys are stable).
//   - The SoaringSpot HTML scrape (lib/scoring/sources/soaringspotscrape.ts)
//     passes normalizeClassName(rawName) because pilot rosters and class
//     listings come from different pages and sometimes disagree on casing
//     or a trailing "class" suffix.
//   - SGP (lib/scoring/sources/sgp.ts) uses a fixed constant.
//
// IMPORTANT: do NOT feed normalizeClassNameForDisplay() output here — that
// collapses "18 Meter" → "18m" for the UI and would shift the hash,
// orphaning every row keyed on the previous classid.
//
export function makeClassId(compid: string, name: string): string {
    return createHash('sha256')
        .update(compid + ':' + name)
        .digest('hex')
        .substring(0, 15);
}

//
// Normalize a scoring-source class label into a canonical form that hashes
// identically whether it came from the source's primary class listing
// (usually bare, e.g. "Open") or from a pilot-roster row's class column
// (which may carry a trailing "class"-word suffix in some language, extra
// whitespace, or vary in case). The HTML-scrape source MUST feed every
// raw label through this before calling makeClassId(), otherwise the
// pilots and classes rows won't share a classid and nothing joins.
//
// The stripped token list covers the languages we see on SoaringSpot:
// EN class/classes, DE/NL/SV klasse/klass, FR/IT/PT classe, ES clase,
// PL klasa.
//
export function normalizeClassName(raw: string): string {
    return (raw || '')
        .replace(/\s*(classes|classe|class|klasse|klass|clase|klasa)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

//
// Tighten a class label for *display* in the UI / `classes.classname`
// column. Currently this just collapses "<number> meter" (in any of the
// languages SoaringSpot publishes in — meter, metre, metro, metri, mètre,
// méter, metr, metrów, metriä, plus plural forms) down to "<number>m",
// e.g. "18 Meter" or "18-Metros" → "18m". The `classes.description` column
// keeps the pre-display form so the long name is still recoverable.
//
// NOT used as input to makeClassId() — see the warning there. The hash
// stays on the normalizeClassName() output so existing class rows don't
// get orphaned when the display rule changes.
//
export function normalizeClassNameForDisplay(name: string): string {
    return (name || '').replace(
        /(\d+)[\s-]+(meters?|metres?|metros?|mètres?|metriä|metrów|metri|metr|méter)(?=\s|$|[^a-z])/giu,
        '$1m'
    );
}
