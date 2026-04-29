/**
 * Unified mock message queue for testing.
 * Replaces MockMessageQueue from gateway setup.ts.
 */

export class MockMessageQueue {
  private queues = new Map<string, any[]>();
  private workers = new Map<string, (job: any) => Promise<void>>();

  async createQueue(queueName: string): Promise<void> {
    if (!this.queues.has(queueName)) {
      this.queues.set(queueName, []);
    }
  }

  async work(
    queueName: string,
    handler: (job: any) => Promise<void>,
    _options?: { startPaused?: boolean }
  ): Promise<void> {
    this.workers.set(queueName, handler);
  }

  async addJob(queueName: string, job: any): Promise<void> {
    const queue = this.queues.get(queueName);
    if (!queue) throw new Error(`Queue ${queueName} does not exist`);
    queue.push(job);

    const handler = this.workers.get(queueName);
    if (handler) await handler(job);
  }

  // --- Test helpers ---

  getQueue(queueName: string): any[] | undefined {
    return this.queues.get(queueName);
  }

  clearQueues(): void {
    this.queues.clear();
    this.workers.clear();
  }
}
