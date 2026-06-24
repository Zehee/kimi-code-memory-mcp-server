/**
 * A simple per-instance promise mutex.
 *
 * Operations queued through `runExclusive` are serialized: each waits for the
 * previous one to complete before starting. This prevents read-modify-write
 * races on shared files such as index.json, theme JSON, and refined JSONL.
 */

export class Mutex {
  private queue: Promise<unknown> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const task = this.queue.then(
      () => fn(),
      () => fn(),
    );
    // Keep a non-rejecting reference so one failed operation does not block the queue.
    this.queue = task.then(
      () => {},
      () => {},
    );
    return task;
  }
}
