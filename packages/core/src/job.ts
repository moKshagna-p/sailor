import { z } from 'zod';

/**
 * The target the resume is being tailored *to*. `sourceUrl` matters: a JD the
 * agent fetched itself is trustworthy in a way that pasted text is not, and the
 * agent is told which it is holding.
 */
export const JobTarget = z.object({
  id: z.string(),
  company: z.string().min(1),
  role: z.string().min(1),
  /** Full JD text. Either pasted by the user or fetched by the agent. */
  description: z.string(),
  sourceUrl: z.url().nullable(),
  /** 'fetched' = the agent pulled it from sourceUrl. 'pasted' = user-supplied. */
  provenance: z.enum(['fetched', 'pasted']),
  createdAt: z.date(),
});
export type JobTarget = z.infer<typeof JobTarget>;

/**
 * What the agent extracted from the JD, and how the resume currently stacks up.
 * This is the artifact the tailoring plan is built from — it is shown to the
 * user so they can see *why* an edit was proposed.
 */
export const RequirementMatch = z.object({
  requirement: z.string(),
  /** Verbatim resume evidence. Empty ⇒ the resume does not support this claim. */
  evidence: z.array(z.string()),
  status: z.enum(['strong', 'weak', 'missing']),
  /**
   * Set when status is 'missing' and the agent believes the user may in fact
   * have this but has not written it down. This becomes a question to the user,
   * NEVER an invented bullet. See the first invariant in AGENTS.md.
   */
  askUser: z.string().nullable(),
});
export type RequirementMatch = z.infer<typeof RequirementMatch>;

export const GapAnalysis = z.object({
  matches: z.array(RequirementMatch),
  /** 0-100. Deliberately coarse; it is a signal, not a score to optimise. */
  coverage: z.number().min(0).max(100),
  notes: z.string(),
});
export type GapAnalysis = z.infer<typeof GapAnalysis>;
