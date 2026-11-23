import { useEffect, useRef } from 'react';
import type { UserLabels } from './locale.ts';

/** One-time, in-memory disclosure: never persisted or copied automatically. */
export function TemporaryPasswordPanel({ username, password, labels, onDismiss, signedOut = false }: {
  username: string; password: string; labels: UserLabels; onDismiss: () => void; signedOut?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <section className="temporary-password-panel" aria-labelledby="temporary-password-heading">
      <h3 ref={heading} id="temporary-password-heading" tabIndex={-1} className="font-bold outline-none">{labels.secretHeading}</h3>
      <p className="mt-1 font-semibold"><bdi>{username}</bdi></p>
      {signedOut && <p role="status" className="mt-3 text-sm leading-7">{labels.selfResetComplete}</p>}
      <p className="my-3 text-sm leading-7">{labels.secretHelp}</p>
      <output className="temporary-password" dir="ltr" aria-label={labels.secretHeading}>{password}</output>
      <button type="button" className="control mt-4" onClick={onDismiss}>{signedOut ? labels.signInAgain : labels.dismissSecret}</button>
    </section>
  );
}
