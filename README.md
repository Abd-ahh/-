# Passport AI WhatsApp — منصة استخراج بيانات الجوازات عبر واتساب

## نظرة عامة على المشروع
- **الاسم**: Passport AI WhatsApp
- **الهدف**: منصة اشتراكات SaaS تحوّل أي رقم واتساب متصل بها إلى بوت ذكي يستقبل صور جوازات السفر، يحللها عبر Google Gemini، يستخرج بيانات الجواز (وخصوصاً الاسم بالعربي)، ويرد على المرسل مباشرة — مع رفض الصور غير الواضحة بدلاً من التخمين.
- **المرحلة الحالية**: MVP قابل للاختبار الكامل محلياً على رقم واحد. مبني بحيث يتوسع مباشرة لعدة عملاء وأرقام دون أي تغيير في البنية.

## ✅ الميزات المكتملة
### لوحة الإدارة (Admin Dashboard) — `/admin`
- تسجيل حساب المدير الأول (Bootstrap) تلقائياً عند أول تشغيل
- نظرة عامة: عدد العملاء، الاشتراكات النشطة/المنتهية، الأرقام المتصلة، عدد العمليات (ناجحة/فاشلة)، الإيرادات
- إدارة العملاء (إضافة، عرض تفصيلي، ربط اشتراك)
- إدارة الباقات (بداية / احترافية / شركات) مع إمكانية تعديل السعر وعدد الأرقام وعدد العمليات
- إدارة تفعيل/إلغاء الاشتراكات لكل عميل
- ربط أرقام واتساب بالعملاء (بيانات WhatsApp Business Cloud API)
- سجل كامل لكل عمليات استخراج الجوازات مع الحالة والتفاصيل
- **أداة اختبار الاستخراج**: رفع صورة جواز تجريبية مباشرة من اللوحة لقياس دقة Gemini في استخراج الاسم العربي **قبل** ربط أي رقم واتساب حقيقي (تقليل المخاطر كما طُلب)

### لوحة العميل (Customer Portal) — `/portal`
- تسجيل دخول بحساب أنشأه المدير
- نظرة عامة على الاشتراك الحالي، الحد الأقصى للعمليات، والمستخدم منها
- عرض الأرقام المربوطة (بدون كشف بيانات الاعتماد الحساسة)
- سجل عملياته الخاصة فقط
- إعدادات: لغة رد البوت (عربي/إنجليزي)، رسالة ترحيب مخصصة، رقم تواصل

### محرك معالجة الجوازات (WhatsApp Webhook)
- استقبال صور عبر WhatsApp Business Cloud API الرسمي (Meta Graph API)
- تنزيل الصورة، إرسالها إلى Gemini مع Prompt متخصص في قراءة جوازات السفر + التحقق التبادلي مع MRZ
- **رفض التخمين**: إذا كانت الصورة غير واضحة أو ليست جوازاً، يرسل البوت تنبيهاً بدلاً من نتيجة خاطئة
- خصم تلقائي من رصيد العمليات الشهري لكل عميل، مع رسالة عند بلوغ الحد الأقصى
- تخزين نسخة من كل صورة في Cloudflare R2 للتدقيق
- دعم لغتين للرد (عربي/إنجليزي) حسب إعداد كل عميل

### صفحة الهبوط (Landing Page) — `/`
- عرض تسويقي للمنصة، آلية العمل، المزايا، والباقات (تُجلب ديناميكياً من قاعدة البيانات)

## 🔗 ملخص نقاط الدخول (APIs)

### مصادقة (`/api/auth`)
| Method | Path | الوصف |
|---|---|---|
| GET | `/api/auth/admin/bootstrap-status` | هل يوجد حساب مدير بالفعل؟ |
| POST | `/api/auth/admin/bootstrap` | إنشاء أول حساب مدير `{name, email, password}` |
| POST | `/api/auth/admin/login` | دخول المدير `{email, password}` |
| POST | `/api/auth/admin/logout` | خروج المدير |
| POST | `/api/auth/customer/login` | دخول العميل `{email, password}` |
| POST | `/api/auth/customer/logout` | خروج العميل |

### لوحة الإدارة (`/api/admin`, تتطلب رمز مدير)
- `GET /dashboard` — إحصائيات عامة
- `GET/POST/PUT/DELETE /packages` , `/packages/:id`
- `GET /customers` , `GET /customers/:id` , `POST /customers` , `PUT/DELETE /customers/:id`
- `POST /subscriptions` `{customer_id, package_id, duration_days, price_paid}`
- `PUT /subscriptions/:id/cancel`
- `GET/POST/PUT/DELETE /whatsapp-numbers` , `/whatsapp-numbers/:id`
- `GET /operations?page=` — سجل كل العمليات
- `POST /test-extract` `{image_base64, mime_type}` — اختبار استخراج مباشر

### لوحة العميل (`/api/customer`, تتطلب رمز عميل)
- `GET /me`
- `GET /dashboard`
- `PUT /settings` `{reply_language, welcome_message, phone}`
- `GET /operations?page=`

### عام (`/api/public`)
- `GET /packages` — الباقات النشطة (لصفحة الهبوط)

### واتساب (`/webhook/whatsapp`)
- `GET` — تحقق Meta من الـ Webhook (`hub.mode`, `hub.verify_token`, `hub.challenge`)
- `POST` — استقبال الرسائل الواردة من واتساب

## 🗄️ البنية التقنية للبيانات
- **قاعدة البيانات**: Cloudflare D1 (SQLite على الحافة)
- **الجداول**: `admins`, `customers`, `packages`, `subscriptions`, `whatsapp_numbers`, `operations`, `settings`
- **تخزين الصور**: (غير مفعّل حالياً في الإنتاج — الكود الحالي لا يستخدم R2 فعلياً؛ يمكن إضافته لاحقاً لأرشفة الصور إذا لزم الأمر)
- **الذكاء الاصطناعي**: Google Gemini (`gemini-2.5-flash`) عبر REST API مباشرة (`generativelanguage.googleapis.com`)
- **واتساب**: WhatsApp Business Cloud API الرسمي من Meta (Graph API) — **وليس** حل QR غير رسمي، لأن المنصة مبنية بالكامل serverless على Cloudflare Workers (لا عمليات دائمة، لا اتصال Socket مستمر ممكن)

## 🚀 كيفية الإعداد والتشغيل

### 1. المتطلبات الأساسية (يجب تجهيزها قبل الإطلاق الفعلي)
1. **Google Gemini API Key** — من [Google AI Studio](https://aistudio.google.com/apikey)
2. **حساب Meta Business + WhatsApp Business Platform**:
   - إنشاء تطبيق على [Meta for Developers](https://developers.facebook.com/)
   - إضافة منتج WhatsApp، الحصول على `phone_number_id` و `waba_id` و `access_token` (System User Token دائم)
   - ضبط رابط الـ Webhook إلى: `https://<your-domain>/webhook/whatsapp`
   - القيمة `hub.verify_token` يجب أن تطابق `WHATSAPP_VERIFY_TOKEN` في الأسرار

### 2. إعداد الأسرار (Secrets) على Cloudflare
```bash
npx wrangler pages secret put GEMINI_API_KEY
npx wrangler pages secret put JWT_SECRET
npx wrangler pages secret put WHATSAPP_VERIFY_TOKEN
```

### 3. التطوير المحلي
```bash
npm install
npm run db:migrate:local   # تطبيق مخطط قاعدة البيانات محلياً
npm run db:seed            # إضافة الباقات الافتراضية
npm run build
pm2 start ecosystem.config.cjs
curl http://localhost:3000
```

### 4. أول دخول
- افتح `/admin` وأنشئ حساب المدير الأول (Bootstrap تلقائي عند عدم وجود أي مدير)
- من لوحة الإدارة: أنشئ عميلاً → فعّل له اشتراكاً → اربط رقم واتساب ببياناته الحقيقية من Meta
- استخدم تبويب **"اختبار الاستخراج"** لرفع صور جوازات تجريبية والتحقق من دقة استخراج الاسم العربي قبل الاعتماد على رقم واتساب حقيقي

## 📦 نموذج الباقات الافتراضي
| الباقة | الأرقام | العمليات الشهرية | السعر |
|---|---|---|---|
| بداية | 1 | 500 | 199 ر.س |
| احترافية | 3 | 2000 | 499 ر.س |
| شركات | 10 | 10000 | 1499 ر.س |

(قابلة للتعديل بالكامل من لوحة الإدارة)

## ⚠️ ميزة عدم التخمين
البوت **لا يُرجع أبداً اسماً مخموناً**. الـ Prompt الخاص بـ Gemini مصمم بحيث:
1. يتحقق أولاً أن الصورة فعلاً صفحة جواز سفر
2. يتحقق من وضوح الصورة (لا انعكاسات، لا قصّ، لا تشوّش)
3. يقارن البيانات المطبوعة مع منطقة القراءة الآلية MRZ
4. إن لم تكن هناك ثقة كافية، يُرجع `is_clear: false` مع سبب، فيرسل البوت: **"⚠️ الصورة غير واضحة، يرجى إرسال صورة أوضح للجواز."**

## 🔜 ما لم يُنفَّذ بعد (خطوات تالية مقترحة)
1. **الدفع الإلكتروني**: دمج Stripe/PayPal أو بوابة دفع محلية (حالياً التفعيل يدوي من لوحة الأدمن)
2. **إشعارات انتهاء الاشتراك التلقائية** (بريد إلكتروني/واتساب تذكيري قبل الانتهاء)
3. **تجديد تلقائي شهري** للاشتراكات + إعادة تعيين عداد العمليات
4. **دعم أنواع وثائق إضافية** (بطاقات هوية، إقامات)
5. **Rate limiting** على الويبهوك لمنع إساءة الاستخدام
6. **سجل تدقيق (Audit log)** لتغييرات لوحة الإدارة
7. **تصدير التقارير** (Excel/CSV) من سجل العمليات

## 👤 دليل الاستخدام السريع
**كصاحب منصة (أدمن)**: ادخل `/admin` → أنشئ عملاء → فعّل باقات → اربط أرقام واتساب حقيقية من Meta Business.
**كعميل**: استلم بيانات الدخول من صاحب المنصة → ادخل `/portal` → تابع استهلاكك وسجل عملياتك.
**كمستخدم نهائي**: أرسل صورة واضحة لصفحة بيانات الجواز على رقم واتساب العميل المتصل بالمنصة، واستلم النتيجة خلال ثوانٍ.

## 🌐 الروابط
- **الإنتاج (مباشر الآن)**: https://passport-ai-whatsapp.pages.dev
- **لوحة الإدارة**: https://passport-ai-whatsapp.pages.dev/admin
- **لوحة العميل**: https://passport-ai-whatsapp.pages.dev/portal
- **Webhook واتساب**: https://passport-ai-whatsapp.pages.dev/webhook/whatsapp
- **المعاينة المحلية (Sandbox)**: يتم توفيرها عبر GetServiceUrl أثناء التطوير

## 🏗️ الحالة التقنية
- **المنصة**: Cloudflare Pages + Workers (Hono framework)
- **قاعدة البيانات**: Cloudflare D1 (SQLite) — `passport-ai-production`، تم تطبيق كل الـ migrations وزرع الباقات الافتراضية
- **التخزين**: غير مستخدم حالياً (R2 غير مفعّل، راجع قسم البنية التقنية أعلاه)
- **الذكاء الاصطناعي**: Google Gemini (`gemini-flash-latest`)
- **الحالة**: ✅ **منشور فعلياً ويعمل على Cloudflare Pages** — تم إنشاء حساب المدير الأول وتسجيل الدخول تم التحقق منه
- **الخطوة التالية المطلوبة من المستخدم**: ربط رقم واتساب حقيقي من Meta Business (phone_number_id + waba_id + access_token) من داخل لوحة الإدارة، وضبط رابط الـ Webhook في إعدادات تطبيق Meta
- **آخر تحديث**: 2026-08-17
