import { useState } from 'react';
import type { NumberingSeries } from '../../../../../shared/numbering/settings.ts';
import type { Language } from '../../../i18n/locale.ts';
import type { AccessFailureHandlers } from '../../auth/access-failures.ts';
import { numberingMessages } from './locale.ts';
import { RequestFailure } from '../../../components/feedback/RequestFailure.tsx';
import type { NumberingLabels } from './locale.ts';
import { displayFormat, exampleNumber, SeriesForm } from './SeriesForm.tsx';
import { useNumberingSettings } from './useNumberingSettings.ts';

function errorText(error: string, labels: NumberingLabels) {
  const keys: Record<string, keyof NumberingLabels> = {
    NUMBERING_INVALID_INPUT: 'invalidInput', NUMBERING_INVALID_PREFIX: 'invalidPrefix',
    NUMBERING_DUPLICATE_CODE: 'duplicateCode', NUMBERING_DUPLICATE_PREFIX: 'duplicatePrefix',
    NUMBERING_NOT_FOUND: 'notFound', NUMBERING_CONFLICT: 'conflict', NUMBERING_LOCKED: 'lockedError',
    NUMBERING_UNAVAILABLE: 'requestFailed', NUMBERING_UNCERTAIN: 'uncertain', NUMBERING_REFRESH_FAILED: 'refreshFailed',
    AUTH_REQUIRED: 'sessionExpired', AUTH_FORBIDDEN: 'forbidden', AUTH_CSRF: 'csrfFailed',
    AUTH_RATE_LIMITED: 'rateLimited', AUTH_UNAVAILABLE: 'requestFailed',
  };
  return labels[keys[error] ?? 'requestFailed'];
}

function SeriesDetails({ series, calendarYear, labels }: { series: NumberingSeries; calendarYear: number | null; labels: NumberingLabels }) {
  const preview = exampleNumber(series.prefix, calendarYear, series.format, series.paddingWidth);
  return (
    <div className="min-w-0 rounded-2xl border border-line p-4 sm:p-6">
      <h3 className="text-lg font-bold">{labels.selected}: <bdi className="break-all">{series.code}</bdi></h3>
      <dl className="account-details mt-4">
        <div><dt>{labels.prefix}</dt><dd><bdi>{series.prefix}</bdi></dd></div>
        <div><dt>{labels.resetPolicy}</dt><dd>{series.resetPolicy === 'annual' ? labels.annual : labels.continuous}</dd></div>
        <div><dt>{labels.format}</dt><dd className="min-w-0 break-all"><bdi>{displayFormat(series.format, labels)}</bdi></dd></div>
        <div><dt>{labels.padding}</dt><dd dir="ltr">{series.paddingWidth}</dd></div>
      </dl>
      <p className="mt-4 text-sm">{series.enabled ? labels.active : labels.inactive} · {series.hasIssued ? labels.issued : labels.unissued}</p>
      {series.hasIssued && <p className="mt-3 text-sm leading-7 text-muted">{labels.locked}</p>}
      <p className="mt-5 text-sm font-semibold">{labels.preview}</p>
      <p className="mt-2 break-all text-lg font-bold text-brand" dir={preview ? 'ltr' : undefined}>{preview ?? labels.previewUnavailable}</p>
      <p className="field-hint mt-2">{labels.previewHelp}</p>
    </div>
  );
}

export function NumberingScreen({ language, verificationPending, accessHandlers, foregroundActions }: {
  language: Language; verificationPending: boolean; accessHandlers: AccessFailureHandlers;
  foregroundActions: { begin: () => boolean; end: (options?: { skipQueuedRefresh?: boolean }) => void };
}) {
  const labels = numberingMessages[language];
  const numbering = useNumberingSettings(accessHandlers, foregroundActions);
  const [editor, setEditor] = useState<'create' | NumberingSeries | null>(null);
  const { series, selected, calendarYear, loading, pending, error, notice, reviewRequired } = numbering;
  const blocked = pending || verificationPending || loading;
  const writesBlocked = blocked || reviewRequired;
  const refresh = () => { setEditor(null); void numbering.refresh(); };
  return (
    <section className="w-full min-w-0" aria-labelledby="numbering-heading">
      <h2 id="numbering-heading" className="card-title">{labels.heading}</h2>
      <p className="card-description">{labels.description}</p>
      {error && <RequestFailure message={errorText(error, labels)} code={error} requestId={numbering.errorRequestId} language={language} />}
      {notice && <p className="feedback feedback-success" role="status">{labels[notice.kind]} {notice.code && <bdi>{notice.code}</bdi>}</p>}
      {reviewRequired && <p className="mt-4 text-sm leading-7 text-muted" role="status">{labels.reviewRequired}</p>}
      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" className="control" disabled={blocked} onClick={refresh}>{labels.refresh}</button>
        <button type="button" className="primary-button" disabled={writesBlocked} onClick={() => { numbering.clearFeedback(); setEditor('create'); }}>{labels.add}</button>
      </div>
      <div className="mt-7 grid min-w-0 gap-8 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <section className="min-w-0" aria-labelledby="numbering-series-heading">
          <h3 id="numbering-series-heading" className="text-lg font-bold">{labels.list}</h3>
          <p className="mt-3 text-xs text-muted">{labels.page} {numbering.page.toLocaleString(language)}</p>
          {loading ? <p className="py-6 text-sm text-muted" role="status">{labels.loading}</p> : !series.length ? <p className="py-6 text-sm text-muted">{labels.empty}</p> : (
            <ul className="mt-4 grid min-w-0 gap-3">{series.map(value => <li key={value.id} className="min-w-0">
              <button type="button" className={`control grid w-full min-w-0 gap-2 p-3 text-start ${selected?.id === value.id ? 'bg-brand/8' : ''}`} aria-pressed={selected?.id === value.id} disabled={blocked} onClick={() => { setEditor(null); numbering.select(value); }}>
                <bdi className="break-all text-sm font-semibold">{value.code}</bdi>
                <span className="text-xs"><bdi>{value.prefix}</bdi> · {value.enabled ? labels.active : labels.inactive}</span>
                <span className="text-xs leading-6 text-muted">{value.hasIssued ? labels.issued : labels.unissued}</span>
              </button>
            </li>)}</ul>
          )}
          <nav className="mt-4 flex flex-wrap justify-between gap-3" aria-label={labels.list}>
            <button type="button" className="control" disabled={blocked || !numbering.hasPrevious} onClick={() => { setEditor(null); numbering.previous(); }}>{labels.previous}</button>
            <button type="button" className="control" disabled={blocked || !numbering.hasNext} onClick={() => { setEditor(null); numbering.next(); }}>{labels.next}</button>
          </nav>
        </section>
        <div className="min-w-0">
          {editor ? <SeriesForm key={editor === 'create' ? 'create' : `${editor.id}:${editor.version}`} series={editor === 'create' ? undefined : editor}
            calendarYear={calendarYear} labels={labels} disabled={writesBlocked} pending={pending} onCancel={() => setEditor(null)}
            onSave={input => editor === 'create' ? numbering.create(input) : numbering.update({ seriesId: editor.id, expectedVersion: editor.version, prefix: input.prefix, resetPolicy: input.resetPolicy, enabled: input.enabled })} />
            : selected ? <>
              <SeriesDetails series={selected} calendarYear={calendarYear} labels={labels} />
              <button type="button" className="primary-button mt-4" disabled={writesBlocked} onClick={() => { numbering.clearFeedback(); setEditor(selected); }}>{labels.edit}</button>
            </> : <p className="py-6 text-sm text-muted">{labels.select}</p>}
        </div>
      </div>
    </section>
  );
}
