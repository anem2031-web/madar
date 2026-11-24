import ar from '../../../../shared/i18n/ar/errors.ts';
import en from '../../../../shared/i18n/en/errors.ts';
import { genericErrorCodes, isPublicErrorCode, isRequestId, messageKeyFor } from '../../../../shared/errors/contracts.ts';
import type { Language } from '../../i18n/locale.ts';

export const errorMessages: Record<Language, Record<keyof typeof ar, string>> = { ar, en };
const genericCodes = new Set<string>(genericErrorCodes);

export function RequestReference({ requestId, language }: { requestId?: string; language: Language }) {
  return isRequestId(requestId) ? <p className="mt-2 min-w-0 text-xs leading-6">{errorMessages[language].requestReference}: <bdi dir="ltr" className="break-all">{requestId}</bdi></p> : null;
}

export function RequestFailure({ message, code, requestId, language }: { message: string; code: string; requestId?: string; language: Language }) {
  const translated = genericCodes.has(code) && isPublicErrorCode(code) ? errorMessages[language][messageKeyFor(code)] : message;
  return <div role="alert" className="feedback feedback-error min-w-0"><p>{translated}</p><RequestReference requestId={requestId} language={language} /></div>;
}
