'use client';

import { createAuthClient } from 'better-auth/react';
import { API } from './api.ts';

export const authClient = createAuthClient({
  baseURL: API,
  fetchOptions: { credentials: 'include' },
});
