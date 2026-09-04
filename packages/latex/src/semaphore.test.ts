import { describe, expect, test } from 'bun:test';
import { Semaphore } from './semaphore.ts';

describe('Semaphore', () => {
  test('rejects an already-aborted acquisition without consuming capacity', async () => {
    const gate = new Semaphore(1);
    const controller = new AbortController();
    controller.abort();

    await expect(gate.acquire(controller.signal)).rejects.toHaveProperty('name', 'AbortError');

    const release = await gate.acquire();
    expect(gate.activeCount).toBe(1);
    release();
    expect(gate.activeCount).toBe(0);
  });

  test('removes an aborted waiter and grants the next waiter', async () => {
    const gate = new Semaphore(1);
    const releaseFirst = await gate.acquire();
    const controller = new AbortController();
    const aborted = gate.acquire(controller.signal);
    const next = gate.acquire();

    expect(gate.queueDepth).toBe(2);
    controller.abort();
    await expect(aborted).rejects.toHaveProperty('name', 'AbortError');
    expect(gate.queueDepth).toBe(1);

    releaseFirst();
    const releaseNext = await next;
    expect(gate.activeCount).toBe(1);
    releaseNext();
    expect(gate.activeCount).toBe(0);
  });

  test('hands a released permit directly to the oldest waiter', async () => {
    const gate = new Semaphore(1);
    const order: string[] = [];
    const releaseFirst = await gate.acquire();
    const second = gate.acquire().then((release) => {
      order.push('second');
      return release;
    });

    releaseFirst();
    const third = gate.acquire().then((release) => {
      order.push('third');
      return release;
    });

    const releaseSecond = await second;
    expect(gate.activeCount).toBe(1);
    expect(order).toEqual(['second']);

    releaseSecond();
    const releaseThird = await third;
    expect(order).toEqual(['second', 'third']);
    releaseThird();
    expect(gate.activeCount).toBe(0);
  });
});
