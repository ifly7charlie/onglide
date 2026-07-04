//
// Front-end hostname -> competition group for the /all/<group> websocket feed.
// A grouped deployment sees only competitions whose `compgroup` column matches;
// hosts absent from this map get the unfiltered /all feed (every competition).
//
// Configure grouped deployments here, the same way the domain->compid map in
// middleware.ts is maintained. Consulted client-side by competitionsWebsocketUrl()
// in lib/react/fixupUrls.ts.
//

export const domainGroups: Record<string, string> = {
    // 'uk.onglide.com': 'uk',
};

// Resolve the group for a hostname (host may carry a :port suffix). Returns
// null when the host is not configured for a group. Localhost/dev hosts get
// an empty string sentinel so callers can distinguish "stay local" from
// "redirect to onglide.com".
export function groupForHost(host: string | undefined): string | null {
    if (!host) return null;
    const base = host.toLowerCase().split(':')[0];
    if (base === 'localhost' || base === '127.0.0.1' || base === '0.0.0.0') return '';
    return domainGroups[base] ?? null;
}
