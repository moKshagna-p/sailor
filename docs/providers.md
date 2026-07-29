# Providers and credentials

`@sailor/providers` is the single gateway from the agent to model providers.
The agent receives a provider/model reference such as `anthropic:claude-sonnet-5`;
it never imports a provider SDK or handles an API key directly.

## Adding or changing a provider

Create a driver under `packages/providers/src/drivers/` and register it in
`registry.ts`. A driver declares its id, label, supported credential kinds,
curated tool-capable models, `createModel()`, `verifyApiKey()`, and optional
OAuth support. SDK imports are allowed only in this directory.

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

`POST /api/credentials` accepts an API key, verifies it against the provider
with a cheap authenticated probe (`verifyApiKey()` on the driver), and only
then stores it encrypted. A rejected key is a 401 and is never saved; an
unreachable provider is a 502, so a network fault is never reported as a wrong
key. The route returns only `{ ok: true }`; neither it nor credential-listing
endpoints return a key or a prefix. Environment fallbacks are `ANTHROPIC_API_KEY`,
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
  store, and redirects to `/settings?oauth=connected` — a clean browser URL
  with no code in it. Failures redirect to `/settings?oauth=error` with a
  user-legible reason instead of rendering JSON at the API origin.

Some public OAuth clients refuse third-party redirect URIs. Anthropic's is one:
its consent page can only land on Anthropic's own code-display page. A driver
declares this with `codePaste` on its OAuth descriptor, and the flow changes
shape: `/authorize` still creates the state and redirects to consent, but the
provider then shows the user a `code#state` string, which the browser submits to
`POST /api/oauth/:provider/exchange`. The state half must match a live attempt
created by the same user; the exchange behaves exactly like the callback route
otherwise, and no token is ever in the response.

The Settings page offers a "Connect account" button for every provider whose
driver currently exposes an `oauth` descriptor (`oauthFlow` in
`GET /api/models`), alongside the API-key form — plus a paste-the-code field
for `code-paste` providers.

A provider that *could* do OAuth but has not been configured on this deployment
reports its missing variables as `oauthMissingEnv`, sourced from the driver's
`oauthRequires`. Settings uses that to say "not set up here, an operator needs
to set X" rather than silently omitting the button, which is indistinguishable
from the provider having no OAuth at all.

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

## OpenRouter: the zero-setup path

OpenRouter is the only provider that needs no configuration from anyone. There
is no client to register and no secret to set, because OpenRouter identifies the
app by its callback URL and accepts localhost on any port. That makes it the
only route by which a brand-new user holding no API key at all can reach a
working model, so Settings leads with it whenever no credential exists yet.

Its flow is OAuth-shaped but does not end in a token: `POST /api/v1/auth/keys`
returns a durable API key scoped to the user. Two consequences shaped the code:

- `exchangeCode` returns an `ExchangedCredential`, a union of `{ kind: 'oauth' }`
  and `{ kind: 'api_key' }`. A sign-in flow and the credential it produces are
  independent, and forcing OpenRouter's key into the token shape would mean
  inventing an expiry it does not have — after which the refresh path would fire
  against a provider that has no refresh endpoint.
- OpenRouter's consent URL spells the redirect `callback_url` and has no `state`
  parameter, so its driver implements `buildAuthorizationUrl` and threads state
  through the callback URL's own query string, which OpenRouter preserves when
  it appends `?code=`. The callback route still gets the state it needs to bind
  the response to the user who began the flow; the quirk stays in the driver
  instead of leaking a special case into the API route.

Its curated model list includes two free, tool-capable slugs. Tool support is
the constraint — most free models lack it, and a model that cannot call tools is
useless to this agent no matter how cheap it is.
