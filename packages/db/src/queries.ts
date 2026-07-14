import type {
  CredentialKind,
  ProviderId,
  PublicCredential,
  ResolvedCredential,
  ResumeTree,
  ResumeVersion,
} from '@sailor/core';
import { createId, hashTree } from '@sailor/core';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from './client.ts';
import { decryptSecret, encryptSecret } from './crypto.ts';
import {
  agentSessions,
  jobTargets,
  providerCredentials,
  resumes,
  resumeVersions,
  sessionMessages,
  users,
} from './schema.ts';

// ---------------------------------------------------------------------------
// Users — placeholder until Better Auth owns this. See schema.ts.
// ---------------------------------------------------------------------------

export async function ensureUser(email: string, name?: string): Promise<string> {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  const found = existing[0];
  if (found) return found.id;

  const id = createId('usr');
  await db.insert(users).values({ id, email, name: name ?? null });
  return id;
}

// ---------------------------------------------------------------------------
// Resumes + versions
// ---------------------------------------------------------------------------

export type ResumeSummary = {
  id: string;
  title: string;
  currentVersionId: string | null;
  updatedAt: Date;
};

export async function listResumes(userId: string): Promise<ResumeSummary[]> {
  return db
    .select({
      id: resumes.id,
      title: resumes.title,
      currentVersionId: resumes.currentVersionId,
      updatedAt: resumes.updatedAt,
    })
    .from(resumes)
    .where(eq(resumes.userId, userId))
    .orderBy(desc(resumes.updatedAt));
}

/** Creates the resume *and* its root version in one transaction. */
export async function createResume(args: {
  userId: string;
  title: string;
  tree: ResumeTree;
}): Promise<{ resumeId: string; versionId: string }> {
  const resumeId = createId('res');
  const versionId = createId('ver');
  const contentHash = await hashTree(args.tree);

  await db.transaction(async (tx) => {
    await tx.insert(resumes).values({
      id: resumeId,
      userId: args.userId,
      title: args.title,
      currentVersionId: null,
    });
    await tx.insert(resumeVersions).values({
      id: versionId,
      resumeId,
      contentHash,
      tree: args.tree,
      summary: 'Initial upload',
      createdBy: 'user',
      parentId: null,
    });
    await tx.update(resumes).set({ currentVersionId: versionId }).where(eq(resumes.id, resumeId));
  });

  return { resumeId, versionId };
}

function rowToVersion(row: typeof resumeVersions.$inferSelect): ResumeVersion {
  return {
    id: row.id,
    resumeId: row.resumeId,
    contentHash: row.contentHash,
    tree: row.tree,
    summary: row.summary,
    createdBy: row.createdBy === 'agent' ? 'agent' : 'user',
    parentId: row.parentId,
    createdAt: row.createdAt,
  };
}

export async function getVersion(versionId: string): Promise<ResumeVersion | null> {
  const rows = await db.select().from(resumeVersions).where(eq(resumeVersions.id, versionId));
  const row = rows[0];
  return row ? rowToVersion(row) : null;
}

/** The tip of a resume — what the editor loads and what the agent reads. */
export async function getCurrentVersion(resumeId: string): Promise<ResumeVersion | null> {
  const rows = await db
    .select()
    .from(resumeVersions)
    .where(eq(resumeVersions.resumeId, resumeId))
    .orderBy(desc(resumeVersions.createdAt))
    .limit(1);
  const row = rows[0];
  return row ? rowToVersion(row) : null;
}

export async function listVersions(resumeId: string): Promise<ResumeVersion[]> {
  const rows = await db
    .select()
    .from(resumeVersions)
    .where(eq(resumeVersions.resumeId, resumeId))
    .orderBy(desc(resumeVersions.createdAt));
  return rows.map(rowToVersion);
}

export type CommitOutcome =
  | { status: 'committed'; version: ResumeVersion }
  /** The new tree hashed identically to the tip. We do not write a duplicate row. */
  | { status: 'unchanged'; version: ResumeVersion };

/**
 * The ONLY way resume content changes. Appends an immutable version and moves
 * the tip. Never updates a version in place — invariant 2 in AGENTS.md.
 *
 * Callers pass the tree they *believe* they are branching from via `parentId`.
 * If the tip has moved since (a concurrent agent turn, two tabs open), we still
 * commit — the parent pointer records the truth, so the history stays an honest
 * tree rather than silently linearising a conflict.
 */
export async function commitVersion(args: {
  resumeId: string;
  tree: ResumeTree;
  summary: string;
  createdBy: 'user' | 'agent';
  parentId: string | null;
}): Promise<CommitOutcome> {
  const contentHash = await hashTree(args.tree);

  return db.transaction(async (tx): Promise<CommitOutcome> => {
    const tipRows = await tx
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.resumeId, args.resumeId))
      .orderBy(desc(resumeVersions.createdAt))
      .limit(1);

    const tip = tipRows[0];
    // A no-op edit is common: the agent "fixes" a bullet to the same words, or a
    // save fires with no changes. Writing a row for that pollutes the history.
    if (tip && tip.contentHash === contentHash) {
      return { status: 'unchanged', version: rowToVersion(tip) };
    }

    const id = createId('ver');
    const inserted = await tx
      .insert(resumeVersions)
      .values({
        id,
        resumeId: args.resumeId,
        contentHash,
        tree: args.tree,
        summary: args.summary,
        createdBy: args.createdBy,
        parentId: args.parentId ?? tip?.id ?? null,
      })
      .returning();

    const row = inserted[0];
    if (!row) throw new Error('commitVersion: insert returned no row');

    await tx
      .update(resumes)
      .set({ currentVersionId: id, updatedAt: new Date() })
      .where(eq(resumes.id, args.resumeId));

    return { status: 'committed', version: rowToVersion(row) };
  });
}

/**
 * Rollback is a forward operation: it commits the old tree as a *new* version.
 * Nothing is deleted, so a rollback is itself undoable.
 */
export async function rollbackTo(versionId: string): Promise<CommitOutcome> {
  const target = await getVersion(versionId);
  if (!target) throw new Error(`Cannot roll back: version ${versionId} does not exist`);

  return commitVersion({
    resumeId: target.resumeId,
    tree: target.tree,
    summary: `Rolled back to "${target.summary}"`,
    createdBy: 'user',
    parentId: null,
  });
}

// ---------------------------------------------------------------------------
// Provider credentials
// ---------------------------------------------------------------------------

export async function listCredentials(userId: string): Promise<PublicCredential[]> {
  const rows = await db
    .select({
      provider: providerCredentials.provider,
      kind: providerCredentials.kind,
      label: providerCredentials.label,
      expiresAt: providerCredentials.expiresAt,
    })
    .from(providerCredentials)
    .where(eq(providerCredentials.userId, userId));

  // Deliberately re-shaped by hand rather than spread: if someone adds a `secret`
  // column to the select above, this mapping is where it gets caught.
  return rows.map((r) => ({
    provider: r.provider as ProviderId,
    kind: r.kind as CredentialKind,
    label: r.label,
    expiresAt: r.expiresAt ? r.expiresAt.getTime() : null,
  }));
}

export async function upsertCredential(args: {
  userId: string;
  provider: ProviderId;
  kind: CredentialKind;
  label: string;
  secret: string;
  refreshSecret?: string;
  expiresAt?: Date;
}): Promise<void> {
  const secret = await encryptSecret(args.secret);
  const refreshSecret = args.refreshSecret ? await encryptSecret(args.refreshSecret) : null;

  await db
    .insert(providerCredentials)
    .values({
      id: createId('cred'),
      userId: args.userId,
      provider: args.provider,
      kind: args.kind,
      label: args.label,
      secret,
      refreshSecret,
      expiresAt: args.expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [providerCredentials.userId, providerCredentials.provider],
      set: {
        kind: args.kind,
        label: args.label,
        secret,
        refreshSecret,
        expiresAt: args.expiresAt ?? null,
      },
    });
}

export async function deleteCredential(userId: string, provider: ProviderId): Promise<void> {
  await db
    .delete(providerCredentials)
    .where(and(eq(providerCredentials.userId, userId), eq(providerCredentials.provider, provider)));
}

/**
 * The ONE function that returns plaintext secrets. Server-side callers only —
 * grep for this name before you widen anything that touches it.
 */
export async function getDecryptedCredential(
  userId: string,
  provider: ProviderId,
): Promise<(ResolvedCredential & { refreshToken: string | null }) | null> {
  const rows = await db
    .select()
    .from(providerCredentials)
    .where(and(eq(providerCredentials.userId, userId), eq(providerCredentials.provider, provider)));

  const row = rows[0];
  if (!row) return null;

  const secret = await decryptSecret(row.secret);
  const refreshToken = row.refreshSecret ? await decryptSecret(row.refreshSecret) : null;

  if (row.kind === 'oauth') {
    return {
      kind: 'oauth',
      provider,
      accessToken: secret,
      expiresAt: row.expiresAt ? row.expiresAt.getTime() : 0,
      refreshToken,
    };
  }
  return { kind: 'api_key', provider, apiKey: secret, refreshToken: null };
}

// ---------------------------------------------------------------------------
// Job targets + agent sessions
// ---------------------------------------------------------------------------

export async function createJobTarget(args: {
  userId: string;
  company: string;
  role: string;
  description: string;
  sourceUrl: string | null;
  provenance: 'fetched' | 'pasted';
}): Promise<string> {
  const id = createId('job');
  await db.insert(jobTargets).values({ id, ...args });
  return id;
}

export async function getJobTarget(id: string) {
  const rows = await db.select().from(jobTargets).where(eq(jobTargets.id, id));
  return rows[0] ?? null;
}

export async function createSession(args: {
  userId: string;
  resumeId: string;
  jobTargetId: string | null;
  model: string;
  title: string;
}): Promise<string> {
  const id = createId('ses');
  await db.insert(agentSessions).values({ id, ...args });
  return id;
}

export async function getSession(id: string) {
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id));
  return rows[0] ?? null;
}

export async function listSessions(resumeId: string) {
  return db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.resumeId, resumeId))
    .orderBy(desc(agentSessions.createdAt));
}

/** Persisted history, in turn order, ready to replay into the model. */
export async function getSessionMessages(sessionId: string): Promise<unknown[]> {
  const rows = await db
    .select({ content: sessionMessages.content })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(asc(sessionMessages.seq));
  return rows.map((r) => r.content);
}

export async function appendSessionMessages(
  sessionId: string,
  messages: Array<{ role: string; content: unknown }>,
): Promise<void> {
  if (messages.length === 0) return;

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ seq: sessionMessages.seq })
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(desc(sessionMessages.seq))
      .limit(1);

    let seq = (existing[0]?.seq ?? -1) + 1;
    await tx.insert(sessionMessages).values(
      messages.map((m) => ({
        id: createId('msg'),
        sessionId,
        seq: seq++,
        role: m.role,
        content: m.content,
      })),
    );
  });
}
