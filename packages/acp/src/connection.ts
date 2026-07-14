import {
  ERROR_CODES,
  JSONRPC_VERSION,
  type RequestId,
  type RpcError,
  RpcNotification,
  RpcRequest,
  RpcResponse,
} from './protocol.ts';

export type Transport = {
  send(raw: string): void;
  close(): void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type MethodHandler = (params: unknown) => Promise<unknown> | unknown;

export class RpcError_ extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/**
 * A JSON-RPC peer. Symmetric: it serves inbound methods and issues outbound
 * requests over the same transport. Both directions matter — the agent calls the
 * client for permission just as the client calls the agent to prompt.
 */
export class Connection {
  private readonly handlers = new Map<string, MethodHandler>();
  private readonly pending = new Map<RequestId, Pending>();
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly transport: Transport,
    /**
     * How long to wait for the *client* to answer a request. A permission prompt
     * sits until a human notices it, so this is generous — but not infinite, or a
     * user who closes the tab mid-prompt leaks the turn forever.
     */
    private readonly requestTimeoutMs = 10 * 60_000,
  ) {}

  on(method: string, handler: MethodHandler): void {
    this.handlers.set(method, handler);
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Fire-and-forget, agent → client. */
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.transport.send(JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, params }));
  }

  /** Call the client and wait for its answer. This is what blocks a tool. */
  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`Connection is closed; cannot call ${method}`));
    }

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${this.requestTimeoutMs}ms waiting for ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.transport.send(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method, params }));
    });
  }

  /** Feed one raw frame in. Never throws — a bad frame must not kill the socket. */
  async handle(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendError(null, ERROR_CODES.parseError, 'Message was not valid JSON');
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      this.sendError(null, ERROR_CODES.invalidRequest, 'Message was not a JSON-RPC frame');
      return;
    }

    /*
     * Dispatch on the RAW shape, deliberately, before any schema runs.
     *
     * Do NOT reach for `z.union([RpcResponse, RpcRequest, RpcNotification])` here.
     * `RpcResponse.result` is `z.unknown().optional()`, which matches literally
     * anything — so a union tries RpcResponse first, happily accepts an inbound
     * *request*, and strips the `method` key on the way through (zod drops
     * unknown keys by default). The frame then looks like a reply to a request we
     * never sent, we find nothing pending, and we return silently. The socket
     * stays open, the client waits forever, and nothing anywhere logs an error.
     *
     * The presence of `method` is the only honest discriminator JSON-RPC gives
     * us. Use it first, then validate against the specific schema.
     */
    const frame = parsed as Record<string, unknown>;
    const hasMethod = typeof frame.method === 'string';
    const hasId = frame.id !== undefined && frame.id !== null;

    if (!hasMethod && hasId) {
      const response = RpcResponse.safeParse(parsed);
      if (!response.success) return;
      const data = response.data;

      const pending = this.pending.get(data.id);
      if (!pending) return; // A late answer to a request we already gave up on.
      this.pending.delete(data.id);
      clearTimeout(pending.timer);

      if (data.error) {
        pending.reject(new RpcError_(data.error.code, data.error.message, data.error.data));
      } else {
        pending.resolve(data.result);
      }
      return;
    }

    if (hasMethod && !hasId) {
      const notification = RpcNotification.safeParse(parsed);
      if (!notification.success) return;
      this.notificationHandlers.get(notification.data.method)?.(notification.data.params);
      return;
    }

    if (hasMethod && hasId) {
      const request = RpcRequest.safeParse(parsed);
      if (!request.success) {
        this.sendError(
          typeof frame.id === 'string' || typeof frame.id === 'number' ? frame.id : null,
          ERROR_CODES.invalidRequest,
          'Message was not a valid JSON-RPC request',
        );
        return;
      }

      const data = request.data;
      const handler = this.handlers.get(data.method);
      if (!handler) {
        this.sendError(data.id, ERROR_CODES.methodNotFound, `Unknown method: ${data.method}`);
        return;
      }

      try {
        const result = await handler(data.params);
        if (this.closed) return;
        this.transport.send(
          JSON.stringify({
            jsonrpc: JSONRPC_VERSION,
            id: data.id,
            result: result ?? null,
          }),
        );
      } catch (cause) {
        const error: RpcError =
          cause instanceof RpcError_
            ? { code: cause.code, message: cause.message, data: cause.data }
            : {
                code: ERROR_CODES.internalError,
                message: cause instanceof Error ? cause.message : String(cause),
              };
        this.sendError(data.id, error.code, error.message, error.data);
      }
      return;
    }

    this.sendError(null, ERROR_CODES.invalidRequest, 'Message was not a valid JSON-RPC frame');
  }

  private sendError(id: RequestId | null, code: number, message: string, data?: unknown): void {
    if (this.closed) return;
    this.transport.send(
      JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: id ?? 0,
        error: data === undefined ? { code, message } : { code, message, data },
      }),
    );
  }

  /** Reject everything still in flight, so no tool is left awaiting a dead socket. */
  close(reason = 'Connection closed'): void {
    if (this.closed) return;
    this.closed = true;

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    this.transport.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
