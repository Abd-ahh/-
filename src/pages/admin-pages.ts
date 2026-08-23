import { baseHead } from './layout'

export function adminLoginPage(): string {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  ${baseHead('دخول الإدارة | Passport AI')}
</head>
<body class="bg-gray-900 min-h-screen flex items-center justify-center p-4">
  <div class="w-full max-w-md">
    <div class="text-center mb-8">
      <div class="w-14 h-14 rounded-2xl bg-brand-600 flex items-center justify-center text-white text-2xl mx-auto mb-4">
        <i class="fa-solid fa-user-shield"></i>
      </div>
      <h1 class="text-2xl font-extrabold text-white">لوحة إدارة المنصة</h1>
      <p class="text-gray-400 text-sm mt-1">Passport AI WhatsApp</p>
    </div>

    <div id="bootstrap-box" class="hidden bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl p-4 mb-4">
      <i class="fa-solid fa-circle-info ml-1"></i> لا يوجد حساب مدير بعد. الرجاء إنشاء حساب المدير الأول.
    </div>

    <form id="login-form" class="bg-white rounded-2xl shadow-2xl p-8 space-y-4">
      <div id="name-field" class="hidden">
        <label class="block text-sm font-bold text-gray-700 mb-1.5">الاسم</label>
        <input id="name" type="text" class="w-full border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-brand-500" placeholder="اسمك الكامل" />
      </div>
      <div>
        <label class="block text-sm font-bold text-gray-700 mb-1.5">البريد الإلكتروني</label>
        <input id="email" type="email" required class="w-full border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-brand-500" placeholder="admin@example.com" />
      </div>
      <div>
        <label class="block text-sm font-bold text-gray-700 mb-1.5">كلمة المرور</label>
        <input id="password" type="password" required class="w-full border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-brand-500" placeholder="••••••••" />
      </div>
      <div id="error-msg" class="hidden text-sm text-red-600 bg-red-50 rounded-lg p-3"></div>
      <button id="submit-btn" type="submit" class="w-full bg-brand-600 hover:bg-brand-700 transition text-white font-bold py-3 rounded-xl">
        <span id="submit-text">دخول</span>
      </button>
    </form>
    <p class="text-center text-gray-500 text-sm mt-6"><a href="/" class="hover:text-white">← العودة للصفحة الرئيسية</a></p>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script>
    let needsBootstrap = false;

    async function checkBootstrap() {
      try {
        const res = await axios.get('/api/auth/admin/bootstrap-status');
        needsBootstrap = res.data.needs_bootstrap;
        if (needsBootstrap) {
          document.getElementById('bootstrap-box').classList.remove('hidden');
          document.getElementById('name-field').classList.remove('hidden');
          document.getElementById('submit-text').textContent = 'إنشاء حساب المدير';
        }
      } catch (e) { console.error(e); }
    }
    checkBootstrap();

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById('error-msg');
      errorEl.classList.add('hidden');
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      const name = document.getElementById('name').value;

      try {
        if (needsBootstrap) {
          await axios.post('/api/auth/admin/bootstrap', { name, email, password });
          needsBootstrap = false;
        }
        const res = await axios.post('/api/auth/admin/login', { email, password });
        localStorage.setItem('admin_token', res.data.token);
        window.location.href = '/admin/dashboard';
      } catch (err) {
        errorEl.textContent = err?.response?.data?.error || 'حدث خطأ غير متوقع';
        errorEl.classList.remove('hidden');
      }
    });
  </script>
</body>
</html>`
}

export function adminDashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  ${baseHead('لوحة الإدارة | Passport AI')}
</head>
<body class="bg-gray-50">
  <div class="flex h-screen overflow-hidden" id="app-root">

    <!-- Sidebar -->
    <aside class="w-64 bg-gray-900 text-gray-300 flex-shrink-0 flex flex-col">
      <div class="p-5 flex items-center gap-2 border-b border-gray-800">
        <div class="w-9 h-9 rounded-xl bg-brand-600 flex items-center justify-center text-white"><i class="fa-solid fa-passport"></i></div>
        <span class="font-extrabold text-white">Passport AI</span>
      </div>
      <nav class="flex-1 p-3 space-y-1 text-sm">
        <button data-tab="overview" class="tab-btn w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-gray-800 transition font-medium"><i class="fa-solid fa-chart-pie w-5"></i> نظرة عامة</button>
        <button data-tab="customers" class="tab-btn w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-gray-800 transition font-medium"><i class="fa-solid fa-users w-5"></i> العملاء</button>
        <button data-tab="packages" class="tab-btn w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-gray-800 transition font-medium"><i class="fa-solid fa-box w-5"></i> الباقات</button>
        <button data-tab="numbers" class="tab-btn w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-gray-800 transition font-medium"><i class="fa-brands fa-whatsapp w-5"></i> أرقام واتساب</button>
        <button data-tab="groups" class="tab-btn w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-gray-800 transition font-medium"><i class="fa-solid fa-people-group w-5"></i> مجموعات واتساب</button>
        <button data-tab="operations" class="tab-btn w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-gray-800 transition font-medium"><i class="fa-solid fa-list-check w-5"></i> سجل العمليات</button>
        <div class="pt-3 pb-1 px-4 text-xs text-gray-500 font-bold">ضبط الميزات</div>
        <button data-tab="welcome" class="tab-btn w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-gray-800 transition font-medium"><i class="fa-solid fa-comment-dots w-5"></i> رسالة الترحيب</button>
        <button data-tab="suggestions" class="tab-btn w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-gray-800 transition font-medium"><i class="fa-solid fa-lightbulb w-5"></i> صندوق المقترحات</button>
        <button data-tab="visachecks" class="tab-btn w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-gray-800 transition font-medium"><i class="fa-solid fa-passport w-5"></i> فحوصات التأشيرات</button>
        <button data-tab="test" class="tab-btn w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-gray-800 transition font-medium"><i class="fa-solid fa-flask w-5"></i> اختبار الاستخراج</button>
      </nav>
      <div class="p-3 border-t border-gray-800">
        <button id="logout-btn" class="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-gray-800 transition font-medium text-red-400"><i class="fa-solid fa-right-from-bracket w-5"></i> تسجيل الخروج</button>
      </div>
    </aside>

    <!-- Main content -->
    <main class="flex-1 overflow-y-auto">
      <header class="bg-white border-b border-gray-100 px-8 py-5 flex items-center justify-between sticky top-0 z-10">
        <h1 id="page-title" class="text-xl font-extrabold text-gray-900">نظرة عامة</h1>
      </header>
      <div class="p-8" id="content-area">
        <div class="text-center text-gray-400 py-20"><i class="fa-solid fa-spinner fa-spin text-2xl"></i></div>
      </div>
    </main>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script src="/static/admin.js"></script>
</body>
</html>`
}
