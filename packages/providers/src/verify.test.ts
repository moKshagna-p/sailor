import { afterEach, expect, test } from 'bun:test';
import { providerIds } from '@sailor/core';
import { keyProbeResult } from './driver.ts';
import { getDriver } from './registry.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(status: number): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return new Response(status === 200 ? '{}' : '{"error":"nope"}', { status });
  }) as typeof fetch;
  return { calls };
}

test('every driver can verify an API key — the credentials route depends on it', () => {
  for (const id of providerIds) {
    expect(typeof getDriver(id).verifyApiKey).toBe('function');
  }
});

test('a key the provider accepts verifies true', async () => {
  for (const id of providerIds) {
    stubFetch(200);
    expect(await getDriver(id).verifyApiKey('sk-plausible-but-fake')).toBe(true);
  }
});

test('a key the provider rejects verifies false, not an exception', async () => {
  for (const id of providerIds) {
    stubFetch(401);
    expect(await getDriver(id).verifyApiKey('sk-wrong')).toBe(false);
  }
});

test('a provider outage throws — it must never read as "wrong key"', async () => {
  for (const id of providerIds) {
    stubFetch(500);
    expect(getDriver(id).verifyApiKey('sk-unknowable')).rejects.toThrow(/verification failed/);
  }
});

test('Google reports a bad key as 400, which still means invalid, not a fault', async () => {
  stubFetch(400);
  expect(await getDriver('google').verifyApiKey('AIza-wrong')).toBe(false);
});

test('the probe never puts the key in the URL where a proxy log could catch it', async () => {
  for (const id of providerIds) {
    const { calls } = stubFetch(200);
    await getDriver(id).verifyApiKey('sk-super-secret-value');
    expect(calls.join(' ')).not.toContain('sk-super-secret-value');
  }
});

test('keyProbeResult treats only the declared statuses as a definitive no', () => {
  expect(keyProbeResult(new Response('{}', { status: 200 }), 'anthropic')).toBe(true);
  expect(keyProbeResult(new Response('', { status: 403 }), 'anthropic')).toBe(false);
  expect(() => keyProbeResult(new Response('', { status: 400 }), 'anthropic')).toThrow();
  expect(keyProbeResult(new Response('', { status: 400 }), 'google', [400, 401, 403])).toBe(false);
});
