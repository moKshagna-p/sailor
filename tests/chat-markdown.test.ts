import { expect, test } from 'bun:test';
import { Chat } from '../apps/web/components/chat.tsx';
import { createElement } from '../apps/web/node_modules/react';
import { renderToStaticMarkup } from '../apps/web/node_modules/react-dom/server';

test('agent Markdown renders as semantic headings, lists, emphasis, and code', () => {
  const html = renderToStaticMarkup(
    createElement(Chat, {
      items: [
        {
          kind: 'agent',
          text: '### Key summary\n\n1. **Validated** the `PyTest` workflow.',
        },
      ],
      busy: false,
      connected: true,
      permission: null,
      elicit: null,
      onSend: () => {},
      onCancel: () => {},
    }),
  );

  expect(html).toContain('<h3>Key summary</h3>');
  expect(html).toContain('<ol>');
  expect(html).toContain('<strong>Validated</strong>');
  expect(html).toContain('<code>PyTest</code>');
  expect(html).not.toContain('### Key summary');
});

test('agent-owned chat surfaces never render emoji', () => {
  const html = renderToStaticMarkup(
    createElement(Chat, {
      items: [
        { kind: 'agent', text: 'Ready 🚀. Score 90/100.' },
        { kind: 'tool', name: 'web_search', ok: true, detail: 'Found it 🔍' },
        {
          kind: 'gap',
          analysis: {
            coverage: 90,
            notes: 'Strong match ✅',
            matches: [
              {
                requirement: 'Backend systems 🧰',
                evidence: [],
                status: 'strong',
                askUser: 'What scale? 📈',
              },
            ],
          },
        },
        { kind: 'committed', summary: 'Updated bullet ✨' },
        { kind: 'error', message: 'Review failed ⚠️' },
      ],
      busy: false,
      connected: true,
      permission: {
        title: 'Apply edit 🛠️',
        diff: '',
        respond: () => {},
      },
      elicit: { question: 'How many users? 👥', respond: () => {} },
      onSend: () => {},
      onCancel: () => {},
    }),
  );

  for (const emoji of ['🚀', '🔍', '✅', '🧰', '📈', '✨', '⚠️', '🛠️', '👥']) {
    expect(html).not.toContain(emoji);
  }
  expect(html).toContain('Score 90/100.');
});
