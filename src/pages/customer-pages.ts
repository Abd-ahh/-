import { baseHead } from './layout'

export function customerLoginPage(): string {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  ${baseHead('دخول العملاء | Passport AI')}
</head>
<body class="bg-gray-900 min-h-screen flex items-center justify-center p-4">
  <div class="w-full max-w-md">
    <div class="text-center mb-8">
      <div class="w-14 h-14 rounded-2xl bg-brand-600 flex items-center justify-center text-white text-2xl mx-auto mb-4">
        <i class="fa-brands fa-whatsapp"></i>
      </div>
      <h1 class="text-2xl font-extrabold text-white">لوحة تحكم العميل</h1>
      <p class="text-gray-400 text-sm mt-1">تابع اشتراكك وأرقامك وعملياتك</p>
    </div>

    <form id="login-form" class="bg-white rounded-2xl shadow-2xl p-8 space-y-4">
      <div>
        <label class="block text-sm font-bold text-gray-700 mb-1.5">البريد الإلكتروني</label>
        <input id="email" type="email" required class="w-full border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-brand-500" placeholder="you@example.com" />
      </div>
      <div>
        <label class="block text-sm font-bold text-gray-700 mb-1.5">كلمة المرور</label>
        <input id="password" type="password" required class="w-full border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-brand-500" placeholder="••••••••" />
      </div>
      <div id="error-msg" class="hidden text-sm text-red-600 bg-red-50 rounded-lg p-3"></div>
      <button type="submit" class="w-full bg-brand-600 hover:bg-brand-700 transition text-white font-bold py-3 rounded-xl">دخول</button>
      <p class="text-xs text-gray-400 text-center">بيانات الدخول يزودك بها صاحب المنصة عند تفعيل اشتراكك</p>
    </form>
    <p class="text-center text-gray-500 text-sm mt-6"><a href="/" class="hover:text-white">← العودة للصفحة الرئيسية</a></p>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script>
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById('error-msg');
      errorEl.classList.add('hidden');
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      try {
        const res = await axios.post('/api/auth/customer/login', { email, password });
        localStorage.setItem('customer_token', res.data.token);
        window.location.href = '/portal/dashboard';
      } catch (err) {
        errorEl.textContent = err?.response?.data?.error || 'حدث خطأ غير متوقع';
        errorEl.classList.remove('hidden');
      }
    });
  </script>
</body>
</html>`
}

export function customerDashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  ${baseHead('لوحتي | Passport AI')}
</head>
<body class="bg-gray-50">
  <div class="min-h-screen">
    <header class="bg-white border-b border-gray-100 px-6 md:px-8 py-4 flex items-center justify-between sticky top-0 z-10">
      <div class="flex items-center gap-2">
        <div class="w-9 h-9 rounded-xl bg-brand-600 flex items-center justify-center text-white"><i class="fa-solid fa-passport"></i></div>
        <span class="font-extrabold text-gray-900">لوحتي</span>
      </div>
      <div class="flex items-center gap-4">
        <span id="customer-name" class="text-sm font-medium text-gray-600 hidden md:inline"></span>
        <button id="logout-btn" class="text-sm font-semibold text-red-500 hover:text-red-700"><i class="fa-solid fa-right-from-bracket ml-1"></i> خروج</button>
      </div>
    </header>

    <nav class="max-w-6xl mx-auto px-6 pt-6 flex gap-2 overflow-x-auto">
      <button data-tab="overview" class="tab-btn whitespace-nowrap px-5 py-2.5 rounded-xl font-bold text-sm bg-brand-600 text-white">نظرة عامة</button>
      <button data-tab="numbers" class="tab-btn whitespace-nowrap px-5 py-2.5 rounded-xl font-bold text-sm bg-white text-gray-600 border border-gray-200">أرقامي</button>
      <button data-tab="operations" class="tab-btn whitespace-nowrap px-5 py-2.5 rounded-xl font-bold text-sm bg-white text-gray-600 border border-gray-200">سجل العمليات</button>
      <button data-tab="cumulative" class="tab-btn whitespace-nowrap px-5 py-2.5 rounded-xl font-bold text-sm bg-white text-gray-600 border border-gray-200">القائمة التراكمية</button>
      <button data-tab="messagelists" class="tab-btn whitespace-nowrap px-5 py-2.5 rounded-xl font-bold text-sm bg-white text-gray-600 border border-gray-200">قوائم الرسائل</button>
      <button data-tab="settings" class="tab-btn whitespace-nowrap px-5 py-2.5 rounded-xl font-bold text-sm bg-white text-gray-600 border border-gray-200">الإعدادات</button>
    </nav>

    <main class="max-w-6xl mx-auto px-6 py-6" id="content-area">
      <div class="text-center text-gray-400 py-20"><i class="fa-solid fa-spinner fa-spin text-2xl"></i></div>
    </main>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script src="/static/customer.js"></script>
</body>
</html>`
}
