/** Bounded concurrency. Without this, N concurrent users = N forked TeX engines. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error(`Semaphore limit must be >= 1, got ${limit}`);
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;

    let released = false;
    return () => {
      // Guard against a double-release, which would corrupt the count and
      // eventually let unbounded work through.
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }

  get queueDepth(): number {
    return this.waiting.length;
  }
}
