import { useEffect, useRef } from 'react';

/** Retained forms keep non-secret drafts while hidden, but clear every native password field. */
export function usePasswordPrivacy(clear: () => void) {
  const form = useRef<HTMLFormElement>(null);
  const clearRef = useRef(clear);
  clearRef.current = clear;
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return;
      form.current?.querySelectorAll<HTMLInputElement>('input[type="password"], input[autocomplete~="current-password"], input[autocomplete~="new-password"]')
        .forEach(input => { input.value = ''; });
      clearRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  return form;
}
