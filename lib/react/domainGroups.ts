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
// null when the host is not configured for a group.
export function groupForHost(host: string | undefined): string | null {
    if (!host) return null;
    return domainGroups[host.toLowerCase().split(':')[0]] ?? null;
}
