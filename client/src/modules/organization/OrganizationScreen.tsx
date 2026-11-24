import { useState } from 'react';
import type { Language } from '../../i18n/locale.ts';
import { NameForm } from './NameForm.tsx';
import { organizationMessages } from './locale.ts';
import type { OrganizationLabels } from './locale.ts';
import { useOrganization } from './useOrganization.ts';
import type { Branch, Department } from './useOrganization.ts';

type Action = { kind: 'createBranch' } | { kind: 'renameBranch'; branch: Branch }
  | { kind: 'createDepartment'; branch: Branch } | { kind: 'renameDepartment'; department: Department; branch: Branch };
function errorText(error: string, labels: OrganizationLabels) {
  const keys: Record<string, keyof OrganizationLabels> = {
    ORG_INVALID_INPUT: 'invalidInput', ORG_BRANCH_NOT_FOUND: 'branchNotFound', ORG_DEPARTMENT_NOT_FOUND: 'departmentNotFound',
    ORG_CONFLICT: 'conflict', ORG_UNAVAILABLE: 'requestFailed', ORG_UNCERTAIN: 'uncertain', ORG_REFRESH_FAILED: 'refreshFailed',
    AUTH_REQUIRED: 'sessionExpired', AUTH_FORBIDDEN: 'forbidden', AUTH_CSRF: 'csrfFailed', AUTH_RATE_LIMITED: 'rateLimited', AUTH_UNAVAILABLE: 'requestFailed',
  };
  return labels[keys[error] ?? 'requestFailed'];
}

export function OrganizationScreen({ language, canWrite, verificationPending, onSessionInvalid, foregroundActions }: {
  language: Language; canWrite: boolean; verificationPending: boolean; onSessionInvalid: () => void;
  foregroundActions: { begin: () => boolean; end: (options?: { skipQueuedRefresh?: boolean }) => void };
}) {
  const labels = organizationMessages[language];
  const organization = useOrganization(onSessionInvalid, foregroundActions);
  const [action, setAction] = useState<Action | null>(null);
  const { branches, departments, selectedBranch, loadingBranches, loadingDepartments, pending, error, notice, reviewRequired } = organization;
  const blocked = pending || verificationPending || loadingBranches || loadingDepartments;
  const writesBlocked = blocked || reviewRequired || !canWrite;
  const begin = (next: Action) => { organization.clearFeedback(); setAction(next); };
  const refresh = () => { setAction(null); void organization.refresh(); };
  const branchForm = action?.kind === 'createBranch' || action?.kind === 'renameBranch';
  const departmentForm = action?.kind === 'createDepartment' || action?.kind === 'renameDepartment';
  const form = action && canWrite ? (
    <NameForm key={action.kind === 'createBranch' ? 'create-branch' : action.kind === 'renameBranch' ? `branch-${action.branch.id}:${action.branch.version}` : action.kind === 'createDepartment' ? `new-department-${action.branch.id}` : `department-${action.department.id}:${action.department.version}`}
      title={action.kind === 'createBranch' ? labels.addBranch : action.kind === 'renameBranch' ? labels.renameBranch : action.kind === 'createDepartment' ? labels.addDepartment : labels.renameDepartment}
      fieldLabel={branchForm ? labels.branchName : labels.departmentName}
      initialName={action.kind === 'renameBranch' ? action.branch.name : action.kind === 'renameDepartment' ? action.department.name : ''}
      branchName={action.kind === 'createDepartment' || action.kind === 'renameDepartment' ? action.branch.name : undefined}
      labels={labels} disabled={writesBlocked} pending={pending} onCancel={() => setAction(null)}
      onSave={name => action.kind === 'createBranch' ? organization.createBranch(name)
        : action.kind === 'renameBranch' ? organization.renameBranch(action.branch, name)
        : action.kind === 'createDepartment' ? organization.createDepartment(action.branch, name)
        : organization.renameDepartment(action.department, name)} />
  ) : null;
  return (
    <section className="w-full min-w-0" aria-labelledby="organization-heading">
      <h2 id="organization-heading" className="card-title">{labels.heading}</h2>
      <p className="card-description">{labels.description}</p>
      {!canWrite && <p className="mt-4 text-sm leading-7 text-muted">{labels.readOnly}</p>}
      {error && <p className="feedback feedback-error" role="alert">{errorText(error, labels)}</p>}
      {notice && <p className="feedback feedback-success" role="status">{labels[notice.kind]} {notice.name && <bdi className="break-words">{notice.name}</bdi>}</p>}
      {reviewRequired && <p className="mt-4 text-sm leading-7 text-muted" role="status">{labels.reviewRequired}</p>}
      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" className="control" disabled={blocked} onClick={refresh}>{labels.refresh}</button>
        {canWrite && <button type="button" className="primary-button" disabled={writesBlocked} onClick={() => begin({ kind: 'createBranch' })}>{labels.addBranch}</button>}
      </div>
      {branchForm && <div className="mt-6 max-w-2xl">{form}</div>}
      <div className="mt-7 grid min-w-0 gap-8 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <section className="min-w-0" aria-labelledby="organization-branches-heading">
          <h3 id="organization-branches-heading" className="text-lg font-bold">{labels.branches}</h3>
          <p className="mt-3 text-xs text-muted">{labels.page} {organization.branchPage.toLocaleString(language)}</p>
          {loadingBranches ? <p className="py-6 text-sm text-muted" role="status">{labels.loadingBranches}</p> : !branches.length ? <p className="py-6 text-sm text-muted">{labels.emptyBranches}</p> : (
            <ul className="mt-4 grid min-w-0 gap-3">{branches.map(branch => (
              <li key={branch.id} className="min-w-0 rounded-xl border border-line p-3">
                <button type="button" className={`control w-full min-w-0 break-words text-start ${selectedBranch?.id === branch.id ? 'bg-brand/8' : ''}`} aria-pressed={selectedBranch?.id === branch.id} disabled={blocked} onClick={() => {
                  if (action?.kind === 'createDepartment' || action?.kind === 'renameDepartment'
                    || (action?.kind === 'renameBranch' && action.branch.id !== branch.id)) setAction(null);
                  organization.selectBranch(branch);
                }}><bdi>{branch.name}</bdi></button>
                {canWrite && <button type="button" className="control mt-3 w-full text-sm" disabled={writesBlocked} onClick={() => begin({ kind: 'renameBranch', branch })}>{labels.renameBranch}</button>}
              </li>
            ))}</ul>
          )}
          <nav className="mt-4 flex flex-wrap justify-between gap-3" aria-label={labels.branches}>
            <button type="button" className="control" disabled={blocked || !organization.hasPreviousBranch} onClick={() => { setAction(null); organization.previousBranch(); }}>{labels.previous}</button>
            <button type="button" className="control" disabled={blocked || !organization.hasNextBranch} onClick={() => { setAction(null); organization.nextBranch(); }}>{labels.next}</button>
          </nav>
        </section>
        <section className="min-w-0" aria-labelledby="organization-departments-heading">
          <h3 id="organization-departments-heading" className="text-lg font-bold">{labels.departments}</h3>
          {!selectedBranch ? <p className="py-6 text-sm text-muted">{labels.chooseBranch}</p> : <>
            <p className="mt-4 break-words text-sm leading-7">{labels.selectedBranch}: <strong><bdi>{selectedBranch.name}</bdi></strong></p>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              {canWrite && <div className="flex min-w-0 flex-wrap gap-3">
                <button type="button" className="primary-button" disabled={writesBlocked} onClick={() => begin({ kind: 'createDepartment', branch: selectedBranch })}>{labels.addDepartment}</button>
                <button type="button" className="control" disabled={writesBlocked} onClick={() => begin({ kind: 'renameBranch', branch: selectedBranch })}>{labels.renameBranch}</button>
              </div>}
              <p className="text-xs text-muted">{labels.page} {organization.departmentPage.toLocaleString(language)}</p>
            </div>
            {departmentForm && <div className="mt-5">{form}</div>}
            {loadingDepartments ? <p className="py-6 text-sm text-muted" role="status">{labels.loadingDepartments}</p> : !departments.length ? <p className="py-6 text-sm text-muted">{labels.emptyDepartments}</p> : (
              <ul className="mt-5 grid min-w-0 gap-3">{departments.map(department => (
                <li key={department.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-4">
                  <bdi className="min-w-0 break-words text-sm font-semibold">{department.name}</bdi>
                  {canWrite && <button type="button" className="control text-sm" disabled={writesBlocked} onClick={() => begin({ kind: 'renameDepartment', department, branch: selectedBranch })}>{labels.renameDepartment}</button>}
                </li>
              ))}</ul>
            )}
            <nav className="mt-5 flex flex-wrap justify-between gap-3" aria-label={labels.departments}>
              <button type="button" className="control" disabled={blocked || !organization.hasPreviousDepartment} onClick={() => { setAction(null); organization.previousDepartment(); }}>{labels.previous}</button>
              <button type="button" className="control" disabled={blocked || !organization.hasNextDepartment} onClick={() => { setAction(null); organization.nextDepartment(); }}>{labels.next}</button>
            </nav>
          </>}
        </section>
      </div>
    </section>
  );
}
