import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { auditModules, auditResults } from '../../../../shared/audit/contracts.ts';
import type { AuditModule, AuditResult } from '../../../../shared/audit/contracts.ts';
import type { Language } from '../../i18n/locale.ts';
import type { AccessFailureHandlers } from '../auth/access-failures.ts';
import { AuditDetails, Identifier } from './AuditDetails.tsx';
import { DeliverySummary } from './DeliverySummary.tsx';
import { actionLabel, auditMessages, moduleLabel, reasonLabel, roleLabel } from './locale.ts';
import type { AuditLabels } from './locale.ts';
import { auditDraftFromFilters, defaultAuditDraft, formatAuditTime, isIdentifier, normalizeAuditFilters, readAuditSubmission } from './filters.ts';
import type { AuditFilterDraft } from './filters.ts';
import { useAudit } from './useAudit.ts';
import { RequestFailure } from '../../components/feedback/RequestFailure.tsx';

function errorLabel(value: string, labels: AuditLabels) {
  const keys: Record<string, keyof AuditLabels> = {
    AUDIT_INVALID_INPUT: 'invalidInput', AUDIT_NOT_FOUND: 'notFound', AUDIT_UNAVAILABLE: 'requestFailed',
    AUTH_REQUIRED: 'sessionExpired', AUTH_FORBIDDEN: 'forbidden', AUTH_CSRF: 'csrfFailed', AUTH_RATE_LIMITED: 'rateLimited', AUTH_UNAVAILABLE: 'requestFailed',
  };
  return labels[keys[value] ?? 'requestFailed'];
}
export function AuditScreen({ language, verificationPending, accessHandlers }: {
  language: Language; verificationPending: boolean; accessHandlers: AccessFailureHandlers;
}) {
  const labels = auditMessages[language];
  const audit = useAudit(accessHandlers);
  const [draft, setDraft] = useState<AuditFilterDraft>(audit.initialDraft);
  const [validation, setValidation] = useState<'invalidPeriod' | 'invalidIdentifier' | null>(null);
  const [customPeriod, setCustomPeriod] = useState(false);
  const [eventId, setEventId] = useState('');
  const [lookupInvalid, setLookupInvalid] = useState(false);
  const blocked = verificationPending || audit.loading;
  const detailBlocked = blocked || audit.detailLoading;
  useEffect(() => { setDraft(auditDraftFromFilters(audit.filters)); setCustomPeriod(!audit.rolling); }, [audit.filters, audit.rolling]);
  const apply = (next: AuditFilterDraft, rolling: boolean) => {
    const normalized = normalizeAuditFilters(next);
    if ('error' in normalized) { setValidation(normalized.error); return; }
    setValidation(null); audit.apply(normalized.filters, rolling);
  };
  const submitFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (blocked) return;
    const submitted = readAuditSubmission(new FormData(event.currentTarget), draft, audit.filters, audit.rolling, customPeriod);
    setDraft(submitted.draft);
    if ('error' in submitted) { setValidation(submitted.error); return; }
    setValidation(null); setCustomPeriod(!submitted.rolling); audit.apply(submitted.filters, submitted.rolling);
  };
  const editDate = (field: 'from' | 'to', value: string) => { setDraft(draft => ({ ...draft, [field]: value })); setCustomPeriod(true); setValidation(null); };
  const lookup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (detailBlocked) return;
    const identifier = eventId.trim();
    if (!isIdentifier(identifier)) { setLookupInvalid(true); return; }
    setLookupInvalid(false); void audit.openDetail(identifier.toLowerCase());
  };
  return <section className="w-full min-w-0" aria-labelledby="audit-heading">
    <h2 id="audit-heading" className="card-title">{labels.heading}</h2><p className="card-description">{labels.description}</p>
    <form className="mt-6 min-w-0 rounded-2xl border border-line p-4 sm:p-6" aria-label={labels.filters} onSubmit={submitFilters} noValidate>
      <fieldset disabled={blocked} className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="sr-only">{labels.filters}</legend>
        <label className="field min-w-0" htmlFor="audit-from"><span>{labels.from}</span><input id="audit-from" name="from" className="min-w-0" dir="ltr" type="datetime-local" step="1" value={draft.from} onChange={event => editDate('from', event.currentTarget.value)} onInput={event => editDate('from', event.currentTarget.value)} aria-invalid={validation === 'invalidPeriod' || undefined} aria-describedby={validation === 'invalidPeriod' ? 'audit-period-help audit-filter-error' : 'audit-period-help'} /></label>
        <label className="field min-w-0" htmlFor="audit-to"><span>{labels.to}</span><input id="audit-to" name="to" className="min-w-0" dir="ltr" type="datetime-local" step="1" value={draft.to} onChange={event => editDate('to', event.currentTarget.value)} onInput={event => editDate('to', event.currentTarget.value)} aria-invalid={validation === 'invalidPeriod' || undefined} aria-describedby={validation === 'invalidPeriod' ? 'audit-period-help audit-filter-error' : 'audit-period-help'} /></label>
        <label className="field min-w-0" htmlFor="audit-module"><span>{labels.module}</span><select id="audit-module" value={draft.module} onChange={event => setDraft(value => ({ ...value, module: event.target.value as AuditModule | '' }))}><option value="">{labels.all}</option>{auditModules.map(value => <option key={value} value={value}>{moduleLabel(value, labels)}</option>)}</select></label>
        <label className="field min-w-0" htmlFor="audit-result"><span>{labels.result}</span><select id="audit-result" value={draft.result} onChange={event => setDraft(value => ({ ...value, result: event.target.value as AuditResult | '' }))}><option value="">{labels.all}</option>{auditResults.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label>
        <label className="field min-w-0 sm:col-span-2" htmlFor="audit-actor"><span>{labels.actorUserId}</span><input id="audit-actor" name="actor" dir="ltr" autoComplete="off" autoCapitalize="none" spellCheck={false} value={draft.actorUserId} onChange={event => { setDraft(value => ({ ...value, actorUserId: event.target.value })); setValidation(null); }} aria-invalid={validation === 'invalidIdentifier' || undefined} aria-describedby={validation === 'invalidIdentifier' ? 'audit-actor-help audit-filter-error' : 'audit-actor-help'} /></label>
        <div className="min-w-0 sm:col-span-2 lg:col-span-3"><p className="field-hint" id="audit-period-help">{labels.periodHint}</p><p className="field-hint mt-2" id="audit-actor-help">{labels.actorHint}</p>{validation && <p id="audit-filter-error" className="feedback feedback-error" role="alert">{labels[validation]}</p>}<div className="mt-4 flex flex-wrap gap-3"><button className="primary-button" type="submit">{labels.apply}</button><button className="control" type="button" onClick={() => { const next = { ...draft, ...defaultAuditDraft(), actorUserId: draft.actorUserId, module: draft.module, result: draft.result }; setDraft(next); setCustomPeriod(false); apply(next, true); }}>{labels.lastSeven}</button></div></div>
      </fieldset>
    </form>
    {audit.error && <RequestFailure message={errorLabel(audit.error, labels)} code={audit.error} requestId={audit.errorRequestId} language={language} />}
    <div className="mt-5 flex min-w-0 flex-wrap items-center justify-between gap-3"><button type="button" className="control" disabled={blocked} onClick={audit.refresh}>{labels.refresh}</button><p className="text-xs text-muted">{labels.page} {audit.page.toLocaleString(language)}</p></div>
    <p className="mt-4 text-xs leading-7 text-muted">{labels.displayedPeriod}: <time dateTime={audit.filters.from}>{formatAuditTime(audit.filters.from, language, labels.notRecorded)}</time> — <time dateTime={audit.filters.to}>{formatAuditTime(audit.filters.to, language, labels.notRecorded)}</time></p>
    <p className="mt-1 text-xs leading-7 text-muted">{audit.rolling ? labels.rollingPeriod : labels.fixedPeriod}</p>
    {audit.loading ? <p role="status" className="py-8 text-sm text-muted">{labels.loading}</p> : !audit.events.length ? <p className="py-8 text-sm text-muted">{labels.empty}</p> : <div className="mt-5 max-w-full min-w-0 overflow-x-auto rounded-xl border border-line" role="region" aria-label={labels.list} tabIndex={0}>
      <table className="w-full min-w-[64rem] border-collapse text-start text-sm"><caption className="sr-only">{labels.list}</caption><thead className="bg-slate-50"><tr>{[labels.occurredAt, labels.actor, labels.module, labels.action, labels.result, labels.eventId, labels.viewDetails].map(label => <th key={label} scope="col" className="whitespace-nowrap border-b border-line p-3 text-start text-xs font-semibold">{label}</th>)}</tr></thead><tbody>{audit.events.map(event => <tr key={event.eventId} className="align-top">
        <td className="max-w-[11rem] border-b border-line p-3 leading-7"><time dateTime={event.occurredAt}>{formatAuditTime(event.occurredAt, language, labels.notRecorded)}</time></td>
        <td className="max-w-[13rem] border-b border-line p-3"><Identifier value={event.actorUserId} labels={labels} /><p className="mt-2 text-xs text-muted">{roleLabel(event.actorRoleCode, labels)}</p></td>
        <td className="max-w-[10rem] border-b border-line p-3 leading-7">{moduleLabel(event.module, labels)}</td>
        <td className="max-w-[14rem] border-b border-line p-3 leading-7">{actionLabel(event.action, labels)}</td>
        <td className="max-w-[12rem] border-b border-line p-3 leading-7"><strong className={event.result === 'success' ? 'text-brand' : 'text-danger'}>{auditResults.includes(event.result) ? labels[event.result] : labels.unknown}</strong>{event.reasonCode && <p className="mt-1 text-xs leading-6 text-muted">{reasonLabel(event.reasonCode, labels)}</p>}</td>
        <td className="max-w-[13rem] border-b border-line p-3"><Identifier value={event.eventId} labels={labels} /></td>
        <td className="border-b border-line p-3"><button className="control" type="button" disabled={detailBlocked || !isIdentifier(event.eventId)} onClick={() => { setLookupInvalid(false); void audit.openDetail(event.eventId); }}>{labels.viewDetails}</button></td>
      </tr>)}</tbody></table>
    </div>}
    <nav className="mt-5 flex flex-wrap justify-between gap-3" aria-label={labels.list}><button type="button" className="control" disabled={blocked || !audit.hasPrevious} onClick={audit.previous}>{labels.previous}</button><button type="button" className="control" disabled={blocked || !audit.hasNext} onClick={audit.next}>{labels.next}</button></nav>
    <form className="mt-7 min-w-0 rounded-2xl border border-line p-4 sm:p-6" aria-label={labels.lookup} onSubmit={lookup} noValidate><fieldset className="grid min-w-0 gap-4" disabled={detailBlocked}><legend className="sr-only">{labels.lookup}</legend><label className="field min-w-0" htmlFor="audit-event-id"><span>{labels.eventId}</span><input id="audit-event-id" dir="ltr" autoComplete="off" autoCapitalize="none" spellCheck={false} value={eventId} onChange={event => { setEventId(event.target.value); setLookupInvalid(false); }} aria-invalid={lookupInvalid || undefined} aria-describedby="audit-event-help" /></label><p id="audit-event-help" className="field-hint">{labels.lookupHint}</p>{lookupInvalid && <p className="feedback feedback-error" role="alert">{labels.invalidIdentifier}</p>}<button type="submit" className="control justify-self-start">{labels.openEvent}</button></fieldset></form>
    {audit.detailError && <RequestFailure message={errorLabel(audit.detailError, labels)} code={audit.detailError} requestId={audit.detailErrorRequestId} language={language} />}
    {audit.detailLoading && <p className="py-6 text-sm text-muted" role="status">{labels.loadingDetail}</p>}
    {audit.detail && <div className="mt-6 min-w-0"><AuditDetails event={audit.detail} language={language} labels={labels} disabled={verificationPending} onClose={audit.closeDetail} /></div>}
    {audit.delivery && <div className="mt-7 min-w-0"><DeliverySummary delivery={audit.delivery} language={language} labels={labels} /></div>}
  </section>;
}
