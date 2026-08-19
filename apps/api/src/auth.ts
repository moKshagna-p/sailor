import { createId } from '@sailor/core';
import { authDatabase } from '@sailor/db';
import { betterAuth } from 'better-auth';
import { requestHeaders, requireUserId } from './session.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.`);
  return value;
}

const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const apiOrigin = process.env.API_PUBLIC_URL ?? 'http://localhost:3001';

export const auth = betterAuth({
  appName: 'Sailor',
  database: authDatabase,
  baseURL: apiOrigin,
  secret: required('BETTER_AUTH_SECRET'),
  trustedOrigins: [webOrigin],
  socialProviders: {
    google: {
      clientId: required('AUTH_GOOGLE_CLIENT_ID'),
      clientSecret: required('AUTH_GOOGLE_CLIENT_SECRET'),
    },
    github: {
      clientId: required('AUTH_GITHUB_CLIENT_ID'),
      clientSecret: required('AUTH_GITHUB_CLIENT_SECRET'),
    },
  },
  advanced: {
    database: {
      generateId: ({ model }) => createId(model.slice(0, 3)),
    },
  },
});

export async function currentUserId(headers: Record<string, string | undefined>): Promise<string> {
  return requireUserId(requestHeaders(headers), ({ headers: request }) =>
    auth.api.getSession({ headers: request }),
  );
}
