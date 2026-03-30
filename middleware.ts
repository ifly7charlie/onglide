import {NextResponse} from 'next/server';
import type {NextRequest} from 'next/server';

export function middleware(request: NextRequest) {
    if (request.headers.get('host')?.startsWith('viewer.') && request.nextUrl.pathname === '/') {
        return NextResponse.rewrite(new URL('/viewer', request.url));
    }
}
