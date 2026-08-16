// Customer portal SPA logic
axios.defaults.headers.common['Authorization'] = 'Bearer ' + (localStorage.getItem('customer_token') || '');

const API = '/api/customer';
let currentTab = 'overview';

function guardAuth(err) {
  if (err?.response?.status === 401) {
    localStorage.removeItem('customer_token');
    window.location.href = '/portal';
    return true;
  }
  return false;
}

function fmtDate(s) {
  if (!s) return '-';
  return new Date(s).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
}

function statusBadge(status) {
  const map = {
    success: ['bg-emerald-50 text-emerald-700', 'ناجحة'],
    failed: ['bg-red-50 text-red-700', 'فاشلة'],
    unclear: ['bg-amber-50 text-amber-700', 'غير واضحة'],
    processing: ['bg-gray-100 text-gray-600', 'قيد المعالجة'],
    connected: ['bg-emerald-50 text-emerald-700', 'متصل'],
    pending: ['bg-amber-50 text-amber-700', 'قيد الربط'],
    disconnected: ['bg-red-50 text-red-700', 'غير متصل'],
  };
  const [cls, label] = map[status] || ['bg-gray-100 text-gray-600', status];
  return `<span class="text-xs font-bold px-2.5 py-1 rounded-full ${cls}">${label}</span>`;
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.remove('bg-brand-600', 'text-white');
      b.classList.add('bg-white', 'text-gray-600', 'border', 'border-gray-200');
    });
    btn.classList.add('bg-brand-600', 'text-white');
    btn.classList.remove('bg-white', 'text-gray-600', 'border', 'border-gray-200');
    currentTab = btn.dataset.tab;
    render();
  });
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await axios.post('/api/auth/customer/logout').catch(() => {});
  localStorage.removeItem('customer_token');
  window.location.href = '/portal';
});

async function loadMe() {
  try {
    const { data } = await axios.get(`${API}/me`);
    document.getElementById('customer-name').textContent = data.customer.name;
  } catch (err) { guardAuth(err); }
}
loadMe();

async function render() {
  const area = document.getElementById('content-area');
  area.innerHTML = '<div class="text-center text-gray-400 py-20"><i class="fa-solid fa-spinner fa-spin text-2xl"></i></div>';
  try {
    if (currentTab === 'overview') await renderOverview(area);
    else if (currentTab === 'numbers') await renderNumbers(area);
    else if (currentTab === 'operations') await renderOperations(area);
    else if (currentTab === 'settings') await renderSettings(area);
  } catch (err) {
    if (guardAuth(err)) return;
    area.innerHTML = `<div class="text-center text-red-500 py-20">حدث خطأ: ${err?.response?.data?.error || err.message}</div>`;
  }
}

async function renderOverview(area) {
  const { data } = await axios.get(`${API}/dashboard`);
  const sub = data.active_subscription;
  area.innerHTML = `
    <div class="grid md:grid-cols-3 gap-5 mb-8">
      <div class="bg-white rounded-2xl border border-gray-100 p-6">
        <p class="text-xs text-gray-400 mb-1">الباقة الحالية</p>
        <p class="text-xl font-extrabold text-gray-900">${sub ? sub.package_name_ar : 'لا يوجد اشتراك نشط'}</p>
        ${sub ? `<p class="text-xs text-gray-400 mt-2">ينتهي في ${fmtDate(sub.end_date)}</p>` : ''}
      </div>
      <div class="bg-white rounded-2xl border border-gray-100 p-6">
        <p class="text-xs text-gray-400 mb-1">العمليات المستخدمة</p>
        <p class="text-xl font-extrabold text-gray-900">${sub ? `${sub.operations_used} / ${sub.operations_limit}` : '-'}</p>
        ${sub ? `<div class="w-full bg-gray-100 rounded-full h-2 mt-3"><div class="bg-brand-600 h-2 rounded-full" style="width:${Math.min(100, (sub.operations_used / sub.operations_limit) * 100)}%"></div></div>` : ''}
      </div>
      <div class="bg-white rounded-2xl border border-gray-100 p-6">
        <p class="text-xs text-gray-400 mb-1">الأرقام المربوطة</p>
        <p class="text-xl font-extrabold text-gray-900">${data.numbers.length} ${sub ? `/ ${sub.max_numbers}` : ''}</p>
      </div>
    </div>
    <div class="grid md:grid-cols-3 gap-5 mb-8">
      ${statMini('إجمالي العمليات', data.operations_stats.total || 0)}
      ${statMini('عمليات ناجحة', data.operations_stats.success || 0)}
      ${statMini('عمليات فاشلة/غير واضحة', data.operations_stats.failed || 0)}
    </div>
    <div class="bg-white rounded-2xl border border-gray-100 p-6">
      <h3 class="font-bold text-gray-900 mb-4">أحدث العمليات</h3>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-right text-gray-400 border-b border-gray-100">
            <th class="pb-3 font-medium">الاسم المستخرج</th><th class="pb-3 font-medium">الحالة</th><th class="pb-3 font-medium">التاريخ</th>
          </tr></thead>
          <tbody>
            ${data.recent_operations.map(op => `
              <tr class="border-b border-gray-50">
                <td class="py-3">${op.full_name_ar || op.error_message || '-'}</td>
                <td class="py-3">${statusBadge(op.status)}</td>
                <td class="py-3 text-gray-400">${fmtDate(op.created_at)}</td>
              </tr>`).join('') || '<tr><td colspan="3" class="py-8 text-center text-gray-400">لا توجد عمليات بعد</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function statMini(label, value) {
  return `
    <div class="bg-white rounded-2xl border border-gray-100 p-5 text-center">
      <p class="text-2xl font-extrabold text-gray-900">${value}</p>
      <p class="text-xs text-gray-500 mt-1">${label}</p>
    </div>
  `;
}

async function renderNumbers(area) {
  const { data } = await axios.get(`${API}/dashboard`);
  area.innerHTML = `
    <div class="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-right text-gray-400 bg-gray-50 border-b border-gray-100">
          <th class="p-4 font-medium">الاسم</th><th class="p-4 font-medium">الرقم</th><th class="p-4 font-medium">الحالة</th>
        </tr></thead>
        <tbody>
          ${data.numbers.map(n => `
            <tr class="border-b border-gray-50">
              <td class="p-4 font-semibold">${n.display_name}</td>
              <td class="p-4">${n.phone_number}</td>
              <td class="p-4">${statusBadge(n.status)}</td>
            </tr>`).join('') || '<tr><td colspan="3" class="p-8 text-center text-gray-400">لا توجد أرقام مربوطة بعد. تواصل مع الدعم لربط رقمك.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

async function renderOperations(area) {
  const { data } = await axios.get(`${API}/operations`);
  area.innerHTML = `
    <div class="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-right text-gray-400 bg-gray-50 border-b border-gray-100">
          <th class="p-4 font-medium">الرقم</th><th class="p-4 font-medium">الاسم المستخرج</th>
          <th class="p-4 font-medium">رقم الجواز</th><th class="p-4 font-medium">الحالة</th><th class="p-4 font-medium">التاريخ</th>
        </tr></thead>
        <tbody>
          ${data.operations.map(o => `
            <tr class="border-b border-gray-50">
              <td class="p-4 text-gray-400 text-xs">${o.phone_number || '-'}</td>
              <td class="p-4 font-semibold">${o.full_name_ar || '-'}</td>
              <td class="p-4 text-gray-500">${o.passport_number || '-'}</td>
              <td class="p-4">${statusBadge(o.status)}</td>
              <td class="p-4 text-gray-400 text-xs">${fmtDate(o.created_at)}</td>
            </tr>`).join('') || '<tr><td colspan="5" class="p-8 text-center text-gray-400">لا توجد عمليات بعد</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

async function renderSettings(area) {
  const { data } = await axios.get(`${API}/me`);
  const c = data.customer;
  area.innerHTML = `
    <div class="bg-white rounded-2xl border border-gray-100 p-8 max-w-lg">
      <h3 class="font-bold text-lg mb-5">إعدادات الرد</h3>
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-bold text-gray-700 mb-1.5">رقم الجوال للتواصل</label>
          <input id="st-phone" value="${c.phone || ''}" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
        </div>
        <div>
          <label class="block text-sm font-bold text-gray-700 mb-1.5">لغة رد البوت</label>
          <select id="st-lang" class="w-full border border-gray-200 rounded-xl px-4 py-2.5">
            <option value="ar" ${c.reply_language === 'ar' ? 'selected' : ''}>العربية</option>
            <option value="en" ${c.reply_language === 'en' ? 'selected' : ''}>English</option>
          </select>
        </div>
        <div>
          <label class="block text-sm font-bold text-gray-700 mb-1.5">رسالة الترحيب (عند إرسال رسالة غير صورة)</label>
          <textarea id="st-welcome" rows="3" class="w-full border border-gray-200 rounded-xl px-4 py-2.5">${c.welcome_message || ''}</textarea>
        </div>
      </div>
      <div id="st-success" class="hidden text-emerald-600 text-sm bg-emerald-50 rounded-lg p-3 mt-4">تم الحفظ بنجاح</div>
      <button onclick="saveSettings()" class="mt-5 bg-brand-600 hover:bg-brand-700 text-white font-bold px-6 py-3 rounded-xl">حفظ الإعدادات</button>
    </div>
  `;
}

window.saveSettings = async function () {
  const payload = {
    phone: document.getElementById('st-phone').value,
    reply_language: document.getElementById('st-lang').value,
    welcome_message: document.getElementById('st-welcome').value
  };
  await axios.put(`${API}/settings`, payload);
  const el = document.getElementById('st-success');
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2500);
};

render();
