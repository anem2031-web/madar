import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '../../lib/trpc.ts';
import { readRequestFailure, requestReference } from '../../lib/request-failure.ts';
import { useRequestFailure } from '../../lib/useRequestFailure.ts';
import type { AccessFailureHandlers } from '../auth/access-failures.ts';

export type Branch = { id: string; name: string; version: number };
export type Department = Branch & { branchId: string };
type PageHistory = (string | undefined)[];
type Page<T> = { rows: T[]; cursor?: string; nextCursor?: string; history: PageHistory };
type Notice = { kind: 'branchCreated' | 'branchRenamed' | 'departmentCreated' | 'departmentRenamed' | 'unchanged'; name?: string };
type ForegroundActions = { begin: () => boolean; end: (options?: { skipQueuedRefresh?: boolean }) => void };
const emptyPage = <T,>(): Page<T> => ({ rows: [], history: [] });
const knownReasons = new Set([
  'ORG_INVALID_INPUT', 'ORG_BRANCH_NOT_FOUND', 'ORG_DEPARTMENT_NOT_FOUND', 'ORG_CONFLICT', 'ORG_UNAVAILABLE',
  'ORG_CLIENT_UPDATE_REQUIRED', 'ORG_OPERATION_CONFLICT',
  'AUTH_REQUIRED', 'AUTH_FORBIDDEN', 'AUTH_CSRF', 'AUTH_RATE_LIMITED', 'AUTH_UNAVAILABLE',
]);
function reason(error: unknown, write: boolean) {
  return readRequestFailure(error, knownReasons, write ? 'ORG_UNCERTAIN' : 'ORG_UNAVAILABLE', write).code;
}
async function timed<T>(call: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15_000);
  try { return await call(controller.signal); } finally { window.clearTimeout(timer); }
}

export function useOrganization(accessHandlers: AccessFailureHandlers, foregroundActions: ForegroundActions) {
  const [branches, setBranches] = useState<Page<Branch>>(emptyPage);
  const [departments, setDepartments] = useState<Page<Department>>(emptyPage);
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(true);
  const [loadingDepartments, setLoadingDepartments] = useState(false);
  const [pending, setPending] = useState(false);
  const { error, errorRequestId, setError, relabelError } = useRequestFailure();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const mounted = useRef(true);
  const busy = useRef(false);
  const branchGeneration = useRef(0);
  const departmentGeneration = useRef(0);
  const selectedRef = useRef<Branch | null>(null);
  const accessRef = useRef(accessHandlers);
  const pageDenied = useRef(false);
  const foregroundRef = useRef(foregroundActions);
  accessRef.current = accessHandlers;
  foregroundRef.current = foregroundActions;

  const clearDepartments = useCallback(() => {
    ++departmentGeneration.current;
    selectedRef.current = null;
    setSelectedBranch(null); setDepartments(emptyPage()); setLoadingDepartments(false);
  }, []);
  const handleAccessFailure = useCallback((failure: string, source: 'page' | 'operation', original?: unknown) => {
    if (failure === 'AUTH_FORBIDDEN' && source === 'operation') { accessRef.current.onActionForbidden(); return; }
    if (failure === 'AUTH_REQUIRED' || failure === 'AUTH_FORBIDDEN' || failure === 'AUTH_CSRF') {
      ++branchGeneration.current;
      clearDepartments(); setBranches(emptyPage()); setLoadingBranches(false); setNotice(null);
      if (failure === 'AUTH_FORBIDDEN') { pageDenied.current = true; accessRef.current.onReadForbidden(requestReference(original)); }
      else accessRef.current.onSessionInvalid();
    }
  }, [clearDepartments]);
  const loadBranches = useCallback(async (cursor?: string, history?: PageHistory) => {
    const current = ++branchGeneration.current;
    setLoadingBranches(true); setError(null);
    setBranches(page => ({ ...page, rows: [] }));
    try {
      const page = await timed(signal => trpc.organization.listBranches.query({ ...(cursor ? { cursor } : {}) }, { signal }));
      if (!mounted.current || current !== branchGeneration.current) return false;
      setBranches(previous => ({ rows: page.branches, cursor, nextCursor: page.nextCursor, history: history ?? previous.history }));
      return true;
    } catch (failure) {
      if (mounted.current && current === branchGeneration.current) {
        const message = reason(failure, false); setError(message, failure); handleAccessFailure(message, 'page', failure);
      }
      return false;
    } finally {
      if (mounted.current && current === branchGeneration.current) setLoadingBranches(false);
    }
  }, [handleAccessFailure]);
  const loadDepartments = useCallback(async (branch: Branch, cursor?: string, history?: PageHistory) => {
    const current = ++departmentGeneration.current;
    selectedRef.current = branch;
    setSelectedBranch(branch); setLoadingDepartments(true); setError(null);
    setDepartments(page => ({ ...page, rows: [] }));
    try {
      const page = await timed(signal => trpc.organization.listDepartments.query({ branchId: branch.id, ...(cursor ? { cursor } : {}) }, { signal }));
      if (!mounted.current || current !== departmentGeneration.current || selectedRef.current?.id !== branch.id) return false;
      selectedRef.current = page.branch; setSelectedBranch(page.branch);
      setBranches(previous => ({ ...previous, rows: previous.rows.map(row => row.id === page.branch.id ? page.branch : row) }));
      setDepartments(previous => ({ rows: page.departments, cursor, nextCursor: page.nextCursor, history: history ?? previous.history }));
      return true;
    } catch (failure) {
      if (mounted.current && current === departmentGeneration.current) {
        const message = reason(failure, false); setError(message, failure); handleAccessFailure(message, 'operation', failure);
      }
      return false;
    } finally {
      if (mounted.current && current === departmentGeneration.current) setLoadingDepartments(false);
    }
  }, [handleAccessFailure]);

  useEffect(() => {
    mounted.current = true;
    void loadBranches();
    return () => {
      mounted.current = false;
      ++branchGeneration.current; ++departmentGeneration.current;
      if (busy.current && !pageDenied.current) accessRef.current.onSessionInvalid();
    };
  }, [loadBranches]);

  async function mutate<T>(operation: (signal: AbortSignal, operationId: string) => Promise<T>, apply: (value: T) => Promise<boolean>) {
    if (busy.current || reviewRequired) return false;
    if (!foregroundRef.current.begin()) { setError('AUTH_REQUIRED'); return false; }
    busy.current = true;
    ++branchGeneration.current; ++departmentGeneration.current;
    setLoadingBranches(false); setLoadingDepartments(false);
    setPending(true); setError(null); setNotice(null);
    try {
      const operationId = crypto.randomUUID();
      const outcome = await timed(signal => operation(signal, operationId));
      if (!mounted.current) return false;
      const refreshed = await apply(outcome);
      if (mounted.current && !refreshed) { relabelError('ORG_REFRESH_FAILED'); setReviewRequired(true); }
      return true;
    } catch (failure) {
      if (!mounted.current) return false;
      const message = reason(failure, true); setError(message, failure);
      if (['ORG_CONFLICT', 'ORG_OPERATION_CONFLICT', 'ORG_CLIENT_UPDATE_REQUIRED', 'ORG_UNCERTAIN', 'ORG_UNAVAILABLE', 'AUTH_UNAVAILABLE', 'ORG_BRANCH_NOT_FOUND', 'ORG_DEPARTMENT_NOT_FOUND', 'CONFLICT'].includes(message)) setReviewRequired(true);
      handleAccessFailure(message, 'operation', failure);
      return false;
    } finally {
      busy.current = false;
      foregroundRef.current.end();
      if (mounted.current) setPending(false);
    }
  }

  return {
    branches: branches.rows, departments: departments.rows, selectedBranch, loadingBranches, loadingDepartments,
    pending, error, errorRequestId, notice, reviewRequired,
    branchPage: branches.history.length + 1, departmentPage: departments.history.length + 1,
    hasPreviousBranch: branches.history.length > 0, hasNextBranch: !!branches.nextCursor,
    hasPreviousDepartment: departments.history.length > 0, hasNextDepartment: !!departments.nextCursor,
    clearFeedback: () => { if (!busy.current) { setError(null); setNotice(null); } },
    selectBranch: (branch: Branch) => {
      if (busy.current) return;
      clearDepartments(); setNotice(null); void loadDepartments(branch, undefined, []);
    },
    refresh: async () => {
      if (busy.current) return;
      setNotice(null);
      const branch = selectedRef.current;
      // Clear the review barrier only after every displayed resource has been refreshed.
      const refreshed = await Promise.all([loadBranches(branches.cursor), branch ? loadDepartments(branch, departments.cursor) : Promise.resolve(true)]);
      if (mounted.current && refreshed.every(Boolean)) setReviewRequired(false);
    },
    nextBranch: () => {
      if (busy.current || !branches.nextCursor) return;
      clearDepartments(); setNotice(null); void loadBranches(branches.nextCursor, [...branches.history, branches.cursor]);
    },
    previousBranch: () => {
      if (busy.current || !branches.history.length) return;
      clearDepartments(); setNotice(null); void loadBranches(branches.history.at(-1), branches.history.slice(0, -1));
    },
    nextDepartment: () => {
      if (busy.current || !selectedBranch || !departments.nextCursor) return;
      setNotice(null); void loadDepartments(selectedBranch, departments.nextCursor, [...departments.history, departments.cursor]);
    },
    previousDepartment: () => {
      if (busy.current || !selectedBranch || !departments.history.length) return;
      setNotice(null); void loadDepartments(selectedBranch, departments.history.at(-1), departments.history.slice(0, -1));
    },
    createBranch: (name: string) => mutate((signal, operationId) => trpc.organization.createBranch.mutate({ operationId, name }, { signal }), async result => {
      setNotice({ kind: 'branchCreated', name: result.branch.name });
      clearDepartments();
      return (await Promise.all([loadBranches(undefined, []), loadDepartments(result.branch, undefined, [])])).every(Boolean);
    }),
    renameBranch: (branch: Branch, name: string) => mutate((signal, operationId) => trpc.organization.renameBranch.mutate({ operationId, branchId: branch.id, expectedVersion: branch.version, name }, { signal }), async result => {
      setBranches(page => ({ ...page, rows: page.rows.map(row => row.id === result.branch.id ? result.branch : row) }));
      if (selectedRef.current?.id === result.branch.id) { selectedRef.current = result.branch; setSelectedBranch(result.branch); }
      setNotice({ kind: result.changed ? 'branchRenamed' : 'unchanged', name: result.changed ? result.branch.name : undefined });
      return true;
    }),
    createDepartment: (branch: Branch, name: string) => mutate((signal, operationId) => trpc.organization.createDepartment.mutate({ operationId, branchId: branch.id, name }, { signal }), async result => {
      setNotice({ kind: 'departmentCreated', name: result.department.name });
      return loadDepartments(branch, undefined, []);
    }),
    renameDepartment: (department: Department, name: string) => mutate((signal, operationId) => trpc.organization.renameDepartment.mutate({ operationId, branchId: department.branchId, departmentId: department.id, expectedVersion: department.version, name }, { signal }), async result => {
      setDepartments(page => ({ ...page, rows: page.rows.map(row => row.id === result.department.id ? result.department : row) }));
      setNotice({ kind: result.changed ? 'departmentRenamed' : 'unchanged', name: result.changed ? result.department.name : undefined });
      return true;
    }),
  };
}
