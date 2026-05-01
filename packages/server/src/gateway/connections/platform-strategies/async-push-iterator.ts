/**
 * Push-based async iterable: producers call `push(value)` and `close()`;
 * consumers iterate via `for await (...)`.
 */
export class AsyncPushIterator<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiter: ((v: IteratorResult<T>) => void) | null = null;
  private done = false;

  push(value: T): void {
    if (this.done) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        new Promise<IteratorResult<T>>((resolve) => {
          const first = this.queue.shift();
          if (first !== undefined) {
            resolve({ value: first, done: false });
            return;
          }
          if (this.done) {
            resolve({ value: undefined as unknown as T, done: true });
            return;
          }
          this.waiter = resolve;
        }),
    };
  }
}
