import { z } from 'zod';

const ScoreEvidence = z.object({
  score: z.number().finite().min(0).max(100),
  evidence: z.string().trim().min(1).max(500),
});

export const ResumeEvaluation = z.object({
  categories: z.object({
    jobAlignment: ScoreEvidence,
    demonstratedImpact: ScoreEvidence,
    relevantSkills: ScoreEvidence,
    clarity: ScoreEvidence,
    verifiability: ScoreEvidence,
  }),
  strengths: z.array(z.string().trim().min(1).max(500)).min(1).max(5),
  improvements: z.array(z.string().trim().min(1).max(500)).min(1).max(3),
});

export type ResumeEvaluation = z.infer<typeof ResumeEvaluation>;
export type ScoredResumeEvaluation = ResumeEvaluation & { total: number };
