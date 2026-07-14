import type { LatexDiagnostic, ResumeTree, ResumeVersion } from '@sailor/core';

export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export type ResumeSummary = {
  id: string;
  title: string;
  currentVersionId: string | null;
  updatedAt: string;
};

export type ProviderInfo = {
  id: string;
  label: string;
  supports: string[];
  available: boolean;
  models: Array<{
    provider: string;
    modelId: string;
    label: string;
    tier: string;
  }>;
};

export const api = {
  listResumes: () => json<{ resumes: ResumeSummary[] }>('/api/resumes'),

  createResume: (title: string, tree?: ResumeTree) =>
    json<{ resumeId: string; versionId: string }>('/api/resumes', {
      method: 'POST',
      body: JSON.stringify(tree ? { title, tree } : { title }),
    }),

  getResume: (id: string) => json<{ version: ResumeVersion }>(`/api/resumes/${id}`),

  listVersions: (id: string) => json<{ versions: ResumeVersion[] }>(`/api/resumes/${id}/versions`),

  saveVersion: (id: string, tree: ResumeTree, summary: string, parentId: string | null) =>
    json<{ versionId: string; unchanged: boolean }>(`/api/resumes/${id}/versions`, {
      method: 'POST',
      body: JSON.stringify({ tree, summary, parentId }),
    }),

  rollback: (id: string, versionId: string) =>
    json<{ versionId: string }>(`/api/resumes/${id}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ versionId }),
    }),

  models: () => json<{ providers: ProviderInfo[] }>('/api/models'),

  addKey: (provider: string, apiKey: string) =>
    json<{ ok: true }>('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({ provider, apiKey, label: `${provider} key` }),
    }),

  createJob: (input: {
    company: string;
    role: string;
    description: string;
    sourceUrl: string | null;
  }) =>
    json<{ jobTargetId: string }>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  downloadUrl: (versionId: string) => `${API}/api/versions/${versionId}/pdf`,
};

export type CompileFailure = {
  ok: false;
  diagnostics: LatexDiagnostic[];
  summary: string;
  durationMs: number;
};
