export class BootstrapConfigError extends Error {}

/** Local setup messages are fixed text; never interpolate environment values. */
export function readBootstrapConfig(env: NodeJS.ProcessEnv) {
  const password = env.MADAR_ADMIN_PASSWORD;
  if (!password) throw new BootstrapConfigError('أضف MADAR_ADMIN_PASSWORD في ملف .env واحفظ الملف.');
  const length = Array.from(password).length;
  if (length < 15) throw new BootstrapConfigError('كلمة مرور ADMIN المؤقتة أقصر من 15 حرفًا. عدّل MADAR_ADMIN_PASSWORD في ملف .env إلى 15–128 حرفًا واحفظ الملف.');
  if (length > 128) throw new BootstrapConfigError('كلمة مرور ADMIN المؤقتة أطول من 128 حرفًا. عدّل MADAR_ADMIN_PASSWORD في ملف .env إلى 15–128 حرفًا واحفظ الملف.');

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new BootstrapConfigError('إعداد DATABASE_URL غير موجود في بيئة التهيئة.');
  try {
    const url = new URL(databaseUrl);
    if (url.protocol !== 'mysql:' || !url.hostname || !url.username || !url.password
      || decodeURIComponent(url.pathname.slice(1)) !== 'madar') throw new Error();
  } catch {
    throw new BootstrapConfigError('إعداد اتصال التهيئة غير صالح أو لا يشير إلى قاعدة madar. راجع DATABASE_URL محليًا دون مشاركته.');
  }
  return { databaseUrl, password };
}
