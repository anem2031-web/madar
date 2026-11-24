import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { numberingFormat, numberingPaddingWidth } from '../../../../../shared/numbering/settings.ts';
import type { CreateNumberingSeries, NumberingResetPolicy, NumberingSeries } from '../../../../../shared/numbering/settings.ts';
import type { NumberingLabels } from './locale.ts';

export function displayFormat(format: string, labels: NumberingLabels) {
  return format === numberingFormat ? labels.friendlyFormat : format;
}

export function exampleNumber(prefix: string, calendarYear: number | null, format: string, paddingWidth: number) {
  if (!prefix || calendarYear === null || format !== numberingFormat
    || !Number.isInteger(paddingWidth) || paddingWidth < 1 || paddingWidth > 32) return null;
  return `${prefix}-${calendarYear}-${'1'.padStart(paddingWidth, '0')}`;
}

export function SeriesForm({ series, calendarYear, labels, disabled, pending, onSave, onCancel }: {
  series?: NumberingSeries; calendarYear: number | null; labels: NumberingLabels; disabled: boolean; pending: boolean;
  onSave: (input: CreateNumberingSeries) => Promise<boolean>; onCancel: () => void;
}) {
  const [code, setCode] = useState(series?.code ?? '');
  const [prefix, setPrefix] = useState(series?.prefix ?? '');
  const [resetPolicy, setResetPolicy] = useState<NumberingResetPolicy>(series?.resetPolicy ?? 'annual');
  const [enabled, setEnabled] = useState(series?.enabled ?? true);
  const [validation, setValidation] = useState<'invalidCode' | 'invalidPrefix' | 'invalidInput' | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const locked = series?.hasIssued ?? false;
  const format = series?.format ?? numberingFormat;
  const paddingWidth = series?.paddingWidth ?? numberingPaddingWidth;
  const preview = exampleNumber(prefix, calendarYear, format, paddingWidth);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) return;
    const value = new FormData(event.currentTarget);
    const submittedCode = series?.code ?? String(value.get('numbering-code') ?? '').trim();
    const submittedPrefix = String(value.get('numbering-prefix') ?? prefix);
    if (!series && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(submittedCode)) { setValidation('invalidCode'); return; }
    // Existing settings remain byte-for-byte unchanged during an enabled-only edit.
    if ((!series || submittedPrefix !== series.prefix) && !/^[A-Z][a-z]{2}$/.test(submittedPrefix)) { setValidation('invalidPrefix'); return; }
    if (resetPolicy !== 'annual' && resetPolicy !== 'continuous') { setValidation('invalidInput'); return; }
    setValidation(null);
    if (await onSave({ code: submittedCode, prefix: submittedPrefix, resetPolicy, enabled })) onCancel();
  };
  return (
    <form className="auth-form rounded-2xl border border-line bg-slate-50 p-4 sm:p-6" aria-label={series ? labels.editHeading : labels.createHeading} onSubmit={submit} noValidate aria-busy={pending}>
      <h3 ref={heading} tabIndex={-1} className="text-lg font-bold outline-none">{series ? labels.editHeading : labels.createHeading}</h3>
      {locked && <p role="note" className="text-sm leading-7 text-muted">{labels.locked}</p>}
      <fieldset disabled={disabled} className="contents">
        <label className="field" htmlFor="numbering-code"><span>{labels.code}</span><input id="numbering-code" name="numbering-code" dir="ltr" autoComplete="off" autoCapitalize="none" spellCheck={false} value={code} readOnly={!!series} required onChange={event => { setCode(event.target.value); setValidation(null); }} aria-invalid={validation === 'invalidCode' || undefined} aria-describedby={validation === 'invalidCode' ? 'numbering-code-help numbering-error' : 'numbering-code-help'} /></label>
        <p className="field-hint" id="numbering-code-help">{labels.codeHint}</p>
        <label className="field" htmlFor="numbering-prefix"><span>{labels.prefix}</span><input id="numbering-prefix" name="numbering-prefix" dir="ltr" autoComplete="off" autoCapitalize="none" spellCheck={false} value={prefix} readOnly={locked} required onChange={event => { setPrefix(event.target.value); setValidation(null); }} aria-invalid={validation === 'invalidPrefix' || undefined} aria-describedby={validation === 'invalidPrefix' ? 'numbering-prefix-help numbering-error' : 'numbering-prefix-help'} /></label>
        <p className="field-hint" id="numbering-prefix-help">{labels.prefixHint}</p>
        <label className="field" htmlFor="numbering-policy"><span>{labels.resetPolicy}</span><select id="numbering-policy" value={resetPolicy} disabled={locked} onChange={event => { setResetPolicy(event.target.value as NumberingResetPolicy); setValidation(null); }}><option value="annual">{labels.annual}</option><option value="continuous">{labels.continuous}</option></select></label>
        <p className="field-hint">{labels.policyHint}</p>
        <label className="password-toggle"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />{labels.enabled}</label>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <label className="field min-w-0" htmlFor="numbering-format"><span>{labels.format}</span><input id="numbering-format" dir="auto" value={displayFormat(format, labels)} readOnly /></label>
          <label className="field min-w-0" htmlFor="numbering-padding"><span>{labels.padding}</span><input id="numbering-padding" dir="ltr" value={paddingWidth} readOnly /></label>
        </div>
        <p className="field-hint">{labels.fixedSettings}</p>
        <label className="field" htmlFor="numbering-year"><span>{labels.year}</span><input id="numbering-year" dir="ltr" value={calendarYear ?? '—'} readOnly /></label>
        <div className="min-w-0 rounded-xl border border-line bg-white p-4" aria-label={labels.preview}>
          <p className="text-sm font-semibold">{labels.preview}</p>
          <p className="mt-3 break-all text-lg font-bold text-brand" dir={preview ? 'ltr' : undefined}>{preview ?? labels.previewUnavailable}</p>
          <p className="mt-2 text-xs leading-6 text-muted">{labels.previewHelp}</p>
        </div>
        {validation && <p id="numbering-error" className="feedback feedback-error" role="alert">{labels[validation]}</p>}
        <div className="flex flex-wrap gap-3">
          <button type="submit" className="primary-button">{pending ? labels.working : labels.save}</button>
          <button type="button" className="control" onClick={onCancel}>{labels.cancel}</button>
        </div>
      </fieldset>
    </form>
  );
}
