import { expect, test } from 'bun:test';
import { movePaneTab, parsePaneWidths, resizePaneLayout } from './pane-layout.ts';

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

test('stored widths are accepted only when all three values are finite numbers', () => {
  expect(parsePaneWidths('{"source":320,"preview":480,"agent":360}')).toEqual({
    source: 320,
    preview: 480,
    agent: 360,
  });
  expect(parsePaneWidths('{"source":0,"preview":"wide","agent":360}')).toBeNull();
  expect(parsePaneWidths('not json')).toBeNull();
});

test('narrow workbench tabs wrap with arrow-key navigation', () => {
  expect(movePaneTab('source', 1)).toBe('preview');
  expect(movePaneTab('source', -1)).toBe('agent');
  expect(movePaneTab('agent', 1)).toBe('source');
});
