/**
 * Minimal FIFO async mutex: `run` executes tasks one at a time in call order.
 * A failing task does not block the queue.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.catch(() => undefined)
    return result
  }

  /** Resolves once every task queued so far has settled. */
  async idle(): Promise<void> {
    let seen: Promise<unknown>
    do {
      seen = this.tail
      await seen
    } while (seen !== this.tail)
  }
}
