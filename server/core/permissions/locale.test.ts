import { afterEach, expect, test, vi } from 'vitest';
import { applyLanguage, messages, readLanguage } from '../../../client/src/i18n/locale.ts';

afterEach(() => vi.unstubAllGlobals());

test('first use, unsupported saved values and inaccessible storage fall back to Arabic', () => {
  for (const saved of [null, '', 'ar', 'EN', 'fr', 'undefined']) {
    const getItem = vi.fn(() => saved);
    vi.stubGlobal('localStorage', { getItem });
    expect(readLanguage()).toBe('ar');
    expect(getItem).toHaveBeenCalledWith('madar.language');
  }
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Storage is unavailable.'); } });
  expect(readLanguage()).toBe('ar');
});

test('the selected language persists and restores its document direction and product name', () => {
  const stored = new Map<string, string>();
  const setItem = vi.fn((key: string, value: string) => { stored.set(key, value); });
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem });
  const document = { documentElement: { lang: '', dir: '' }, title: '' };
  vi.stubGlobal('document', document);

  expect(readLanguage()).toBe('ar');
  applyLanguage('en');
  expect(readLanguage()).toBe('en');
  expect(document).toEqual({ documentElement: { lang: 'en', dir: 'ltr' }, title: 'Madar' });
  applyLanguage('ar');
  expect(readLanguage()).toBe('ar');
  expect(document).toEqual({ documentElement: { lang: 'ar', dir: 'rtl' }, title: 'مدار' });
  expect(setItem.mock.calls).toEqual([['madar.language', 'en'], ['madar.language', 'ar']]);
  expect([...stored.keys()]).toEqual(['madar.language']);
});

test('a denied storage write leaves the current language, direction and title usable', () => {
  vi.stubGlobal('localStorage', { setItem: () => { throw new Error('Storage is unavailable.'); } });
  const document = { documentElement: { lang: '', dir: '' }, title: '' };
  vi.stubGlobal('document', document);
  expect(() => applyLanguage('en')).not.toThrow();
  expect(document).toEqual({ documentElement: { lang: 'en', dir: 'ltr' }, title: messages.en.appName });
});
