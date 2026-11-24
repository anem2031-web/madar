import { numberingTimeZone } from '../../../shared/numbering/settings.ts';

const yearFormatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', { year: 'numeric', timeZone: numberingTimeZone });

export function calendarYearInRiyadh(date: Date): number {
  return Number(yearFormatter.format(date));
}
