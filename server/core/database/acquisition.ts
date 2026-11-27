export type DatabaseAcquisitionCode = 'DB_BUSY' | 'DB_WAIT_TIMEOUT' | 'DB_CLOSED';

/** These fixed codes/messages are safe to classify; driver errors are never copied here. */
export class DatabaseAcquisitionError extends Error {
  readonly code: DatabaseAcquisitionCode;

  constructor(code: DatabaseAcquisitionCode) {
    super(code === 'DB_BUSY' ? 'Database capacity is busy.'
      : code === 'DB_WAIT_TIMEOUT' ? 'Database acquisition timed out.' : 'Database is closing.');
    this.name = 'DatabaseAcquisitionError';
    this.code = code;
  }
}

export type ConnectionLease<T> = { resource: T; waitMs: number; release(): void };
type Waiter<T> = {
  startedAt: number;
  deadline: number;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (lease: ConnectionLease<T>) => void;
  reject: (error: unknown) => void;
};

/** Owns admission, including connections still opening after their caller has timed out. */
export function createAcquisitionManager<T>(options: {
  connect: () => Promise<T>;
  release: (resource: T) => void;
  limit: number;
  queueLimit: number;
  timeoutMs: number;
  now?: () => number;
}) {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1
    || !Number.isSafeInteger(options.queueLimit) || options.queueLimit < 0
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error('Invalid database acquisition configuration.');
  }
  const now = options.now ?? (() => performance.now());
  const queue: Waiter<T>[] = [];
  const pending = new Set<Waiter<T>>();
  let active = 0;
  let connecting = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let resolveClosed: (() => void) | undefined;
  let admitted = 0;
  let timedOut = 0;
  let busy = 0;
  let totalWaitMs = 0;
  let totalExecutionMs = 0;
  let maxWaitMs = 0;
  let maxExecutionMs = 0;
  let releaseFailures = 0;

  function settleRejected(waiter: Waiter<T>, error: unknown) {
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    pending.delete(waiter);
    const index = queue.indexOf(waiter);
    if (index !== -1) queue.splice(index, 1);
    if (error instanceof DatabaseAcquisitionError && error.code === 'DB_WAIT_TIMEOUT') timedOut++;
    waiter.reject(error);
  }

  function slotReleased() {
    active--;
    if (closed) {
      if (active === 0) resolveClosed?.();
      return;
    }
    while (active < options.limit && queue.length > 0) {
      const waiter = queue.shift()!;
      if (now() >= waiter.deadline) settleRejected(waiter, new DatabaseAcquisitionError('DB_WAIT_TIMEOUT'));
      else start(waiter);
    }
  }

  function connectionFailed(waiter: Waiter<T>, error: unknown) {
    connecting--;
    settleRejected(waiter, closed ? new DatabaseAcquisitionError('DB_CLOSED')
      : now() >= waiter.deadline ? new DatabaseAcquisitionError('DB_WAIT_TIMEOUT') : error);
    slotReleased();
  }

  function start(waiter: Waiter<T>) {
    active++;
    connecting++;
    let opening: Promise<T>;
    try { opening = options.connect(); }
    catch (error) { connectionFailed(waiter, error); return; }
    void opening.then(resource => {
      connecting--;
      // The timer can be delayed by a busy event loop, so also check the deadline here.
      if (waiter.settled || closed || now() >= waiter.deadline) {
        settleRejected(waiter, new DatabaseAcquisitionError(closed ? 'DB_CLOSED' : 'DB_WAIT_TIMEOUT'));
        try { options.release(resource); }
        catch { releaseFailures++; }
        finally { slotReleased(); }
        return;
      }
      waiter.settled = true;
      clearTimeout(waiter.timer);
      pending.delete(waiter);
      const leasedAt = now();
      const waitMs = Math.max(0, leasedAt - waiter.startedAt);
      totalWaitMs += waitMs;
      maxWaitMs = Math.max(maxWaitMs, waitMs);
      admitted++;
      let released = false;
      waiter.resolve({ resource, waitMs, release() {
        if (released) return;
        released = true;
        try { options.release(resource); }
        catch (error) { releaseFailures++; throw error; }
        finally {
          const executionMs = Math.max(0, now() - leasedAt);
          totalExecutionMs += executionMs;
          maxExecutionMs = Math.max(maxExecutionMs, executionMs);
          slotReleased();
        }
      } });
    }, error => connectionFailed(waiter, error));
  }

  function acquire(): Promise<ConnectionLease<T>> {
    if (closed) return Promise.reject(new DatabaseAcquisitionError('DB_CLOSED'));
    if (active >= options.limit && queue.length >= options.queueLimit) {
      busy++;
      return Promise.reject(new DatabaseAcquisitionError('DB_BUSY'));
    }
    return new Promise((resolve, reject) => {
      const startedAt = now();
      const waiter: Waiter<T> = { startedAt, deadline: startedAt + options.timeoutMs, settled: false, resolve, reject };
      pending.add(waiter);
      waiter.timer = setTimeout(() => settleRejected(waiter, new DatabaseAcquisitionError('DB_WAIT_TIMEOUT')), options.timeoutMs);
      if (active < options.limit && queue.length === 0) start(waiter);
      else queue.push(waiter);
    });
  }

  return {
    acquire,
    async use<R>(work: (resource: T) => Promise<R>): Promise<R> {
      const lease = await acquire();
      try { return await work(lease.resource); }
      finally { lease.release(); }
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = new Promise<void>(resolve => { resolveClosed = resolve; });
      for (const waiter of pending) settleRejected(waiter, new DatabaseAcquisitionError('DB_CLOSED'));
      if (active === 0) resolveClosed!();
      return closePromise;
    },
    stats() { return { active, waiting: queue.length, connecting, closed, admitted, timedOut, busy,
      totalWaitMs, totalExecutionMs, maxWaitMs, maxExecutionMs, releaseFailures }; },
  };
}
