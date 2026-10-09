// Test helper: an async iterable the test feeds by hand, standing in for a live SSE stream.
export class Channel<T> implements AsyncIterable<T> {
  private queue: ({ value: T } | { end: true } | { error: Error })[] = [];
  private waiter: (() => void) | null = null;

  push(value: T): void {
    this.queue.push({ value });
    this.wake();
  }

  end(): void {
    this.queue.push({ end: true });
    this.wake();
  }

  fail(error: Error): void {
    this.queue.push({ error });
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      while (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
      }
      const item = this.queue.shift()!;
      if ('end' in item) return;
      if ('error' in item) throw item.error;
      yield item.value;
    }
  }
}

// Lets every pending microtask and I/O callback run, so a test can assert on what a background
// consumer did with the events it was just fed.
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

// Polls until `check` stops throwing; for assertions on work that crosses a real socket.
export async function eventually(check: () => void | Promise<void>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
}
