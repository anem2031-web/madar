import { sql } from 'drizzle-orm';
import { customType, datetime, int } from 'drizzle-orm/mysql-core';

export const identifier = customType<{ data: string }>({
  dataType: () => 'char(36) character set ascii collate ascii_bin',
});

export const asciiKey = customType<{ data: string; config: { length: number }; configRequired: true }>({
  dataType: ({ length }) => `varchar(${length}) character set ascii collate ascii_bin`,
});

export const unicodeText = customType<{ data: string; config: { length: number }; configRequired: true }>({
  dataType: ({ length }) => `varchar(${length}) character set utf8mb4 collate utf8mb4_bin`,
});

export const normalizedKey = (name: string, source: string) =>
  unicodeText(name, { length: 64 }).generatedAlwaysAs(sql`lower(trim(${sql.identifier(source)}))`, { mode: 'virtual' });

export const utcTimestamp = (name: string) => datetime(name, { fsp: 3, mode: 'string' });

export const version = (name: string) => int(name, { unsigned: true }).notNull().default(1);

export const sha256 = customType<{ data: Buffer }>({ dataType: () => 'binary(32)' });
