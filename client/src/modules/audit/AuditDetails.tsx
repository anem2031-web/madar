import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { AuditEventDetail, AuditMetadata, AuditValues } from '../../../../shared/audit/contracts.ts';
import { isPermissionCode } from '../../../../shared/permissions/catalog.ts';
import { numberingFormat } from '../../../../shared/numbering/settings.ts';
import type { Language } from '../../i18n/locale.ts';
import { permissionLabelKeys, permissionMessages } from '../permission-overrides/locale.ts';
import { actionLabel, moduleLabel, reasonLabel, roleLabel } from './locale.ts';
import type { AuditLabels } from './locale.ts';
import { formatAuditTime, isIdentifier } from './filters.ts';

export function Identifier({ value, labels }: { value: string | null | undefined; labels: AuditLabels }) {
  return <bdi dir="ltr" className="break-all">{value && isIdentifier(value) ? value : labels.notRecorded}</bdi>;
}
const booleanValue = (value: unknown, labels: AuditLabels) => value === true ? labels.yes : value === false ? labels.no : labels.notRecorded;
const textValue = (value: unknown, labels: AuditLabels) => typeof value === 'string' ? <bdi className="break-words">{value}</bdi> : labels.notRecorded;
const numericValue = (value: unknown, language: Language, labels: AuditLabels) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(language) : labels.notRecorded;

function ValueRows({ values, language, labels }: { values: AuditValues | null; language: Language; labels: AuditLabels }) {
  if (!values) return <p className="mt-3 text-sm text-muted">{labels.noValues}</p>;
  const rows: { key: string; label: string; value: ReactNode }[] = [];
  const add = (key: keyof AuditValues, label: keyof AuditLabels, value: ReactNode) => {
    if (Object.hasOwn(values, key)) rows.push({ key, label: labels[label], value });
  };
  add('roleId', 'fieldRoleId', <Identifier value={values.roleId} labels={labels} />);
  add('accountStatus', 'fieldAccountStatus', values.accountStatus === 'active' ? labels.active : values.accountStatus === 'disabled' ? labels.disabled : labels.notRecorded);
  add('mustChangePassword', 'fieldMustChange', booleanValue(values.mustChangePassword, labels));
  add('authVersion', 'fieldAuthVersion', numericValue(values.authVersion, language, labels));
  add('name', 'fieldName', textValue(values.name, labels));
  add('branchId', 'fieldBranchId', <Identifier value={values.branchId} labels={labels} />);
  add('version', 'fieldVersion', numericValue(values.version, language, labels));
  add('code', 'fieldCode', textValue(values.code, labels));
  add('prefix', 'fieldPrefix', textValue(values.prefix, labels));
  add('format', 'fieldFormat', values.format === numberingFormat ? labels.friendlyFormat : textValue(values.format, labels));
  add('paddingWidth', 'fieldPadding', numericValue(values.paddingWidth, language, labels));
  add('resetPolicy', 'fieldReset', values.resetPolicy === 'annual' ? labels.annual : values.resetPolicy === 'continuous' ? labels.continuous : labels.notRecorded);
  add('enabled', 'fieldEnabled', booleanValue(values.enabled, labels));
  add('overrides', 'fieldOverrides', Array.isArray(values.overrides) ? values.overrides.length ? <ul className="grid min-w-0 gap-2">{values.overrides.map((value, index) => (
    <li key={index} className="text-sm leading-7">{isPermissionCode(value.permissionCode) ? permissionMessages[language][permissionLabelKeys[value.permissionCode]] : labels.unknownPermission}: {value.effect === 'grant' ? labels.grant : value.effect === 'deny' ? labels.deny : labels.unknown}</li>
  ))}</ul> : labels.noValues : labels.notRecorded);
  return rows.length ? <dl className="mt-3 grid min-w-0 gap-4">{rows.map(row => <div key={row.key} className="min-w-0"><dt className="text-xs leading-6 text-muted">{row.label}</dt><dd className="mt-1 min-w-0 break-words text-sm leading-7">{row.value}</dd></div>)}</dl> : <p className="mt-3 text-sm text-muted">{labels.noValues}</p>;
}
function MetadataRows({ metadata, language, labels }: { metadata: AuditMetadata | null; language: Language; labels: AuditLabels }) {
  if (!metadata || (metadata.count === undefined && metadata.changed === undefined && metadata.operationId === undefined && metadata.replayed === undefined && metadata.entityType === undefined && !metadata.filterTypes?.length)) return <p className="mt-3 text-sm text-muted">{labels.noValues}</p>;
  const filterNames: Record<string, string> = { period: labels.period, actorUserId: labels.actorUserId, module: labels.module, result: labels.result };
  return <dl className="mt-3 grid min-w-0 gap-4">
    {metadata.count !== undefined && <div><dt className="text-xs text-muted">{labels.fieldCount}</dt><dd className="mt-1 text-sm">{numericValue(metadata.count, language, labels)}</dd></div>}
    {metadata.changed !== undefined && <div><dt className="text-xs text-muted">{labels.fieldChanged}</dt><dd className="mt-1 text-sm">{booleanValue(metadata.changed, labels)}</dd></div>}
    {metadata.operationId !== undefined && <div className="min-w-0"><dt className="text-xs text-muted">{labels.fieldOperationId}</dt><dd className="mt-1 min-w-0 text-sm"><Identifier value={metadata.operationId} labels={labels} /></dd></div>}
    {metadata.replayed !== undefined && <div><dt className="text-xs text-muted">{labels.fieldReplayed}</dt><dd className="mt-1 text-sm">{booleanValue(metadata.replayed, labels)}</dd></div>}
    {metadata.entityType !== undefined && <div><dt className="text-xs text-muted">{labels.fieldEntityType}</dt><dd className="mt-1 text-sm">{metadata.entityType === 'branch' ? labels.branch : metadata.entityType === 'department' ? labels.department : labels.unknown}</dd></div>}
    {metadata.filterTypes && <div><dt className="text-xs text-muted">{labels.fieldFilterTypes}</dt><dd className="mt-1 text-sm leading-7">{metadata.filterTypes.map(value => filterNames[value] ?? labels.unknown).join(language === 'ar' ? '، ' : ', ')}</dd></div>}
  </dl>;
}

export function AuditDetails({ event, language, labels, disabled, onClose }: {
  event: AuditEventDetail; language: Language; labels: AuditLabels; disabled: boolean; onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [event.eventId]);
  const fields: { label: string; value: ReactNode }[] = [
    { label: labels.eventId, value: <Identifier value={event.eventId} labels={labels} /> },
    { label: labels.occurredAt, value: formatAuditTime(event.occurredAt, language, labels.notRecorded) },
    { label: labels.actor, value: <Identifier value={event.actorUserId} labels={labels} /> },
    { label: labels.role, value: roleLabel(event.actorRoleCode, labels) },
    { label: labels.actorRoleId, value: <Identifier value={event.actorRoleId} labels={labels} /> },
    { label: labels.module, value: moduleLabel(event.module, labels) },
    { label: labels.action, value: actionLabel(event.action, labels) },
    { label: labels.result, value: event.result === 'success' ? labels.success : event.result === 'denied' ? labels.denied : event.result === 'failed' ? labels.failed : labels.unknown },
    { label: labels.reason, value: reasonLabel(event.reasonCode, labels) },
    { label: labels.entityId, value: <Identifier value={event.entityId} labels={labels} /> },
    { label: labels.entityVersion, value: numericValue(event.entityVersion, language, labels) },
    { label: labels.requestId, value: <Identifier value={event.requestId} labels={labels} /> },
  ];
  return <section className="min-w-0 rounded-2xl border border-line p-4 sm:p-6" aria-labelledby="audit-detail-heading">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 ref={heading} tabIndex={-1} id="audit-detail-heading" className="text-lg font-bold outline-none">{labels.detail}</h3><button type="button" className="control" disabled={disabled} onClick={onClose}>{labels.closeDetails}</button></div>
    <dl className="mt-5 grid min-w-0 gap-5 sm:grid-cols-2">{fields.map(field => <div key={field.label} className="min-w-0"><dt className="text-xs leading-6 text-muted">{field.label}</dt><dd className="mt-1 min-w-0 break-words text-sm leading-7">{field.value}</dd></div>)}</dl>
    <div className="mt-7 grid min-w-0 gap-6 lg:grid-cols-2"><section className="min-w-0 rounded-xl border border-line p-4"><h4 className="font-semibold">{labels.before}</h4><ValueRows values={event.beforeValues} language={language} labels={labels} /></section><section className="min-w-0 rounded-xl border border-line p-4"><h4 className="font-semibold">{labels.after}</h4><ValueRows values={event.afterValues} language={language} labels={labels} /></section></div>
    <section className="mt-6 min-w-0"><h4 className="font-semibold">{labels.metadata}</h4><MetadataRows metadata={event.metadata} language={language} labels={labels} /></section>
  </section>;
}
