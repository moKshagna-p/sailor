import { expect, test } from 'bun:test';
import type { LanguageModelV4Usage } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { extractJobTargetFields } from './job-target.ts';

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 },
};

test('extractJobTargetFields returns schema-validated company and role', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text: '{"company":"Acme","role":"Platform Engineer"}' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: USAGE,
      warnings: [],
    },
  });

  await expect(
    extractJobTargetFields(model, 'Acme is hiring a Platform Engineer to build reliable APIs.'),
  ).resolves.toEqual({ company: 'Acme', role: 'Platform Engineer' });
});
