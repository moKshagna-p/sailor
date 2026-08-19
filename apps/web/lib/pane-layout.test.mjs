import { expect, test } from 'bun:test';
import { resizePaneLayout } from './pane-layout.ts';

const start = { source: 360, preview: 440, agent: 400 };

test('the source separator cannot crush source or preview', () => {
  expect(resizePaneLayout(1200, start, 'source', 20)).toEqual({
    source: 240,
    preview: 548,
    agent: 400,
  });
  expect(resizePaneLayout(1200, start, 'source', 1100)).toEqual({
    source: 508,
    preview: 280,
    agent: 400,
  });
});

test('the agent separator cannot crush preview or agent', () => {
  expect(resizePaneLayout(1200, start, 'agent', 1180)).toEqual({
    source: 360,
    preview: 528,
    agent: 300,
  });
  expect(resizePaneLayout(1200, start, 'agent', 500)).toEqual({
    source: 360,
    preview: 280,
    agent: 548,
  });
});

test('keyboard movement uses the same clamping path', () => {
  expect(resizePaneLayout(1200, start, 'source', start.source + 24)).toEqual({
    source: 384,
    preview: 404,
    agent: 400,
  });
});
