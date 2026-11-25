# إصدار حماية الفروع والأقسام من تكرار الحفظ

حالةالتطبيق وفق C-179: أكمل المستخدم الترحيل0001 يدويًا؛ طوبق تعريفالجدول وأعمدته وفهارسه وعلاقته وسجله من النتائج المرسلة. صف0001 بالمعرف30001 وبصمته وتوقيته الصحيحين، وصف0000 محفوظ. الإصلاح ينتظر النشر والفحص والقبول. الأوامر أدناه مرجعالتنفيذ المكتمل ولا تعاد على القاعدة المطبقة. لم يطبق المساعدSQL أو يقرأ.env أو يتصل بقاعدة الإنتاج. ترتيب الإصدار: **تطبيق الترحيل والتحقق منه، ثم رفع الإصدار ونشره، ثم فحص المساعد للرابط.** تبقى فحوص أقفال TiDB والتزامن والأداء في بيئة بيانات اختبار معتمدة شرطًا منفصلًا؛ لا تعادلها اختبارات الذاكرة.

الترحيل إضافي لجدول تقني واحد، ولا يغير سجلات الفروع والأقسام أو أرقام الأعمال. أوامرSQL أدناه مقيدة صراحة بقاعدةmadar، ولا تحتوي إعدادًا عامًا أو CHECK أو حذفًا. تُنفذ كل خانة على حدة داخل SQL Editor لموردmadar بعد مراجعة الهدف وإمكانية الاستعادة. عند اختلاف نتيجة أو فشل أمر، يُراجع الجرد قبل المتابعة؛ لا تكرر دفعة ناجحة عشوائيًا.

## 1. الجرد قبل التغيير

تحقق من وجود قاعدةmadar:

```sql
SELECT SCHEMA_NAME
FROM information_schema.SCHEMATA
WHERE SCHEMA_NAME = 'madar';
```

تحقق من سجل الترحيلات. المتوقع قبل هذه الدفعة صف0000 المعروف؛ وجود ترحيل آخر يحتاج مراجعة:

```sql
SELECT id, hash, created_at
FROM `madar`.`__drizzle_migrations`
ORDER BY id;
```

تحقق من عدم وجود الجدول الجديد قبل إنشائه:

```sql
SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'madar'
  AND TABLE_NAME = 'write_operation_receipts';
```

إذا كان موجودًا، يُطابق جرده في الخطوة3 بدل افتراض أنه مكتمل أو إعادة إنشائه.

## 2. دفعات الترحيل الثلاث

الدفعة الأولى: إنشاء الجدول، دونCHECK:

```sql
CREATE TABLE `madar`.`write_operation_receipts` (
  `operation_id` char(36) character set ascii collate ascii_bin NOT NULL,
  `actor_user_id` char(36) character set ascii collate ascii_bin NOT NULL,
  `operation_code` varchar(96) character set ascii collate ascii_bin NOT NULL,
  `input_hash` binary(32) NOT NULL,
  `reservation_token` char(36) character set ascii collate ascii_bin NOT NULL,
  `response_json` json,
  `created_at` datetime(3) NOT NULL,
  CONSTRAINT `pk_write_operation_receipts` PRIMARY KEY (`operation_id`)
);
```

الدفعة الثانية: فهرس علاقة المستخدم قبل إضافة العلاقة، لتجنب فهرس ضمني مكرر:

```sql
CREATE INDEX `ix_write_operation_receipts_actor`
ON `madar`.`write_operation_receipts` (`actor_user_id`);
```

الدفعة الثالثة: العلاقة بالمستخدم معRESTRICT:

```sql
ALTER TABLE `madar`.`write_operation_receipts`
ADD CONSTRAINT `fk_write_operation_receipts_actor`
FOREIGN KEY (`actor_user_id`) REFERENCES `madar`.`users` (`id`)
ON DELETE RESTRICT ON UPDATE RESTRICT;
```

## 3. المطابقة قبل تسجيل نجاح الترحيل

```sql
SHOW CREATE TABLE `madar`.`write_operation_receipts`;
```

```sql
SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE,
       CHARACTER_SET_NAME, COLLATION_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'madar' AND TABLE_NAME = 'write_operation_receipts'
ORDER BY ORDINAL_POSITION;
```

```sql
SHOW INDEX FROM `madar`.`write_operation_receipts`;
```

```sql
SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA,
       k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
       r.DELETE_RULE, r.UPDATE_RULE
FROM information_schema.KEY_COLUMN_USAGE AS k
JOIN information_schema.REFERENTIAL_CONSTRAINTS AS r
  ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
 AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
 AND r.TABLE_NAME = k.TABLE_NAME
WHERE k.TABLE_SCHEMA = 'madar'
  AND k.TABLE_NAME = 'write_operation_receipts'
  AND k.REFERENCED_TABLE_NAME IS NOT NULL;
```

المتوقع7أعمدة كما في[السيكما](DATABASE_SCHEMA.md)، والمفتاحPRIMARY(operation_id) وفهرسactor_user_id وعلاقة واحدة إلىmadar.users(id) بقواعدRESTRICT. لا تنشأ صفوف اختبار في الإنتاج. لا يُسجل الترحيل التالي إلا بعد مطابقة هذه النتائج.

## 4. تسجيل الترحيل بعد المطابقة فقط

بصمة ملف[0001](../database/migrations/0001_write_operation_receipts.sql) هي`0c6666805e703a5b659f642ae1b1fc1bc294f68b36aa77b58e20e171ce70b927`، وقيمةwhen في سجلDrizzle هي`1795605194621`. هذا يطابق تعريفات الملف المراجع؛ صيغةSQL أعلاه تضيف اسمmadar صراحة لنفس الجداول والحقول والعلاقة. يحافظ.gitattributes علىLF للملف الجديد لتثبيت البصمة بين Windows وLinux دون تغيير0000.

الأمر التالي يضيف صفًا واحدًا فقط إذا كان السجل يحتوي صف0000 الصحيح وحده. إذا أثّر في0صف، تُراجع النتيجة ولا يُفترض النجاح:

```sql
INSERT INTO `madar`.`__drizzle_migrations` (`hash`, `created_at`)
SELECT '0c6666805e703a5b659f642ae1b1fc1bc294f68b36aa77b58e20e171ce70b927', 1795605194621
WHERE (SELECT COUNT(*) FROM `madar`.`__drizzle_migrations`) = 1
  AND EXISTS (
    SELECT 1 FROM `madar`.`__drizzle_migrations`
    WHERE `hash` = '28613c7d87709947e45105ac0489c2ff99d1e5beae4009dca9cb7b0c3f4541c8'
      AND `created_at` = 1795360011508
  );
```

```sql
SELECT id, hash, created_at
FROM `madar`.`__drizzle_migrations`
ORDER BY id;
```

## 5. نشر التطبيق وحدود الرجوع

بعد التحقق يرفع المستخدم النسخة وينشرها بالإعدادات الحالية؛ لا متغيرات أو حزم جديدة ولا bootstrap. تُعاد تحميل التبويبات القديمة لتحمل مفتاحoperationId؛ الطلب القديم بلا مفتاح يرفض بـ400/ORG_CLIENT_UPDATE_REQUIRED قبل الكتابة، والحزمة القديمة ستعرض خطأها الآمن العام لأنها لا تعرف ترجمة الرمز الجديد. العميل الجديد يملك الرسالة المترجمة. لا مسار قديم يتجاوز الحماية.

يفحص المساعد الحزمة والرابط والصلاحيات بالجلسة المتاحة، ويجري اختبارات الكتابة المكررة في بيانات اختبار معتمدة. لا يعاد حقن فقد الرد أو زرع فروع اختبار في بيانات المنشأة. يبقى قبول الإصلاح بعد التسليم مستقلًا عن قبول التصميمD-079.

قبل النشر إذا فشل الجرد أو الترحيل تبقى النسخة الجديدة محلية لحين معالجة الاختلاف. بعد استعمال الجدول تحفظ الإيصالات وتاريخ الترحيل؛ لاDROP أو حذف سجلات للتنظيف. الرجوع إلى خادم قديم يعيد الكتابة غير المحمية، وواجهة قديمة مع خادم جديد تُرفض كتابتها بلا مفتاح؛ لذلك تُراجع خطة الرجوع والتوافق، ولا تُعد إعادة الإصدار القديم وحدها استعادة لهذا الخلل.
