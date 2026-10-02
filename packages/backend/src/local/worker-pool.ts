import { LocalWorkerClientLike, LocalWorkerRequestOptions, LocalWorkerStatus } from './worker-client.js';

/**
 * Nhiều tiến trình worker cùng vai trò (ví dụ 2 tiến trình TTS) sau một giao diện.
 * Yêu cầu suy luận đi tới tiến trình đang rảnh nhất; lệnh hủy (cancel) gửi cho tất cả vì không biết
 * tiến trình nào đang giữ request của generation cũ.
 */
export class LocalWorkerPool implements LocalWorkerClientLike {
  private readonly inFlight: number[];
  private next = 0;

  constructor(private readonly workers: LocalWorkerClientLike[]) {
    if (workers.length < 1) throw new Error('LocalWorkerPool needs at least one worker');
    this.inFlight = workers.map(() => 0);
  }

  get size(): number {
    return this.workers.length;
  }

  async start(): Promise<void> {
    await Promise.all(this.workers.map(worker => worker.start?.()));
  }

  getStatus(): LocalWorkerStatus {
    const statuses = this.workers.map(worker => worker.getStatus?.());
    const known = statuses.filter((status): status is LocalWorkerStatus => Boolean(status));
    const failed = known.find(status => status.state === 'error');
    const state = failed ? 'error'
      : known.every(status => status.state === 'ready') ? 'ready'
      : known.find(status => status.state === 'starting') ? 'starting'
      : known.find(status => status.state === 'stopped') ? 'stopped'
      : 'closed';
    return {
      state,
      ...(failed?.error ? { error: failed.error } : {}),
      pendingRequests: known.reduce((sum, status) => sum + status.pendingRequests, 0)
    };
  }

  async request<T>(payload: Record<string, unknown>, options?: LocalWorkerRequestOptions): Promise<T> {
    if (payload.op === 'cancel') {
      const results = await Promise.allSettled(this.workers.map(worker => worker.request<T>(payload, options)));
      const ok = results.find((result): result is PromiseFulfilledResult<Awaited<T>> => result.status === 'fulfilled');
      if (ok) return ok.value as T;
      throw (results[0] as PromiseRejectedResult).reason;
    }
    const index = this.pick();
    this.inFlight[index]++;
    try {
      return await this.workers[index].request<T>(payload, options);
    } finally {
      this.inFlight[index]--;
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map(worker => worker.close()));
  }

  private pick(): number {
    let best = this.next % this.workers.length;
    for (let offset = 0; offset < this.workers.length; offset++) {
      const index = (this.next + offset) % this.workers.length;
      if (this.inFlight[index] < this.inFlight[best]) best = index;
    }
    this.next = (best + 1) % this.workers.length;
    return best;
  }
}
