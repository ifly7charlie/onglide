//
// Reports the Next.js BUILD_ID of this server process. The frontend compares
// it to the buildId it loaded with (window.__NEXT_DATA__.buildId) so it can
// detect when a deploy has happened — usually triggered by daemon protobuf
// changes that would silently break the websocket feed for old clients.
//
import type {NextApiRequest, NextApiResponse} from 'next';
import fs from 'fs';
import path from 'path';

let cached: string | null = null;

function readBuildId(): string | null {
    if (cached) return cached;
    try {
        cached = fs.readFileSync(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim();
    } catch {
        // Dev mode (`next dev`) doesn't write BUILD_ID — return null so the
        // client treats it as "no comparison possible" rather than reloading.
        return null;
    }
    return cached;
}

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({buildId: readBuildId()});
}
