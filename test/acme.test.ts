import {describe, it, expect, afterEach} from 'vitest';

import * as acme from 'acme-client';

import {acmeConfigFromEnv, certificateDaysRemaining, isRenewalDue, nextRetryDelayMs, nextRoutineCheckDelayMs, registerChallenge, unregisterChallenge, clearChallenges, getAcmeChallengeResponse} from '../bin/lib/acme';
import {FIXTURE_CERT_PEM, FIXTURE_CERT_NOT_AFTER_MS} from './lib/acmeFixtures';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('certificateDaysRemaining', () => {
    it('reports the exact remaining validity', () => {
        expect(certificateDaysRemaining(FIXTURE_CERT_PEM, FIXTURE_CERT_NOT_AFTER_MS - 10 * DAY_MS)).toBeCloseTo(10, 6);
        expect(certificateDaysRemaining(FIXTURE_CERT_PEM, FIXTURE_CERT_NOT_AFTER_MS - 0.5 * DAY_MS)).toBeCloseTo(0.5, 6);
    });

    it('is negative once expired', () => {
        expect(certificateDaysRemaining(FIXTURE_CERT_PEM, FIXTURE_CERT_NOT_AFTER_MS + DAY_MS)).toBeCloseTo(-1, 6);
    });

    it('returns null for garbage input', () => {
        expect(certificateDaysRemaining('not a certificate')).toBeNull();
        expect(certificateDaysRemaining('')).toBeNull();
    });
});

describe('isRenewalDue', () => {
    it('is due below the threshold and not due above it', () => {
        expect(isRenewalDue(FIXTURE_CERT_PEM, 30, FIXTURE_CERT_NOT_AFTER_MS - 29 * DAY_MS)).toBe(true);
        expect(isRenewalDue(FIXTURE_CERT_PEM, 30, FIXTURE_CERT_NOT_AFTER_MS - 31 * DAY_MS)).toBe(false);
    });

    it('is due when expired, missing or unparseable', () => {
        expect(isRenewalDue(FIXTURE_CERT_PEM, 30, FIXTURE_CERT_NOT_AFTER_MS + DAY_MS)).toBe(true);
        expect(isRenewalDue(null, 30)).toBe(true);
        expect(isRenewalDue('not a certificate', 30)).toBe(true);
    });
});

describe('challenge store', () => {
    afterEach(() => clearChallenges());

    it('serves a registered token and nothing else', () => {
        registerChallenge('tok1', 'tok1.keyauth');
        expect(getAcmeChallengeResponse('/.well-known/acme-challenge/tok1')).toBe('tok1.keyauth');
        expect(getAcmeChallengeResponse('/.well-known/acme-challenge/other')).toBeNull();
        expect(getAcmeChallengeResponse('/status')).toBeNull();
        expect(getAcmeChallengeResponse(undefined)).toBeNull();
    });

    it('forgets tokens on unregister and clear', () => {
        registerChallenge('tok1', 'a');
        registerChallenge('tok2', 'b');
        unregisterChallenge('tok1');
        expect(getAcmeChallengeResponse('/.well-known/acme-challenge/tok1')).toBeNull();
        expect(getAcmeChallengeResponse('/.well-known/acme-challenge/tok2')).toBe('b');
        clearChallenges();
        expect(getAcmeChallengeResponse('/.well-known/acme-challenge/tok2')).toBeNull();
    });
});

describe('nextRetryDelayMs', () => {
    const noJitter = () => 0.5; // 0.9 + 0.2*0.5 = exactly 1.0

    it('doubles from 1h and caps at 24h', () => {
        expect(nextRetryDelayMs(1, noJitter)).toBe(1 * HOUR_MS);
        expect(nextRetryDelayMs(2, noJitter)).toBe(2 * HOUR_MS);
        expect(nextRetryDelayMs(3, noJitter)).toBe(4 * HOUR_MS);
        expect(nextRetryDelayMs(6, noJitter)).toBe(24 * HOUR_MS);
        expect(nextRetryDelayMs(20, noJitter)).toBe(24 * HOUR_MS);
    });

    it('treats a zero failure count as the first failure', () => {
        expect(nextRetryDelayMs(0, noJitter)).toBe(1 * HOUR_MS);
    });

    it('jitters within +-10%', () => {
        expect(nextRetryDelayMs(1, () => 0)).toBe(Math.round(0.9 * HOUR_MS));
        expect(nextRetryDelayMs(1, () => 1)).toBe(Math.round(1.1 * HOUR_MS));
    });
});

describe('nextRoutineCheckDelayMs', () => {
    it('is 12h plus up to an hour of jitter', () => {
        expect(nextRoutineCheckDelayMs(() => 0)).toBe(12 * HOUR_MS);
        expect(nextRoutineCheckDelayMs(() => 1)).toBe(13 * HOUR_MS);
    });
});

describe('acmeConfigFromEnv', () => {
    const goodEnv = {ACME_ENABLED: '1', NEXT_PUBLIC_WEBSOCKET_HOST: 'gliding.example.com', ACME_EMAIL: 'ops@example.com'};

    it('is off unless explicitly enabled', () => {
        expect(acmeConfigFromEnv({})).toBeNull();
        expect(acmeConfigFromEnv({NEXT_PUBLIC_WEBSOCKET_HOST: 'gliding.example.com', ACME_EMAIL: 'ops@example.com'})).toBeNull();
        expect(acmeConfigFromEnv({...goodEnv, ACME_ENABLED: '0'})).toBeNull();
    });

    it('rejects hosts a certificate cannot be issued for', () => {
        expect(acmeConfigFromEnv({...goodEnv, NEXT_PUBLIC_WEBSOCKET_HOST: undefined})).toBeNull();
        expect(acmeConfigFromEnv({...goodEnv, NEXT_PUBLIC_WEBSOCKET_HOST: 'localhost:3000'})).toBeNull();
        expect(acmeConfigFromEnv({...goodEnv, NEXT_PUBLIC_WEBSOCKET_HOST: 'localhost'})).toBeNull();
        expect(acmeConfigFromEnv({...goodEnv, NEXT_PUBLIC_WEBSOCKET_HOST: 'example.com/path'})).toBeNull();
    });

    it('requires a contact email, with SERVER_ADMIN as fallback', () => {
        expect(acmeConfigFromEnv({...goodEnv, ACME_EMAIL: undefined})).toBeNull();
        expect(acmeConfigFromEnv({...goodEnv, ACME_EMAIL: undefined, SERVER_ADMIN: 'admin@example.com'})?.email).toBe('admin@example.com');
        expect(acmeConfigFromEnv({...goodEnv, SERVER_ADMIN: 'admin@example.com'})?.email).toBe('ops@example.com');
    });

    it('selects the directory url', () => {
        expect(acmeConfigFromEnv(goodEnv)?.directoryUrl).toBe(acme.directory.letsencrypt.production);
        expect(acmeConfigFromEnv({...goodEnv, ACME_STAGING: '1'})?.directoryUrl).toBe(acme.directory.letsencrypt.staging);
        expect(acmeConfigFromEnv({...goodEnv, ACME_STAGING: '1', ACME_DIRECTORY: 'https://ca.internal/dir'})?.directoryUrl).toBe('https://ca.internal/dir');
    });

    it('parses renewal threshold and ports with safe defaults', () => {
        expect(acmeConfigFromEnv(goodEnv)).toMatchObject({renewDays: 30, tryPort80: true, httpPort: 8080, keysDir: 'keys'});
        expect(acmeConfigFromEnv({...goodEnv, ACME_RENEW_DAYS: '45'})?.renewDays).toBe(45);
        expect(acmeConfigFromEnv({...goodEnv, ACME_RENEW_DAYS: 'soon'})?.renewDays).toBe(30);
        expect(acmeConfigFromEnv({...goodEnv, ACME_RENEW_DAYS: '-5'})?.renewDays).toBe(30);
        expect(acmeConfigFromEnv({...goodEnv, ACME_PORT80: '0'})?.tryPort80).toBe(false);
        expect(acmeConfigFromEnv({...goodEnv, WEBSOCKET_PORT: '9000'})?.httpPort).toBe(9000);
    });
});
