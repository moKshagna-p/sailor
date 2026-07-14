'use client';

import { API } from './api.ts';

/**
 * The browser side of ACP. It is a JSON-RPC *peer*, not a listener: the agent
 * calls `session/request_permission` and `session/elicit` on us and blocks for
 * the answer, which is why this cannot be a plain SSE stream.
 */
export type AgentEvent =
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; callId: string; name: string; input: unknown }
  | {
      type: 'tool_end';
      callId: string;
      name: string;
      ok: boolean;
      output: unknown;
    }
  | {
      type: 'version_committed';
      versionId: string;
      summary: string;
      diff: string;
    }
  | { type: 'gap_analysis'; analysis: GapAnalysis }
  | { type: 'turn_end'; stopReason: string }
  | { type: 'error'; message: string };

export type GapAnalysis = {
  matches: Array<{
    requirement: string;
    evidence: string[];
    status: 'strong' | 'weak' | 'missing';
    askUser: string | null;
  }>;
  coverage: number;
  notes: string;
};

export type PermissionAsk = {
  toolName: string;
  title: string;
  diff?: string;
  respond: (outcome: 'allow' | 'deny') => void;
};

export type ElicitAsk = {
  question: string;
  respond: (answer: string) => void;
};

export type AcpHandlers = {
  onEvent: (event: AgentEvent) => void;
  onPermission: (ask: PermissionAsk) => void;
  onElicit: (ask: ElicitAsk) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

export class AcpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly handlers: AcpHandlers) {}

  connect(): void {
    const url = `${API.replace(/^http/, 'ws')}/acp`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => this.handlers.onOpen?.();
    ws.onclose = () => {
      for (const [, p] of this.pending) p.reject(new Error('Disconnected'));
      this.pending.clear();
      this.handlers.onClose?.();
    };
    ws.onmessage = (event) => this.receive(String(event.data));
  }

  private receive(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message: string };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    // A reply to something we asked.
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }

    // The agent streaming us what it is doing.
    if (message.method === 'session/update') {
      const params = message.params as { update: AgentEvent };
      this.handlers.onEvent(params.update);
      return;
    }

    // The agent *asking* us something and waiting. Both of these block a tool
    // call on the server until we reply, so we must always reply.
    if (message.method === 'session/request_permission' && message.id !== undefined) {
      const id = message.id;
      const params = message.params as {
        toolName: string;
        title: string;
        diff?: string;
      };
      this.handlers.onPermission({
        ...params,
        respond: (outcome) => this.reply(id, { outcome }),
      });
      return;
    }

    if (message.method === 'session/elicit' && message.id !== undefined) {
      const id = message.id;
      const params = message.params as { question: string };
      this.handlers.onElicit({
        question: params.question,
        respond: (answer) => this.reply(id, { answer }),
      });
    }
  }

  private reply(id: number, result: unknown): void {
    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  private call<T>(method: string, params: unknown): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected'));
    }

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  initialize() {
    return this.call<{
      agent: { name: string };
      tools: Array<{ name: string; gated: boolean }>;
    }>('initialize', { protocolVersion: 1 });
  }

  newSession(resumeId: string, model: string, jobTargetId: string | null) {
    return this.call<{ sessionId: string }>('session/new', {
      resumeId,
      model,
      jobTargetId,
    });
  }

  /** Resolves when the whole turn is done — events arrive via onEvent meanwhile. */
  prompt(sessionId: string, text: string) {
    return this.call<{ stopReason: string }>('session/prompt', {
      sessionId,
      text,
    });
  }

  cancel(sessionId: string): void {
    this.ws?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId },
      }),
    );
  }

  close(): void {
    this.ws?.close();
  }
}
