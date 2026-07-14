import { z } from 'zod';

/**
 * Agent Client Protocol — JSON-RPC 2.0, bidirectional.
 *
 * The essential property, and the reason we use it rather than a bespoke SSE
 * stream: **both sides can call the other**. The agent does not merely push
 * tokens at the client; mid-turn it can call `session/request_permission` and
 * *block* on the human's answer. That is a request, not an event, and a
 * one-directional transport cannot express it.
 *
 * This package knows about JSON-RPC and sessions. It does NOT know what a resume
 * is — keep it that way, or the protocol stops being reusable.
 */
export const JSONRPC_VERSION = '2.0';

export const RequestId = z.union([z.string(), z.number()]);
export type RequestId = z.infer<typeof RequestId>;

export const RpcRequest = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: RequestId,
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export const RpcNotification = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcNotification = z.infer<typeof RpcNotification>;

export const RpcError = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcError>;

export const RpcResponse = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: RequestId,
  result: z.unknown().optional(),
  error: RpcError.optional(),
});
export type RpcResponse = z.infer<typeof RpcResponse>;

export const RpcMessage = z.union([RpcResponse, RpcRequest, RpcNotification]);
export type RpcMessage = z.infer<typeof RpcMessage>;

export const ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

// --- Method payloads -------------------------------------------------------

/** client → agent */
export const InitializeParams = z.object({
  protocolVersion: z.number().default(1),
  clientCapabilities: z
    .object({
      /** Can the client show a permission dialog and answer it? */
      permissions: z.boolean().default(true),
      /** Can the client ask the human a free-text question? */
      elicitation: z.boolean().default(true),
    })
    .default({ permissions: true, elicitation: true }),
});
export type InitializeParams = z.infer<typeof InitializeParams>;

export const InitializeResult = z.object({
  protocolVersion: z.number(),
  agent: z.object({ name: z.string(), version: z.string() }),
  /** Tool names the agent may call, so the client can render them meaningfully. */
  tools: z.array(z.object({ name: z.string(), gated: z.boolean() })),
});
export type InitializeResult = z.infer<typeof InitializeResult>;

/** client → agent */
export const NewSessionParams = z.object({
  resumeId: z.string(),
  jobTargetId: z.string().nullable().default(null),
  /** Serialised ModelRef, e.g. "anthropic:claude-opus-4-8". */
  model: z.string(),
});
export type NewSessionParams = z.infer<typeof NewSessionParams>;

export const NewSessionResult = z.object({ sessionId: z.string() });

/** client → agent. Resolves when the turn ends. */
export const PromptParams = z.object({
  sessionId: z.string(),
  text: z.string().min(1),
});
export type PromptParams = z.infer<typeof PromptParams>;

export const PromptResult = z.object({
  stopReason: z.enum(['end_turn', 'max_steps', 'error', 'cancelled']),
});

/** client → agent, notification. */
export const CancelParams = z.object({ sessionId: z.string() });

/** agent → client, notification. The stream of everything happening in a turn. */
export const SessionUpdateParams = z.object({
  sessionId: z.string(),
  update: z.unknown(),
});

/**
 * agent → client, REQUEST. The agent blocks until the human answers. This is the
 * method that justifies the whole protocol.
 */
export const RequestPermissionParams = z.object({
  sessionId: z.string(),
  toolName: z.string(),
  title: z.string(),
  diff: z.string().optional(),
});
export type RequestPermissionParams = z.infer<typeof RequestPermissionParams>;

export const RequestPermissionResult = z.object({
  outcome: z.enum(['allow', 'deny']),
});

/** agent → client, REQUEST. Free-text question to the human; blocks for an answer. */
export const ElicitParams = z.object({
  sessionId: z.string(),
  question: z.string(),
});

export const ElicitResult = z.object({
  /** Empty string means "the user declined to answer" — never a fabricated value. */
  answer: z.string(),
});

export const METHODS = {
  initialize: 'initialize',
  newSession: 'session/new',
  prompt: 'session/prompt',
  cancel: 'session/cancel',
  update: 'session/update',
  requestPermission: 'session/request_permission',
  elicit: 'session/elicit',
} as const;
