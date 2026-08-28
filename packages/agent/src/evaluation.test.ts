import { expect, test } from 'bun:test';
import type { LanguageModelV4Usage } from '@ai-sdk/provider';
import { type JobTarget, ResumeEvaluation, type ResumeVersion } from '@sailor/core';
import { MockLanguageModelV4 } from 'ai/test';
import {
  evaluateResume,
  formatResumeEvaluation,
  reviewCorrectionContext,
  scoreResumeEvaluation,
} from './evaluation.ts';

const REVIEW = {
  categories: {
    jobAlignment: {
      score: 40,
      evidence: 'Backend API work matches the primary responsibility.',
    },
    demonstratedImpact: {
      score: 20,
      evidence: 'Outcomes are present but mostly unquantified.',
    },
    relevantSkills: {
      score: 18,
      evidence: 'The resume supports the requested TypeScript skills.',
    },
    clarity: { score: 9, evidence: 'Bullets are concise and direct.' },
    verifiability: { score: 8, evidence: 'Dates and employers are present.' },
  },
  strengths: ['Relevant backend experience'],
  improvements: ['Ask the user for a real latency or throughput result.'],
};

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

const VERSION: ResumeVersion = {
  id: 'ver_review',
  resumeId: 'res_review',
  contentHash: 'hash',
  tree: {
    entry: 'main.tex',
    files: [
      {
        path: 'main.tex',
        content: String.raw`\section{Experience}\item Built TypeScript APIs.`,
      },
      { path: 'resume.cls', content: 'CLASS FILE MUST NOT REACH REVIEWER' },
    ],
  },
  summary: 'Tailored backend experience',
  createdBy: 'agent',
  parentId: 'ver_parent',
  createdAt: new Date('2026-08-28T00:00:00Z'),
};

const JOB: JobTarget = {
  id: 'job_review',
  company: 'Acme',
  role: 'Backend Engineer',
  description: 'Build reliable TypeScript APIs for payment systems.',
  sourceUrl: 'https://example.com/jobs/backend',
  provenance: 'fetched',
  createdAt: new Date('2026-08-28T00:00:00Z'),
};

test('scoreResumeEvaluation caps categories and calculates the total in code', () => {
  const scored = scoreResumeEvaluation(ResumeEvaluation.parse(REVIEW));

  expect(scored.categories.jobAlignment.score).toBe(35);
  expect(scored.total).toBe(90);
});

test('ResumeEvaluation rejects empty and oversized reviewer comments', () => {
  expect(() => ResumeEvaluation.parse({ ...REVIEW, improvements: [''] })).toThrow();
  expect(() => ResumeEvaluation.parse({ ...REVIEW, strengths: ['x'.repeat(501)] })).toThrow();
});

test('evaluateResume reviews job and tex evidence without template implementation', async () => {
  let modelPrompt = '';
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      modelPrompt = JSON.stringify(options.prompt);
      return {
        content: [{ type: 'text', text: JSON.stringify(REVIEW) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },
  });

  const evaluated = await evaluateResume({ model, version: VERSION, job: JOB });

  expect(evaluated.total).toBe(90);
  expect(modelPrompt).toContain(JOB.description);
  expect(modelPrompt).toContain('Built TypeScript APIs');
  expect(modelPrompt).not.toContain('CLASS FILE MUST NOT REACH REVIEWER');
});

test('review reports are deterministic and correction context cannot supply facts', () => {
  const scored = scoreResumeEvaluation(ResumeEvaluation.parse(REVIEW));

  expect(formatResumeEvaluation('final', VERSION.id, scored)).toContain(
    'Final resume score: 90/100',
  );
  expect(formatResumeEvaluation('interim', VERSION.id, scored)).toContain(
    'Evaluated version `ver_review`',
  );
  expect(reviewCorrectionContext(scored)).toContain('not resume evidence');
  expect(reviewCorrectionContext(scored)).toContain('ask_user');
});
