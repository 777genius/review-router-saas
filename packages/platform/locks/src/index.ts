export interface DistributedLock {
  withLock<T>(key: string, run: () => Promise<T>): Promise<T>;
}

export class InMemoryLock implements DistributedLock {
  private readonly active = new Set<string>();

  async withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (this.active.has(key)) throw new Error(`Lock already held: ${key}`);
    this.active.add(key);
    try {
      return await run();
    } finally {
      this.active.delete(key);
    }
  }
}
