# Real auth, provider access, and resizable workbench

## Goal

Replace Sailor's single development user with production session auth, make
model credentials clear and reliable, and let the editor, preview, and agent
panes fit the user's screen without changing the repository's boundaries.

The deliberately small product is:

- Google and GitHub sign-in only;
- the existing encrypted, per-user provider credentials;
- current curated, tool-capable model slugs; and
- native, accessible pane resizing with a compact mobile view.

Email/password auth, account linking UI, organizations, roles, billing, and a
new component or resizing library are out of scope.

## Architecture

Better Auth lives at the Elysia API boundary. The API owns the auth handler,
OAuth client secrets, sessions, and authorization decisions. The Next.js app
remains UI-only and talks to the API with cookies over HTTP and ACP WebSocket.
This keeps OAuth tokens, API keys, and database access out of the browser
bundle and preserves the existing package dependency direction.

The API mounts Better Auth at `/api/auth/*`, with Google and GitHub as its only
social providers. `WEB_ORIGIN` is the trusted browser origin and the API's
public URL is the OAuth callback origin. Better Auth's built-in state, PKCE,
CSRF, secure cookie, and session handling replace custom login logic.

The Drizzle adapter is created inside `@sailor/db`; no Drizzle import crosses
into `apps/api`. The API supplies the resulting database adapter to Better Auth
alongside its environment-backed provider configuration.

## Database and migration

Better Auth owns four conventional tables: users, accounts, sessions, and
verifications. Sailor keeps the existing plural `users` table because every
application table already references it. The schema gains Better Auth's
required user fields, while account, session, and verification tables are
added with foreign keys and the indexes expected by the adapter.

Schema source is changed in `packages/db`; the SQL migration is produced by
Drizzle Kit and is never edited by hand. Existing development-user rows and
their resumes remain intact. They are not assigned to the first person who
signs in and become unreachable through the authenticated application, which
avoids silently transferring private data between identities.

Provider OAuth authorization attempts also move from API process memory into
a small expiring DB record. Creation binds a random one-use state to the signed-
in user and provider; consumption is atomic and deletes the record. This keeps
provider connection callbacks correct across API restarts or multiple
instances. Only the verifier needed to finish the flow is stored, and expired
records are ignored.

Resume content remains immutable. Auth and credential migrations do not update
resume versions or weaken the compile-before-commit path.

## Request authentication and ownership

`currentUserId()` becomes a Better Auth session lookup using the incoming
headers. A missing or invalid session produces a real 401; it never creates a
user. Existing DB query functions continue to scope every resume, version,
session, job target, and credential operation by that returned user ID.

The shared browser HTTP helper sends credentials on every request and turns a
401 into navigation to the sign-in screen. Full-page OAuth navigation and PDF
downloads send the same session cookie. The ACP WebSocket authenticates the
upgrade request before attaching the agent peer; an unauthenticated socket is
closed without accepting agent requests.

The web app gets one minimal sign-in page with Google and GitHub buttons, one
session-loading boundary, and a compact user menu with Settings and Sign out.
There is no password form or duplicate client-side authorization state.

## Model-provider access

Login OAuth and model-provider credentials are separate concepts in both code
and UI. Signing in proves who owns data; connecting OpenRouter, Google,
Anthropic, or OpenAI grants Sailor permission to run a model for that user.

The existing provider credential path remains the source of truth:

- API keys are verified before storage;
- secrets and refresh tokens remain encrypted server-side;
- public APIs return only provider, kind, label, and expiry metadata; and
- one credential per user and provider can be replaced or removed.

Settings becomes a compact list of provider cards. Each card shows one status,
one primary action, and an optional API-key disclosure. OAuth is preferred when
the deployment supports it; API-key entry remains available because provider
OAuth does not grant free quota and is not universally supported. Login Google
OAuth must never be reused as a Gemini model credential.

The curated registry replaces discontinued Gemini slugs with currently
available tool-capable models. Registry tests continue to require tool support,
so a model cannot appear in the workbench picker if it cannot run Sailor's
agent tools. A free-text OpenRouter slug remains a separate roadmap item because
it needs provider validation and a tool-capability check at selection time.

## Resizable and responsive workbench

Desktop uses the existing three panes with two separators. Each separator is a
keyboard-focusable `role="separator"` control with an accessible label, current
value, arrow-key adjustment, and a generous hit target. Pointer dragging updates
two CSS grid track sizes, clamped so Source, Preview, and Agent each retain a
usable minimum. The current proportions are stored in local storage and restored
only when they still fit the viewport.

This uses pointer events, CSS grid, and local storage directly; no resizing
dependency is added. During dragging, text selection is disabled and pointer
capture keeps the resize stable when the cursor leaves the handle.

On narrow screens, simultaneous three-pane resizing stops being useful. The
workbench switches to Source, Preview, and Agent tabs, with one active full-width
pane. The active tab remains keyboard accessible, and changing viewport size
does not destroy editor, preview, or chat state.

## Error handling and security

- OAuth configuration errors fail at startup with the missing variable name.
- OAuth callback failures return to sign-in or Settings with a short safe reason;
  tokens, authorization codes, prompts, and resume text are never logged.
- Provider keys stay password inputs and are cleared after submission.
- Auth/session data crosses the browser boundary only through Better Auth's
  public session shape; provider secrets are never serialized to the client.
- Unauthorized HTTP requests are 401, forbidden owned-resource requests remain
  404 where hiding existence matters, and failed ACP authentication cannot start
  an agent turn.

## Verification

Automated checks cover session lookup, unauthenticated HTTP and WebSocket
access, authenticated ownership isolation, provider OAuth attempt consumption,
credential redaction, current model registry entries, separator clamping and
keyboard adjustment, and responsive pane selection.

Completion still follows the repository order: `bun run check`, `bun run
typecheck`, `bun test`, then the real flow. The driven flow signs in with Google
or GitHub, creates or opens a resume, inserts and removes a provider API key,
connects any configured provider OAuth path, compiles a preview, runs an actual
agent turn, drags both separators, exercises their keyboard controls, and checks
the tabbed workbench at a narrow viewport. Any external OAuth flow that cannot
be completed because operator credentials are unavailable is reported explicitly
rather than described as verified.
