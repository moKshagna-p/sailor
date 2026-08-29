import { expect, test } from 'bun:test';
import type { LanguageModelV4Usage } from '@ai-sdk/provider';
import { type JobTarget, ResumeEvaluation, type ResumeVersion } from '@sailor/core';
import { MockLanguageModelV4 } from 'ai/test';
import { evaluateResume, formatResumeEvaluation, scoreResumeEvaluation } from './evaluation.ts';

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
  outputTokens: { total: 8, text: 8, reasoning: 0 },
};

const VERSION: ResumeVersion = {
  id: 'version-1',
  resumeId: 'resume-1',
  contentHash: 'hash',
  tree: {
    entry: 'main.tex',
    files: [
      { path: 'main.tex', content: 'Built reliable TypeScript APIs.' },
      { path: 'resume.cls', content: 'CLASS CONTENT MUST NOT BE REVIEWED' },
    ],
  },
  summary: 'Initial resume',
  createdBy: 'user',
  parentId: null,
  createdAt: new Date('2026-08-29T00:00:00Z'),
};

const JOB: JobTarget = {
  id: 'job-1',
  company: 'Acme',
  role: 'Platform Engineer',
  description: 'Build reliable TypeScript backend services.',
  sourceUrl: null,
  provenance: 'pasted',
  createdAt: new Date('2026-08-29T00:00:00Z'),
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

test('evaluateResume reviews only bounded resume source and formats the score', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text: JSON.stringify(REVIEW) }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: USAGE,
      warnings: [],
    },
  });

  const evaluated = await evaluateResume({ model, version: VERSION, job: JOB });
  expect(evaluated.total).toBe(90);
  expect(formatResumeEvaluation('final', VERSION.id, evaluated)).toContain(
    'Final resume score: 90/100',
  );

  const call = JSON.stringify(model.doGenerateCalls[0]);
  expect(call).toContain(JOB.description);
  expect(call).toContain('Built reliable TypeScript APIs.');
  expect(call).not.toContain('CLASS CONTENT MUST NOT BE REVIEWED');
});
