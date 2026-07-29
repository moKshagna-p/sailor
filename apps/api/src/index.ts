import { cors } from '@elysiajs/cors';
import { errorMessage, ProviderId, ResumeTree, summariseDiagnostics } from '@sailor/core';
import {
  commitVersion,
  createJobTarget,
  createResume,
  deleteCredential,
  getCurrentVersion,
  getVersion,
  isResumeOwnedBy,
  isVersionOwnedBy,
  listCredentials,
  listResumes,
  listVersions,
  rollbackTo,
  upsertCredential,
} from '@sailor/db';
import { compileWithTectonic, prewarm, STARTER_RESUME } from '@sailor/latex';
import { allDrivers, availableProviders, getDriver } from '@sailor/providers';
import { Elysia } from 'elysia';
import { z } from 'zod';
import { attachAcp } from './acp-bridge.ts';
import { currentUserId } from './auth.ts';
import { credentialStore } from './credential-store.ts';

const PORT = Number(process.env.API_PORT ?? 3001);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';

/** Parse at the boundary; inside, values are real types. Never cast. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(z.prettifyError(result.error));
  }
  return result.data;
}

class ValidationError extends Error {
  readonly status = 400;
}

class OAuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

/** A stored-key problem the user can act on: 401 wrong key, 502 provider down. */
class CredentialError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 502,
  ) {
    super(message);
  }
}

type OAuthAttempt = {
  userId: string;
  provider: ProviderId;
  codeVerifier: string | null;
  expiresAt: number;
};

const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const oauthAttempts = new Map<string, OAuthAttempt>();

function randomOAuthValue(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString('base64url');
}

function removeExpiredOAuthAttempts(now = Date.now()): void {
  for (const [state, attempt] of oauthAttempts) {
    if (attempt.expiresAt <= now) oauthAttempts.delete(state);
  }
}

function oauthCallbackUrl(provider: ProviderId): string {
  const apiOrigin = process.env.API_PUBLIC_URL ?? `http://localhost:${PORT}`;
  return new URL(`/api/oauth/${provider}/callback`, apiOrigin).toString();
}

function settingsUrl(params: Record<string, string>): string {
  const url = new URL('/settings', WEB_ORIGIN);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

/** Live ACP peers, keyed by Elysia's socket id. See the /acp handler below. */
const peers = new Map<string, ReturnType<typeof attachAcp>>();

async function requireResumeOwner(userId: string, resumeId: string): Promise<void> {
  if (!(await isResumeOwnedBy(userId, resumeId))) {
    throw new ValidationError(`Resume ${resumeId} not found`);
  }
}

async function requireVersionOwner(userId: string, versionId: string): Promise<void> {
  if (!(await isVersionOwnedBy(userId, versionId))) {
    throw new ValidationError(`Version ${versionId} not found`);
  }
}

const app = new Elysia()
  .use(cors({ origin: WEB_ORIGIN, credentials: true }))
  .onError(({ error, code, set }) => {
    if (error instanceof ValidationError) {
      set.status = 400;
      return { error: error.message };
    }
    if (error instanceof OAuthError || error instanceof CredentialError) {
      set.status = error.status;
      return { error: error.message };
    }
    if (code === 'NOT_FOUND') {
      set.status = 404;
      return { error: 'Not found' };
    }
    // Never leak an internal error message to the client verbatim — it may carry
    // a connection string or a key. Log it, return something safe.
    console.error('[api]', error);
    set.status = 500;
    return { error: 'Internal error' };
  })

  .get('/health', () => ({ ok: true }))

  // --- Models & credentials ------------------------------------------------

  .get('/api/models', async ({ headers }) => {
    const userId = await currentUserId(headers);
    const available = await availableProviders(userId, credentialStore);

    return {
      providers: allDrivers().map((d) => ({
        id: d.id,
        label: d.label,
        supports: d.supports,
        available: available.includes(d.id),
        // `supports` says the provider could do OAuth; this says whether our
        // OAuth client for it is actually configured, and which shape the flow
        // takes: a normal redirect back to us, or a code the user pastes.
        oauthFlow: d.oauth
          ? d.oauth.codePaste
            ? ('code-paste' as const)
            : ('redirect' as const)
          : null,
        // Only populated when OAuth is possible but unconfigured, so the UI can
        // say what is missing rather than silently omitting a button.
        oauthMissingEnv: d.oauth ? [] : (d.oauthRequires ?? []),
        models: d.models,
      })),
    };
  })

  .get('/api/credentials', async ({ headers }) => {
    const userId = await currentUserId(headers);
    return { credentials: await listCredentials(userId) };
  })

  .post('/api/credentials', async ({ headers, body }) => {
    const userId = await currentUserId(headers);
    const input = parse(
      z.object({
        provider: ProviderId,
        apiKey: z.string().min(8),
        label: z.string().min(1).default('API key'),
      }),
      body,
    );

    // Ask the provider itself before storing anything. A key that was never
    // checked shows up as "Connected" and then fails mid-agent-turn — the worst
    // possible place to discover a typo.
    const driver = getDriver(input.provider);
    let keyWorks: boolean;
    try {
      keyWorks = await driver.verifyApiKey(input.apiKey);
    } catch (cause) {
      console.error(`[api] ${input.provider} key verification faulted:`, errorMessage(cause));
      throw new CredentialError(
        `Could not reach ${driver.label} to verify that key, so it was not saved. Try again in a moment.`,
        502,
      );
    }
    if (!keyWorks) {
      throw new CredentialError(
        `${driver.label} rejected that API key, so it was not saved. Check it for typos or create a new one.`,
        401,
      );
    }

    await upsertCredential({
      userId,
      provider: input.provider,
      kind: 'api_key',
      label: input.label,
      secret: input.apiKey,
    });

    // Note what is NOT returned: the key. Not even a prefix of it.
    return { ok: true };
  })

  .delete('/api/credentials/:provider', async ({ headers, params }) => {
    const userId = await currentUserId(headers);
    await deleteCredential(userId, parse(ProviderId, params.provider));
    return { ok: true };
  })

  // --- Provider OAuth -----------------------------------------------------

  /**
   * Starts an OAuth authorization-code flow. State is one-use, bound to the
   * current user, and retained only long enough to receive the provider's
   * callback. The browser is redirected straight to the provider; no token is
   * ever present in a response from Sailor.
   */
  .get('/api/oauth/:provider/authorize', async ({ headers, params }) => {
    const userId = await currentUserId(headers);
    const provider = parse(ProviderId, params.provider);
    const oauth = getDriver(provider).oauth;
    if (!oauth) {
      throw new OAuthError(`OAuth is not configured for ${provider}`, 404);
    }

    removeExpiredOAuthAttempts();
    const state = randomOAuthValue();
    const codeVerifier = oauth.usesPkce ? randomOAuthValue() : null;
    oauthAttempts.set(state, {
      userId,
      provider,
      codeVerifier,
      expiresAt: Date.now() + OAUTH_ATTEMPT_TTL_MS,
    });

    const codeChallenge = codeVerifier ? await pkceChallenge(codeVerifier) : null;
    // Code-paste clients only allow the provider's own code page as the target;
    // everyone else comes back to our /callback route.
    const redirectUri = oauth.codePaste?.redirectUri ?? oauthCallbackUrl(provider);

    // Providers that spell the authorize parameters their own way build the URL
    // themselves; the rest get standard OAuth 2.0.
    if (oauth.buildAuthorizationUrl) {
      return Response.redirect(
        oauth.buildAuthorizationUrl({ redirectUri, state, codeChallenge }),
        302,
      );
    }

    const redirect = new URL(oauth.authorizationUrl);
    if (oauth.clientId) redirect.searchParams.set('client_id', oauth.clientId);
    redirect.searchParams.set('redirect_uri', redirectUri);
    redirect.searchParams.set('response_type', 'code');
    redirect.searchParams.set('scope', oauth.scopes.join(' '));
    redirect.searchParams.set('state', state);
    for (const [name, value] of Object.entries(oauth.authorizationParams ?? {})) {
      redirect.searchParams.set(name, value);
    }
    if (codeChallenge) {
      redirect.searchParams.set('code_challenge', codeChallenge);
      redirect.searchParams.set('code_challenge_method', 'S256');
    }

    return Response.redirect(redirect.toString(), 302);
  })

  /**
   * Exchanges a one-time authorization code and redirects without exposing it.
   * This is a browser navigation arriving from the provider, so it never renders
   * JSON: success and failure both land back on Settings with a legible banner.
   */
  .get('/api/oauth/:provider/callback', async ({ headers, params, query }) => {
    try {
      const provider = parse(ProviderId, params.provider);
      const input = parse(
        z.object({
          state: z.string().min(1),
          code: z.string().min(1).optional(),
          error: z.string().min(1).optional(),
        }),
        query,
      );
      const attempt = oauthAttempts.get(input.state);
      oauthAttempts.delete(input.state);

      if (!attempt || attempt.expiresAt <= Date.now()) {
        throw new OAuthError('That OAuth sign-in link has expired. Start again from Sailor.', 409);
      }
      if (attempt.provider !== provider) {
        throw new OAuthError('That OAuth sign-in link was issued for another provider.', 400);
      }
      if (input.error || !input.code) {
        throw new OAuthError('The provider did not approve the connection.', 400);
      }

      // State is the authoritative binding, but this catches a stale/cross-user
      // browser session too when the real auth adapter replaces the development stub.
      const userId = await currentUserId(headers);
      if (userId !== attempt.userId) {
        throw new OAuthError('Your Sailor session changed while connecting the provider.', 409);
      }

      const oauth = getDriver(provider).oauth;
      if (!oauth) {
        throw new OAuthError(`OAuth is not configured for ${provider}`, 404);
      }
      const token = await oauth.exchangeCode({
        code: input.code,
        state: input.state,
        redirectUri: oauthCallbackUrl(provider),
        codeVerifier: attempt.codeVerifier,
      });
      await credentialStore.save(userId, provider, token);

      // The code has been consumed by this point. Redirect to a URL with no code,
      // avoiding browser history and Referer leaks from the callback query string.
      return Response.redirect(settingsUrl({ oauth: 'connected' }), 302);
    } catch (cause) {
      console.error('[api] oauth callback failed:', errorMessage(cause));
      // OAuthError messages are written for the user; anything else stays vague
      // so an internal message can never leak through a redirect.
      const reason =
        cause instanceof OAuthError
          ? cause.message
          : 'The connection could not be completed. Try again.';
      return Response.redirect(settingsUrl({ oauth: 'error', reason }), 302);
    }
  })

  /**
   * Completes a code-paste OAuth flow (Anthropic). The consent page cannot
   * redirect back to Sailor, so it shows the user a `code#state` string and the
   * browser POSTs it here. The state half must match a live attempt created by
   * /authorize for this same user — the pasted string alone is not enough.
   */
  .post('/api/oauth/:provider/exchange', async ({ headers, params, body }) => {
    const userId = await currentUserId(headers);
    const provider = parse(ProviderId, params.provider);
    const oauth = getDriver(provider).oauth;
    if (!oauth?.codePaste) {
      throw new OAuthError(`Pasting a code is not how ${provider} connects here.`, 404);
    }

    const input = parse(z.object({ code: z.string().min(1) }), body);
    const pasted = input.code.trim();
    const hash = pasted.indexOf('#');
    if (hash <= 0 || hash === pasted.length - 1) {
      throw new OAuthError(
        'That does not look like a complete code. Copy the whole string the provider showed, including the part after "#".',
        400,
      );
    }
    const code = pasted.slice(0, hash);
    const state = pasted.slice(hash + 1);

    const attempt = oauthAttempts.get(state);
    oauthAttempts.delete(state);
    if (!attempt || attempt.expiresAt <= Date.now()) {
      throw new OAuthError(
        'That code has expired or was already used. Click Connect and approve again.',
        409,
      );
    }
    if (attempt.provider !== provider || attempt.userId !== userId) {
      throw new OAuthError('That code was issued for a different connection attempt.', 409);
    }

    const token = await oauth.exchangeCode({
      code,
      state,
      redirectUri: oauth.codePaste.redirectUri,
      codeVerifier: attempt.codeVerifier,
    });
    await credentialStore.save(userId, provider, token);

    // Like every credential route: the token itself is never in the response.
    return { ok: true };
  })

  // --- Resumes -------------------------------------------------------------

  .get('/api/resumes', async ({ headers }) => {
    const userId = await currentUserId(headers);
    return { resumes: await listResumes(userId) };
  })

  .post('/api/resumes', async ({ headers, body }) => {
    const userId = await currentUserId(headers);
    const input = parse(
      z.object({
        title: z.string().min(1).max(120).default('Untitled resume'),
        /** Omit to start from the built-in template. */
        tree: ResumeTree.optional(),
      }),
      body,
    );

    const tree = input.tree ?? STARTER_RESUME;

    // Refuse to store a resume that does not build. Otherwise the user's very
    // first action is staring at a broken preview with no idea why.
    const compiled = await compileWithTectonic(tree);
    if (!compiled.ok) {
      throw new ValidationError(
        `That LaTeX does not compile, so it was not saved:\n${summariseDiagnostics(
          compiled.diagnostics,
        )}`,
      );
    }

    const { resumeId, versionId } = await createResume({
      userId,
      title: input.title,
      tree,
    });
    return { resumeId, versionId };
  })

  .get('/api/resumes/:id', async ({ headers, params }) => {
    const userId = await currentUserId(headers);
    await requireResumeOwner(userId, params.id);
    const version = await getCurrentVersion(params.id);
    if (!version) throw new ValidationError(`Resume ${params.id} not found`);
    return { version };
  })

  .get('/api/resumes/:id/versions', async ({ headers, params }) => {
    const userId = await currentUserId(headers);
    await requireResumeOwner(userId, params.id);
    return { versions: await listVersions(params.id) };
  })

  /** A user-initiated save from the editor. */
  .post('/api/resumes/:id/versions', async ({ headers, params, body }) => {
    const userId = await currentUserId(headers);
    await requireResumeOwner(userId, params.id);
    const input = parse(
      z.object({
        tree: ResumeTree,
        summary: z.string().min(1).max(200).default('Manual edit'),
        parentId: z.string().nullable().default(null),
      }),
      body,
    );

    const outcome = await commitVersion({
      resumeId: params.id,
      tree: input.tree,
      summary: input.summary,
      createdBy: 'user',
      parentId: input.parentId,
    });

    return {
      versionId: outcome.version.id,
      unchanged: outcome.status === 'unchanged',
    };
  })

  .post('/api/resumes/:id/rollback', async ({ headers, params, body }) => {
    const userId = await currentUserId(headers);
    await requireResumeOwner(userId, params.id);
    const input = parse(z.object({ versionId: z.string() }), body);
    await requireVersionOwner(userId, input.versionId);
    const version = await getVersion(input.versionId);
    if (!version || version.resumeId !== params.id) {
      throw new ValidationError(`Version ${input.versionId} does not belong to this resume`);
    }
    const outcome = await rollbackTo(input.versionId);
    return { versionId: outcome.version.id };
  })

  /**
   * The authoritative compile. Returns the PDF itself, not a URL — the document
   * is small, the client wants it immediately, and a URL would mean storing a
   * PDF we would then have to invalidate.
   */
  .post('/api/compile', async ({ body, set }) => {
    const input = parse(z.object({ tree: ResumeTree }), body);
    const result = await compileWithTectonic(input.tree);

    if (!result.ok) {
      set.status = 422;
      return {
        ok: false,
        diagnostics: result.diagnostics,
        summary: summariseDiagnostics(result.diagnostics),
        durationMs: result.durationMs,
      };
    }

    set.headers['content-type'] = 'application/pdf';
    set.headers['x-compile-ms'] = String(result.durationMs);
    return new Response(new Uint8Array(result.pdf));
  })

  /** Compile a stored version — used by the download button. */
  .get('/api/versions/:id/pdf', async ({ headers, params, set }) => {
    const userId = await currentUserId(headers);
    await requireVersionOwner(userId, params.id);
    const version = await getVersion(params.id);
    if (!version) throw new ValidationError(`Version ${params.id} not found`);

    const result = await compileWithTectonic(version.tree);
    if (!result.ok) {
      set.status = 422;
      return { ok: false, summary: summariseDiagnostics(result.diagnostics) };
    }

    set.headers['content-type'] = 'application/pdf';
    set.headers['content-disposition'] = `attachment; filename="resume.pdf"`;
    return new Response(new Uint8Array(result.pdf));
  })

  // --- Job targets ---------------------------------------------------------

  .post('/api/jobs', async ({ headers, body }) => {
    const userId = await currentUserId(headers);
    const input = parse(
      z.object({
        company: z.string().min(1),
        role: z.string().min(1),
        description: z.string().min(20),
        sourceUrl: z.url().nullable().default(null),
      }),
      body,
    );

    const id = await createJobTarget({
      userId,
      ...input,
      // The user typed or pasted this. Only the agent's own fetch_url earns
      // 'fetched', and the prompt tells the model to treat the two differently.
      provenance: 'pasted',
    });

    return { jobTargetId: id };
  })

  // --- ACP -----------------------------------------------------------------

  /**
   * One ACP peer per socket, tracked here by socket id.
   *
   * Do NOT stash the peer on `ws.data`: Elysia rebuilds the context between the
   * `open` and `message` handlers, so a mutation made in `open` is simply gone by
   * the time a frame arrives — the socket connects, every request hangs, and
   * nothing errors. An explicit map is the only thing that survives.
   */
  .ws('/acp', {
    // Synchronous on purpose — see the note on attachAcp. Awaiting anything here
    // loses the client's first frame.
    open(ws) {
      peers.set(
        ws.id,
        attachAcp({ send: (raw) => ws.send(raw), close: () => ws.close() }, () =>
          currentUserId({}),
        ),
      );
    },

    async message(ws, message) {
      const connection = peers.get(ws.id);
      if (!connection) return;

      await connection.handle(typeof message === 'string' ? message : JSON.stringify(message));
    },

    close(ws) {
      peers.get(ws.id)?.close('The client disconnected');
      peers.delete(ws.id);
    },
  })

  .listen(PORT);

// Populate the TeX package cache now, so the first user compile is not the one
// that pays the download cost. Deliberately not awaited — the server should
// accept connections immediately.
void prewarm().catch((cause) => console.error('[api] prewarm failed:', errorMessage(cause)));

console.warn(`[api] listening on http://localhost:${PORT}  (ACP: ws://localhost:${PORT}/acp)`);

export type App = typeof app;
