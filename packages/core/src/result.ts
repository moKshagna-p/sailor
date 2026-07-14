/**
 * Tools return Result, never throw. A thrown exception kills the agent turn;
 * a structured error lets the model read what went wrong and try again. The
 * `hint` field exists for exactly that — it is written *to the model*.
 */
export type Ok<T> = { ok: true } & T;
export type Err = { ok: false; error: string; hint?: string };
export type Result<T> = Ok<T> | Err;

export const ok = <T extends object>(value: T): Ok<T> => ({
  ok: true,
  ...value,
});

export const err = (error: string, hint?: string): Err =>
  hint === undefined ? { ok: false, error } : { ok: false, error, hint };

/** Turn an unknown thrown value into a message without losing the stack context. */
export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return JSON.stringify(cause);
}
