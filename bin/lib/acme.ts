//
// Built-in ACME (Let's Encrypt) certificate management for the OGN daemon.
//
// Lives in the daemon build (tsconfig-bin) - never imported by the front-end.
// The daemon serves its websocket over TLS from keys/<host>.key.pem +
// keys/<host>.cert.pem; this module keeps that pair renewed automatically and
// hands the fresh pair back via onCertificate so ogn.ts can hot-swap it into
// the live https.Server with setSecureContext() - no restart, no outage.
//
// Opt-in via ACME_ENABLED (see acmeConfigFromEnv). Validation is http-01: the
// token responses are registered in a module-level map that ogn.ts also serves
// from its always-on HTTP listener, and during an order we additionally try to
// bind a temporary listener on :80 - if that fails (EACCES/EADDRINUSE) the
// operator is expected to forward /.well-known/acme-challenge/ to the daemon.
//
// Failure policy per the repo conventions: a failed order never crashes the
// daemon and never latches ACME off - it logs loudly and retries with
// exponential backoff (1h doubling, 24h cap; straight to the cap when the CA
// says we are rate limited).
//

import * as acme from 'acme-client';
import {X509Certificate} from 'node:crypto';
import * as tls from 'node:tls';
import * as http from 'node:http';
import {readFileSync, writeFileSync, renameSync, mkdirSync} from 'fs';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

const TRUTHY = ['1', 'true', 'yes'];

export interface AcmeConfig {
    host: string; // the hostname the certificate is for (NEXT_PUBLIC_WEBSOCKET_HOST)
    email: string; // ACME account contact
    directoryUrl: string;
    renewDays: number; // renew when fewer than this many days of validity remain
    tryPort80: boolean; // attempt the temporary :80 challenge listener during orders
    keysDir: string; // where the key/cert pair and the account key live
    httpPort: number; // the always-on HTTP listener port, only used in operator hints
}

//
// Pure config parser. Returns null when ACME should not run: silently when it
// simply is not enabled, loudly when it is enabled but misconfigured - in both
// cases the daemon carries on exactly as before (manual certs still work).
export function acmeConfigFromEnv(env: Record<string, string | undefined>): AcmeConfig | null {
    if (!TRUTHY.includes((env.ACME_ENABLED || '').toLowerCase())) {
        return null;
    }

    const host = env.NEXT_PUBLIC_WEBSOCKET_HOST;
    // A cert can only be issued for a bare public hostname - this rejects the
    // localhost:3000 style values dev setups use even if ACME_ENABLED is set.
    if (!host || !host.includes('.') || host.includes(':') || host.includes('/')) {
        console.error(`acme: ACME_ENABLED is set but NEXT_PUBLIC_WEBSOCKET_HOST (${host}) is not a bare public hostname - certificate management disabled`);
        return null;
    }

    const email = env.ACME_EMAIL || env.SERVER_ADMIN;
    if (!email) {
        console.error('acme: ACME_ENABLED is set but neither ACME_EMAIL nor SERVER_ADMIN is - certificate management disabled');
        return null;
    }

    const directoryUrl = env.ACME_DIRECTORY || (TRUTHY.includes((env.ACME_STAGING || '').toLowerCase()) ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production);

    let renewDays = parseInt(env.ACME_RENEW_DAYS || '30');
    if (!Number.isFinite(renewDays) || renewDays <= 0) {
        console.error(`acme: ignoring invalid ACME_RENEW_DAYS (${env.ACME_RENEW_DAYS}), using 30`);
        renewDays = 30;
    }

    return {
        host,
        email,
        directoryUrl,
        renewDays,
        tryPort80: (env.ACME_PORT80 ?? '1') !== '0',
        keysDir: 'keys',
        httpPort: parseInt(env.WEBSOCKET_PORT || '8080')
    };
}

//
// Days of validity left on a PEM certificate, fractional. null when the input
// does not parse as a certificate - callers treat that as renewal-due.
export function certificateDaysRemaining(certPem: string | Buffer, nowMs: number = Date.now()): number | null {
    let parsed: X509Certificate;
    try {
        parsed = new X509Certificate(certPem);
    } catch (e) {
        return null;
    }
    const validTo = Date.parse(parsed.validTo);
    if (isNaN(validTo)) {
        return null;
    }
    return (validTo - nowMs) / DAY_MS;
}

// Missing (null) and unparseable certificates are both due - the order path is
// the fix for either.
export function isRenewalDue(certPem: string | Buffer | null, renewDays: number, nowMs: number = Date.now()): boolean {
    if (certPem === null) {
        return true;
    }
    const days = certificateDaysRemaining(certPem, nowMs);
    return days === null || days < renewDays;
}

// Backoff after a failed order: 1h, 2h, 4h ... capped at 24h, +-10% jitter so a
// fleet of restarts does not synchronise against the CA.
export function nextRetryDelayMs(consecutiveFailures: number, rand: () => number = Math.random): number {
    const base = Math.min(HOUR_MS * Math.pow(2, Math.max(consecutiveFailures, 1) - 1), DAY_MS);
    return Math.round(base * (0.9 + 0.2 * rand()));
}

// Routine expiry check cadence: twice a day-ish, jittered up to an hour.
export function nextRoutineCheckDelayMs(rand: () => number = Math.random): number {
    return Math.round(12 * HOUR_MS + rand() * HOUR_MS);
}

//
// http-01 challenge responses, token -> keyAuthorization. Shared between the
// daemon's always-on HTTP listener (ogn.ts routes the prefix here) and the
// temporary :80 listener below. Only one order runs at a time (inFlight guard)
// so clearing wholesale after an order cannot race another order's tokens.
const CHALLENGE_PREFIX = '/.well-known/acme-challenge/';
const challengeResponses = new Map<string, string>();

export function registerChallenge(token: string, keyAuthorization: string): void {
    challengeResponses.set(token, keyAuthorization);
}

export function unregisterChallenge(token: string): void {
    challengeResponses.delete(token);
}

export function clearChallenges(): void {
    challengeResponses.clear();
}

// null = not an ACME URL or unknown token; callers fall through to their 404.
export function getAcmeChallengeResponse(url: string | undefined): string | null {
    if (!url || !url.startsWith(CHALLENGE_PREFIX)) {
        return null;
    }
    return challengeResponses.get(url.slice(CHALLENGE_PREFIX.length)) ?? null;
}

export interface AcmeStatus {
    host: string;
    certDaysRemaining: number | null;
    lastCheckAt: number | null;
    lastError: string | null;
    nextCheckAt: number | null;
    inFlight: boolean;
}

export interface AcmeManager {
    stop(): void;
    forceCheck(reason: string): void;
    status(): AcmeStatus;
}

//
// Start the renewal loop: an immediate check, then self-scheduling ticks.
// onCertificate receives every freshly issued (key, fullchain-cert) pair after
// it has been validated and written to disk - ogn.ts uses it to hot-swap the
// live TLS context (or to start the TLS listener on first-ever issuance).
export function startAcmeManager(config: AcmeConfig & {onCertificate: (key: Buffer, cert: Buffer) => void | Promise<void>}): AcmeManager {
    const keyPath = `${config.keysDir}/${config.host}.key.pem`;
    const certPath = `${config.keysDir}/${config.host}.cert.pem`;
    const accountKeyPath = `${config.keysDir}/acme/account.key.pem`;

    let stopped = false;
    let inFlight = false;
    let consecutiveFailures = 0;
    let timer: NodeJS.Timeout | null = null;
    let lastCheckAt: number | null = null;
    let lastError: string | null = null;
    let nextCheckAt: number | null = null;
    let certDaysRemaining: number | null = null;

    function scheduleNext(delayMs: number, why: string): void {
        if (stopped) {
            return;
        }
        if (timer) {
            clearTimeout(timer);
        }
        nextCheckAt = Date.now() + delayMs;
        console.log(`acme: next certificate check for ${config.host} in ${(delayMs / HOUR_MS).toFixed(1)}h (${why})`);
        timer = setTimeout(() => runCheck('timer'), delayMs);
        timer.unref(); // never keeps the daemon alive at shutdown
    }

    async function loadOrCreateAccountKey(): Promise<Buffer> {
        try {
            return readFileSync(accountKeyPath);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw e; // exists-but-unreadable is a real problem, surface it
            }
        }
        console.log(`acme: creating new account key at ${accountKeyPath}`);
        const accountKey = await acme.crypto.createPrivateKey();
        mkdirSync(`${config.keysDir}/acme`, {recursive: true});
        writeFileSync(accountKeyPath, accountKey, {mode: 0o600});
        return accountKey;
    }

    // Best-effort: resolves null (never rejects) when :80 cannot be bound, in
    // which case validation relies on an external forward of the challenge
    // prefix to the always-on listener. Either way the order proceeds.
    function openTemporaryPort80(): Promise<http.Server | null> {
        return new Promise((resolve) => {
            const server = http.createServer((req, res) => {
                const response = getAcmeChallengeResponse(req.url);
                if (response !== null) {
                    res.writeHead(200, {'Content-Type': 'text/plain', 'Cache-Control': 'no-store'});
                    res.end(response);
                } else {
                    res.writeHead(404);
                    res.end();
                }
            });
            server.once('error', (e: NodeJS.ErrnoException) => {
                if (e.code === 'EACCES' || e.code === 'EADDRINUSE') {
                    console.log(`acme: cannot bind :80 (${e.code}) - relying on an external forward of ${CHALLENGE_PREFIX} to port ${config.httpPort}`);
                } else {
                    console.error(`acme: unexpected error binding :80 for ${config.host}, proceeding without it:`, e);
                }
                resolve(null);
            });
            server.listen(80, () => {
                console.log('acme: temporary challenge listener on :80');
                server.unref();
                resolve(server);
            });
        });
    }

    async function obtainCertificate(): Promise<void> {
        const accountKey = await loadOrCreateAccountKey();
        const tempServer = config.tryPort80 ? await openTemporaryPort80() : null;
        try {
            const [certKey, csr] = await acme.crypto.createCsr({commonName: config.host});
            const client = new acme.Client({directoryUrl: config.directoryUrl, accountKey, backoffAttempts: 10, backoffMin: 5000, backoffMax: 30000});
            const cert = await client.auto({
                csr,
                email: config.email,
                termsOfServiceAgreed: true,
                challengePriority: ['http-01'],
                challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
                    registerChallenge(challenge.token, keyAuthorization);
                },
                challengeRemoveFn: async (_authz, challenge) => {
                    unregisterChallenge(challenge.token);
                }
            });

            // Refuse to touch disk or the live listener with a pair Node will
            // not accept - throws into the runCheck boundary, old files and the
            // old TLS context stay in service.
            tls.createSecureContext({key: certKey, cert});

            // Write both files via tmp+rename so a crash mid-write can never
            // leave a truncated pem behind. The two renames are not one
            // transaction - a reader in the sub-millisecond window between
            // them sees a mismatched pair; a restart re-reads both.
            writeFileSync(`${keyPath}.tmp`, certKey, {mode: 0o600});
            writeFileSync(`${certPath}.tmp`, cert);
            renameSync(`${keyPath}.tmp`, keyPath);
            renameSync(`${certPath}.tmp`, certPath);

            certDaysRemaining = certificateDaysRemaining(cert);
            console.log(`acme: obtained certificate for ${config.host}, ${certDaysRemaining === null ? 'unknown' : Math.floor(certDaysRemaining)} days validity`);

            await config.onCertificate(Buffer.from(certKey), Buffer.from(cert));
        } finally {
            clearChallenges();
            tempServer?.close();
        }
    }

    async function runCheck(reason: string): Promise<void> {
        if (stopped) {
            return;
        }
        if (inFlight) {
            console.log(`acme: check (${reason}) skipped - renewal already in flight`);
            return;
        }
        inFlight = true;
        lastCheckAt = Date.now();
        try {
            // The pair is only usable if both halves are readable - a missing
            // key with a valid cert (half-restored backup etc) still needs a
            // reissue or the TLS listener can never come up.
            let certPem: Buffer | null = null;
            let haveKey = true;
            try {
                certPem = readFileSync(certPath);
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw e;
                }
            }
            try {
                readFileSync(keyPath);
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw e;
                }
                haveKey = false;
            }

            certDaysRemaining = certPem ? certificateDaysRemaining(certPem) : null;
            if (certPem && certDaysRemaining === null) {
                console.error(`acme: existing certificate at ${certPath} is unparseable - reissuing`);
            }
            if (certPem && !haveKey) {
                console.error(`acme: certificate exists but ${keyPath} is missing - reissuing`);
            }

            if (haveKey && !isRenewalDue(certPem, config.renewDays)) {
                console.log(`acme: certificate for ${config.host} has ${Math.floor(certDaysRemaining!)} days remaining (check: ${reason}), renews at <${config.renewDays}`);
                lastError = null;
                consecutiveFailures = 0;
                scheduleNext(nextRoutineCheckDelayMs(), 'routine');
                return;
            }

            console.log(`acme: ordering certificate for ${config.host} from ${config.directoryUrl} (check: ${reason})`);
            await obtainCertificate();
            lastError = null;
            consecutiveFailures = 0;
            scheduleNext(nextRoutineCheckDelayMs(), 'routine');
        } catch (e) {
            // Boundary for everything unexpected in the tick: log with full
            // context and retry with backoff - never crash the daemon, never
            // latch ACME off.
            consecutiveFailures++;
            lastError = e instanceof Error ? e.message : String(e);
            console.error(`acme: certificate check/renewal for ${config.host} failed (attempt ${consecutiveFailures}, directory ${config.directoryUrl}):`, e);
            if (/challenge|authoriz|verif/i.test(lastError)) {
                console.error(`acme: ensure port 80 of ${config.host} reaches this daemon or forwards ${CHALLENGE_PREFIX} to port ${config.httpPort}`);
            }
            const rateLimited = /rateLimited|too many/i.test(lastError);
            scheduleNext(rateLimited ? DAY_MS : nextRetryDelayMs(consecutiveFailures), rateLimited ? 'rate limited by CA' : 'retry backoff');
        } finally {
            inFlight = false;
        }
    }

    runCheck('startup').catch((e) => console.error('acme: startup check failed unexpectedly:', e));

    return {
        stop(): void {
            stopped = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            clearChallenges();
        },
        forceCheck(reason: string): void {
            runCheck(reason).catch((e) => console.error(`acme: forced check (${reason}) failed unexpectedly:`, e));
        },
        status(): AcmeStatus {
            return {
                host: config.host,
                certDaysRemaining: certDaysRemaining === null ? null : Math.floor(certDaysRemaining),
                lastCheckAt,
                lastError,
                nextCheckAt,
                inFlight
            };
        }
    };
}
