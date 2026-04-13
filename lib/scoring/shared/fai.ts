// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// FAI ranking-list lookup. Given a contestant name + 2-letter country
// code, queries the FAI SGP search and returns a numeric pilot id
// (and as a side effect, kicks off a picture download if the search hit
// includes one).
//
// This used to live inside ssscrape.ts and was called every 5 minutes
// for any pilot whose stored fai was missing or synthetic — i.e. on
// every scrape cycle for everyone we couldn't resolve. The scheduler now
// calls into here only behind the `idsig` gate in `shared/pilots.ts`, so
// the only time this fires is on a brand-new pilot insert or when the
// pilot's name/compno actually changes.
//

import * as htmlparser from 'htmlparser2';
import {findOne, find, isTag, textContent, getAttributeValue} from 'domutils';
import {Element} from 'domhandler';
import getCountryISO3 from 'country-iso-2-to-3';

import type {ClassId, CompNo} from '../source';
import {downloadPictureCached} from './images';

function toElement(x: any): Element | null {
    return x?.nodeType == 1 ? (x as Element) : null;
}

//
// findPilotByName — search the FAI SGP ranking list. Returns the integer
// pilot id (e.g. 12345) on a unique match, or undefined otherwise. Only
// returns a value when there's *exactly one* potential match against all
// of the surname tokens — anything ambiguous is left for the caller to
// fall back to a synthetic id.
//
// Side effects:
// - If the matched row carries an image, an image download is started
//   (fire-and-forget) via downloadPictureCached. This is harmless if the
//   24h cache is fresh; it just no-ops.
//
export async function findPilotByName(
    db: any, //
    log: (msg: string, ...args: unknown[]) => void,
    lastname: string,
    countrycode: string,
    classid: ClassId,
    compno: CompNo
): Promise<number | undefined> {
    const names = lastname.split(' ').reverse();

    log(`checking FAI ranking list for ${lastname} from ${countrycode}`);

    for (const name of names) {
        const possible = await fetch(`https://rankingdata.fai.org/SGP_SearchResults.php?surname=${name}&nationality=${getCountryISO3(countrycode) ?? ''}`)
            .then((res) => res.text())
            .then((body) => {
                const dom = htmlparser.parseDocument(body);

                const nameTable = findOne((x) => x.attribs?.class == 'RL_table_innerTable', dom.children);
                if (!nameTable) return undefined;

                const matches = find((x) => isTag(x) && x.name == 'a', nameTable.children, true, 100).map(toElement);

                const potentials = matches
                    .map((match) => ({
                        id: match ? getAttributeValue(match, 'href')?.match(/pilotid=([0-9]+)/)?.[1] : undefined,
                        name: match ? textContent(match) : undefined
                    }))
                    .filter((m) => m.id && m.name && m.name != 'No image');

                const filteredByName = potentials.filter((p) => names.every((n) => p.name!.match(new RegExp(`(^${n}| +${n})`, 'i'))));

                if (filteredByName.length == 1 && filteredByName[0]?.id) {
                    const img = matches
                        .filter((match) => match && getAttributeValue(match, 'href')?.match(/pilotid=([0-9]+)/)?.[1] == filteredByName[0].id)
                        .map((row) => row && findOne((x) => isTag(x) && x.name == 'img', row.children))
                        .map((img) => img && getAttributeValue(img, 'src'))
                        .filter((src) => !!src);

                    log(`-> found using ${name} fai id: ${filteredByName[0].id}, ${img}`);
                    if (img.length && img[0]) {
                        // fire-and-forget; downloadPictureCached has its own
                        // 24h gates so re-firing is cheap.
                        downloadPictureCached(db, log, classid, compno, {
                            directUrl: 'https://rankingdata.fai.org/' + img[0]
                        }).catch(() => undefined);
                    }
                    return parseInt(filteredByName[0].id);
                }
                return undefined;
            });
        if (possible) {
            return possible;
        }
    }
    return undefined;
}
