// Admin dashboard SPA logic
axios.defaults.headers.common['Authorization'] = 'Bearer ' + (localStorage.getItem('admin_token') || '');

const API = '/api/admin';
let currentTab = 'overview';
let packagesCache = [];
let customersCache = [];
let numbersCache = [];

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
              <td class="p-4">
                <button onclick="deleteNumber(${n.id})" class="text-red-500 hover:underline text-xs font-bold">حذف</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="6" class="p-8 text-center text-gray-400">لا توجد أرقام مربوطة</td></tr>'}
        </tbody>
      </table>
    </div>
    <div id="modal-root"></div>
  `;
}

window.openNumberModal = function () {
  const modal = document.getElementById('modal-root');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl p-6 w-full max-w-lg">
        <h3 class="font-bold text-lg mb-1">ربط رقم واتساب جديد</h3>
        <p class="text-xs text-gray-400 mb-4">تحتاج بيانات WhatsApp Business Cloud API من Meta for Developers</p>
        <div class="space-y-3">
          <select id="wn-customer" class="w-full border border-gray-200 rounded-xl px-4 py-2.5">
            ${customersCache.map(c => `<option value="${c.id}">${c.name} (${c.email})</option>`).join('')}
          </select>
          <input id="wn-name" placeholder="اسم مميز للرقم (مثال: خدمة عملاء الرياض)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="wn-phone" placeholder="رقم الجوال بصيغة دولية +9665xxxxxxxx" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="wn-pnid" placeholder="Phone Number ID (من Meta)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="wn-waba" placeholder="WhatsApp Business Account ID (اختياري)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="wn-token" type="password" placeholder="Access Token (System User Token)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
        </div>
        <div id="wn-error" class="hidden text-red-600 text-xs bg-red-50 rounded-lg p-2 mt-3"></div>
        <div class="flex gap-3 mt-5">
          <button onclick="submitNumber()" class="flex-1 bg-brand-600 text-white font-bold py-2.5 rounded-xl">ربط الرقم</button>
          <button onclick="closeModal()" class="flex-1 bg-gray-100 text-gray-700 font-bold py-2.5 rounded-xl">إلغاء</button>
        </div>
      </div>
    </div>
  `;
};

window.submitNumber = async function () {
  const payload = {
    customer_id: document.getElementById('wn-customer').value,
    display_name: document.getElementById('wn-name').value,
    phone_number: document.getElementById('wn-phone').value,
    phone_number_id: document.getElementById('wn-pnid').value,
    waba_id: document.getElementById('wn-waba').value,
    access_token: document.getElementById('wn-token').value
  };
  try {
    await axios.post(`${API}/whatsapp-numbers`, payload);
    closeModal();
    render();
  } catch (err) {
    const el = document.getElementById('wn-error');
    el.textContent = err?.response?.data?.error || 'حدث خطأ';
    el.classList.remove('hidden');
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
              <td class="p-4 font-semibold">${o.full_name_ar || '-'}</td>
              <td class="p-4 text-gray-500">${o.passport_number || '-'}</td>
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
