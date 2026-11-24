import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { OrganizationLabels } from './locale.ts';

export function NameForm({ title, fieldLabel, initialName = '', branchName, labels, disabled, pending, onSave, onCancel }: {
  title: string; fieldLabel: string; initialName?: string; branchName?: string; labels: OrganizationLabels;
  disabled: boolean; pending: boolean; onSave: (name: string) => Promise<boolean>; onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [invalid, setInvalid] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) return;
    const value = new FormData(event.currentTarget).get('organization-name');
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || Array.from(normalized).length > 150) { setInvalid(true); return; }
    setInvalid(false);
    if (await onSave(normalized)) onCancel();
  };
  return (
    <form className="auth-form rounded-2xl border border-line bg-slate-50 p-4 sm:p-6" aria-label={title} onSubmit={submit} noValidate aria-busy={pending}>
      <h3 ref={heading} tabIndex={-1} className="text-lg font-bold outline-none">{title}</h3>
      {branchName && <p className="text-sm leading-7 text-muted">{labels.selectedBranch}: <bdi className="break-words">{branchName}</bdi></p>}
      <fieldset disabled={disabled} className="contents">
        <label className="field" htmlFor="organization-name"><span>{fieldLabel}</span><input id="organization-name" name="organization-name" dir="auto" autoComplete="off" value={name} onChange={event => { setName(event.target.value); setInvalid(false); }} required aria-invalid={invalid || undefined} aria-describedby={invalid ? 'organization-name-hint organization-name-error' : 'organization-name-hint'} /></label>
        <p className="field-hint" id="organization-name-hint">{labels.nameHint}</p>
        {invalid && <p className="feedback feedback-error" id="organization-name-error" role="alert">{labels.invalidName}</p>}
        <div className="flex flex-wrap gap-3">
          <button type="submit" className="primary-button">{pending ? labels.working : labels.save}</button>
          <button type="button" className="control" onClick={onCancel}>{labels.cancel}</button>
        </div>
      </fieldset>
    </form>
  );
}
