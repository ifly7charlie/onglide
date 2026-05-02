import {NextResponse} from 'next/server';
import type {NextRequest} from 'next/server';
import {query} from './lib/react/db';
import escape from 'sql-template-strings';

export const config = {
    runtime: 'nodejs',
    matcher: ['/((?!_next/|api/|.*\\.).*)']
};

let domainMap: Map<string, string> | null = null;
let loading: Promise<Map<string, string>> | null = null;

function getDomainMap(): Promise<Map<string, string>> {
    if (domainMap) return Promise.resolve(domainMap);
    if (!loading) {
        console.log(`[proxy] loading domain map...`);
        loading = (async () => {
            const rows = await query(escape`
                SELECT compid, domain FROM scoringsource
                WHERE domain IS NOT NULL AND domain != ''
            `);
            console.log(`[proxy] query returned:`, rows);
            const m = new Map<string, string>();
            for (const r of rows ?? []) m.set(r.domain.toLowerCase(), r.compid);
            console.log(`[proxy] domain map loaded: ${[...m.entries()].map(([d, c]) => `${d}->${c}`).join(', ') || '(empty)'}`);
            domainMap = m;
            return m;
        })().catch((e) => {
            console.log(`[proxy] domain map load failed:`, e);
            loading = null;
            throw e;
        });
    }
    return loading;
}

export async function middleware(request: NextRequest) {
    const host = request.headers.get('host')?.toLowerCase().split(':')[0];
    const pathname = request.nextUrl.pathname;
    console.log(`[proxy] ${host}${pathname}`);

    if (host?.startsWith('viewer.') && pathname === '/') {
        console.log(`[proxy] rewriting to /viewer`);
        return NextResponse.rewrite(new URL('/viewer', request.url));
    }

    if (host && pathname === '/') {
        const compid = (await getDomainMap()).get(host);
        if (compid) {
            console.log(`[proxy] rewriting ${host} to /${compid}`);
            return NextResponse.rewrite(new URL(`/${compid}`, request.url));
        }
    }
}
