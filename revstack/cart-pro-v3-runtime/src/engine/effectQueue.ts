/**
 * Cart Pro V3 — effect queue.
 * Serialized async execution: strictly in order, no parallel, continue on failure.
 */
type AsyncFn = () => Promise<void>;

export interface EffectQueue {
  enqueue(asyncFn: AsyncFn): void;
  getQueueLength(): number;
}

export function createEffectQueue(): EffectQueue {
  let running = false;
  const queue: AsyncFn[] = [];

  async function runNext(): Promise<void> {
    if (queue.length === 0) {
      running = false;
      return;
    }
    const fn = queue.shift()!;
    try {
      await fn();
    } catch (err) {
      console.error('[Cart Pro V3] Effect queue error:', err);
    }
    await runNext();
  }

  function enqueue(asyncFn: AsyncFn): void {
    queue.push(asyncFn);
    if (!running) {
      running = true;
      runNext();
    }
  }

  function getQueueLength(): number {
    return queue.length + (running ? 1 : 0);
  }

  return { enqueue, getQueueLength };
}
