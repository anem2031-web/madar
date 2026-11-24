import type { AuditDeliveryStatus } from '../../../../shared/audit/contracts.ts';
import type { Language } from '../../i18n/locale.ts';
import { Identifier } from './AuditDetails.tsx';
import { formatAuditTime } from './filters.ts';
import type { AuditLabels } from './locale.ts';

function failureLabel(code: string, labels: AuditLabels) {
  return code === 'AUDIT_UNSAFE_EVENT' ? labels.failureSource : code === 'AUDIT_EVENT_CONFLICT' ? labels.failureMismatch : labels.failureOther;
}
export function DeliverySummary({ delivery, language, labels }: { delivery: AuditDeliveryStatus; language: Language; labels: AuditLabels }) {
  const counts = [
    { label: labels.pending, value: delivery.pending }, { label: labels.leased, value: delivery.leased }, { label: labels.failedDelivery, value: delivery.failed },
  ];
  return <section className="min-w-0 rounded-2xl border border-line p-4 sm:p-6" aria-labelledby="audit-delivery-heading">
    <h3 id="audit-delivery-heading" className="text-lg font-bold">{labels.delivery}</h3>
    <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-3">{counts.map(count => <div key={count.label} className="rounded-xl bg-slate-50 p-4"><p className="text-xs leading-6 text-muted">{count.label}</p><p className="mt-2 text-xl font-bold">{count.value.toLocaleString(language)}</p></div>)}</div>
    <p className="mt-4 text-sm leading-7">{labels.oldestPending}: {formatAuditTime(delivery.oldestPendingAt, language, labels.notRecorded)}</p>
    <p className="field-hint mt-2">{labels.deliveryHint}</p>
    <h4 className="mt-5 font-semibold">{labels.failedSample}</h4>
    {!delivery.failures.length ? <p className="mt-2 text-sm leading-7 text-muted">{labels.noFailures}</p> : <ul className="mt-3 grid min-w-0 gap-3">{delivery.failures.slice(0, 10).map(failure => <li key={failure.eventId} className="min-w-0 rounded-xl border border-line p-3 text-sm leading-7"><Identifier value={failure.eventId} labels={labels} /><p className="mt-1 text-xs text-muted">{formatAuditTime(failure.occurredAt, language, labels.notRecorded)}</p><p>{failureLabel(failure.errorCode, labels)}</p></li>)}</ul>}
  </section>;
}
