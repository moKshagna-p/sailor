import { afterEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { assertPortsAvailable } from './dev';

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

test('reports occupied ports before starting the dev servers', async () => {
  server = createServer();
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP test server');
  }

  await expect(assertPortsAvailable([address.port])).rejects.toThrow(
    `Port ${address.port} is already in use`,
  );
});
