// Admin dashboard SPA logic
axios.defaults.headers.common['Authorization'] = 'Bearer ' + (localStorage.getItem('admin_token') || '');

const API = '/api/admin';
let currentTab = 'overview';
let packagesCache = [];
let customersCache = [];
let numbersCache = [];
let fieldsCache = [];

// ---------------- Shared WABA credentials (used once for ALL numbers) ----------------
// Meta account (WABA ID + Access Token) is usually the same for every WhatsApp number
// the admin manages, so once entered they're remembered and reused automatically —
// no need to retype them for every new number.
function getSavedWaba() {
  return {
    waba_id: localStorage.getItem('saved_waba_id') || '',
    access_token: localStorage.getItem('saved_waba_token') || ''
  };
}
function saveWaba(waba_id, access_token) {
  if (waba_id) localStorage.setItem('saved_waba_id', waba_id);
  if (access_token) localStorage.setItem('saved_waba_token', access_token);
}
window.clearSavedWaba = function () {
  localStorage.removeItem('saved_waba_id');
  localStorage.removeItem('saved_waba_token');
  render();
};

// ---------------- Copy to clipboard helper ----------------
window.copyValue = function (value, btnEl) {
  if (!value) return;
  navigator.clipboard.writeText(String(value)).then(() => {
    if (!btnEl) return;
    const original = btnEl.innerHTML;
    btnEl.innerHTML = '<i class="fa-solid fa-check text-emerald-500"></i>';
    setTimeout(() => { btnEl.innerHTML = original; }, 1200);
  }).catch(() => alert('تعذر النسخ'));
};

function copyBtn(value) {
  if (!value) return '';
  return `<button onclick='copyValue(${JSON.stringify(String(value))}, this)' title="نسخ" class="text-gray-400 hover:text-brand-600 px-1"><i class="fa-regular fa-copy"></i></button>`;
}

async function getFields() {
  if (fieldsCache.length) return fieldsCache;
  const { data } = await axios.get(`${API}/fields`);
  fieldsCache = data.fields;
  return fieldsCache;
}

function guardAuth(err) {
  if (err?.response?.status === 401) {
    localStorage.removeItem('admin_token');
    window.location.href = '/admin';
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
    active: ['bg-emerald-50 text-emerald-700', 'نشط'],
    suspended: ['bg-red-50 text-red-700', 'موقوف'],
    connected: ['bg-emerald-50 text-emerald-700', 'متصل'],
    pending: ['bg-amber-50 text-amber-700', 'قيد الربط'],
    disconnected: ['bg-red-50 text-red-700', 'غير متصل'],
  };
  const [cls, label] = map[status] || ['bg-gray-100 text-gray-600', status];
  return `<span class="text-xs font-bold px-2.5 py-1 rounded-full ${cls}">${label}</span>`;
}

// ---------------- Navigation ----------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await axios.post('/api/auth/admin/logout').catch(() => {});
  localStorage.removeItem('admin_token');
  window.location.href = '/admin';
});

const titles = {
  overview: 'نظرة عامة', customers: 'العملاء', packages: 'الباقات',
  numbers: 'أرقام واتساب', operations: 'سجل العمليات', test: 'اختبار الاستخراج'
};

function switchTab(tab) {
  currentTab = tab;
  document.getElementById('page-title').textContent = titles[tab];
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('bg-gray-800', b.dataset.tab === tab);
    b.classList.toggle('text-white', b.dataset.tab === tab);
  });
  render();
}

async function render() {
  const area = document.getElementById('content-area');
  area.innerHTML = '<div class="text-center text-gray-400 py-20"><i class="fa-solid fa-spinner fa-spin text-2xl"></i></div>';
  try {
    if (currentTab === 'overview') await renderOverview(area);
    else if (currentTab === 'customers') await renderCustomers(area);
    else if (currentTab === 'packages') await renderPackages(area);
    else if (currentTab === 'numbers') await renderNumbers(area);
    else if (currentTab === 'operations') await renderOperations(area);
    else if (currentTab === 'test') await renderTest(area);
  } catch (err) {
    if (guardAuth(err)) return;
    area.innerHTML = `<div class="text-center text-red-500 py-20">حدث خطأ: ${err?.response?.data?.error || err.message}</div>`;
  }
}

// ---------------- Overview ----------------
async function renderOverview(area) {
  const { data } = await axios.get(`${API}/dashboard`);
  area.innerHTML = `
    <div class="grid md:grid-cols-4 gap-5 mb-8">
      ${statCard('fa-users', 'العملاء', data.customers_count, 'text-blue-600 bg-blue-50')}
      ${statCard('fa-file-signature', 'اشتراكات نشطة', data.active_subscriptions, 'text-emerald-600 bg-emerald-50')}
      ${statCard('fa-brands fa-whatsapp', 'أرقام متصلة', data.connected_numbers, 'text-brand-600 bg-brand-50')}
      ${statCard('fa-sack-dollar', 'الإيرادات', data.revenue_total.toLocaleString() + ' ر.س', 'text-amber-600 bg-amber-50')}
    </div>
    <div class="grid md:grid-cols-3 gap-5 mb-8">
      ${statCard('fa-list-check', 'إجمالي العمليات', data.operations_total, 'text-gray-600 bg-gray-100')}
      ${statCard('fa-circle-check', 'عمليات ناجحة', data.operations_success, 'text-emerald-600 bg-emerald-50')}
      ${statCard('fa-circle-xmark', 'عمليات فاشلة/غير واضحة', data.operations_failed, 'text-red-600 bg-red-50')}
    </div>
    <div class="bg-white rounded-2xl border border-gray-100 p-6">
      <h3 class="font-bold text-gray-900 mb-4">أحدث العمليات</h3>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-right text-gray-400 border-b border-gray-100">
            <th class="pb-3 font-medium">العميل</th><th class="pb-3 font-medium">الاسم المستخرج</th>
            <th class="pb-3 font-medium">الحالة</th><th class="pb-3 font-medium">التاريخ</th>
          </tr></thead>
          <tbody>
            ${data.recent_operations.map(op => `
              <tr class="border-b border-gray-50">
                <td class="py-3">${op.customer_name || '-'}</td>
                <td class="py-3">${op.full_name_ar || '-'}</td>
                <td class="py-3">${statusBadge(op.status)}</td>
                <td class="py-3 text-gray-400">${fmtDate(op.created_at)}</td>
              </tr>`).join('') || '<tr><td colspan="4" class="py-8 text-center text-gray-400">لا توجد عمليات بعد</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function statCard(icon, label, value, colorCls) {
  return `
    <div class="bg-white rounded-2xl border border-gray-100 p-5 flex items-center gap-4">
      <div class="w-12 h-12 rounded-xl ${colorCls} flex items-center justify-center text-lg"><i class="fa-solid ${icon}"></i></div>
      <div>
        <p class="text-2xl font-extrabold text-gray-900">${value}</p>
        <p class="text-xs text-gray-500">${label}</p>
      </div>
    </div>
  `;
}

// ---------------- Customers ----------------
async function renderCustomers(area) {
  const { data } = await axios.get(`${API}/customers`);
  customersCache = data.customers;
  area.innerHTML = `
    <div class="flex justify-end mb-5">
      <button onclick="openCustomerModal()" class="bg-brand-600 hover:bg-brand-700 text-white font-bold px-5 py-2.5 rounded-xl text-sm"><i class="fa-solid fa-plus ml-1"></i> عميل جديد</button>
    </div>
    <div class="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-right text-gray-400 bg-gray-50 border-b border-gray-100">
          <th class="p-4 font-medium">الاسم</th><th class="p-4 font-medium">البريد</th>
          <th class="p-4 font-medium">الأرقام</th><th class="p-4 font-medium">الحالة</th>
          <th class="p-4 font-medium">الاشتراك</th><th class="p-4 font-medium">إجراءات</th>
        </tr></thead>
        <tbody>
          ${data.customers.map(c => `
            <tr class="border-b border-gray-50 hover:bg-gray-50">
              <td class="p-4 font-semibold">${c.name}</td>
              <td class="p-4 text-gray-500">${c.email}</td>
              <td class="p-4">${c.numbers_count}</td>
              <td class="p-4">${statusBadge(c.status)}</td>
              <td class="p-4">${c.active_subscription_id ? '<span class="text-emerald-600 font-bold text-xs">نشط</span>' : '<span class="text-gray-400 text-xs">لا يوجد</span>'}</td>
              <td class="p-4">
                <button onclick="openCustomerDetail(${c.id})" class="text-brand-600 hover:underline text-xs font-bold">التفاصيل</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="6" class="p-8 text-center text-gray-400">لا يوجد عملاء بعد</td></tr>'}
        </tbody>
      </table>
    </div>
    <div id="modal-root"></div>
  `;
}

window.openCustomerModal = function () {
  const modal = document.getElementById('modal-root');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl p-6 w-full max-w-md">
        <h3 class="font-bold text-lg mb-4">إضافة عميل جديد</h3>
        <div class="space-y-3">
          <input id="nc-name" placeholder="الاسم الكامل" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="nc-email" type="email" placeholder="البريد الإلكتروني" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="nc-phone" placeholder="رقم الجوال (اختياري)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="nc-password" type="text" placeholder="كلمة المرور المبدئية" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
        </div>
        <div id="nc-error" class="hidden text-red-600 text-xs bg-red-50 rounded-lg p-2 mt-3"></div>
        <div class="flex gap-3 mt-5">
          <button onclick="submitCustomer()" class="flex-1 bg-brand-600 text-white font-bold py-2.5 rounded-xl">حفظ</button>
          <button onclick="closeModal()" class="flex-1 bg-gray-100 text-gray-700 font-bold py-2.5 rounded-xl">إلغاء</button>
        </div>
      </div>
    </div>
  `;
};

window.closeModal = function () { document.getElementById('modal-root').innerHTML = ''; };

window.submitCustomer = async function () {
  const name = document.getElementById('nc-name').value;
  const email = document.getElementById('nc-email').value;
  const phone = document.getElementById('nc-phone').value;
  const password = document.getElementById('nc-password').value;
  try {
    await axios.post(`${API}/customers`, { name, email, phone, password });
    closeModal();
    render();
  } catch (err) {
    const el = document.getElementById('nc-error');
    el.textContent = err?.response?.data?.error || 'حدث خطأ';
    el.classList.remove('hidden');
  }
};

window.openCustomerDetail = async function (id) {
  const { data } = await axios.get(`${API}/customers/${id}`);
  const { data: pkgData } = await axios.get(`${API}/packages`);
  const modal = document.getElementById('modal-root');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[85vh] overflow-y-auto">
        <div class="flex justify-between items-start mb-4">
          <div>
            <h3 class="font-bold text-lg">${data.customer.name}</h3>
            <p class="text-gray-500 text-sm">${data.customer.email}</p>
          </div>
          <button onclick="closeModal()" class="text-gray-400 hover:text-gray-700"><i class="fa-solid fa-xmark text-xl"></i></button>
        </div>

        <div class="mb-5">
          <h4 class="font-bold text-sm text-gray-700 mb-2">إدارة الاشتراك</h4>
          <div class="flex gap-2 items-center bg-gray-50 rounded-xl p-3">
            <select id="pkg-select" class="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm">
              ${pkgData.packages.map(p => `<option value="${p.id}">${p.name_ar} - ${p.price} ${p.currency}</option>`).join('')}
            </select>
            <input id="pkg-days" type="number" value="30" class="w-20 border border-gray-200 rounded-lg px-2 py-2 text-sm" title="عدد الأيام" />
            <button onclick="assignSubscription(${id})" class="bg-brand-600 text-white text-sm font-bold px-4 py-2 rounded-lg">تفعيل</button>
          </div>
        </div>

        <div class="mb-5">
          <h4 class="font-bold text-sm text-gray-700 mb-2">الاشتراكات</h4>
          <div class="space-y-2 text-sm">
            ${data.subscriptions.map(s => `
              <div class="flex justify-between items-center bg-gray-50 rounded-lg p-3">
                <span>${s.package_name_ar} — ${s.operations_used}/${s.operations_limit} عملية</span>
                <span class="flex items-center gap-2">${statusBadge(s.status)} <span class="text-xs text-gray-400">حتى ${fmtDate(s.end_date)}</span></span>
              </div>`).join('') || '<p class="text-gray-400">لا يوجد اشتراكات</p>'}
          </div>
        </div>

        <div class="mb-5">
          <h4 class="font-bold text-sm text-gray-700 mb-2">أرقام واتساب (${data.numbers.length})</h4>
          <div class="space-y-2 text-sm">
            ${data.numbers.map(n => `
              <div class="flex justify-between items-center bg-gray-50 rounded-lg p-3">
                <span>${n.display_name} — ${n.phone_number}</span>
                ${statusBadge(n.status)}
              </div>`).join('') || '<p class="text-gray-400">لا توجد أرقام مربوطة</p>'}
          </div>
        </div>

        <div>
          <h4 class="font-bold text-sm text-gray-700 mb-2">آخر العمليات</h4>
          <div class="space-y-2 text-sm max-h-48 overflow-y-auto">
            ${data.operations.map(o => `
              <div class="flex justify-between items-center bg-gray-50 rounded-lg p-3">
                <span>${o.full_name_ar || o.error_message || '-'}</span>
                ${statusBadge(o.status)}
              </div>`).join('') || '<p class="text-gray-400">لا توجد عمليات</p>'}
          </div>
        </div>
      </div>
    </div>
  `;
};

window.assignSubscription = async function (customerId) {
  const package_id = document.getElementById('pkg-select').value;
  const duration_days = document.getElementById('pkg-days').value;
  try {
    await axios.post(`${API}/subscriptions`, { customer_id: customerId, package_id, duration_days: Number(duration_days) });
    closeModal();
    render();
  } catch (err) {
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

// ---------------- Packages ----------------
async function renderPackages(area) {
  const { data } = await axios.get(`${API}/packages`);
  packagesCache = data.packages;
  area.innerHTML = `
    <div class="flex justify-end mb-5">
      <button onclick="openPackageModal()" class="bg-brand-600 hover:bg-brand-700 text-white font-bold px-5 py-2.5 rounded-xl text-sm"><i class="fa-solid fa-plus ml-1"></i> باقة جديدة</button>
    </div>
    <div class="grid md:grid-cols-3 gap-5">
      ${data.packages.map(p => `
        <div class="bg-white rounded-2xl border border-gray-100 p-6">
          <div class="flex justify-between items-start mb-3">
            <h3 class="font-bold text-lg">${p.name_ar}</h3>
            ${p.is_active ? statusBadge('active') : statusBadge('suspended')}
          </div>
          <p class="text-2xl font-extrabold text-gray-900 mb-1">${p.price} <span class="text-sm text-gray-400 font-normal">${p.currency}/شهرياً</span></p>
          <p class="text-sm text-gray-500 mb-4">${p.max_numbers} رقم — ${p.monthly_operations} عملية شهرياً</p>
          <div class="flex gap-2">
            <button onclick="editPackage(${p.id})" class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-bold py-2 rounded-lg">تعديل</button>
            <button onclick="deletePackage(${p.id})" class="bg-red-50 hover:bg-red-100 text-red-600 text-sm font-bold px-3 py-2 rounded-lg"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>
      `).join('') || '<p class="text-gray-400 col-span-3 text-center py-10">لا توجد باقات، أضف باقتك الأولى</p>'}
    </div>
    <div id="modal-root"></div>
  `;
}

window.openPackageModal = function (pkg) {
  const modal = document.getElementById('modal-root');
  const p = pkg || { name_ar: '', name_en: '', max_numbers: 1, monthly_operations: 500, price: 0, currency: 'SAR', sort_order: 0, is_active: 1 };
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl p-6 w-full max-w-md">
        <h3 class="font-bold text-lg mb-4">${pkg ? 'تعديل الباقة' : 'باقة جديدة'}</h3>
        <div class="space-y-3">
          <input id="pk-name-ar" value="${p.name_ar}" placeholder="اسم الباقة (عربي)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="pk-name-en" value="${p.name_en}" placeholder="Package name (English)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <div class="grid grid-cols-2 gap-3">
            <input id="pk-numbers" type="number" value="${p.max_numbers}" placeholder="عدد الأرقام" class="border border-gray-200 rounded-xl px-4 py-2.5" />
            <input id="pk-ops" type="number" value="${p.monthly_operations}" placeholder="العمليات الشهرية" class="border border-gray-200 rounded-xl px-4 py-2.5" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <input id="pk-price" type="number" value="${p.price}" placeholder="السعر" class="border border-gray-200 rounded-xl px-4 py-2.5" />
            <input id="pk-currency" value="${p.currency}" placeholder="العملة" class="border border-gray-200 rounded-xl px-4 py-2.5" />
          </div>
        </div>
        <div class="flex gap-3 mt-5">
          <button onclick="submitPackage(${p.id || ''})" class="flex-1 bg-brand-600 text-white font-bold py-2.5 rounded-xl">حفظ</button>
          <button onclick="closeModal()" class="flex-1 bg-gray-100 text-gray-700 font-bold py-2.5 rounded-xl">إلغاء</button>
        </div>
      </div>
    </div>
  `;
};

window.editPackage = function (id) {
  const pkg = packagesCache.find(p => p.id === id);
  openPackageModal(pkg);
};

window.submitPackage = async function (id) {
  const payload = {
    name_ar: document.getElementById('pk-name-ar').value,
    name_en: document.getElementById('pk-name-en').value,
    max_numbers: Number(document.getElementById('pk-numbers').value),
    monthly_operations: Number(document.getElementById('pk-ops').value),
    price: Number(document.getElementById('pk-price').value),
    currency: document.getElementById('pk-currency').value,
    is_active: 1
  };
  try {
    if (id) await axios.put(`${API}/packages/${id}`, payload);
    else await axios.post(`${API}/packages`, payload);
    closeModal();
    render();
  } catch (err) {
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

window.deletePackage = async function (id) {
  if (!confirm('هل أنت متأكد من حذف هذه الباقة؟')) return;
  await axios.delete(`${API}/packages/${id}`);
  render();
};

// ---------------- WhatsApp Numbers ----------------
async function renderNumbers(area) {
  const { data } = await axios.get(`${API}/whatsapp-numbers`);
  const { data: custData } = await axios.get(`${API}/customers`);
  customersCache = custData.customers;
  numbersCache = data.numbers;
  area.innerHTML = `
    <div class="flex justify-end mb-5">
      <button onclick="openNumberModal()" class="bg-brand-600 hover:bg-brand-700 text-white font-bold px-5 py-2.5 rounded-xl text-sm"><i class="fa-solid fa-plus ml-1"></i> ربط رقم جديد</button>
    </div>
    <div class="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-right text-gray-400 bg-gray-50 border-b border-gray-100">
          <th class="p-4 font-medium">الاسم</th><th class="p-4 font-medium">الرقم</th>
          <th class="p-4 font-medium">العميل</th><th class="p-4 font-medium">Phone Number ID</th>
          <th class="p-4 font-medium">الحالة</th><th class="p-4 font-medium">إجراءات</th>
        </tr></thead>
        <tbody>
          ${data.numbers.map(n => `
            <tr class="border-b border-gray-50 hover:bg-gray-50">
              <td class="p-4 font-semibold">${n.display_name}</td>
              <td class="p-4">${n.phone_number}</td>
              <td class="p-4 text-gray-500">${n.customer_name}</td>
              <td class="p-4 text-gray-400 text-xs">${n.phone_number_id || '-'}</td>
              <td class="p-4">${statusBadge(n.status)}</td>
              <td class="p-4 flex gap-3">
                <button onclick="openConnectionModal(${n.id})" class="text-gray-600 hover:underline text-xs font-bold">بيانات الاتصال</button>
                <button onclick="openFieldsModal(${n.id})" class="text-brand-600 hover:underline text-xs font-bold">حقول الاستخراج</button>
                <button onclick="deleteNumber(${n.id})" class="text-red-500 hover:underline text-xs font-bold">حذف</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="6" class="p-8 text-center text-gray-400">لا توجد أرقام مربوطة</td></tr>'}
        </tbody>
      </table>
    </div>
    <div id="modal-root"></div>
  `;
}

window.openNumberModal = async function () {
  const fields = await getFields();
  const saved = getSavedWaba();
  const hasSaved = !!(saved.waba_id && saved.access_token);
  const modal = document.getElementById('modal-root');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <h3 class="font-bold text-lg mb-1">ربط رقم واتساب جديد</h3>
        <p class="text-xs text-gray-400 mb-4">أدخل WABA ID والـ Access Token — سيتم التفعيل تلقائياً بالكامل. نفس البيانات تُحفظ وتُستخدم تلقائياً لكل رقم جديد بعد ذلك، بدون إعادة إدخالها.</p>
        <div class="space-y-3">
          <select id="wn-customer" class="w-full border border-gray-200 rounded-xl px-4 py-2.5">
            ${customersCache.map(c => `<option value="${c.id}">${c.name} (${c.email})</option>`).join('')}
          </select>
          <input id="wn-name" placeholder="اسم مميز للرقم (مثال: خدمة عملاء الرياض)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="wn-waba" placeholder="WhatsApp Business Account ID (WABA ID)" value="${saved.waba_id}" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="wn-token" type="password" placeholder="Access Token (System User Token)" value="${saved.access_token}" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          ${hasSaved ? `<div class="flex items-center justify-between bg-emerald-50 text-emerald-700 text-xs rounded-lg px-3 py-2">
            <span><i class="fa-solid fa-circle-check ml-1"></i> تم استخدام بيانات الحساب المحفوظة تلقائياً</span>
            <button type="button" onclick="clearSavedWaba(); openNumberModal();" class="underline font-bold">حساب مختلف؟</button>
          </div>` : ''}
          <button type="button" onclick="browseWabaNumbers('wn')" id="wn-browse-btn" class="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-2.5 rounded-xl text-sm">
            <i class="fa-solid fa-list ml-1"></i> عرض كل الأرقام المتاحة تحت هذا الحساب
          </button>
          <div id="wn-lookup-result"></div>
          <input id="wn-phone" type="hidden" />
          <input id="wn-pnid" type="hidden" />
        </div>
        <div class="mt-4">
          <p class="text-sm font-bold text-gray-700 mb-2">الحقول التي يستخرجها البوت لهذا الرقم</p>
          <p class="text-xs text-gray-400 mb-3">اترك الكل بدون تحديد لاستخراج جميع الحقول، أو اختر فقط ما تحتاجه (مثال: الاسم فقط)</p>
          <div class="grid grid-cols-2 gap-2">
            ${fields.map(f => `
              <label class="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2 text-sm cursor-pointer">
                <input type="checkbox" class="wn-field-cb" value="${f.key}" />
                <span>${f.emoji} ${f.label_ar}</span>
              </label>`).join('')}
          </div>
        </div>
        <div id="wn-error" class="hidden text-red-600 text-xs bg-red-50 rounded-lg p-2 mt-3"></div>
        <div class="flex gap-3 mt-5">
          <button onclick="submitNumber()" id="wn-submit-btn" class="flex-1 bg-brand-600 text-white font-bold py-2.5 rounded-xl">ربط الرقم وتفعيله</button>
          <button onclick="closeModal()" class="flex-1 bg-gray-100 text-gray-700 font-bold py-2.5 rounded-xl">إلغاء</button>
        </div>
      </div>
    </div>
  `;
};

// Shows ALL phone numbers under the given WABA (even if there's only one), so
// the admin can add several numbers from the same Meta account one after another
// by just clicking each in the list — no retyping credentials, no guessing.
window.browseWabaNumbers = async function (prefix) {
  const waba_id = document.getElementById(`${prefix}-waba`).value.trim();
  const access_token = document.getElementById(`${prefix}-token`).value.trim();
  const resultEl = document.getElementById(`${prefix}-lookup-result`);
  const errEl = document.getElementById(`${prefix}-error`);
  const btn = document.getElementById(`${prefix}-browse-btn`);
  if (errEl) errEl.classList.add('hidden');
  resultEl.innerHTML = '';
  if (!waba_id || !access_token) {
    resultEl.innerHTML = `<div class="text-red-600 text-xs bg-red-50 rounded-lg p-2 mt-1">أدخل WABA ID والـ Access Token أولاً</div>`;
    return;
  }
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin ml-1"></i> جارِ التحميل...';
  try {
    const { data } = await axios.post(`${API}/whatsapp-lookup`, { waba_id, access_token });
    const numbers = data.numbers || [];
    if (!numbers.length) {
      resultEl.innerHTML = `<div class="text-red-600 text-xs bg-red-50 rounded-lg p-2 mt-1">لم يتم العثور على أي رقم تحت هذا الحساب</div>`;
      return;
    }
    const usedIds = numbersCache.map(n => n.phone_number_id).filter(Boolean);
    resultEl.innerHTML = `
      <div class="bg-blue-50 rounded-lg p-2 mt-1 text-xs">
        <p class="mb-2">أرقام هذا الحساب (${numbers.length}) — اضغط على الرقم لتفعيله:</p>
        ${numbers.map(n => `
          <button type="button" ${prefix === 'wn' ? `onclick='finishSubmitNumber(${JSON.stringify(n)})'` : `onclick='finishSaveConnectionDetails(${window.__cnNumberId}, ${JSON.stringify(n)})'`}
            class="block w-full text-right bg-white border border-gray-200 rounded-lg px-3 py-2 mb-1 hover:bg-gray-50">
            ${n.display_phone_number} — ${n.verified_name}
            ${usedIds.includes(n.id) ? '<span class="text-gray-400"> (مربوط بالفعل)</span>' : ''}
          </button>`).join('')}
      </div>`;
  } catch (err) {
    resultEl.innerHTML = `<div class="text-red-600 text-xs bg-red-50 rounded-lg p-2 mt-1">${err?.response?.data?.error || 'فشل الاتصال بـ Meta'}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-list ml-1"></i> عرض كل الأرقام المتاحة تحت هذا الحساب';
  }
};

// Fully-automatic flow: given only WABA ID + Access Token, look up the phone number
// from Meta ourselves, then create the number in one click (no manual ID copy-paste,
// no separate "lookup" step for the admin to remember to press).
window.submitNumber = async function () {
  const waba_id = document.getElementById('wn-waba').value.trim();
  const access_token = document.getElementById('wn-token').value.trim();
  const el = document.getElementById('wn-error');
  const resultEl = document.getElementById('wn-lookup-result');
  const btn = document.getElementById('wn-submit-btn');
  el.classList.add('hidden');
  resultEl.innerHTML = '';

  if (!waba_id || !access_token) {
    el.textContent = 'أدخل WABA ID والـ Access Token أولاً';
    el.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin ml-1"></i> جارِ التفعيل...';
  try {
    // Step 1: ask Meta for the phone number(s) under this WABA automatically
    const { data } = await axios.post(`${API}/whatsapp-lookup`, { waba_id, access_token });
    const numbers = data.numbers || [];
    if (numbers.length > 1) {
      // Rare case: more than one number under the same WABA — ask which one, then continue automatically
      resultEl.innerHTML = `
        <div class="bg-blue-50 rounded-lg p-2 mt-1 text-xs">
          <p class="mb-2">تم العثور على ${numbers.length} أرقام تحت هذا الـ WABA، اختر الرقم المطلوب لإكمال التفعيل:</p>
          ${numbers.map(n => `
            <button type="button" onclick='finishSubmitNumber(${JSON.stringify(n)})' class="block w-full text-right bg-white border border-gray-200 rounded-lg px-3 py-2 mb-1 hover:bg-gray-50">
              ${n.display_phone_number} — ${n.verified_name}
            </button>`).join('')}
        </div>`;
      return;
    }
    if (!numbers.length) {
      el.textContent = 'لم يتم العثور على أي رقم مسجل تحت هذا WABA ID';
      el.classList.remove('hidden');
      return;
    }
    await finishSubmitNumber(numbers[0]);
  } catch (err) {
    el.textContent = err?.response?.data?.error || 'فشل الاتصال بـ Meta';
    el.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'ربط الرقم وتفعيله';
  }
};

// Step 2: actually create the WhatsApp number record now that we have the
// phone_number_id resolved automatically from Meta.
window.finishSubmitNumber = async function (n) {
  const selectedFields = Array.from(document.querySelectorAll('.wn-field-cb:checked')).map(cb => cb.value);
  const el = document.getElementById('wn-error');
  const waba_id = document.getElementById('wn-waba').value.trim();
  const access_token = document.getElementById('wn-token').value.trim();
  const payload = {
    customer_id: document.getElementById('wn-customer').value,
    display_name: document.getElementById('wn-name').value || n.verified_name || n.display_phone_number,
    phone_number: n.display_phone_number,
    phone_number_id: n.id,
    waba_id,
    access_token,
    extraction_fields: selectedFields.length ? selectedFields : null
  };
  try {
    await axios.post(`${API}/whatsapp-numbers`, payload);
    saveWaba(waba_id, access_token); // remember for next time — same account, no retyping
    closeModal();
    render();
  } catch (err) {
    el.textContent = err?.response?.data?.error || 'حدث خطأ';
    el.classList.remove('hidden');
  }
};

// ---------------- Connection details modal (fix an existing number missing phone_number_id) ----------------
window.openConnectionModal = function (numberId) {
  const n = numbersCache.find(x => x.id === numberId);
  const saved = getSavedWaba();
  // Prefer the number's own saved credentials if it has them, otherwise fall back
  // to the shared account credentials already used for other numbers.
  const wabaVal = (n && n.waba_id) || saved.waba_id;
  const tokenVal = saved.access_token; // token itself is never pre-filled from n (write-only field), but we can reuse the shared one
  window.__cnNumberId = numberId;
  const modal = document.getElementById('modal-root');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <h3 class="font-bold text-lg mb-1">بيانات الاتصال — ${n ? n.display_name : ''}</h3>
        <p class="text-xs text-gray-400 mb-4">أدخل WABA ID والـ Access Token واضغط حفظ — سيتم جلب رقم الهاتف تلقائياً من Meta وتفعيل الرقم في نفس الخطوة. نفس بيانات الحساب المستخدمة لبقية أرقامك تُملأ هنا تلقائياً.</p>
        <div class="space-y-3">
          <input id="cn-waba" placeholder="WhatsApp Business Account ID (WABA ID)" value="${wabaVal}" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="cn-token" type="password" placeholder="Access Token (System User Token)" value="${tokenVal}" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <button type="button" onclick="browseWabaNumbers('cn')" id="cn-browse-btn" class="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-2.5 rounded-xl text-sm">
            <i class="fa-solid fa-list ml-1"></i> عرض كل الأرقام المتاحة تحت هذا الحساب
          </button>
          <div id="cn-lookup-result"></div>
          ${n && n.phone_number_id ? `<p class="text-xs text-gray-400">Phone Number ID الحالي: <span class="font-mono">${n.phone_number_id}</span></p>` : ''}
        </div>
        <div id="cn-error" class="hidden text-red-600 text-xs bg-red-50 rounded-lg p-2 mt-3"></div>
        <div class="flex gap-3 mt-5">
          <button onclick="saveConnectionDetails(${numberId})" id="cn-save-btn" class="flex-1 bg-brand-600 text-white font-bold py-2.5 rounded-xl">جلب وحفظ</button>
          <button onclick="closeModal()" class="flex-1 bg-gray-100 text-gray-700 font-bold py-2.5 rounded-xl">إلغاء</button>
        </div>
      </div>
    </div>
  `;
};

// One-click flow: look up the phone number from Meta using WABA ID + token,
// then immediately save it as this number's connection details. No manual
// Phone Number ID copy-paste required, no separate lookup step to remember.
window.saveConnectionDetails = async function (numberId) {
  const waba_id = document.getElementById('cn-waba').value.trim();
  const access_token = document.getElementById('cn-token').value.trim();
  const resultEl = document.getElementById('cn-lookup-result');
  const errEl = document.getElementById('cn-error');
  const btn = document.getElementById('cn-save-btn');
  errEl.classList.add('hidden');
  resultEl.innerHTML = '';

  if (!waba_id || !access_token) {
    errEl.textContent = 'أدخل WABA ID والـ Access Token أولاً';
    errEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin ml-1"></i> جارِ التفعيل...';
  try {
    const { data } = await axios.post(`${API}/whatsapp-lookup`, { waba_id, access_token });
    const numbers = data.numbers || [];
    if (numbers.length > 1) {
      resultEl.innerHTML = `
        <div class="bg-blue-50 rounded-lg p-2 mt-1 text-xs">
          <p class="mb-2">تم العثور على ${numbers.length} أرقام، اختر الرقم المطلوب لإكمال الحفظ:</p>
          ${numbers.map(nn => `
            <button type="button" onclick='finishSaveConnectionDetails(${numberId}, ${JSON.stringify(nn)})' class="block w-full text-right bg-white border border-gray-200 rounded-lg px-3 py-2 mb-1 hover:bg-gray-50">
              ${nn.display_phone_number} — ${nn.verified_name}
            </button>`).join('')}
        </div>`;
      return;
    }
    if (!numbers.length) {
      errEl.textContent = 'لم يتم العثور على أي رقم مسجل تحت هذا WABA ID';
      errEl.classList.remove('hidden');
      return;
    }
    await finishSaveConnectionDetails(numberId, numbers[0], waba_id, access_token);
  } catch (err) {
    errEl.textContent = err?.response?.data?.error || 'فشل الاتصال بـ Meta';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'جلب وحفظ';
  }
};

window.finishSaveConnectionDetails = async function (numberId, n, wabaIdArg, tokenArg) {
  const waba_id = wabaIdArg || document.getElementById('cn-waba').value.trim();
  const access_token = tokenArg || document.getElementById('cn-token').value.trim();
  const errEl = document.getElementById('cn-error');
  const payload = { waba_id, phone_number_id: n.id, phone_number: n.display_phone_number };
  if (access_token) payload.access_token = access_token;
  try {
    await axios.put(`${API}/whatsapp-numbers/${numberId}`, payload);
    saveWaba(waba_id, access_token); // remember for next time — same account, no retyping
    closeModal();
    render();
  } catch (err) {
    errEl.textContent = err?.response?.data?.error || 'حدث خطأ';
    errEl.classList.remove('hidden');
  }
};

// ---------------- Extraction fields modal (edit existing number) ----------------
window.openFieldsModal = async function (numberId) {
  const fields = await getFields();
  const n = numbersCache.find(x => x.id === numberId);
  let currentFields = [];
  try { currentFields = n && n.extraction_fields ? JSON.parse(n.extraction_fields) : []; } catch { currentFields = []; }

  const modal = document.getElementById('modal-root');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl p-6 w-full max-w-md">
        <h3 class="font-bold text-lg mb-1">حقول الاستخراج — ${n ? n.display_name : ''}</h3>
        <p class="text-xs text-gray-400 mb-4">اترك الكل بدون تحديد لاستخراج جميع الحقول، أو اختر فقط ما تحتاجه (مثال: الاسم فقط)</p>
        <div class="grid grid-cols-2 gap-2">
          ${fields.map(f => `
            <label class="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2 text-sm cursor-pointer">
              <input type="checkbox" class="wnf-field-cb" value="${f.key}" ${currentFields.includes(f.key) ? 'checked' : ''} />
              <span>${f.emoji} ${f.label_ar}</span>
            </label>`).join('')}
        </div>
        <div class="flex gap-3 mt-5">
          <button onclick="saveNumberFields(${numberId})" class="flex-1 bg-brand-600 text-white font-bold py-2.5 rounded-xl">حفظ</button>
          <button onclick="closeModal()" class="flex-1 bg-gray-100 text-gray-700 font-bold py-2.5 rounded-xl">إلغاء</button>
        </div>
      </div>
    </div>
  `;
};

window.saveNumberFields = async function (numberId) {
  const selectedFields = Array.from(document.querySelectorAll('.wnf-field-cb:checked')).map(cb => cb.value);
  try {
    await axios.put(`${API}/whatsapp-numbers/${numberId}`, { extraction_fields: selectedFields.length ? selectedFields : null });
    closeModal();
    render();
  } catch (err) {
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

window.deleteNumber = async function (id) {
  if (!confirm('هل أنت متأكد من حذف هذا الرقم؟')) return;
  await axios.delete(`${API}/whatsapp-numbers/${id}`);
  render();
};

// ---------------- Operations ----------------
async function renderOperations(area) {
  const { data } = await axios.get(`${API}/operations`);
  area.innerHTML = `
    <div class="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-right text-gray-400 bg-gray-50 border-b border-gray-100">
          <th class="p-4 font-medium">العميل</th><th class="p-4 font-medium">الرقم</th>
          <th class="p-4 font-medium">الاسم المستخرج</th><th class="p-4 font-medium">رقم الجواز</th>
          <th class="p-4 font-medium">الحالة</th><th class="p-4 font-medium">المصدر</th><th class="p-4 font-medium">التاريخ</th>
        </tr></thead>
        <tbody>
          ${data.operations.map(o => `
            <tr class="border-b border-gray-50 hover:bg-gray-50">
              <td class="p-4">${o.customer_name || '-'}</td>
              <td class="p-4 text-gray-400 text-xs">${o.phone_number || '-'}</td>
              <td class="p-4 font-semibold">${o.full_name_ar ? `<span class="inline-flex items-center gap-1">${o.full_name_ar} ${copyBtn(o.full_name_ar)}</span>` : '-'}</td>
              <td class="p-4 text-gray-500">${o.passport_number ? `<span class="inline-flex items-center gap-1">${o.passport_number} ${copyBtn(o.passport_number)}</span>` : '-'}</td>
              <td class="p-4">${statusBadge(o.status)}</td>
              <td class="p-4 text-xs text-gray-400">${o.source === 'whatsapp' ? 'واتساب' : 'اختبار'}</td>
              <td class="p-4 text-gray-400 text-xs">${fmtDate(o.created_at)}</td>
            </tr>`).join('') || '<tr><td colspan="7" class="p-8 text-center text-gray-400">لا توجد عمليات بعد</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

// ---------------- Test Extraction Tool ----------------
async function renderTest(area) {
  area.innerHTML = `
    <div class="bg-white rounded-2xl border border-gray-100 p-8 max-w-2xl">
      <h3 class="font-bold text-lg mb-2"><i class="fa-solid fa-flask text-brand-600 ml-2"></i> اختبار دقة استخراج بيانات الجواز</h3>
      <p class="text-sm text-gray-500 mb-6">ارفع صورة جواز سفر تجريبية للتحقق من دقة Gemini في استخراج الاسم العربي والبيانات قبل ربط أرقام واتساب حقيقية.</p>
      <input id="test-file" type="file" accept="image/*" class="w-full border border-gray-200 rounded-xl px-4 py-2.5 mb-4" />
      <button onclick="runTestExtraction()" id="test-btn" class="bg-brand-600 hover:bg-brand-700 text-white font-bold px-6 py-3 rounded-xl">
        <i class="fa-solid fa-magnifying-glass ml-1"></i> تحليل الصورة
      </button>
      <div id="test-result" class="mt-6"></div>
    </div>
  `;
}

window.runTestExtraction = async function () {
  const fileInput = document.getElementById('test-file');
  const resultEl = document.getElementById('test-result');
  const btn = document.getElementById('test-btn');
  if (!fileInput.files[0]) { alert('الرجاء اختيار صورة أولاً'); return; }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin ml-1"></i> جاري التحليل...';
  resultEl.innerHTML = '';

  const file = fileInput.files[0];
  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result.split(',')[1];
    try {
      const { data } = await axios.post(`${API}/test-extract`, { image_base64: base64, mime_type: file.type });
      const r = data.result;
      resultEl.innerHTML = `
        <div class="bg-gray-50 rounded-xl p-5 space-y-2 text-sm">
          <p><strong>جواز سفر صالح:</strong> ${r.is_passport ? '✅ نعم' : '❌ لا'}</p>
          <p><strong>الصورة واضحة:</strong> ${r.is_clear ? '✅ نعم' : '⚠️ لا — ' + (r.clarity_reason || '')}</p>
          ${r.is_passport && r.is_clear ? `
            <hr class="my-3"/>
            <p><strong>الاسم بالعربي:</strong> ${r.full_name_ar || '-'}</p>
            <p><strong>الاسم بالإنجليزي:</strong> ${r.full_name_en || '-'}</p>
            <p><strong>رقم الجواز:</strong> ${r.passport_number || '-'}</p>
            <p><strong>الجنسية:</strong> ${r.nationality || '-'}</p>
            <p><strong>تاريخ الميلاد:</strong> ${r.date_of_birth || '-'}</p>
            <p><strong>تاريخ الانتهاء:</strong> ${r.date_of_expiry || '-'}</p>
            <p><strong>الجنس:</strong> ${r.gender || '-'}</p>
            <p><strong>درجة الثقة:</strong> ${((r.confidence || 0) * 100).toFixed(0)}%</p>
          ` : ''}
          <p class="text-xs text-gray-400 pt-2">زمن المعالجة: ${data.processing_time_ms}ms</p>
        </div>
      `;
    } catch (err) {
      resultEl.innerHTML = `<div class="bg-red-50 text-red-600 rounded-xl p-4 text-sm">${err?.response?.data?.error || 'حدث خطأ'}</div>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-magnifying-glass ml-1"></i> تحليل الصورة';
    }
  };
  reader.readAsDataURL(file);
};

// Init
switchTab('overview');
