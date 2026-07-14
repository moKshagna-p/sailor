# Providers and credentials

`@sailor/providers` is the single gateway from the agent to model providers.
The agent receives a provider/model reference such as `anthropic:claude-sonnet-5`;
it never imports a provider SDK or handles an API key directly.

## Adding or changing a provider

Create a driver under `packages/providers/src/drivers/` and register it in
`registry.ts`. A driver declares its id, label, supported credential kinds,
curated tool-capable models, `createModel()`, and optional OAuth support. SDK
imports are allowed only in this directory.

The registry owns the common resolution order:

1. Load the user's encrypted stored credential.
2. If it is OAuth and expires within 60 seconds, refresh it and save the
   replacement.
3. If no stored credential exists, fall back to the provider's environment API
   key.
4. Return a model bound to that credential, or a `NoCredentialError`.

This means a user's own connection always beats an operator key, and a refresh
failure simply makes that provider unavailable rather than breaking the model
picker.

## API keys

`POST /api/credentials` accepts an API key and stores it encrypted. The route
returns only `{ ok: true }`; neither it nor credential-listing endpoints return
a key or a prefix. Environment fallbacks are `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, and `OPENROUTER_API_KEY`.

## OAuth

OAuth-capable drivers expose an `oauth` descriptor: authorization URL, public
client id, requested scopes, optional authorization parameters, whether PKCE is
required, and the provider-owned authorization-code exchange. The API therefore
uses the same generic routes for every configured driver:

- `GET /api/oauth/:provider/authorize` creates a random, one-use state record
  bound to the current user for ten minutes, then redirects to the provider.
- `GET /api/oauth/:provider/callback` validates and consumes that state, trades
  the code for tokens through the driver, encrypts them through the credential
  store, and redirects to a clean browser URL with no code in it.

The state and PKCE verifier are in API memory only and are deleted on use or
expiry. Access and refresh tokens never pass through a browser response. For a
multi-instance deployment, replace this in-memory short-lived state store with a
shared TTL-backed store before sending users to different API instances.

Anthropic's public OAuth client is available out of the box and uses PKCE.
OpenAI OAuth needs `OPENAI_OAUTH_CLIENT_ID` (and optionally
`OPENAI_OAUTH_CLIENT_SECRET`); Google OAuth needs both
`GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. Configure the exact
`API_PUBLIC_URL` callback origin with each provider; it defaults to the local
API listener. Each provider's OAuth app must register
`/api/oauth/<provider>/callback` as its redirect URI.

OpenRouter intentionally has no OAuth descriptor because it is API-key-only.
