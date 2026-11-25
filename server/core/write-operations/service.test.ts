import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { executeWriteOperation, WriteOperationConflict, writeInputHash } from './service.ts';
import type { WriteOperationReceipt, WriteOperationsTransaction } from './store.ts';

function fixture(stored?: (claim: WriteOperationReceipt) => WriteOperationReceipt) {
  const claimWriteOperation = vi.fn(async (claim: WriteOperationReceipt) => stored ? stored(claim) : claim);
  const completeWriteOperation = vi.fn(async () => true);
  const cancelWriteOperation = vi.fn(async () => {});
  const tx: WriteOperationsTransaction = { claimWriteOperation, completeWriteOperation, cancelWriteOperation };
  const execute = vi.fn(async () => ({ entityId: randomUUID() }));
  const readResponse = (value: unknown) => {
    if (!value || typeof value !== 'object' || typeof (value as any).entityId !== 'string' || Object.keys(value).length !== 1) {
      throw new Error('Invalid stored response');
    }
    return { entityId: (value as { entityId: string }).entityId };
  };
  const options = { operationId: randomUUID(), actorUserId: randomUUID(), operationCode: 'organization.branches.create',
    input: { name: 'فرع اصطناعي', expectedVersion: 1 }, now: new Date('2026-11-25T12:00:00Z'), readResponse, execute };
  return { tx, options, execute, claimWriteOperation, completeWriteOperation, cancelWriteOperation };
}

test('hash binds operation and every parsed field while object field order is irrelevant', () => {
  expect(writeInputHash('branches.rename', { name: 'A', version: 1 })).toEqual(writeInputHash('branches.rename', { version: 1, name: 'A' }));
  expect(writeInputHash('branches.rename', { name: 'A', version: 1 })).not.toEqual(writeInputHash('departments.rename', { name: 'A', version: 1 }));
  expect(writeInputHash('branches.rename', { name: 'A', version: 1 })).not.toEqual(writeInputHash('branches.rename', { name: 'A', version: 2 }));
});

test('new reservation completes with validated result and a matching reservation identity', async () => {
  const f = fixture();
  const result = await executeWriteOperation(f.tx, f.options);
  const claim = f.claimWriteOperation.mock.calls[0][0];
  expect(result.replayed).toBe(false);
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.completeWriteOperation).toHaveBeenCalledWith(f.options.operationId, claim.reservationToken, result.value);
  expect(f.cancelWriteOperation).not.toHaveBeenCalled();
});

test('completed matching receipt returns its validated snapshot without performing business work', async () => {
  const response = { entityId: randomUUID() };
  const f = fixture(claim => ({ ...claim, reservationToken: randomUUID(), response }));
  expect(await executeWriteOperation(f.tx, f.options)).toEqual({ value: response, replayed: true });
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.completeWriteOperation).not.toHaveBeenCalled();
  expect(f.cancelWriteOperation).not.toHaveBeenCalled();
});

test.each(['operationId', 'actorUserId', 'operationCode', 'inputHash'] as const)('mismatched receipt %s cannot expose its snapshot or execute again', async key => {
  const f = fixture(claim => ({ ...claim, response: { entityId: 'private-target' },
    [key]: key === 'inputHash' ? Buffer.alloc(32) : key === 'operationCode' ? 'organization.departments.create' : randomUUID() }));
  await expect(executeWriteOperation(f.tx, f.options)).rejects.toBeInstanceOf(WriteOperationConflict);
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.cancelWriteOperation).not.toHaveBeenCalled();
});

test('foreign incomplete reservation fails closed rather than claiming unfinished work', async () => {
  const f = fixture(claim => ({ ...claim, reservationToken: randomUUID() }));
  await expect(executeWriteOperation(f.tx, f.options)).rejects.toThrow('Incomplete write receipt');
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.cancelWriteOperation).not.toHaveBeenCalled();
});

test('corrupt completed snapshot is rejected before any business work', async () => {
  const f = fixture(claim => ({ ...claim, response: { entityId: 'private-target', password: 'must-never-be-returned' } }));
  await expect(executeWriteOperation(f.tx, f.options)).rejects.toThrow('Invalid stored response');
  expect(f.execute).not.toHaveBeenCalled();
});

test('business rejection cancels only its new incomplete reservation and preserves the error', async () => {
  const f = fixture();
  const rejected = new Error('Synthetic business rejection');
  f.execute.mockRejectedValue(rejected);
  await expect(executeWriteOperation(f.tx, f.options)).rejects.toBe(rejected);
  expect(f.completeWriteOperation).not.toHaveBeenCalled();
  expect(f.cancelWriteOperation).toHaveBeenCalledWith(f.options.operationId, f.claimWriteOperation.mock.calls[0][0].reservationToken);
});

test('incomplete completion remains unexpected so outer transaction must roll back the business change', async () => {
  const f = fixture();
  f.completeWriteOperation.mockResolvedValue(false);
  await expect(executeWriteOperation(f.tx, f.options)).rejects.toThrow('Write receipt could not complete');
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.cancelWriteOperation).toHaveBeenCalledTimes(1);
});
