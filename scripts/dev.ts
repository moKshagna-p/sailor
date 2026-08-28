import { createConnection } from 'node:net';

const DEV_PORTS = [3000, 3001] as const;

function isListening(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

export async function assertPortsAvailable(ports: readonly number[]): Promise<void> {
  const occupied: number[] = [];

  for (const port of ports) {
    if ((await isListening(port, '127.0.0.1')) || (await isListening(port, '::1'))) {
      occupied.push(port);
    }
  }

  if (occupied.length > 0) {
    const label = occupied.length === 1 ? 'Port' : 'Ports';
    const verb = occupied.length === 1 ? 'is' : 'are';
    throw new Error(`${label} ${occupied.join(', ')} ${verb} already in use`);
  }
}

if (import.meta.main) {
  try {
    await assertPortsAvailable(DEV_PORTS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Sailor cannot start: ${message}. Stop the existing dev server and retry.`);
    process.exitCode = 1;
  }
}
