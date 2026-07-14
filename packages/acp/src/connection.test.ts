import { expect, test } from 'bun:test';
import { Connection } from './connection.ts';

function pair() {
  const sent: string[] = [];
  const connection = new Connection({ send: (raw) => sent.push(raw), close: () => {} }, 500);
  return { connection, sent };
}

test('an inbound request gets a reply', async () => {
  const { connection, sent } = pair();
  connection.on('initialize', () => ({ agent: { name: 'sailor' } }));

  await connection.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));

  expect(sent).toHaveLength(1);
  const reply = JSON.parse(sent[0] ?? '{}');
  expect(reply).toMatchObject({
    jsonrpc: '2.0',
    id: 1,
    result: { agent: { name: 'sailor' } },
  });
});

test('a handler that throws produces an error reply, not a hang', async () => {
  const { connection, sent } = pair();
  connection.on('boom', () => {
    throw new Error('exploded');
  });

  await connection.handle(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'boom' }));

  const reply = JSON.parse(sent[0] ?? '{}');
  expect(reply.id).toBe(7);
  expect(reply.error.message).toBe('exploded');
});

test('an unknown method replies methodNotFound', async () => {
  const { connection, sent } = pair();
  await connection.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'nope' }));
  expect(JSON.parse(sent[0] ?? '{}').error.code).toBe(-32601);
});

test('malformed JSON does not kill the connection', async () => {
  const { connection, sent } = pair();
  await connection.handle('{not json');
  expect(JSON.parse(sent[0] ?? '{}').error.code).toBe(-32700);
});

test('an outbound request resolves when the peer answers — this is the permission gate', async () => {
  const { connection, sent } = pair();

  const answer = connection.request<{ outcome: string }>('session/request_permission', {
    title: 'Edit bullet',
  });

  const asked = JSON.parse(sent[0] ?? '{}');
  expect(asked.method).toBe('session/request_permission');

  // The human clicks Apply.
  await connection.handle(
    JSON.stringify({
      jsonrpc: '2.0',
      id: asked.id,
      result: { outcome: 'allow' },
    }),
  );

  expect(await answer).toEqual({ outcome: 'allow' });
});

test('closing rejects in-flight requests, so a tool never awaits a dead socket', async () => {
  const { connection } = pair();
  const answer = connection.request('session/request_permission', {});
  connection.close('gone');
  await expect(answer).rejects.toThrow('gone');
});
