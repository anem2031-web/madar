import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { errorMessages, RequestFailure, RequestReference } from '../../../../client/src/components/feedback/RequestFailure.tsx';

const requestId = '12345678-1234-1234-1234-123456789abc';

test('failure feedback preserves the translated domain message and contains references in either direction', () => {
  for (const language of ['ar', 'en'] as const) {
    const message = language === 'ar' ? 'كلمة مرورك الحالية غير صحيحة.' : 'Your current password is incorrect.';
    const html = renderToStaticMarkup(createElement(RequestFailure, { message, code: 'USERS_REAUTH_FAILED', requestId, language }));
    expect(html).toContain('role="alert"'); expect(html).toContain(message);
    expect(html).toContain(errorMessages[language].requestReference);
    expect(html).toContain('<bdi dir="ltr" class="break-all">'); expect(html).toContain(requestId);
    expect(html).toContain('min-w-0'); expect(html).not.toContain('USERS_REAUTH_FAILED');
  }
});

test('generic server failures use local translated keys instead of response text', () => {
  for (const language of ['ar', 'en'] as const) {
    const html = renderToStaticMarkup(createElement(RequestFailure, { message: 'untrusted SQL password stack', code: 'PAYLOAD_TOO_LARGE', requestId, language }));
    expect(html).toContain(errorMessages[language].requestTooLarge);
    expect(html).not.toContain('untrusted'); expect(html).not.toContain('SQL'); expect(html).not.toContain('PAYLOAD_TOO_LARGE');
  }
});

test('transport and local validation feedback omit unavailable or malformed references', () => {
  for (const reference of [undefined, '', 'cookie=secret', `${requestId}\nprivate`]) {
    const html = renderToStaticMarkup(createElement(RequestReference, { requestId: reference, language: 'ar' }));
    expect(html).toBe('');
    const feedback = renderToStaticMarkup(createElement(RequestFailure, { message: 'راجع البيانات.', code: 'USERS_UNAVAILABLE', requestId: reference, language: 'ar' }));
    expect(feedback).toContain('راجع البيانات.'); expect(feedback).not.toContain('مرجع الطلب'); expect(feedback).not.toContain('private'); expect(feedback).not.toContain('secret');
  }
});
