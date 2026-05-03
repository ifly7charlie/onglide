import {NextResponse} from 'next/server';
import type {NextRequest} from 'next/server';

const domains = {
    'viewer.onglide.com': 'viewer',
    // list the competition urls to compids mapping here and then rebuild nextjs
    'sgp.onglide.com': 'sgp'
};

export async function middleware(request: NextRequest) {
    const host = request.headers.get('host')?.toLowerCase().split(':')[0];
    const pathname = request.nextUrl.pathname;
    console.log(`[proxy] ${host}${pathname}`);

    if (host && pathname === '/') {
        const compid = domains[host];
        if (compid) {
            console.log(`[proxy] rewriting ${host} to /${compid}`);
            return NextResponse.rewrite(new URL(`/${compid}`, request.url));
        }
    }
}
