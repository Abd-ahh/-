import { baseHead } from './layout'

export function landingPage(): string {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  ${baseHead('Passport AI WhatsApp | منصة استخراج بيانات الجوازات عبر واتساب')}
</head>
<body class="bg-gray-50 text-gray-800">

  <!-- Navbar -->
  <header class="bg-white/90 backdrop-blur sticky top-0 z-50 border-b border-gray-100">
    <nav class="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <div class="w-9 h-9 rounded-xl bg-brand-600 flex items-center justify-center text-white">
          <i class="fa-solid fa-passport"></i>
        </div>
        <span class="font-extrabold text-lg text-gray-900">Passport AI</span>
      </div>
      <div class="hidden md:flex items-center gap-8 text-sm font-medium text-gray-600">
        <a href="#features" class="hover:text-brand-600">المزايا</a>
        <a href="#how" class="hover:text-brand-600">كيف يعمل</a>
        <a href="#pricing" class="hover:text-brand-600">الباقات</a>
      </div>
      <div class="flex items-center gap-3">
        <a href="/portal" class="text-sm font-semibold text-gray-600 hover:text-brand-600">دخول العملاء</a>
        <a href="/admin" class="text-sm font-semibold bg-brand-600 text-white px-4 py-2 rounded-lg hover:bg-brand-700 transition">لوحة الإدارة</a>
      </div>
    </nav>
  </header>

  <!-- Hero -->
  <section class="relative overflow-hidden">
    <div class="absolute inset-0 bg-gradient-to-br from-brand-50 via-white to-emerald-50"></div>
    <div class="relative max-w-6xl mx-auto px-6 py-20 grid md:grid-cols-2 gap-12 items-center">
      <div>
        <span class="inline-flex items-center gap-2 bg-brand-100 text-brand-700 text-xs font-bold px-3 py-1.5 rounded-full mb-5">
          <i class="fa-solid fa-robot"></i> مدعوم بـ Google Gemini AI
        </span>
        <h1 class="text-4xl md:text-5xl font-extrabold text-gray-900 leading-tight mb-6">
          حوّل أي رقم واتساب<br/>إلى <span class="text-brand-600">بوت ذكي</span><br/>لقراءة الجوازات
        </h1>
        <p class="text-lg text-gray-600 mb-8 leading-relaxed">
          اربط رقم واتسابك بالمنصة، وأي شخص يرسل صورة جواز سفر سيحصل فوراً على استخراج دقيق
          للاسم بالعربي وكل بيانات الجواز — مدعوم بالذكاء الاصطناعي مع تحقق ذكي من الوضوح
          قبل إعطاء نتيجة خاطئة.
        </p>
        <div class="flex flex-wrap gap-4">
          <a href="#pricing" class="bg-brand-600 hover:bg-brand-700 transition text-white font-bold px-7 py-3.5 rounded-xl shadow-lg shadow-brand-600/20">
            <i class="fa-solid fa-rocket ml-2"></i> ابدأ الآن
          </a>
          <a href="#how" class="bg-white border border-gray-200 hover:border-brand-300 transition text-gray-700 font-bold px-7 py-3.5 rounded-xl">
            <i class="fa-solid fa-circle-play ml-2"></i> كيف يعمل؟
          </a>
        </div>
      </div>
      <div class="relative">
        <div class="bg-white rounded-3xl shadow-2xl shadow-gray-200 p-6 border border-gray-100">
          <div class="flex items-center gap-2 mb-4 pb-4 border-b border-gray-100">
            <div class="w-10 h-10 rounded-full bg-brand-500 flex items-center justify-center text-white"><i class="fa-brands fa-whatsapp"></i></div>
            <div>
              <p class="font-bold text-sm">بوت استخراج الجوازات</p>
              <p class="text-xs text-brand-600">● متصل الآن</p>
            </div>
          </div>
          <div class="space-y-3">
            <div class="bg-gray-100 rounded-2xl rounded-tr-none p-3 max-w-[80%] mr-auto">
              <i class="fa-solid fa-image text-gray-400 ml-2"></i>
              <span class="text-sm text-gray-500">[صورة جواز سفر]</span>
            </div>
            <div class="bg-brand-600 text-white rounded-2xl rounded-tl-none p-3 max-w-[85%] ml-auto text-sm leading-relaxed">
              ✅ تم استخراج بيانات الجواز بنجاح:<br/><br/>
              👤 الاسم بالعربي: محمد عبدالله الأحمدي<br/>
              🛂 رقم الجواز: A1234567<br/>
              🌍 الجنسية: سعودي
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Features -->
  <section id="features" class="max-w-6xl mx-auto px-6 py-20">
    <div class="text-center mb-14">
      <h2 class="text-3xl font-extrabold text-gray-900 mb-3">لماذا Passport AI؟</h2>
      <p class="text-gray-500">ليست مجرد OCR — بل نظام تحقق ذكي كامل</p>
    </div>
    <div class="grid md:grid-cols-3 gap-8">
      ${featureCard('fa-brain', 'ذكاء اصطناعي حقيقي', 'يستخدم Google Gemini لفهم الصورة، قراءة MRZ، والتحقق التبادلي بين البيانات المطبوعة والمقروءة آلياً.')}
      ${featureCard('fa-triangle-exclamation', 'لا تخمين للأسماء', 'إذا كانت الصورة غير واضحة، يطلب البوت صورة أوضح بدلاً من إعطاء اسم خاطئ.')}
      ${featureCard('fa-language', 'دقة الاسم العربي', 'استخراج متخصص للأسماء العربية من الجوازات، حتى لو كانت مطبوعة بالإنجليزية فقط.')}
      ${featureCardBrand('fa-brands fa-whatsapp', 'أي رقم واتساب', 'اربط رقمك عبر واتساب بزنس الرسمي، ويعمل البوت تلقائياً على مدار الساعة.')}
      ${featureCard('fa-chart-line', 'لوحة تحكم كاملة', 'تابع كل العمليات، الاستهلاك، الإيرادات، والاشتراكات من مكان واحد.')}
      ${featureCard('fa-shield-halved', 'أمان وخصوصية', 'الصور والبيانات مشفرة ومخزنة بأمان على Cloudflare، مع سجل كامل لكل عملية.')}
    </div>
  </section>

  <!-- How it works -->
  <section id="how" class="bg-white py-20 border-y border-gray-100">
    <div class="max-w-6xl mx-auto px-6">
      <div class="text-center mb-14">
        <h2 class="text-3xl font-extrabold text-gray-900 mb-3">كيف يعمل النظام؟</h2>
      </div>
      <div class="grid md:grid-cols-4 gap-6">
        ${stepCard('1', 'fa-user-plus', 'اشترك واربط رقمك', 'تشترك في إحدى الباقات وتربط رقم واتسابك بالمنصة.')}
        ${stepCard('2', 'fa-camera', 'استقبال صورة الجواز', 'أي شخص يرسل صورة جواز سفر للرقم المتصل.')}
        ${stepCard('3', 'fa-robot', 'المعالجة بالذكاء الاصطناعي', 'Gemini يحلل الصورة، يتحقق من الوضوح، ويستخرج البيانات.')}
        ${stepCard('4', 'fa-reply', 'إرسال النتيجة فوراً', 'يستلم المرسل الاسم والبيانات، وتُسجَّل العملية في لوحتك.')}
      </div>
    </div>
  </section>

  <!-- Pricing -->
  <section id="pricing" class="max-w-6xl mx-auto px-6 py-20">
    <div class="text-center mb-14">
      <h2 class="text-3xl font-extrabold text-gray-900 mb-3">الباقات والأسعار</h2>
      <p class="text-gray-500">اختر الباقة المناسبة لحجم أعمالك</p>
    </div>
    <div id="pricing-grid" class="grid md:grid-cols-3 gap-8">
      <div class="col-span-3 text-center text-gray-400 py-10"><i class="fa-solid fa-spinner fa-spin ml-2"></i> جاري تحميل الباقات...</div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="bg-gray-900 text-gray-400 py-10">
    <div class="max-w-6xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
      <p class="text-sm">© ${new Date().getFullYear()} Passport AI WhatsApp — جميع الحقوق محفوظة</p>
      <div class="flex gap-6 text-sm">
        <a href="/admin" class="hover:text-white">لوحة الإدارة</a>
        <a href="/portal" class="hover:text-white">لوحة العملاء</a>
      </div>
    </div>
  </footer>

  <script>
    async function loadPricing() {
      try {
        const res = await axios.get('/api/public/packages')
        const packages = res.data.packages || []
        const grid = document.getElementById('pricing-grid')
        if (packages.length === 0) {
          grid.innerHTML = '<div class="col-span-3 text-center text-gray-400 py-10">لا توجد باقات متاحة حالياً</div>'
          return
        }
        grid.innerHTML = packages.map((p, idx) => \`
          <div class="relative bg-white rounded-2xl border \${idx === 1 ? 'border-brand-500 shadow-xl shadow-brand-100 scale-105' : 'border-gray-200'} p-8 flex flex-col">
            \${idx === 1 ? '<span class="absolute -top-3 right-8 bg-brand-600 text-white text-xs font-bold px-3 py-1 rounded-full">الأكثر طلباً</span>' : ''}
            <h3 class="text-xl font-extrabold text-gray-900 mb-2">\${p.name_ar}</h3>
            <div class="mb-6">
              <span class="text-4xl font-extrabold text-gray-900">\${p.price}</span>
              <span class="text-gray-500">\${p.currency} / شهرياً</span>
            </div>
            <ul class="space-y-3 text-sm text-gray-600 mb-8 flex-1">
              <li><i class="fa-solid fa-check text-brand-600 ml-2"></i> \${p.max_numbers} رقم واتساب</li>
              <li><i class="fa-solid fa-check text-brand-600 ml-2"></i> \${p.monthly_operations} عملية شهرياً</li>
              <li><i class="fa-solid fa-check text-brand-600 ml-2"></i> لوحة تحكم كاملة</li>
              <li><i class="fa-solid fa-check text-brand-600 ml-2"></i> دعم فني</li>
            </ul>
            <a href="/portal" class="text-center \${idx === 1 ? 'bg-brand-600 hover:bg-brand-700 text-white' : 'bg-gray-100 hover:bg-gray-200 text-gray-800'} font-bold py-3 rounded-xl transition">اشترك الآن</a>
          </div>
        \`).join('')
      } catch (e) {
        document.getElementById('pricing-grid').innerHTML = '<div class="col-span-3 text-center text-red-400 py-10">تعذر تحميل الباقات</div>'
      }
    }
    loadPricing()
  </script>
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
</body>
</html>`
}

function featureCard(icon: string, title: string, desc: string): string {
  return `
    <div class="bg-white rounded-2xl p-7 border border-gray-100 hover:border-brand-200 hover:shadow-lg transition">
      <div class="w-12 h-12 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center text-xl mb-4">
        <i class="fa-solid ${icon}"></i>
      </div>
      <h3 class="font-bold text-lg text-gray-900 mb-2">${title}</h3>
      <p class="text-sm text-gray-500 leading-relaxed">${desc}</p>
    </div>
  `
}

function featureCardBrand(icon: string, title: string, desc: string): string {
  return `
    <div class="bg-white rounded-2xl p-7 border border-gray-100 hover:border-brand-200 hover:shadow-lg transition">
      <div class="w-12 h-12 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center text-xl mb-4">
        <i class="${icon}"></i>
      </div>
      <h3 class="font-bold text-lg text-gray-900 mb-2">${title}</h3>
      <p class="text-sm text-gray-500 leading-relaxed">${desc}</p>
    </div>
  `
}

function stepCard(num: string, icon: string, title: string, desc: string): string {
  return `
    <div class="text-center">
      <div class="relative w-16 h-16 mx-auto mb-4 rounded-2xl bg-brand-600 text-white flex items-center justify-center text-2xl shadow-lg shadow-brand-600/30">
        <i class="fa-solid ${icon}"></i>
        <span class="absolute -top-2 -left-2 w-6 h-6 rounded-full bg-gray-900 text-white text-xs flex items-center justify-center font-bold">${num}</span>
      </div>
      <h3 class="font-bold text-gray-900 mb-2">${title}</h3>
      <p class="text-sm text-gray-500">${desc}</p>
    </div>
  `
}
