import {
  CancelParams,
  Connection,
  InitializeParams,
  METHODS,
  NewSessionParams,
  PromptParams,
  type Transport,
} from '@sailor/acp';
import type { AgentEvent, ToolContext } from '@sailor/agent';
import { buildTools, isGated, runTurn } from '@sailor/agent';
import { errorMessage, type GapAnalysis, parseModelRef } from '@sailor/core';
import {
  appendSessionMessages,
  commitVersion,
  createSession,
  getCurrentVersion,
  getJobTarget,
  getSession,
  getSessionMessages,
  isJobTargetOwnedBy,
  isResumeOwnedBy,
} from '@sailor/db';
import { getModel } from '@sailor/providers';
import type { ModelMessage } from 'ai';
import { credentialStore } from './credential-store.ts';

/**
 * One live ACP session. Owns the agent turn, the permission round-trips, and the
 * abort signal — so cancelling actually stops work rather than just hiding it.
 */
type LiveSession = {
  sessionId: string;
  userId: string;
  resumeId: string;
  jobTargetId: string | null;
  model: string;
  abort: AbortController | null;
};

/**
 * `getUserId` is a thunk, not a value, so that the caller can build the peer
 * **synchronously** on socket open. Resolving the user first would make `open`
 * async, and a client that sends `initialize` immediately would have its frame
 * arrive before the peer was registered — the socket connects, every request
 * hangs, and nothing errors. Ask how I know.
 */
export function attachAcp(transport: Transport, getUserId: () => Promise<string>): Connection {
  const connection = new Connection(transport);
  const sessions = new Map<string, LiveSession>();

  connection.on(METHODS.initialize, (raw) => {
    InitializeParams.parse(raw ?? {});

    // Advertise the tools and, crucially, WHICH are gated — so the client knows
    // to expect a permission request rather than being surprised by one.
    const names = Object.keys(buildTools(stubContext()));
    return {
      protocolVersion: 1,
      agent: { name: 'sailor', version: '0.1.0' },
      tools: names.map((name) => ({ name, gated: isGated(name) })),
    };
  });

  connection.on(METHODS.newSession, async (raw) => {
    const params = NewSessionParams.parse(raw);
    // Validate the model ref now, not at first token — a typo here should fail
    // loudly at session creation, not halfway through a streaming turn.
    parseModelRef(params.model);

    const userId = await getUserId();
    if (!(await isResumeOwnedBy(userId, params.resumeId))) {
      throw new Error('Resume not found');
    }
    if (params.jobTargetId !== null && !(await isJobTargetOwnedBy(userId, params.jobTargetId))) {
      throw new Error('Job target not found');
    }
    const sessionId = await createSession({
      userId,
      resumeId: params.resumeId,
      jobTargetId: params.jobTargetId,
      model: params.model,
      title: 'Tailoring session',
    });

    sessions.set(sessionId, {
      sessionId,
      userId,
      resumeId: params.resumeId,
      jobTargetId: params.jobTargetId,
      model: params.model,
      abort: null,
    });

    return { sessionId };
  });

  connection.on(METHODS.prompt, async (raw) => {
    const params = PromptParams.parse(raw);
    const session =
      sessions.get(params.sessionId) ??
      (await rehydrate(params.sessionId, await getUserId(), sessions));
    if (!session) throw new Error(`Unknown session ${params.sessionId}`);

    const ref = parseModelRef(session.model);
    const model = await getModel({
      userId: session.userId,
      provider: ref.provider,
      modelId: ref.modelId,
      store: credentialStore,
    });

    // Anthropic subscription tokens (obtained by connecting a Claude account)
    // are accepted by our token exchange but *rejected at inference* unless the
    // request impersonates Claude Code — Anthropic scopes them to that client.
    // Sailor does not impersonate another app, so this connection cannot run the
    // model. Detect it up front and say so, instead of letting the turn die with
    // an opaque "AI_APICallError: Error" after three silent retries.
    const usingAnthropicSubscription =
      ref.provider === 'anthropic' &&
      (await credentialStore.load(session.userId, 'anthropic'))?.kind === 'oauth';

    const abort = new AbortController();
    session.abort = abort;

    const emit = (event: AgentEvent) => {
      connection.notify(METHODS.update, {
        sessionId: session.sessionId,
        update: event,
      });
    };

    if (usingAnthropicSubscription) {
      emit({
        type: 'error',
        message:
          'Your Anthropic connection is a Claude subscription (from "Connect account"). ' +
          'Anthropic only allows those tokens inside Claude Code, so Sailor cannot run the ' +
          'model with it. Add an Anthropic API key in Settings instead — create one at ' +
          'console.anthropic.com — or pick a provider you have a key for.',
      });
      emit({ type: 'turn_end', stopReason: 'error' });
      return { stopReason: 'error' };
    }

    const ctx = liveContext(session, connection, emit);
    const history = (await getSessionMessages(session.sessionId)) as ModelMessage[];

    try {
      const result = await runTurn({
        model,
        ctx,
        history,
        userMessage: params.text,
        emit,
        signal: abort.signal,
      });

      if (result.messages.length > 0) {
        await appendSessionMessages(
          session.sessionId,
          result.messages.map((m) => ({ role: m.role, content: m })),
        );
      }

      return { stopReason: result.stopReason };
    } finally {
      session.abort = null;
    }
  });

  connection.onNotification(METHODS.cancel, (raw) => {
    const params = CancelParams.parse(raw);
    sessions.get(params.sessionId)?.abort?.abort();
  });

  return connection;
}

/**
 * The ToolContext wired to a live client. This is where a tool's
 * `requestPermission()` becomes an actual dialog in the user's browser, and
 * where the tool genuinely blocks until they click.
 */
function liveContext(
  session: LiveSession,
  connection: Connection,
  emit: (event: AgentEvent) => void,
): ToolContext {
  return {
    userId: session.userId,
    sessionId: session.sessionId,
    resumeId: session.resumeId,

    async currentVersion() {
      const version = await getCurrentVersion(session.resumeId);
      if (!version) throw new Error(`Resume ${session.resumeId} has no versions`);
      return version;
    },

    async jobTarget() {
      if (!session.jobTargetId) return null;
      const row = await getJobTarget(session.jobTargetId);
      if (!row) return null;
      return {
        id: row.id,
        company: row.company,
        role: row.role,
        description: row.description,
        sourceUrl: row.sourceUrl,
        provenance: row.provenance === 'fetched' ? 'fetched' : 'pasted',
        createdAt: row.createdAt,
      };
    },

    async requestPermission({ toolName, title, diff }) {
      try {
        const result = await connection.request<{ outcome: 'allow' | 'deny' }>(
          METHODS.requestPermission,
          { sessionId: session.sessionId, toolName, title, diff },
        );
        return result.outcome === 'allow';
      } catch (cause) {
        // Socket died, or the human never answered. Denying is the only safe
        // default: an unattended "yes" is how an agent edits a resume nobody
        // was watching.
        emit({
          type: 'error',
          message: `Permission request failed, treating as denied: ${errorMessage(cause)}`,
        });
        return false;
      }
    },

    async askUser(question) {
      const result = await connection.request<{ answer: string }>(METHODS.elicit, {
        sessionId: session.sessionId,
        question,
      });
      return result.answer;
    },

    emitGapAnalysis(analysis: GapAnalysis) {
      emit({ type: 'gap_analysis', analysis });
    },

    async commit({ tree, summary, parentId }) {
      const outcome = await commitVersion({
        resumeId: session.resumeId,
        tree,
        summary,
        createdBy: 'agent',
        parentId,
      });

      if (outcome.status === 'committed') {
        // Tells the editor to reload and the preview to re-render. Without this
        // the user watches the agent claim success against a stale document.
        emit({
          type: 'version_committed',
          versionId: outcome.version.id,
          summary,
          diff: '',
        });
      }

      return {
        versionId: outcome.version.id,
        unchanged: outcome.status === 'unchanged',
      };
    },
  };
}

/** A page refresh drops the in-memory session; the DB still has it. */
async function rehydrate(
  sessionId: string,
  userId: string,
  sessions: Map<string, LiveSession>,
): Promise<LiveSession | null> {
  const row = await getSession(sessionId);
  if (!row || row.userId !== userId) return null;

  const session: LiveSession = {
    sessionId: row.id,
    userId: row.userId,
    resumeId: row.resumeId,
    jobTargetId: row.jobTargetId,
    model: row.model,
    abort: null,
  };
  sessions.set(sessionId, session);
  return session;
}

/**
 * Used only to enumerate tool NAMES during `initialize`, before any session
 * exists. Every method throws: if a code path ever actually calls one of these,
 * that is a bug and it should be loud, not silently return empty data.
 */
function stubContext(): ToolContext {
  const boom = (): never => {
    throw new Error('stubContext is for listing tool names only');
  };
  return {
    userId: '',
    sessionId: '',
    resumeId: '',
    currentVersion: boom,
    jobTarget: boom,
    requestPermission: boom,
    askUser: boom,
    emitGapAnalysis: boom,
    commit: boom,
  };
}
