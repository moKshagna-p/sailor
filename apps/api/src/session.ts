export class UnauthorizedError extends Error {
  readonly status = 401;

  constructor() {
    super('Authentication required');
  }
}

export type SessionLookup = (input: {
  headers: Headers;
}) => Promise<{ user: { id: string } } | null>;

export async function requireUserId(headers: Headers, getSession: SessionLookup): Promise<string> {
  const session = await getSession({ headers });
  if (!session) throw new UnauthorizedError();
  return session.user.id;
}

export function requestHeaders(headers: Record<string, string | undefined>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result.append(name, value);
  }
  return result;
}
