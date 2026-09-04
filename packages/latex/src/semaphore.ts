/** Bounded concurrency. Without this, N concurrent users = N forked TeX engines. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<{
    grant: (release: () => void) => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error(`Semaphore limit must be >= 1, got ${limit}`);
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();

    if (this.active < this.limit) {
      this.active++;
      return this.createRelease();
    }

    return new Promise<() => void>((grant, reject) => {
      const waiter: (typeof this.waiting)[number] = { grant, reject, signal };
      const onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index === -1) return;
        this.waiting.splice(index, 1);
        reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
      };
      waiter.onAbort = onAbort;
      this.waiting.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      // Guard against a double-release, which would corrupt the count and
      // eventually let unbounded work through.
      if (released) return;
      released = true;

      const waiter = this.waiting.shift();
      if (!waiter) {
        this.active--;
        return;
      }

      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      // Transfer the existing permit directly. Decrementing before waking the
      // waiter would let a new acquisition jump the queue and exceed the limit.
      waiter.grant(this.createRelease());
    };
  }

  get queueDepth(): number {
    return this.waiting.length;
  }

  get activeCount(): number {
    return this.active;
  }
}
