import { expect, test } from 'bun:test';
import { prefersOAuth, providerStatus } from './provider-settings.ts';

const provider = {
  id: 'google',
  label: 'Google Gemini',
  supports: ['api_key', 'oauth'],
  available: false,
  oauthFlow: 'redirect',
  oauthMissingEnv: [],
  models: [],
};

test('a configured account has one clear connected status', () => {
  const credential = {
    provider: 'google',
    kind: 'oauth',
    label: 'Google account',
    expiresAt: null,
  };
  expect(providerStatus(provider, credential)).toBe('Connected · Account');
});

test('OAuth is primary only when this deployment can start it', () => {
  expect(prefersOAuth(provider)).toBe(true);
  expect(prefersOAuth({ ...provider, oauthFlow: null })).toBe(false);
  expect(prefersOAuth({ ...provider, oauthMissingEnv: ['GOOGLE_OAUTH_CLIENT_ID'] })).toBe(false);
});

test('an operator key is visible as environment access', () => {
  expect(providerStatus({ ...provider, available: true }, undefined)).toBe('Environment key');
  expect(providerStatus(provider, undefined)).toBe('Not connected');
});
