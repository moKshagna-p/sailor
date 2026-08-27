import { expect, test } from 'bun:test';
import { toChatHistory } from './history.ts';

test('toChatHistory exposes user and assistant text without model internals', () => {
  expect(
    toChatHistory([
      { role: 'user', content: 'Make the validation bullet stronger.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Updated the **validation** bullet.' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'edit_resume',
            input: { oldText: 'before', newText: 'after' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'edit_resume',
            output: { type: 'json', value: { ok: true } },
          },
        ],
      },
    ]),
  ).toEqual([
    { kind: 'user', text: 'Make the validation bullet stronger.' },
    { kind: 'agent', text: 'Updated the **validation** bullet.' },
  ]);
});
