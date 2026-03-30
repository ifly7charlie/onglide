import {NextResponse} from 'next/server';
import type {NextRequest} from 'next/server';

export function middleware(request: NextRequest) {
    const host = request.headers.get('host');
    const pathname = request.nextUrl.pathname;

    if (host?.startsWith('viewer.') && pathname === '/') {
        console.log(`[proxy] rewriting to /viewer`);
        return NextResponse.rewrite(new URL('/viewer', request.url));
    }
}
