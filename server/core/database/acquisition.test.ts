import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcquisitionManager } from './acquisition.ts';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const setup = (limit = 1, queueLimit = 2, timeoutMs = 50) => {
  let id = 0;
  const connect = vi.fn(async () => ({ id: ++id }));
  const release = vi.fn<(resource: { id: number }) => void>();
  const manager = createAcquisitionManager({ connect, release, limit, queueLimit, timeoutMs, now: () => Date.now() });
  return { manager, connect, release };
};

describe('bounded database acquisition', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('admits only the active limit, queues a bounded number and rejects excess capacity', async () => {
    const { manager, connect } = setup(5, 10);
    const leases = await Promise.all(Array.from({ length: 5 }, () => manager.acquire()));
    const queued = Array.from({ length: 10 }, () => manager.acquire());
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'DB_BUSY' });
    expect(connect).toHaveBeenCalledTimes(5);
    expect(manager.stats()).toMatchObject({ active: 5, waiting: 10, busy: 1 });
    for (const lease of leases) lease.release();
    const next = await Promise.all(queued.slice(0, 5));
    expect(manager.stats()).toMatchObject({ active: 5, waiting: 5 });
    for (const lease of next) lease.release();
    for (const lease of await Promise.all(queued.slice(5))) lease.release();
    await manager.close();
    expect(manager.stats()).toMatchObject({ active: 0, waiting: 0, admitted: 15 });
  });

  it('serves waiting acquisitions in FIFO order and release is idempotent', async () => {
    const { manager, release } = setup();
    const first = await manager.acquire();
    const order: string[] = [];
    const second = manager.acquire().then(lease => { order.push('second'); return lease; });
    const third = manager.acquire().then(lease => { order.push('third'); return lease; });
    first.release(); first.release();
    const secondLease = await second;
    expect(order).toEqual(['second']);
    secondLease.release();
    const thirdLease = await third;
    expect(order).toEqual(['second', 'third']);
    thirdLease.release();
    expect(release).toHaveBeenCalledTimes(3);
    expect(manager.stats().active).toBe(0);
  });

  it('removes an expired queued acquisition so its work can never run later', async () => {
    const { manager, connect } = setup();
    const first = await manager.acquire();
    const work = vi.fn(async () => 'must not run');
    const rejected = expect(manager.use(work)).rejects.toMatchObject({ code: 'DB_WAIT_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(manager.stats()).toMatchObject({ active: 1, waiting: 0, timedOut: 1 });
    first.release();
    await flush();
    expect(work).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    (await manager.acquire()).release();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('checks the deadline before starting queued work even if the timer has not run', async () => {
    const { manager, connect } = setup();
    const first = await manager.acquire();
    const rejected = expect(manager.acquire()).rejects.toMatchObject({ code: 'DB_WAIT_TIMEOUT' });
    vi.setSystemTime(51);
    first.release();
    await rejected;
    expect(connect).toHaveBeenCalledTimes(1);
    expect(manager.stats()).toMatchObject({ active: 0, waiting: 0, timedOut: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds the slot for a timed-out connection until its late resource is released without work', async () => {
    const { manager, connect, release } = setup();
    const opening = deferred<{ id: number }>();
    connect.mockImplementationOnce(() => opening.promise);
    const work = vi.fn(async () => 'must not run');
    const rejected = expect(manager.use(work)).rejects.toMatchObject({ code: 'DB_WAIT_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(25);
    const queued = manager.acquire();
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(manager.stats()).toMatchObject({ active: 1, connecting: 1, waiting: 1 });
    expect(connect).toHaveBeenCalledTimes(1);
    opening.resolve({ id: 99 });
    const next = await queued;
    expect(release).toHaveBeenCalledWith({ id: 99 });
    expect(work).not.toHaveBeenCalled();
    next.release();
    expect(manager.stats()).toMatchObject({ active: 0, connecting: 0, waiting: 0 });
  });

  it('checks the deadline again when a connection arrives before a delayed timer callback', async () => {
    const { manager, connect, release } = setup();
    const opening = deferred<{ id: number }>();
    connect.mockImplementationOnce(() => opening.promise);
    const rejected = expect(manager.acquire()).rejects.toMatchObject({ code: 'DB_WAIT_TIMEOUT' });
    vi.setSystemTime(51);
    opening.resolve({ id: 99 });
    await rejected;
    expect(release).toHaveBeenCalledWith({ id: 99 });
    expect(manager.stats()).toMatchObject({ active: 0, connecting: 0, admitted: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases a lease after work fails, including a transaction BEGIN failure', async () => {
    const { manager, release } = setup();
    const failure = new Error('simulated begin failure');
    await expect(manager.use(async () => { throw failure; })).rejects.toBe(failure);
    expect(release).toHaveBeenCalledTimes(1);
    expect(manager.stats().active).toBe(0);
    await expect(manager.use(async resource => resource.id)).resolves.toBe(2);
  });

  it('does not expire a transaction after the lease has been admitted', async () => {
    const { manager, release } = setup();
    const work = deferred<string>();
    const result = manager.use(async () => work.promise);
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(manager.stats()).toMatchObject({ active: 1, timedOut: 0 });
    expect(release).not.toHaveBeenCalled();
    work.resolve('committed');
    await expect(result).resolves.toBe('committed');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('closes idempotently, rejects waiting/new work and drains active and late connections', async () => {
    const { manager, connect, release } = setup(2);
    const active = await manager.acquire();
    const opening = deferred<{ id: number }>();
    connect.mockImplementationOnce(() => opening.promise);
    const connecting = expect(manager.acquire()).rejects.toMatchObject({ code: 'DB_CLOSED' });
    const waiting = expect(manager.acquire()).rejects.toMatchObject({ code: 'DB_CLOSED' });
    let drained = false;
    const close = manager.close();
    void close.then(() => { drained = true; });
    expect(manager.close()).toBe(close);
    await connecting; await waiting;
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'DB_CLOSED' });
    active.release();
    await flush();
    expect(drained).toBe(false);
    opening.resolve({ id: 99 });
    await close;
    expect(drained).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
    expect(manager.stats()).toMatchObject({ active: 0, connecting: 0, waiting: 0, closed: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers capacity after synchronous and asynchronous connection failures', async () => {
    const { manager, connect } = setup();
    const failure = new Error('simulated connection failure');
    connect.mockImplementationOnce(() => { throw failure; });
    await expect(manager.acquire()).rejects.toBe(failure);
    connect.mockRejectedValueOnce(failure);
    await expect(manager.acquire()).rejects.toBe(failure);
    const lease = await manager.acquire();
    expect(manager.stats()).toMatchObject({ active: 1, connecting: 0, admitted: 1 });
    lease.release();
  });

  it('does not leak a slot or release twice when the release callback throws', async () => {
    const { manager, release } = setup();
    const lease = await manager.acquire();
    const queued = manager.acquire();
    release.mockImplementationOnce(() => { throw new Error('simulated release failure'); });
    expect(() => lease.release()).toThrow('simulated release failure');
    expect(() => lease.release()).not.toThrow();
    const next = await queued;
    next.release();
    expect(manager.stats()).toMatchObject({ active: 0, waiting: 0, releaseFailures: 1 });
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('contains a late release failure without an unhandled rejection and drains shutdown', async () => {
    const { manager, connect, release } = setup();
    const opening = deferred<{ id: number }>();
    connect.mockImplementationOnce(() => opening.promise);
    const rejected = expect(manager.acquire()).rejects.toMatchObject({ code: 'DB_WAIT_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    const close = manager.close();
    release.mockImplementationOnce(() => { throw new Error('simulated release failure'); });
    opening.resolve({ id: 99 });
    await close;
    expect(manager.stats()).toMatchObject({ active: 0, connecting: 0, releaseFailures: 1 });
  });

  it('records bounded timing totals without recording query, actor or input data', async () => {
    const { manager } = setup();
    const first = await manager.acquire();
    const second = manager.acquire();
    await vi.advanceTimersByTimeAsync(20);
    first.release();
    const next = await second;
    expect(next.waitMs).toBe(20);
    await vi.advanceTimersByTimeAsync(10);
    next.release();
    expect(manager.stats()).toMatchObject({ admitted: 2, totalWaitMs: 20, totalExecutionMs: 30, maxWaitMs: 20, maxExecutionMs: 20 });
  });

  it.each([{ limit: 0, queueLimit: 1, timeoutMs: 1 }, { limit: 1, queueLimit: -1, timeoutMs: 1 },
    { limit: 1, queueLimit: 1, timeoutMs: 0 }])('rejects invalid configuration %#', options => {
    expect(() => createAcquisitionManager({ ...options, connect: async () => 1, release: () => {} })).toThrow('Invalid database acquisition configuration.');
  });
});
