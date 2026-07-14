import type { ResumeTree } from '@sailor/core';
import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Auth is a stub for now — Better Auth (GitHub/Google OAuth) drops in later and
 * owns this table. Keep the shape minimal so its migration is additive: it needs
 * `id`, `email`, `name`, `image`, `emailVerified`, and we already have the first
 * three. Do not add app-specific columns here; hang them off a profile table.
 */
export const users = pgTable('users', {
  id: varchar('id', { length: 32 }).primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * BYO-key storage. `secret` and `refreshSecret` are AES-256-GCM ciphertext — see
 * crypto.ts. They are never selected by the public query helpers; only
 * `getDecryptedCredential()` touches them.
 */
export const providerCredentials = pgTable(
  'provider_credentials',
  {
    id: varchar('id', { length: 32 }).primaryKey(),
    userId: varchar('user_id', { length: 32 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    kind: text('kind').notNull(),
    /** Shown in the UI so a user can tell two keys apart. Never the key itself. */
    label: text('label').notNull(),
    secret: text('secret').notNull(),
    refreshSecret: text('refresh_secret'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('provider_credentials_user_provider_idx').on(t.userId, t.provider)],
);

export const resumes = pgTable(
  'resumes',
  {
    id: varchar('id', { length: 32 }).primaryKey(),
    userId: varchar('user_id', { length: 32 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /**
     * Pointer to the tip. Deliberately NOT a foreign key: versions reference the
     * resume, so an FK back would be a cycle that makes the first insert
     * impossible without a deferred constraint. Integrity is enforced in
     * `commitVersion()`, which is the only writer.
     */
    currentVersionId: varchar('current_version_id', { length: 32 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('resumes_user_idx').on(t.userId)],
);

/**
 * Immutable. There is no UPDATE path to this table — see invariant 2 in AGENTS.md.
 * `parentId` makes the history a tree, so a rollback followed by new edits
 * branches rather than destroying what was there.
 */
export const resumeVersions = pgTable(
  'resume_versions',
  {
    id: varchar('id', { length: 32 }).primaryKey(),
    resumeId: varchar('resume_id', { length: 32 })
      .notNull()
      .references(() => resumes.id, { onDelete: 'cascade' }),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    tree: jsonb('tree').$type<ResumeTree>().notNull(),
    summary: text('summary').notNull(),
    createdBy: text('created_by').notNull(),
    parentId: varchar('parent_id', { length: 32 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('resume_versions_resume_idx').on(t.resumeId, t.createdAt),
    // Lets commitVersion() cheaply detect a no-op edit (same content, same resume).
    index('resume_versions_hash_idx').on(t.resumeId, t.contentHash),
  ],
);

export const jobTargets = pgTable(
  'job_targets',
  {
    id: varchar('id', { length: 32 }).primaryKey(),
    userId: varchar('user_id', { length: 32 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    company: text('company').notNull(),
    role: text('role').notNull(),
    description: text('description').notNull(),
    sourceUrl: text('source_url'),
    provenance: text('provenance').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('job_targets_user_idx').on(t.userId)],
);

/** One ACP session = one tailoring conversation against one resume + one job. */
export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: varchar('id', { length: 32 }).primaryKey(),
    userId: varchar('user_id', { length: 32 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    resumeId: varchar('resume_id', { length: 32 })
      .notNull()
      .references(() => resumes.id, { onDelete: 'cascade' }),
    jobTargetId: varchar('job_target_id', { length: 32 }).references(() => jobTargets.id, {
      onDelete: 'set null',
    }),
    /** Serialised ModelRef, e.g. "anthropic:claude-opus-4-8". */
    model: text('model').notNull(),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_sessions_resume_idx').on(t.resumeId)],
);

/**
 * Persisted turn history, stored as AI SDK ModelMessage objects so a session can
 * be resumed by feeding these straight back to the model. `seq` orders them —
 * `createdAt` is not reliable for ordering within a fast turn.
 */
export const sessionMessages = pgTable(
  'session_messages',
  {
    id: varchar('id', { length: 32 }).primaryKey(),
    sessionId: varchar('session_id', { length: 32 })
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role').notNull(),
    /** An AI SDK `ModelMessage`. Typed as unknown here so `@sailor/db` stays free
     *  of an AI SDK dependency; `@sailor/agent` parses it on read. */
    content: jsonb('content').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('session_messages_seq_idx').on(t.sessionId, t.seq)],
);

export const usersRelations = relations(users, ({ many }) => ({
  resumes: many(resumes),
  credentials: many(providerCredentials),
}));

export const resumesRelations = relations(resumes, ({ one, many }) => ({
  user: one(users, { fields: [resumes.userId], references: [users.id] }),
  versions: many(resumeVersions),
}));

export const resumeVersionsRelations = relations(resumeVersions, ({ one }) => ({
  resume: one(resumes, {
    fields: [resumeVersions.resumeId],
    references: [resumes.id],
  }),
}));

export const agentSessionsRelations = relations(agentSessions, ({ one, many }) => ({
  resume: one(resumes, {
    fields: [agentSessions.resumeId],
    references: [resumes.id],
  }),
  jobTarget: one(jobTargets, {
    fields: [agentSessions.jobTargetId],
    references: [jobTargets.id],
  }),
  messages: many(sessionMessages),
}));
