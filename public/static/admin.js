// Admin dashboard SPA logic
axios.defaults.headers.common['Authorization'] = 'Bearer ' + (localStorage.getItem('admin_token') || '');

const API = '/api/admin';
let currentTab = 'overview';
let packagesCache = [];
let customersCache = [];
let numbersCache = [];
let fieldsCache = [];
let sharedNumberCache = null;

// ---------------- Platform-wide Meta connection (linked once for the whole platform) ----------------
// WABA ID + Access Token are entered ONE time in "إعدادات واتساب" and stored server-side.
// After that, adding any customer's number only needs their phone number — the backend
// resolves phone_number_id automatically. No ID of any kind is ever typed per-number.
let metaSettingsCache = null;
async function getMetaSettings(force) {
  if (metaSettingsCache && !force) return metaSettingsCache;
  const { data } = await axios.get(`${API}/meta-settings`);
  metaSettingsCache = data;
  return data;
}

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
    checking: ['bg-blue-50 text-blue-700', 'جاري الفحص'],
    found: ['bg-emerald-50 text-emerald-700', 'تم الإصدار'],
    cancelled: ['bg-gray-100 text-gray-500', 'ملغاة'],
    new: ['bg-amber-50 text-amber-700', 'جديد'],
    reviewed: ['bg-blue-50 text-blue-700', 'تمت المراجعة'],
    done: ['bg-emerald-50 text-emerald-700', 'مُنفّذ'],
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
  numbers: 'أرقام واتساب', groups: 'مجموعات واتساب', bridgenumbers: 'أرقام الجسر', messagelists: 'قوائم الرسائل', operations: 'سجل العمليات', test: 'اختبار الاستخراج',
  welcome: 'رسالة الترحيب', suggestions: 'صندوق المقترحات', visachecks: 'فحوصات التأشيرات', activation: 'أوامر التفعيل',
  knowledgebase: 'قاعدة المعرفة', smartemployee: 'المعاملات والوكلاء'
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
    else if (currentTab === 'groups') await renderGroups(area);
    else if (currentTab === 'bridgenumbers') await renderBridgeNumbers(area);
    else if (currentTab === 'messagelists') await renderMessageLists(area);
    else if (currentTab === 'operations') await renderOperations(area);
    else if (currentTab === 'welcome') await renderWelcome(area);
    else if (currentTab === 'suggestions') await renderSuggestions(area);
    else if (currentTab === 'visachecks') await renderVisaChecks(area);
    else if (currentTab === 'activation') await renderActivationCommands(area);
    else if (currentTab === 'knowledgebase') await renderKnowledgeBase(area);
    else if (currentTab === 'smartemployee') await renderSmartEmployee(area);
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
          <hr class="my-1" />
          <p class="text-xs text-gray-400">أوامر الربط بالرقم المشترك (اختياري - يمكن ضبطها لاحقاً من صفحة العميل)</p>
          <input id="nc-activation" placeholder="أمر تفعيل مخصص (اختياري)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="nc-deactivation" placeholder="أمر إيقاف/إلغاء الربط (اختياري)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
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
  const activation_code = document.getElementById('nc-activation').value;
  const deactivation_code = document.getElementById('nc-deactivation').value;
  try {
    await axios.post(`${API}/customers`, { name, email, phone, password, activation_code, deactivation_code });
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
          <h4 class="font-bold text-sm text-gray-700 mb-2">أوامر الربط بالرقم المشترك (اختياري)</h4>
          <p class="text-xs text-gray-400 mb-2">إذا تُرك فارغاً يُستخدم النمط الافتراضي: "${data.customer.name} تفعيل"</p>
          <div class="space-y-2">
            <input id="cu-activation" value="${data.customer.activation_code || ''}" placeholder="أمر تفعيل مخصص، مثال: معالم الرياض" class="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm" />
            <input id="cu-deactivation" value="${data.customer.deactivation_code || ''}" placeholder="أمر إيقاف/إلغاء الربط، مثال: الغاء معالم الرياض" class="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm" />
            <div id="cu-cmd-error" class="hidden text-red-600 text-xs bg-red-50 rounded-lg p-2"></div>
            <button onclick="saveCustomerCommands(${id})" class="w-full bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold py-2 rounded-lg">حفظ الأوامر</button>
          </div>
        </div>

        <div class="mb-5">
          <h4 class="font-bold text-sm text-gray-700 mb-2">🛂 فحص التأشيرة الآلي (PDF)</h4>
          <p class="text-xs text-gray-400 mb-2">لم يعد بإمكان أعضاء المجموعات تفعيل/إيقاف هذه الميزة من واتساب — التحكم أصبح خاصاً بالإدارة فقط. عند الإيقاف يتم إلغاء أي فحوصات معلّقة حالياً لهذا المكتب تلقائياً.</p>
          <div class="flex items-center justify-between bg-gray-50 rounded-xl p-3">
            <span class="text-sm font-semibold ${data.customer.feature_visa_check_enabled ? 'text-emerald-700' : 'text-gray-500'}">
              ${data.customer.feature_visa_check_enabled ? '✅ مفعّلة حالياً' : '⛔ متوقفة حالياً'}
            </span>
            <button onclick="toggleVisaCheck(${id}, ${data.customer.feature_visa_check_enabled ? 0 : 1})"
              class="text-sm font-bold px-4 py-2 rounded-lg ${data.customer.feature_visa_check_enabled ? 'bg-red-50 hover:bg-red-100 text-red-600' : 'bg-brand-600 hover:bg-brand-700 text-white'}">
              ${data.customer.feature_visa_check_enabled ? 'إيقاف الميزة' : 'تفعيل الميزة'}
            </button>
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

window.saveCustomerCommands = async function (customerId) {
  const activation_code = document.getElementById('cu-activation').value;
  const deactivation_code = document.getElementById('cu-deactivation').value;
  try {
    await axios.put(`${API}/customers/${customerId}`, { activation_code, deactivation_code });
    closeModal();
    render();
  } catch (err) {
    const el = document.getElementById('cu-cmd-error');
    el.textContent = err?.response?.data?.error || 'حدث خطأ';
    el.classList.remove('hidden');
  }
};

window.toggleVisaCheck = async function (customerId, enabled) {
  const label = enabled ? 'تفعيل' : 'إيقاف';
  if (!confirm(`تأكيد ${label} ميزة فحص التأشيرة الآلي لهذا المكتب؟${!enabled ? ' سيتم إلغاء كل الفحوصات المعلّقة حالياً.' : ''}`)) return;
  const { data } = await axios.put(`${API}/customers/${customerId}/visa-check`, { enabled: !!enabled });
  if (!enabled && data.cancelled) {
    alert(`تم الإيقاف، وتم إلغاء ${data.cancelled} فحص تأشيرة كان معلّقاً لهذا المكتب.`);
  }
  openCustomerDetail(customerId);
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
          <p class="text-sm text-gray-500 mb-2">${p.max_numbers} رقم — ${p.monthly_operations} عملية شهرياً</p>
          <p class="text-xs font-bold mb-4 ${p.number_mode === 'shared' ? 'text-amber-600' : 'text-brand-600'}">
            <i class="fa-solid ${p.number_mode === 'shared' ? 'fa-people-group' : 'fa-lock'} ml-1"></i>
            ${p.number_mode === 'shared' ? 'رقم واتساب مشترك للمنصة' : 'رقم واتساب خاص بالعميل'}
          </p>
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
  const p = pkg || { name_ar: '', name_en: '', max_numbers: 1, monthly_operations: 500, price: 0, currency: 'SAR', sort_order: 0, is_active: 1, number_mode: 'private' };
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
          <div>
            <label class="block text-xs font-bold text-gray-500 mb-1.5">نوع رقم واتساب لعملاء هذه الباقة</label>
            <select id="pk-number-mode" class="w-full border border-gray-200 rounded-xl px-4 py-2.5">
              <option value="private" ${p.number_mode !== 'shared' ? 'selected' : ''}>خاص — رقم واتساب مستقل لكل عميل</option>
              <option value="shared" ${p.number_mode === 'shared' ? 'selected' : ''}>مشترك — يستخدم رقم المنصة الموحد (تفعيل فوري بدون إعداد)</option>
            </select>
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
    number_mode: document.getElementById('pk-number-mode').value,
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
  const { data: sharedData } = await axios.get(`${API}/shared-number`);
  const meta = await getMetaSettings(true);
  customersCache = custData.customers;
  numbersCache = data.numbers;
  sharedNumberCache = sharedData.number;
  const connected = !!meta.has_token;
  const shared = sharedData.number;
  area.innerHTML = `
    <div class="flex items-center justify-between mb-5 gap-3 flex-wrap">
      <div class="flex items-center gap-2 text-xs font-bold ${connected ? 'text-emerald-600' : 'text-amber-600'}">
        <i class="fa-solid ${connected ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
        ${connected ? `حساب واتساب الأعمال مربوط بالمنصة (WABA: ${meta.waba_id})` : 'لم يتم ربط حساب واتساب الأعمال بعد بالمنصة'}
        <button onclick="openMetaSettingsModal()" class="underline font-bold text-gray-500">${connected ? 'تغيير الإعدادات' : 'ربط الآن'}</button>
      </div>
      <button onclick="openNumberModal()" class="bg-brand-600 hover:bg-brand-700 text-white font-bold px-5 py-2.5 rounded-xl text-sm"><i class="fa-solid fa-plus ml-1"></i> ربط رقم جديد</button>
    </div>
    <div class="bg-white rounded-2xl border-2 ${shared ? 'border-amber-200' : 'border-dashed border-gray-200'} p-5 mb-6">
      <div class="flex items-center justify-between flex-wrap gap-3">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center"><i class="fa-solid fa-people-group"></i></div>
          <div>
            <p class="font-bold text-gray-900 text-sm">الرقم المشترك للمنصة (لعملاء الباقات ذات النمط "مشترك")</p>
            <p class="text-xs text-gray-400">${shared ? `${shared.display_name} — ${shared.phone_number}` : 'لم يتم تحديد رقم مشترك بعد'}</p>
          </div>
        </div>
        <button onclick="openSharedNumberModal()" class="bg-amber-500 hover:bg-amber-600 text-white font-bold px-4 py-2 rounded-xl text-xs">
          ${shared ? 'تغيير الرقم المشترك' : 'تحديد الرقم المشترك'}
        </button>
      </div>
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
                ${!n.phone_number_id ? `<button onclick="autoFixNumber(${n.id})" class="text-amber-600 hover:underline text-xs font-bold">إصلاح تلقائي</button>` : `<button onclick="autoFixNumber(${n.id})" class="text-gray-500 hover:underline text-xs font-bold">تحديث الاتصال</button>`}
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

// ---------------- WhatsApp Group Bridge (unofficial, read-only + unlink) ----------------
// Groups are activated from inside WhatsApp itself (a member sends the
// office's activation text in the group); this tab just gives the admin
// visibility into which groups are linked to which office, and lets them
// force-unlink one if needed. The bridge process (Baileys) runs on a
// separate VPS and is managed outside this dashboard.
async function renderGroups(area) {
  const [{ data }, { data: bnData }] = await Promise.all([
    axios.get(`${API}/whatsapp-groups`),
    axios.get(`${API}/bridge-numbers`)
  ]);
  window._bridgeNumbersCache = bnData.bridge_numbers || [];
  const bnOptions = (list, selectedId) => list.map(bn =>
    `<option value="${bn.id}" ${bn.id === selectedId ? 'selected' : ''}>${bn.label}${bn.phone_number ? ' (' + bn.phone_number + ')' : ''}</option>`
  ).join('');

  area.innerHTML = `
    <div class="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl p-4 mb-5">
      <i class="fa-solid fa-circle-info ml-1"></i>
      هذه المجموعات تُفعَّل تلقائياً من داخل واتساب (عضو يرسل "اسم المكتب تفعيل" داخل المجموعة بعد إضافة رقم الجسر لها) — هذه اللوحة لعرض الحالة وإلغاء الربط فقط. يمكن أيضاً تغيير رقم الجسر المسؤول عن كل مجموعة (راجع تبويب "أرقام الجسر" لإدارة الأرقام نفسها).
    </div>
    <div class="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-right text-gray-400 bg-gray-50 border-b border-gray-100">
          <th class="p-4 font-medium">اسم المجموعة</th><th class="p-4 font-medium">المكتب</th>
          <th class="p-4 font-medium">رقم الجسر</th>
          <th class="p-4 font-medium">تاريخ التفعيل</th><th class="p-4 font-medium"></th>
        </tr></thead>
        <tbody>
          ${data.groups.map(g => `
            <tr class="border-b border-gray-50">
              <td class="p-4 font-semibold">${g.group_name || '-'}</td>
              <td class="p-4 text-gray-500">${g.customer_name}</td>
              <td class="p-4">
                <select onchange="changeGroupBridgeNumber(${g.id}, this.value)" class="border border-gray-200 rounded-lg px-2 py-1 text-xs">
                  ${bnOptions(window._bridgeNumbersCache, g.bridge_number_id)}
                </select>
              </td>
              <td class="p-4 text-gray-400 text-xs">${fmtDate(g.created_at)}</td>
              <td class="p-4"><button onclick="deleteGroup(${g.id})" class="text-red-500 hover:underline text-xs font-bold">إلغاء الربط</button></td>
            </tr>`).join('') || '<tr><td colspan="5" class="p-8 text-center text-gray-400">لا توجد مجموعات مفعّلة حالياً</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

window.deleteGroup = async function (id) {
  if (!confirm('تأكيد إلغاء ربط هذه المجموعة؟')) return;
  await axios.delete(`${API}/whatsapp-groups/${id}`);
  render();
};

window.changeGroupBridgeNumber = async function (groupId, bridgeNumberId) {
  try {
    await axios.put(`${API}/whatsapp-groups/${groupId}/bridge-number`, { bridge_number_id: parseInt(bridgeNumberId, 10) });
  } catch (err) {
    alert('فشل تغيير رقم الجسر: ' + (err?.response?.data?.error || err.message));
    render();
  }
};

// ---------------- Bridge Numbers (multi-number support) ----------------
// Lets the admin register multiple Baileys bridge numbers (each one still
// needs its OWN running bridge.js process on the VPS — see
// bridge/ecosystem.config.cjs — this tab only manages the dashboard-side
// metadata + shows self-reported live status, it never starts/stops a
// VPS process itself).
const bridgeStatusBadge = (status) => {
  const map = {
    pending: ['bg-gray-100 text-gray-500', 'لم يبدأ بعد'],
    connecting: ['bg-amber-50 text-amber-700', 'جاري الربط'],
    connected: ['bg-emerald-50 text-emerald-700', 'متصل'],
    disconnected: ['bg-red-50 text-red-700', 'غير متصل']
  };
  const [cls, label] = map[status] || map.pending;
  return `<span class="text-xs font-bold px-2.5 py-1 rounded-full ${cls}">${label}</span>`;
};

async function renderBridgeNumbers(area) {
  const { data } = await axios.get(`${API}/bridge-numbers`);
  area.innerHTML = `
    <div class="bg-blue-50 border border-blue-200 text-blue-800 text-sm rounded-xl p-4 mb-5">
      <i class="fa-solid fa-circle-info ml-1"></i>
      كل رقم مُسجَّل هنا يحتاج عملية <code>bridge.js</code> مستقلة فعلياً تعمل على VPS (راجع <code>bridge/ecosystem.config.cjs</code>) — هذه اللوحة فقط لتسجيل الأرقام وتتبّع حالتها المُبلَّغة تلقائياً من كل عملية، ولا تبدأ/توقف أي عملية بنفسها.
    </div>
    <div class="flex justify-end mb-4">
      <button onclick="openAddBridgeNumberModal()" class="bg-brand-600 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-brand-700"><i class="fa-solid fa-plus ml-1"></i> إضافة رقم جسر</button>
    </div>
    <div class="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-right text-gray-400 bg-gray-50 border-b border-gray-100">
          <th class="p-4 font-medium">#</th><th class="p-4 font-medium">التسمية</th><th class="p-4 font-medium">رقم الهاتف</th>
          <th class="p-4 font-medium">الحالة</th><th class="p-4 font-medium">مجموعات مرتبطة</th>
          <th class="p-4 font-medium">آخر ظهور</th><th class="p-4 font-medium"></th>
        </tr></thead>
        <tbody>
          ${(data.bridge_numbers || []).map(bn => `
            <tr class="border-b border-gray-50">
              <td class="p-4 text-gray-400">${bn.id}</td>
              <td class="p-4 font-semibold">${bn.label}</td>
              <td class="p-4 text-gray-500">${bn.phone_number || '-'}</td>
              <td class="p-4">${bridgeStatusBadge(bn.status)}${bn.status_detail ? `<div class="text-xs text-gray-400 mt-1">${bn.status_detail}</div>` : ''}</td>
              <td class="p-4 text-gray-500">${bn.linked_groups_count}</td>
              <td class="p-4 text-gray-400 text-xs">${bn.last_seen_at ? fmtDate(bn.last_seen_at) : '-'}</td>
              <td class="p-4 flex gap-2">
                <button onclick="openEditBridgeNumberModal(${bn.id})" class="text-brand-600 hover:underline text-xs font-bold">تعديل</button>
                ${bn.id !== 1 ? `<button onclick="deleteBridgeNumber(${bn.id})" class="text-red-500 hover:underline text-xs font-bold">حذف</button>` : ''}
              </td>
            </tr>`).join('') || '<tr><td colspan="7" class="p-8 text-center text-gray-400">لا توجد أرقام جسر مُسجَّلة</td></tr>'}
        </tbody>
      </table>
    </div>
    <div id="bridge-number-modal-root"></div>
  `;
  window._bridgeNumbersCache = data.bridge_numbers || [];
}

window.openAddBridgeNumberModal = function () {
  renderBridgeNumberModal(null);
};

window.openEditBridgeNumberModal = function (id) {
  const bn = (window._bridgeNumbersCache || []).find(b => b.id === id);
  renderBridgeNumberModal(bn || null);
};

function renderBridgeNumberModal(bn) {
  const root = document.getElementById('bridge-number-modal-root');
  const isEdit = !!bn;
  root.innerHTML = `
    <div class="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onclick="if(event.target===this) this.remove()">
      <div class="bg-white rounded-2xl p-6 w-full max-w-md mx-4">
        <h3 class="font-bold text-lg mb-4">${isEdit ? 'تعديل رقم الجسر' : 'إضافة رقم جسر جديد'}</h3>
        <div class="space-y-3">
          <div>
            <label class="text-xs text-gray-500 block mb-1">التسمية (للعرض فقط)</label>
            <input id="bn-label" type="text" value="${bn?.label || ''}" placeholder="مثال: رقم مكاتب صنعاء" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
          </div>
          <div>
            <label class="text-xs text-gray-500 block mb-1">رقم الهاتف (اختياري، أرقام فقط بالمفتاح الدولي)</label>
            <input id="bn-phone" type="text" value="${bn?.phone_number || ''}" placeholder="9665XXXXXXXX" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" dir="ltr">
          </div>
          ${isEdit ? `
          <label class="flex items-center gap-2 text-sm">
            <input id="bn-active" type="checkbox" ${bn.is_active ? 'checked' : ''}>
            مفعّل
          </label>` : `
          <div class="bg-amber-50 text-amber-700 text-xs rounded-lg p-3">
            بعد الإضافة، سجّل الـ id الظاهر في الجدول ثم أضف عملية bridge.js جديدة له على VPS (راجع تعليمات <code>bridge/ecosystem.config.cjs</code> والقسم المخصص في README).
          </div>`}
        </div>
        <div class="flex gap-2 mt-5">
          <button onclick="saveBridgeNumber(${isEdit ? bn.id : 'null'})" class="flex-1 bg-brand-600 text-white py-2 rounded-xl font-bold text-sm hover:bg-brand-700">حفظ</button>
          <button onclick="document.getElementById('bridge-number-modal-root').innerHTML=''" class="flex-1 bg-gray-100 py-2 rounded-xl font-bold text-sm">إلغاء</button>
        </div>
      </div>
    </div>
  `;
}

window.saveBridgeNumber = async function (id) {
  const label = document.getElementById('bn-label').value.trim();
  const phone_number = document.getElementById('bn-phone').value.trim();
  if (!label) { alert('التسمية مطلوبة'); return; }
  try {
    if (id) {
      const is_active = document.getElementById('bn-active').checked;
      await axios.put(`${API}/bridge-numbers/${id}`, { label, phone_number, is_active });
    } else {
      await axios.post(`${API}/bridge-numbers`, { label, phone_number });
    }
    document.getElementById('bridge-number-modal-root').innerHTML = '';
    render();
  } catch (err) {
    alert('فشل الحفظ: ' + (err?.response?.data?.error || err.message));
  }
};

window.deleteBridgeNumber = async function (id) {
  if (!confirm('تأكيد حذف هذا الرقم؟ (لن يُحذف إن كانت هناك مجموعات مرتبطة به بعد)')) return;
  try {
    await axios.delete(`${API}/bridge-numbers/${id}`);
    render();
  } catch (err) {
    alert('فشل الحذف: ' + (err?.response?.data?.error || err.message));
  }
};

// ---------------- Message Lists (قوائم رسائل) — scheduled WhatsApp broadcast lists ----------------
// Admin view: pick any office (customer), then manage that office's contact
// rolodex (message_contacts) and its scheduled lists (message_lists).
// WhatsApp-only, delivered via the unofficial bridge (never the official
// Cloud API), so there are no per-channel options here on purpose.
let mlCustomerId = null;
let mlContactsCache = [];
let mlListsCache = [];

async function renderMessageLists(area) {
  if (!customersCache.length) {
    const { data } = await axios.get(`${API}/customers`);
    customersCache = data.customers;
  }
  if (!mlCustomerId && customersCache.length) mlCustomerId = customersCache[0].id;

  area.innerHTML = `
    <div class="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl p-4 mb-5">
      <i class="fa-solid fa-circle-info ml-1"></i>
      قوائم الرسائل تُرسَل عبر واتساب فقط (جسر واتساب غير الرسمي) — رسائل تسويقية/جماعية مجدولة حسب الوقت والتكرار، بلا قيود القالب الرسمية.
    </div>
    <div class="flex items-center gap-3 mb-5">
      <label class="text-sm font-bold text-gray-600">المكتب:</label>
      <select id="ml-customer-select" class="border border-gray-200 rounded-xl px-4 py-2.5 text-sm min-w-[220px]">
        ${customersCache.map(c => `<option value="${c.id}" ${c.id === mlCustomerId ? 'selected' : ''}>${c.name}</option>`).join('')}
      </select>
    </div>
    <div id="ml-body"></div>
  `;
  document.getElementById('ml-customer-select').addEventListener('change', (e) => {
    mlCustomerId = Number(e.target.value);
    renderMessageListsBody();
  });
  await renderMessageListsBody();
}

async function renderMessageListsBody() {
  const body = document.getElementById('ml-body');
  body.innerHTML = '<div class="text-center text-gray-400 py-10"><i class="fa-solid fa-spinner fa-spin"></i></div>';
  if (!mlCustomerId) { body.innerHTML = '<p class="text-gray-400 text-center py-10">أضف عميلاً أولاً</p>'; return; }

  const [{ data: contactsData }, { data: listsData }] = await Promise.all([
    axios.get(`${API}/message-contacts`, { params: { customer_id: mlCustomerId } }),
    axios.get(`${API}/message-lists`, { params: { customer_id: mlCustomerId } })
  ]);
  mlContactsCache = contactsData.contacts;
  mlListsCache = listsData.lists;

  body.innerHTML = `
    <div class="grid lg:grid-cols-2 gap-6">
      <div class="bg-white rounded-2xl border border-gray-100 p-5">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-gray-900">جهات الاتصال (${mlContactsCache.length})</h3>
          <button onclick="openMlContactModal()" class="bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold px-3 py-2 rounded-lg"><i class="fa-solid fa-plus ml-1"></i> جهة اتصال</button>
        </div>
        <div class="space-y-2 max-h-96 overflow-y-auto">
          ${mlContactsCache.map(ct => `
            <div class="flex items-center justify-between bg-gray-50 rounded-lg p-3 text-sm">
              <div>
                <p class="font-semibold">${ct.name} ${ct.channel === 'group' ? '<span class=\"text-[10px] bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-full mr-1\">مجموعة</span>' : ''}</p>
                <p class="text-xs text-gray-400" dir="ltr">${ct.value}</p>
                ${ct.region ? `<span class="text-[11px] text-brand-600 font-bold">#${ct.region}</span>` : ''}
              </div>
              <div class="flex gap-2">
                <button onclick="openMlContactModal(${ct.id})" class="text-gray-400 hover:text-brand-600 text-xs"><i class="fa-solid fa-pen"></i></button>
                <button onclick="deleteMlContact(${ct.id})" class="text-gray-400 hover:text-red-500 text-xs"><i class="fa-solid fa-trash"></i></button>
              </div>
            </div>`).join('') || '<p class="text-gray-400 text-center py-6 text-sm">لا توجد جهات اتصال بعد</p>'}
        </div>
      </div>

      <div class="bg-white rounded-2xl border border-gray-100 p-5">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-gray-900">القوائم (${mlListsCache.length})</h3>
          <button onclick="openMlListModal()" class="bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold px-3 py-2 rounded-lg"><i class="fa-solid fa-plus ml-1"></i> قائمة جديدة</button>
        </div>
        <div class="space-y-2 max-h-96 overflow-y-auto">
          ${mlListsCache.map(l => `
            <div class="bg-gray-50 rounded-lg p-3 text-sm">
              <div class="flex items-center justify-between">
                <p class="font-semibold">${l.name} ${l.is_active ? '' : '<span class=\"text-[10px] bg-gray-200 text-gray-500 px-1.5 py-0.5 rounded-full mr-1\">متوقفة</span>'}</p>
                <span class="text-xs text-gray-400">${l.schedule_time} — ${recurrenceLabel(l.recurrence)}</span>
              </div>
              <p class="text-xs text-gray-500 mt-1 line-clamp-2">${(l.message_text || '').slice(0, 80)}</p>
              <div class="flex items-center justify-between mt-2">
                <span class="text-[11px] text-gray-400">آخر إرسال: ${l.last_run_at ? fmtDate(l.last_run_at) : 'لم يُرسل بعد'}</span>
                <div class="flex gap-2">
                  <button onclick="sendMlListNow(${l.id})" class="text-emerald-600 hover:underline text-xs font-bold">إرسال الآن</button>
                  <button onclick="openMlListModal(${l.id})" class="text-brand-600 hover:underline text-xs font-bold">تعديل</button>
                  <button onclick="deleteMlList(${l.id})" class="text-red-500 hover:underline text-xs font-bold">حذف</button>
                </div>
              </div>
            </div>`).join('') || '<p class="text-gray-400 text-center py-6 text-sm">لا توجد قوائم بعد</p>'}
        </div>
      </div>
    </div>
    <div id="modal-root"></div>
  `;
}

function recurrenceLabel(r) {
  return r === 'daily' ? 'يومي' : r === 'weekly' ? 'أسبوعي' : r === 'monthly' ? 'شهري' : r;
}

// ---- Contact modal ----
window.openMlContactModal = async function (id) {
  const ct = id ? mlContactsCache.find(c => c.id === id) : null;
  const modal = document.getElementById('modal-root');
  // Multi-number bridge support: let the admin pick which bridge number
  // delivers to this contact (only meaningful for channel='number' — a
  // 'group' contact is always routed via its own group's assigned bridge
  // number instead, see "مجموعات واتساب" tab). Fetched fresh here since
  // the cache may not be populated if the admin never opened that tab.
  let bridgeNumbers = window._bridgeNumbersCache;
  if (!bridgeNumbers) {
    try {
      const { data } = await axios.get(`${API}/bridge-numbers`);
      bridgeNumbers = window._bridgeNumbersCache = data.bridge_numbers || [];
    } catch { bridgeNumbers = []; }
  }
  const bnOptions = bridgeNumbers.map(bn =>
    `<option value="${bn.id}" ${(ct ? ct.bridge_number_id : 1) === bn.id ? 'selected' : ''}>${bn.label}${bn.phone_number ? ' (' + bn.phone_number + ')' : ''}</option>`
  ).join('');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl p-6 w-full max-w-md">
        <h3 class="font-bold text-lg mb-4">${ct ? 'تعديل جهة اتصال' : 'جهة اتصال جديدة'}</h3>
        <div class="space-y-3">
          <input id="mc-name" value="${ct ? ct.name : ''}" placeholder="الاسم (ممثال: وكيل صنعاء - أحمد)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <select id="mc-channel" class="w-full border border-gray-200 rounded-xl px-4 py-2.5">
            <option value="number" ${!ct || ct.channel === 'number' ? 'selected' : ''}>رقم واتساب فردي</option>
            <option value="group" ${ct && ct.channel === 'group' ? 'selected' : ''}>مجموعة واتساب (JID)</option>
          </select>
          <input id="mc-value" value="${ct ? ct.value : ''}" dir="ltr" placeholder="رقم الهاتف (967778260004) أو JID المجموعة" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="mc-region" value="${ct && ct.region ? ct.region : ''}" placeholder="المنطقة (اختياري، ممثال: صنعاء)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <div>
            <label class="text-xs text-gray-500 block mb-1">رقم الجسر المسلّم (للرقم الفردي فقط)</label>
            <select id="mc-bridge-number" class="w-full border border-gray-200 rounded-xl px-4 py-2.5">${bnOptions}</select>
          </div>
        </div>
        <div id="mc-error" class="hidden text-red-600 text-xs bg-red-50 rounded-lg p-2 mt-3"></div>
        <div class="flex gap-3 mt-5">
          <button onclick="submitMlContact(${id || 'null'})" class="flex-1 bg-brand-600 text-white font-bold py-2.5 rounded-xl">حفظ</button>
          <button onclick="closeModal()" class="flex-1 bg-gray-100 text-gray-700 font-bold py-2.5 rounded-xl">إلفاء</button>
        </div>
      </div>
    </div>
  `;
};

window.submitMlContact = async function (id) {
  const payload = {
    customer_id: mlCustomerId,
    name: document.getElementById('mc-name').value.trim(),
    channel: document.getElementById('mc-channel').value,
    value: document.getElementById('mc-value').value.trim(),
    region: document.getElementById('mc-region').value.trim() || null,
    bridge_number_id: parseInt(document.getElementById('mc-bridge-number').value, 10) || 1
  };
  const errEl = document.getElementById('mc-error');
  try {
    if (id) await axios.put(`${API}/message-contacts/${id}`, payload);
    else await axios.post(`${API}/message-contacts`, payload);
    closeModal();
    renderMessageListsBody();
  } catch (err) {
    if (guardAuth(err)) return;
    errEl.textContent = err?.response?.data?.error || 'حدث خطأ';
    errEl.classList.remove('hidden');
  }
};

window.deleteMlContact = async function (id) {
  if (!confirm('حذف جهة الاتصال هذه؟')) return;
  await axios.delete(`${API}/message-contacts/${id}`, { params: { customer_id: mlCustomerId } });
  renderMessageListsBody();
};

// ---- List modal ----
window.openMlListModal = async function (id) {
  let list = null, recipientIds = [];
  if (id) {
    const { data } = await axios.get(`${API}/message-lists/${id}`);
    list = data.list;
    recipientIds = (data.recipients || []).map(r => r.id);
  }
  const l = list || { name: '', message_type: '', message_text: '', schedule_time: '19:00', recurrence: 'daily', schedule_days: null, target_region: '', is_active: 1 };
  let days = [];
  try { days = l.schedule_days ? JSON.parse(l.schedule_days) : []; } catch { days = []; }

  const weekDays = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

  const modal = document.getElementById('modal-root');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <h3 class="font-bold text-lg mb-4">${list ? 'تعديل قائمة رسائل' : 'قائمة رسائل جديدة'}</h3>
        <div class="space-y-3">
          <input id="ml-name" value="${l.name}" placeholder="اسم القائمة (مثال: قائمة وكلاء الجوازات)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="ml-type" value="${l.message_type || ''}" placeholder="نوع الرسالة (اختياري، مثال: تسويقي)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <textarea id="ml-text" rows="4" placeholder="نص الرسالة" class="w-full border border-gray-200 rounded-xl px-4 py-2.5">${l.message_text}</textarea>
          <div class="grid grid-cols-2 gap-3">
            <input id="ml-time" type="time" value="${l.schedule_time}" class="border border-gray-200 rounded-xl px-4 py-2.5" />
            <select id="ml-recurrence" onchange="updateMlDaysUI()" class="border border-gray-200 rounded-xl px-4 py-2.5">
              <option value="daily" ${l.recurrence === 'daily' ? 'selected' : ''}>يومي</option>
              <option value="weekly" ${l.recurrence === 'weekly' ? 'selected' : ''}>أسبوعي</option>
              <option value="monthly" ${l.recurrence === 'monthly' ? 'selected' : ''}>شهري</option>
            </select>
          </div>
          <div id="ml-days-box">
            ${l.recurrence === 'weekly' ? `<div class="grid grid-cols-4 gap-1.5">${weekDays.map((d, i) => `<label class="flex items-center gap-1.5 bg-gray-50 rounded-lg px-2 py-1.5 text-xs cursor-pointer"><input type="checkbox" class="ml-day-cb" value="${i}" ${days.includes(i) ? 'checked' : ''}/> ${d}</label>`).join('')}</div>` : ''}
            ${l.recurrence === 'monthly' ? `<input id="ml-monthdays" value="${days.join(', ')}" placeholder="أيام الشهر مفصولة بفاصلة (مثال: 1, 15)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />` : ''}
          </div>
          <input id="ml-region" value="${l.target_region || ''}" placeholder="استهداف منطقة تلقائياً (اختياري، مثال: صنعاء)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <div>
            <p class="text-xs font-bold text-gray-500 mb-2">مستلمون محددون يدوياً (بالإضافة لمن تشمله المنطقة أعلاه)</p>
            <div class="grid grid-cols-2 gap-1.5 max-h-32 overflow-y-auto bg-gray-50 rounded-xl p-2">
              ${mlContactsCache.map(ct => `<label class="flex items-center gap-1.5 text-xs cursor-pointer"><input type="checkbox" class="ml-recipient-cb" value="${ct.id}" ${recipientIds.includes(ct.id) ? 'checked' : ''}/> ${ct.name}</label>`).join('') || '<p class="text-gray-400 text-xs col-span-2">أضف جهات اتصال أولاً</p>'}
            </div>
          </div>
          <label class="flex items-center gap-2 text-sm"><input id="ml-active" type="checkbox" ${l.is_active ? 'checked' : ''}/> القائمة نشطة (مجدولة للإرسال التلقائي)</label>
        </div>
        <div id="ml-error" class="hidden text-red-600 text-xs bg-red-50 rounded-lg p-2 mt-3"></div>
        <div class="flex gap-3 mt-5">
          <button onclick="submitMlList(${id || 'null'})" class="flex-1 bg-brand-600 text-white font-bold py-2.5 rounded-xl">حفظ</button>
          <button onclick="closeModal()" class="flex-1 bg-gray-100 text-gray-700 font-bold py-2.5 rounded-xl">إلغاء</button>
        </div>
      </div>
    </div>
  `;
};

window.updateMlDaysUI = function () {
  const recurrence = document.getElementById('ml-recurrence').value;
  const box = document.getElementById('ml-days-box');
  const weekDays = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  if (recurrence === 'weekly') {
    box.innerHTML = `<div class="grid grid-cols-4 gap-1.5">${weekDays.map((d, i) => `<label class="flex items-center gap-1.5 bg-gray-50 rounded-lg px-2 py-1.5 text-xs cursor-pointer"><input type="checkbox" class="ml-day-cb" value="${i}"/> ${d}</label>`).join('')}</div>`;
  } else if (recurrence === 'monthly') {
    box.innerHTML = `<input id="ml-monthdays" placeholder="أيام الشهر مفصولة بفاصلة (مثال: 1, 15)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />`;
  } else {
    box.innerHTML = '';
  }
};

window.submitMlList = async function (id) {
  const recurrence = document.getElementById('ml-recurrence').value;
  let schedule_days = [];
  if (recurrence === 'weekly') {
    schedule_days = Array.from(document.querySelectorAll('.ml-day-cb:checked')).map(cb => Number(cb.value));
  } else if (recurrence === 'monthly') {
    const raw = document.getElementById('ml-monthdays')?.value || '';
    schedule_days = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n));
  }
  const recipient_contact_ids = Array.from(document.querySelectorAll('.ml-recipient-cb:checked')).map(cb => Number(cb.value));
  const payload = {
    customer_id: mlCustomerId,
    name: document.getElementById('ml-name').value.trim(),
    message_type: document.getElementById('ml-type').value.trim() || null,
    message_text: document.getElementById('ml-text').value.trim(),
    schedule_time: document.getElementById('ml-time').value,
    recurrence,
    schedule_days,
    target_region: document.getElementById('ml-region').value.trim() || null,
    is_active: document.getElementById('ml-active').checked,
    recipient_contact_ids
  };
  const errEl = document.getElementById('ml-error');
  try {
    if (id) await axios.put(`${API}/message-lists/${id}`, payload);
    else await axios.post(`${API}/message-lists`, payload);
    closeModal();
    renderMessageListsBody();
  } catch (err) {
    if (guardAuth(err)) return;
    errEl.textContent = err?.response?.data?.error || 'حدث خطأ';
    errEl.classList.remove('hidden');
  }
};

window.deleteMlList = async function (id) {
  if (!confirm('حذف هذه القائمة نهائياً؟')) return;
  await axios.delete(`${API}/message-lists/${id}`);
  renderMessageListsBody();
};

window.sendMlListNow = async function (id) {
  if (!confirm('إرسال هذه القائمة الآن لكل مستلميها؟')) return;
  try {
    const { data } = await axios.post(`${API}/message-lists/${id}/send-now`);
    alert(`تم وضع الرسالة في قائمة الإرسال لـ ${data.recipients} مستلم`);
    renderMessageListsBody();
  } catch (err) {
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

// ---------------- Platform-wide Meta settings modal (one-time setup) ----------------
window.openMetaSettingsModal = async function () {
  const meta = await getMetaSettings(true);
  const modal = document.getElementById('modal-root');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <h3 class="font-bold text-lg mb-1">ربط حساب واتساب الأعمال بالمنصة</h3>
        <p class="text-xs text-gray-400 mb-4">تُدخل هذه البيانات مرة واحدة فقط لكامل المنصة. بعد ذلك، إضافة أي رقم عميل جديد تتطلب فقط رقم الهاتف — بدون أي معرّفات (ID).</p>
        <div class="space-y-3">
          <input id="ms-waba" placeholder="WhatsApp Business Account ID (WABA ID)" value="${meta.waba_id || ''}" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="ms-token" type="password" placeholder="${meta.has_token ? 'Access Token محفوظ — اتركه فارغاً للإبقاء عليه، أو أدخل واحداً جديداً' : 'Access Token (System User Token)'}" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          ${meta.has_token ? `<div class="bg-emerald-50 text-emerald-700 text-xs rounded-lg px-3 py-2"><i class="fa-solid fa-circle-check ml-1"></i> يوجد Access Token محفوظ بالفعل لهذا الحساب</div>` : ''}
          <button type="button" onclick="browseWabaNumbers()" id="ms-browse-btn" class="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-2.5 rounded-xl text-sm">
            <i class="fa-solid fa-list ml-1"></i> عرض كل الأرقام المتاحة تحت هذا الحساب (اختياري للتأكد)
          </button>
          <div id="ms-lookup-result"></div>
        </div>
        <div id="ms-error" class="hidden text-red-600 text-xs bg-red-50 rounded-lg p-2 mt-3"></div>
        <div id="ms-success" class="hidden text-emerald-600 text-xs bg-emerald-50 rounded-lg p-2 mt-3"></div>
        <div class="flex gap-3 mt-5">
          <button onclick="saveMetaSettings()" id="ms-save-btn" class="flex-1 bg-brand-600 text-white font-bold py-2.5 rounded-xl">حفظ الإعدادات</button>
          <button onclick="closeModal()" class="flex-1 bg-gray-100 text-gray-700 font-bold py-2.5 rounded-xl">إلغاء</button>
        </div>
      </div>
    </div>
  `;
};

// Optional helper inside the settings modal: browse all numbers under the WABA
// ID currently typed, just so the admin can visually confirm before saving.
window.browseWabaNumbers = async function () {
  const waba_id = document.getElementById('ms-waba').value.trim();
  const access_token = document.getElementById('ms-token').value.trim();
  const resultEl = document.getElementById('ms-lookup-result');
  const btn = document.getElementById('ms-browse-btn');
  resultEl.innerHTML = '';
  if (!waba_id || !access_token) {
    resultEl.innerHTML = `<div class="text-red-600 text-xs bg-red-50 rounded-lg p-2 mt-1">أدخل WABA ID والـ Access Token أولاً (Access Token لا يُحفظ تلقائياً هنا، أدخله للعرض فقط)</div>`;
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
    resultEl.innerHTML = `
      <div class="bg-blue-50 rounded-lg p-2 mt-1 text-xs">
        <p class="mb-2">أرقام هذا الحساب (${numbers.length}):</p>
        ${numbers.map(n => `<div class="bg-white border border-gray-200 rounded-lg px-3 py-2 mb-1">${n.display_phone_number} — ${n.verified_name}</div>`).join('')}
      </div>`;
  } catch (err) {
    resultEl.innerHTML = `<div class="text-red-600 text-xs bg-red-50 rounded-lg p-2 mt-1">${err?.response?.data?.error || 'فشل الاتصال بـ Meta'}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-list ml-1"></i> عرض كل الأرقام المتاحة تحت هذا الحساب (اختياري للتأكد)';
  }
};

window.saveMetaSettings = async function () {
  const waba_id = document.getElementById('ms-waba').value.trim();
  const access_token = document.getElementById('ms-token').value.trim();
  const errEl = document.getElementById('ms-error');
  const okEl = document.getElementById('ms-success');
  const btn = document.getElementById('ms-save-btn');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');

  if (!waba_id) {
    errEl.textContent = 'أدخل WABA ID أولاً';
    errEl.classList.remove('hidden');
    return;
  }
  const currentMeta = await getMetaSettings();
  if (!access_token && !currentMeta.has_token) {
    errEl.textContent = 'أدخل الـ Access Token (مطلوب عند أول ربط للحساب)';
    errEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin ml-1"></i> جارِ الحفظ...';
  try {
    const payload = { waba_id };
    if (access_token) payload.access_token = access_token; // omit to keep the saved token
    await axios.put(`${API}/meta-settings`, payload);
    await getMetaSettings(true); // refresh cache
    okEl.textContent = 'تم ربط الحساب بنجاح! يمكنك الآن إضافة أي رقم عميل بإدخال رقم الهاتف فقط.';
    okEl.classList.remove('hidden');
    setTimeout(() => { closeModal(); render(); }, 1200);
  } catch (err) {
    errEl.textContent = err?.response?.data?.error || 'حدث خطأ';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'حفظ الإعدادات';
  }
};

// ---------------- Add new number: phone number ONLY, no IDs ----------------
window.openNumberModal = async function () {
  const fields = await getFields();
  const meta = await getMetaSettings();
  const modal = document.getElementById('modal-root');

  if (!meta.has_token) {
    modal.innerHTML = `
      <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div class="bg-white rounded-2xl p-6 w-full max-w-md text-center">
          <i class="fa-solid fa-triangle-exclamation text-amber-500 text-3xl mb-3"></i>
          <h3 class="font-bold text-lg mb-2">لم يتم ربط حساب واتساب الأعمال بعد</h3>
          <p class="text-sm text-gray-500 mb-5">اربط WABA ID والـ Access Token مرة واحدة أولاً، بعدها ستضيف أي رقم عميل برقم الهاتف فقط.</p>
          <div class="flex gap-3">
            <button onclick="openMetaSettingsModal()" class="flex-1 bg-brand-600 text-white font-bold py-2.5 rounded-xl">ربط الحساب الآن</button>
            <button onclick="closeModal()" class="flex-1 bg-gray-100 text-gray-700 font-bold py-2.5 rounded-xl">إلغاء</button>
          </div>
        </div>
      </div>`;
    return;
  }

  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <h3 class="font-bold text-lg mb-1">ربط رقم واتساب جديد لعميل</h3>
        <p class="text-xs text-gray-400 mb-4">أدخل رقم هاتف العميل فقط — سيتم البحث عنه تلقائياً تحت حساب واتساب الأعمال المربوط بالمنصة وتفعيله دون أي معرّفات (ID) إضافية.</p>
        <div class="space-y-3">
          <select id="wn-customer" class="w-full border border-gray-200 rounded-xl px-4 py-2.5">
            ${customersCache.map(c => `<option value="${c.id}">${c.name} (${c.email})</option>`).join('')}
          </select>
          <input id="wn-name" placeholder="اسم مميز للرقم (مثال: خدمة عملاء الرياض)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="wn-phone" placeholder="رقم هاتف العميل (مثال: 967778260004+)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
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

// One call, phone number only — the backend resolves everything against the
// platform's saved Meta settings (WABA ID + Access Token).
window.submitNumber = async function () {
  const el = document.getElementById('wn-error');
  const btn = document.getElementById('wn-submit-btn');
  el.classList.add('hidden');

  const phone_number = document.getElementById('wn-phone').value.trim();
  if (!phone_number) {
    el.textContent = 'أدخل رقم هاتف العميل';
    el.classList.remove('hidden');
    return;
  }
  const selectedFields = Array.from(document.querySelectorAll('.wn-field-cb:checked')).map(cb => cb.value);
  const payload = {
    customer_id: document.getElementById('wn-customer').value,
    display_name: document.getElementById('wn-name').value || phone_number,
    phone_number,
    extraction_fields: selectedFields.length ? selectedFields : null
  };

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin ml-1"></i> جارِ التفعيل...';
  try {
    await axios.post(`${API}/whatsapp-numbers`, payload);
    closeModal();
    render();
  } catch (err) {
    el.textContent = err?.response?.data?.error || 'حدث خطأ';
    el.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'ربط الرقم وتفعيله';
  }
};

// ---------------- Auto-fix an existing number (zero input — uses its own stored phone number) ----------------
window.autoFixNumber = async function (numberId) {
  const n = numbersCache.find(x => x.id === numberId);
  if (!confirm(`سيتم البحث عن الرقم "${n ? n.phone_number : ''}" تحت حساب واتساب الأعمال المربوط بالمنصة وتحديث بيانات الاتصال تلقائياً. متابعة؟`)) return;
  try {
    await axios.post(`${API}/whatsapp-numbers/${numberId}/auto-fix`);
    render();
  } catch (err) {
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

// ---------------- Shared platform number modal ----------------
window.openSharedNumberModal = async function () {
  const meta = await getMetaSettings(true);
  const shared = sharedNumberCache;
  const modal = document.getElementById('modal-root');
  if (!meta.has_token) {
    modal.innerHTML = `
      <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div class="bg-white rounded-2xl p-6 w-full max-w-md text-center">
          <p class="text-gray-600 mb-4">يجب ربط حساب واتساب الأعمال بالمنصة أولاً قبل تحديد الرقم المشترك.</p>
          <button onclick="closeModal(); openMetaSettingsModal();" class="bg-brand-600 text-white font-bold px-5 py-2.5 rounded-xl">ربط الحساب الآن</button>
        </div>
      </div>`;
    return;
  }
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl p-6 w-full max-w-md">
        <h3 class="font-bold text-lg mb-1">الرقم المشترك للمنصة</h3>
        <p class="text-xs text-gray-400 mb-4">هذا الرقم يخدم كل عملاء الباقات ذات النمط "مشترك". كل عميل يحصل على رابط واتساب خاص بمكتبه (بنفس الرقم)، ويرسل عملاؤه اسم المكتب + كلمة "تفعيل" مرة واحدة للربط.</p>
        <div class="space-y-3">
          <input id="sn-name" value="${shared ? shared.display_name : ''}" placeholder="اسم العرض (مثال: الرقم الموحد للمنصة)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="sn-phone" value="${shared ? shared.phone_number : ''}" placeholder="رقم الهاتف (كما هو مسجل في Meta)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" dir="ltr" />
        </div>
        <div id="sn-error" class="hidden text-red-600 text-xs bg-red-50 rounded-lg p-2 mt-3"></div>
        <div class="flex gap-3 mt-5">
          <button onclick="saveSharedNumber()" id="sn-save-btn" class="flex-1 bg-amber-500 hover:bg-amber-600 text-white font-bold py-2.5 rounded-xl">حفظ</button>
          <button onclick="closeModal()" class="flex-1 bg-gray-100 text-gray-700 font-bold py-2.5 rounded-xl">إلغاء</button>
        </div>
      </div>
    </div>
  `;
};

window.saveSharedNumber = async function () {
  const display_name = document.getElementById('sn-name').value.trim();
  const phone_number = document.getElementById('sn-phone').value.trim();
  const errEl = document.getElementById('sn-error');
  const btn = document.getElementById('sn-save-btn');
  errEl.classList.add('hidden');
  if (!display_name || !phone_number) {
    errEl.textContent = 'الرجاء تعبئة جميع الحقول';
    errEl.classList.remove('hidden');
    return;
  }
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin ml-1"></i> جارِ الحفظ...';
  try {
    await axios.post(`${API}/shared-number`, { display_name, phone_number });
    closeModal();
    render();
  } catch (err) {
    errEl.textContent = err?.response?.data?.error || 'حدث خطأ';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'حفظ';
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

// ---------------- Feature 1: unified welcome/activation message ----------------
async function renderWelcome(area) {
  const { data } = await axios.get(`${API}/welcome-message`);
  area.innerHTML = `
    <div class="bg-white rounded-2xl border border-gray-100 p-8 max-w-2xl">
      <h3 class="font-bold text-lg mb-2">رسالة الترحيب الموحّدة</h3>
      <p class="text-sm text-gray-500 mb-5">
        تُرسَل تلقائياً لأي عميل غير مُفعَّل يكتب رسالة نصية (بدون صورة) على الرقم الخاص أو المشترك.
        <strong>ملاحظة:</strong> المجموعات لا تستقبل هذه الرسالة أبداً — تبقى صامتة حتى تُفعَّل بأمر النص المخصص للمكتب.
      </p>
      <textarea id="wc-message" rows="6" class="w-full border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-brand-500" placeholder="مثال: مرحباً بك 👋 أرسل صورة جواز السفر وسنقوم باستخراج بياناته فوراً.">${data.message || ''}</textarea>
      <div id="wc-error" class="hidden text-red-600 text-sm bg-red-50 rounded-lg p-3 mt-4"></div>
      <div id="wc-success" class="hidden text-emerald-600 text-sm bg-emerald-50 rounded-lg p-3 mt-4">تم الحفظ بنجاح</div>
      <button onclick="saveWelcomeMessage()" class="mt-5 bg-brand-600 hover:bg-brand-700 text-white font-bold px-6 py-3 rounded-xl">
        <i class="fa-solid fa-floppy-disk ml-1"></i> حفظ الرسالة
      </button>
    </div>
  `;
}

window.saveWelcomeMessage = async function () {
  const message = document.getElementById('wc-message').value;
  const errEl = document.getElementById('wc-error');
  const okEl = document.getElementById('wc-success');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');
  try {
    await axios.put(`${API}/welcome-message`, { message });
    okEl.classList.remove('hidden');
    setTimeout(() => okEl.classList.add('hidden'), 2500);
  } catch (err) {
    if (guardAuth(err)) return;
    errEl.textContent = err?.response?.data?.error || 'حدث خطأ';
    errEl.classList.remove('hidden');
  }
};

// ---------------- Feature 3: suggestion box ----------------
let suggestionsFilter = '';
async function renderSuggestions(area) {
  const { data } = await axios.get(`${API}/suggestions`, { params: suggestionsFilter ? { status: suggestionsFilter } : {} });
  const items = data.suggestions;
  area.innerHTML = `
    <div class="flex items-center gap-2 mb-5">
      ${['', 'new', 'reviewed', 'done'].map(s => `
        <button onclick="filterSuggestions('${s}')" class="px-4 py-2 rounded-xl text-sm font-bold ${suggestionsFilter === s ? 'bg-brand-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}">
          ${s === '' ? 'الكل' : s === 'new' ? 'جديد' : s === 'reviewed' ? 'تمت المراجعة' : 'مُنفّذ'}
        </button>`).join('')}
    </div>
    <div class="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-right text-gray-400 bg-gray-50 border-b border-gray-100">
          <th class="p-4 font-medium">المكتب</th><th class="p-4 font-medium">المقترح</th>
          <th class="p-4 font-medium">الحالة</th><th class="p-4 font-medium">التاريخ</th><th class="p-4 font-medium"></th>
        </tr></thead>
        <tbody>
          ${items.map(s => `
            <tr class="border-b border-gray-50">
              <td class="p-4 font-semibold">${s.customer_name || '-'}</td>
              <td class="p-4 text-gray-600 max-w-md">${s.message}</td>
              <td class="p-4">${statusBadge(s.status)}</td>
              <td class="p-4 text-gray-400 text-xs">${fmtDate(s.created_at)}</td>
              <td class="p-4">
                <select onchange="updateSuggestionStatus(${s.id}, this.value)" class="text-xs border border-gray-200 rounded-lg px-2 py-1">
                  <option value="new" ${s.status === 'new' ? 'selected' : ''}>جديد</option>
                  <option value="reviewed" ${s.status === 'reviewed' ? 'selected' : ''}>تمت المراجعة</option>
                  <option value="done" ${s.status === 'done' ? 'selected' : ''}>مُنفّذ</option>
                </select>
              </td>
            </tr>`).join('') || '<tr><td colspan="5" class="p-8 text-center text-gray-400">لا توجد مقترحات بعد</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

window.filterSuggestions = function (status) {
  suggestionsFilter = status;
  render();
};

window.updateSuggestionStatus = async function (id, status) {
  try {
    await axios.put(`${API}/suggestions/${id}`, { status });
  } catch (err) {
    if (guardAuth(err)) return;
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
  render();
};

// ---------------- Feature 4: Umrah visa-check monitor ----------------
let visaChecksFilter = '';
async function renderVisaChecks(area) {
  const { data } = await axios.get(`${API}/visa-checks`, { params: visaChecksFilter ? { status: visaChecksFilter } : {} });
  const items = data.checks;
  area.innerHTML = `
    <div class="flex items-center gap-2 mb-5 flex-wrap">
      ${['', 'pending', 'checking', 'found', 'failed', 'cancelled'].map(s => `
        <button onclick="filterVisaChecks('${s}')" class="px-4 py-2 rounded-xl text-sm font-bold ${visaChecksFilter === s ? 'bg-brand-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}">
          ${s === '' ? 'الكل' : statusBadge(s).replace(/<[^>]+>/g, '')}
        </button>`).join('')}
    </div>
    <div class="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-right text-gray-400 bg-gray-50 border-b border-gray-100">
          <th class="p-4 font-medium">المكتب</th><th class="p-4 font-medium">الاسم</th>
          <th class="p-4 font-medium">رقم الجواز</th><th class="p-4 font-medium">الحالة</th>
          <th class="p-4 font-medium">عدد المحاولات</th><th class="p-4 font-medium">آخر فحص</th>
          <th class="p-4 font-medium">الفحص القادم</th>
        </tr></thead>
        <tbody>
          ${items.map(v => `
            <tr class="border-b border-gray-50">
              <td class="p-4 font-semibold">${v.customer_name || '-'}</td>
              <td class="p-4">${v.first_name}</td>
              <td class="p-4 text-gray-500">${v.passport_number}</td>
              <td class="p-4">${statusBadge(v.status)}</td>
              <td class="p-4 text-gray-500">${v.check_count}</td>
              <td class="p-4 text-gray-400 text-xs">${fmtDate(v.last_checked_at)}</td>
              <td class="p-4 text-gray-400 text-xs">${v.status === 'pending' || v.status === 'checking' ? fmtDate(v.next_check_at) : '-'}</td>
            </tr>`).join('') || '<tr><td colspan="7" class="p-8 text-center text-gray-400">لا توجد فحوصات بعد</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

window.filterVisaChecks = function (status) {
  visaChecksFilter = status;
  render();
};

// ---------------------- Activation/deactivation commands overview ----------------------
let activationSearch = '';
let activationCommandsCache = [];

async function renderActivationCommands(area) {
  const { data } = await axios.get(`${API}/activation-commands`);
  activationCommandsCache = data.offices;
  area.innerHTML = `
    <div class="bg-blue-50 border border-blue-100 rounded-2xl p-5 mb-6">
      <button onclick="document.getElementById('gen-cmds-box').classList.toggle('hidden')" class="flex items-center justify-between w-full text-right">
        <span class="font-bold text-blue-800"><i class="fa-solid fa-circle-info ml-1"></i> الأوامر العامة (تعمل لأي مكتب مُفعَّل بعد الربط) — اضغط للعرض/الإخفاء</span>
        <i class="fa-solid fa-chevron-down text-blue-400"></i>
      </button>
      <div id="gen-cmds-box" class="hidden mt-4 grid md:grid-cols-2 gap-3 text-sm">
        <div class="bg-white rounded-xl p-3 border border-blue-100">
          <div class="font-bold text-gray-700 mb-1">فحص فوري لتأشيرة العمرة</div>
          <div class="text-gray-500">فحص التاشيره / فحص التأشيرة / فحص الفيزا / تحقق من التاشيره / تحقق التاشيره</div>
        </div>
        <div class="bg-white rounded-xl p-3 border border-blue-100">
          <div class="font-bold text-gray-700 mb-1">عرض القائمة التراكمية</div>
          <div class="text-gray-500">القائمه / القائمة / قائمه الاسماء / قائمة الأسماء</div>
        </div>
        <div class="bg-white rounded-xl p-3 border border-blue-100">
          <div class="font-bold text-gray-700 mb-1">تقرير دوري (نصي أو PDF)</div>
          <div class="text-gray-500">تقرير يومي / تقرير شهري / تقرير سنوي (أضف "pdf" أو "مستند" للحصول على ملف PDF)</div>
        </div>
        <div class="bg-white rounded-xl p-3 border border-blue-100">
          <div class="font-bold text-gray-700 mb-1">إرسال مقترح</div>
          <div class="text-gray-500">اقتراح: ... (النص بعد الكلمة يُحفظ في صندوق المقترحات)</div>
        </div>
        <div class="bg-white rounded-xl p-3 border border-blue-100">
          <div class="font-bold text-gray-700 mb-1">تفعيل/إلغاء القائمة التراكمية (لكل مكتب)</div>
          <div class="text-gray-500">تفعيل القائمة ← تشغيل | الغاء القائمة ← إيقاف (معطّلة افتراضياً)</div>
        </div>
        <div class="bg-white rounded-xl p-3 border border-blue-100">
          <div class="font-bold text-gray-700 mb-1">تفعيل/إلغاء الفحص الدوري لتأشيرة العمرة (لكل مكتب)</div>
          <div class="text-gray-500">تفعيل فحص التاشيره / فحص دوري ← تشغيل (فحص تلقائي كل 30 دقيقة) | الغاء فحص التاشيره / إلغاء الفحص الدوري ← إيقاف (معطّلة افتراضياً)</div>
        </div>
      </div>
    </div>

    <div class="flex items-center justify-between mb-4 gap-3">
      <div class="relative flex-1 max-w-sm">
        <i class="fa-solid fa-magnifying-glass absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 text-sm"></i>
        <input id="activation-search" value="${activationSearch}" oninput="filterActivationCommands(this.value)" placeholder="ابحث باسم المكتب..." class="w-full border border-gray-200 rounded-xl pr-9 pl-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
      </div>
      <span class="text-xs text-gray-400">${data.offices.length} مكتب على الرقم المشترك</span>
    </div>

    <div class="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-right text-gray-400 bg-gray-50 border-b border-gray-100">
          <th class="p-4 font-medium">المكتب</th>
          <th class="p-4 font-medium">أمر التفعيل</th>
          <th class="p-4 font-medium">أمر الإلغاء</th>
          <th class="p-4 font-medium">جلسات نشطة</th>
          <th class="p-4 font-medium">حالة الميزات</th>
          <th class="p-4 font-medium"></th>
        </tr></thead>
        <tbody id="activation-tbody"></tbody>
      </table>
    </div>
  `;
  renderActivationRows();
}

function renderActivationRows() {
  const tbody = document.getElementById('activation-tbody');
  const target = (activationSearch || '').trim();
  const list = target ? activationCommandsCache.filter(o => o.name.includes(target)) : activationCommandsCache;
  tbody.innerHTML = list.map(o => `
    <tr class="border-b border-gray-50">
      <td class="p-4 font-semibold">${o.name}</td>
      <td class="p-4">
        <span class="inline-flex items-center gap-2 text-xs font-bold px-2.5 py-1 rounded-full ${o.activation_is_custom ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-600'}">
          <i class="fa-solid ${o.activation_is_custom ? 'fa-star' : 'fa-circle-dot'}"></i> ${o.activation_is_custom ? 'مخصص' : 'افتراضي'}
        </span>
        <span class="text-gray-700 mr-2">${o.activation_command}</span>
        ${copyBtn(o.activation_command)}
      </td>
      <td class="p-4">
        ${o.deactivation_command
          ? `<span class="text-gray-700">${o.deactivation_command}</span> ${copyBtn(o.deactivation_command)}`
          : '<span class="text-gray-400 text-xs">لا يوجد أمر إلغاء</span>'}
      </td>
      <td class="p-4 text-gray-500">${o.active_sessions}</td>
      <td class="p-4">${featureBadges(o.features)}</td>
      <td class="p-4">
        <button onclick="openCustomerDetail(${o.id})" class="text-brand-600 hover:underline text-xs font-bold">تعديل</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="6" class="p-8 text-center text-gray-400">لا يوجد مكاتب على الرقم المشترك حالياً</td></tr>';
}

// Feature toggles are set ONLY via WhatsApp commands ("بأوامر فقط") — this
// is a read-only status display, no edit control here on purpose.
function featureBadges(features) {
  if (!features) return '';
  const badge = (label, enabled) => `
    <span class="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full ${enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}">
      <i class="fa-solid ${enabled ? 'fa-check' : 'fa-xmark'}"></i> ${label}
    </span>`;
  return `<div class="flex flex-col gap-1">
    ${badge('القائمة التراكمية', features.cumulative_list?.enabled)}
    ${badge('فحص التأشيرة', features.visa_check?.enabled)}
  </div>`;
}

window.filterActivationCommands = function (value) {
  activationSearch = value;
  renderActivationRows();
};

// ---------------- Feature 5: Knowledge Base (قاعدة المعرفة) ----------------
// Admin view: pick any office, manage its confirmed staff numbers (used to
// tell staff answers apart from customer messages), and review/approve the
// knowledge items extracted by Gemini from the office's WhatsApp conversations.
// Nothing here is used live by the bot yet — everything starts as
// "pending_review" and must be approved manually (a later phase).
let kbCustomerId = null;
let kbStaffCache = [];
let kbItemsCache = [];
let kbStatusFilter = 'pending_review';

async function renderKnowledgeBase(area) {
  if (!customersCache.length) {
    const { data } = await axios.get(`${API}/customers`);
    customersCache = data.customers;
  }
  if (!kbCustomerId && customersCache.length) kbCustomerId = customersCache[0].id;

  area.innerHTML = `
    <div class="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl p-4 mb-5">
      <i class="fa-solid fa-circle-info ml-1"></i>
      قاعدة المعرفة تُستخرج تلقائياً من محادثات المكتب على واتساب (لا تُخترع معلومات ولا تُعتبر كلام العميل حقيقة إلا إذا أكّده موظف مسجَّل). كل عنصر يبقى "قيد المراجعة" حتى تعتمده يدوياً.
    </div>
    <div class="flex items-center gap-3 mb-5">
      <label class="text-sm font-bold text-gray-600">المكتب:</label>
      <select id="kb-customer-select" class="border border-gray-200 rounded-xl px-4 py-2.5 text-sm min-w-[220px]">
        ${customersCache.map(c => `<option value="${c.id}" ${c.id === kbCustomerId ? 'selected' : ''}>${c.name}</option>`).join('')}
      </select>
      <button onclick="analyzeKbNow()" class="bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold px-4 py-2.5 rounded-xl">
        <i class="fa-solid fa-wand-magic-sparkles ml-1"></i> تحليل الآن
      </button>
    </div>
    <div id="kb-body"></div>
  `;
  document.getElementById('kb-customer-select').addEventListener('change', (e) => {
    kbCustomerId = Number(e.target.value);
    renderKnowledgeBaseBody();
  });
  await renderKnowledgeBaseBody();
}

async function renderKnowledgeBaseBody() {
  const body = document.getElementById('kb-body');
  body.innerHTML = '<div class="text-center text-gray-400 py-10"><i class="fa-solid fa-spinner fa-spin"></i></div>';
  if (!kbCustomerId) { body.innerHTML = '<p class="text-gray-400 text-center py-10">أضف عميلاً أولاً</p>'; return; }

  const [{ data: staffData }, { data: itemsData }] = await Promise.all([
    axios.get(`${API}/staff-numbers`, { params: { customer_id: kbCustomerId } }),
    axios.get(`${API}/knowledge-base`, { params: { customer_id: kbCustomerId, ...(kbStatusFilter ? { status: kbStatusFilter } : {}) } })
  ]);
  kbStaffCache = staffData.staff_numbers;
  kbItemsCache = itemsData.items;

  body.innerHTML = `
    <div class="grid lg:grid-cols-3 gap-6">
      <div class="bg-white rounded-2xl border border-gray-100 p-5 lg:col-span-1">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-gray-900">أرقام الموظفين (${kbStaffCache.length})</h3>
          <button onclick="openKbStaffModal()" class="bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold px-3 py-2 rounded-lg"><i class="fa-solid fa-plus ml-1"></i> رقم</button>
        </div>
        <p class="text-xs text-gray-400 mb-3">فقط الرسائل الواردة من هذه الأرقام تُعتبر "إجابة موظف مؤكدة" عند استخراج المعرفة.</p>
        <div class="space-y-2 max-h-96 overflow-y-auto">
          ${kbStaffCache.map(s => `
            <div class="flex items-center justify-between bg-gray-50 rounded-lg p-3 text-sm">
              <div>
                <p class="font-semibold">${s.label || 'بدون اسم'}</p>
                <p class="text-xs text-gray-400" dir="ltr">${s.identifier}</p>
              </div>
              <button onclick="deleteKbStaff(${s.id})" class="text-gray-400 hover:text-red-500 text-xs"><i class="fa-solid fa-trash"></i></button>
            </div>`).join('') || '<p class="text-gray-400 text-center py-6 text-sm">لا توجد أرقام موظفين مسجّلة بعد</p>'}
        </div>
      </div>

      <div class="bg-white rounded-2xl border border-gray-100 p-5 lg:col-span-2">
        <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h3 class="font-bold text-gray-900">عناصر المعرفة (${kbItemsCache.length})</h3>
          <div class="flex items-center gap-2">
            ${['pending_review', 'approved', 'rejected', ''].map(s => `
              <button onclick="filterKbStatus('${s}')" class="px-3 py-1.5 rounded-lg text-xs font-bold ${kbStatusFilter === s ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600'}">
                ${s === '' ? 'الكل' : s === 'pending_review' ? 'قيد المراجعة' : s === 'approved' ? 'معتمدة' : 'مرفوضة'}
              </button>`).join('')}
          </div>
        </div>
        <div class="space-y-3 max-h-[32rem] overflow-y-auto">
          ${kbItemsCache.map(it => `
            <div class="bg-gray-50 rounded-xl p-4 text-sm border border-gray-100">
              <div class="flex items-center justify-between mb-2 flex-wrap gap-1">
                <span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">${it.category}</span>
                <div class="flex items-center gap-1">
                  ${it.is_conflicting ? '<span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-700">متعارضة</span>' : ''}
                  ${it.needs_review ? '<span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">تحتاج مراجعة</span>' : ''}
                  <span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">ثقة: ${confidenceLabel(it.confidence)}</span>
                </div>
              </div>
              ${it.question_intent ? `<p class="text-gray-500 text-xs mb-1"><i class="fa-solid fa-circle-question ml-1"></i>${it.question_intent}</p>` : ''}
              <p class="font-semibold text-gray-800 mb-1">${it.knowledge}</p>
              ${it.suggested_answer ? `<p class="text-gray-600 text-xs mb-1"><i class="fa-solid fa-reply ml-1"></i>${it.suggested_answer}</p>` : ''}
              <p class="text-[11px] text-gray-400">المصدر: ${it.source || '-'} — ${fmtDate(it.extracted_at)}</p>
              <div class="flex items-center justify-between mt-3">
                <span>${statusBadge(it.status === 'pending_review' ? 'new' : it.status === 'approved' ? 'done' : 'cancelled')}</span>
                <div class="flex gap-2">
                  ${it.status !== 'approved' ? `<button onclick="updateKbStatus(${it.id}, 'approved')" class="text-emerald-600 hover:underline text-xs font-bold">اعتماد</button>` : ''}
                  ${it.status !== 'rejected' ? `<button onclick="updateKbStatus(${it.id}, 'rejected')" class="text-amber-600 hover:underline text-xs font-bold">رفض</button>` : ''}
                  <button onclick="deleteKbItem(${it.id})" class="text-red-500 hover:underline text-xs font-bold">حذف</button>
                </div>
              </div>
            </div>`).join('') || '<p class="text-gray-400 text-center py-10 text-sm">لا توجد عناصر معرفة بهذا الفلتر بعد</p>'}
        </div>
      </div>
    </div>
    <div id="modal-root"></div>
  `;
}

function confidenceLabel(c) {
  return c === 'high' ? 'عالية' : c === 'medium' ? 'متوسطة' : c === 'low' ? 'منخفضة' : 'غير معروفة';
}

window.filterKbStatus = function (status) {
  kbStatusFilter = status;
  renderKnowledgeBaseBody();
};

window.openKbStaffModal = function () {
  const modal = document.getElementById('modal-root');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl p-6 w-full max-w-md">
        <h3 class="font-bold text-lg mb-4">إضافة رقم موظف</h3>
        <div class="space-y-3">
          <input id="kb-staff-label" placeholder="اسم الموظف (اختياري)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="kb-staff-identifier" placeholder="رقم الواتساب أو JID، مثال: 9665xxxxxxxx" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" dir="ltr" />
        </div>
        <div class="flex gap-2 mt-5">
          <button onclick="closeModal()" class="flex-1 border border-gray-200 rounded-xl py-2.5 font-bold text-gray-600">إلغاء</button>
          <button onclick="saveKbStaff()" class="flex-1 bg-brand-600 hover:bg-brand-700 text-white rounded-xl py-2.5 font-bold">حفظ</button>
        </div>
      </div>
    </div>
  `;
};

window.saveKbStaff = async function () {
  const identifier = document.getElementById('kb-staff-identifier').value.trim();
  const label = document.getElementById('kb-staff-label').value.trim();
  if (!identifier) { alert('الرجاء إدخال رقم أو JID'); return; }
  try {
    await axios.post(`${API}/staff-numbers`, { customer_id: kbCustomerId, identifier, label: label || null });
    closeModal();
    await renderKnowledgeBaseBody();
  } catch (err) {
    if (guardAuth(err)) return;
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

window.deleteKbStaff = async function (id) {
  if (!confirm('حذف هذا الرقم من قائمة الموظفين؟')) return;
  try {
    await axios.delete(`${API}/staff-numbers/${id}`, { params: { customer_id: kbCustomerId } });
    await renderKnowledgeBaseBody();
  } catch (err) {
    if (guardAuth(err)) return;
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

window.updateKbStatus = async function (id, status) {
  try {
    await axios.put(`${API}/knowledge-base/${id}`, { status });
    await renderKnowledgeBaseBody();
  } catch (err) {
    if (guardAuth(err)) return;
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

window.deleteKbItem = async function (id) {
  if (!confirm('حذف عنصر المعرفة هذا نهائياً؟')) return;
  try {
    await axios.delete(`${API}/knowledge-base/${id}`);
    await renderKnowledgeBaseBody();
  } catch (err) {
    if (guardAuth(err)) return;
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

window.analyzeKbNow = async function () {
  if (!kbCustomerId) return;
  try {
    const { data } = await axios.post(`${API}/knowledge-base/analyze-now`, { customer_id: kbCustomerId });
    if (data.error) { alert(data.error); return; }
    alert(`تم التحليل — رسائل مُحلَّلة: ${data.analyzed ?? 0}، عناصر مستخرجة: ${data.extracted ?? 0}`);
    await renderKnowledgeBaseBody();
  } catch (err) {
    if (guardAuth(err)) return;
    alert(err?.response?.data?.error || 'حدث خطأ أثناء التحليل');
  }
};

// ---------------- Smart Employee (الموظف الذكي) ----------------
// Per-office: master toggle + follow-up timers, agents, suppliers,
// transactions list/detail, and WhatsApp-group role classification.
let seCustomerId = null;
let seGroupsCache = [];
let seAgentsCache = [];
let seSuppliersCache = [];
let seSubTab = 'transactions';

const TX_STATUS_LABELS = {
  NEW: 'جديدة', RECEIVED_FROM_AGENT: 'استُلمت من الوكيل', WAITING_AGENT_CONFIRMATION: 'بانتظار تأكيد الوكيل',
  SENT_TO_SUPPLIER: 'أُرسلت للمورد', WAITING_HOSTING: 'بانتظار الاستضافة', HOSTING_RECEIVED: 'استُلمت الاستضافة',
  HOSTING_SENT_TO_AGENT: 'أُرسلت الاستضافة للوكيل', VISA_WAITING: 'بانتظار التأشيرة', VISA_RECEIVED: 'استُلمت التأشيرة',
  VISA_SENT_TO_AGENT: 'أُرسلت التأشيرة للوكيل', COMPLETED: 'مكتملة', NEEDS_REVIEW: 'تحتاج مراجعة',
  MISSING_DOCUMENT: 'مستند ناقص', WRONG_PERSON: 'شخص خاطئ', DUPLICATE_DOCUMENT: 'مستند مكرر',
  FAILED_TRANSFER: 'فشل التحويل', CANCELLED: 'ملغاة'
};
function txStatusBadge(status) {
  const doneSet = ['COMPLETED'];
  const badSet = ['NEEDS_REVIEW', 'MISSING_DOCUMENT', 'WRONG_PERSON', 'DUPLICATE_DOCUMENT', 'FAILED_TRANSFER', 'CANCELLED'];
  const cls = doneSet.includes(status) ? 'bg-emerald-50 text-emerald-700' : badSet.includes(status) ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700';
  return `<span class="text-xs font-bold px-2.5 py-1 rounded-full ${cls}">${TX_STATUS_LABELS[status] || status}</span>`;
}

async function renderSmartEmployee(area) {
  if (!customersCache.length) {
    const { data } = await axios.get(`${API}/customers`);
    customersCache = data.customers;
  }
  if (!seCustomerId && customersCache.length) seCustomerId = customersCache[0].id;

  area.innerHTML = `
    <div class="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl p-4 mb-5">
      <i class="fa-solid fa-circle-info ml-1"></i>
      الموظف الذكي يُدير معاملات العمرة بين الوكلاء (من يرسل الجوازات) والموردين (من يُنفّذ الاستضافة والتأشيرة) داخل مجموعات واتساب مصنَّفة. يجب تفعيل الميزة لكل مكتب، ثم تصنيف مجموعاته من تبويب "مجموعات واتساب".
    </div>
    <div class="flex items-center gap-3 mb-5">
      <label class="text-sm font-bold text-gray-600">المكتب:</label>
      <select id="se-customer-select" class="border border-gray-200 rounded-xl px-4 py-2.5 text-sm min-w-[220px]">
        ${customersCache.map(c => `<option value="${c.id}" ${c.id === seCustomerId ? 'selected' : ''}>${c.name}</option>`).join('')}
      </select>
    </div>
    <div id="se-body"></div>
  `;
  document.getElementById('se-customer-select').addEventListener('change', (e) => {
    seCustomerId = Number(e.target.value);
    renderSmartEmployeeBody();
  });
  await renderSmartEmployeeBody();
}

async function renderSmartEmployeeBody() {
  const body = document.getElementById('se-body');
  body.innerHTML = '<div class="text-center text-gray-400 py-10"><i class="fa-solid fa-spinner fa-spin"></i></div>';
  if (!seCustomerId) { body.innerHTML = '<p class="text-gray-400 text-center py-10">أضف عميلاً أولاً</p>'; return; }

  const customer = customersCache.find(c => c.id === seCustomerId) || {};
  const enabled = !!customer.feature_smart_employee_enabled;

  body.innerHTML = `
    <div class="bg-white rounded-2xl border border-gray-100 p-5 mb-6">
      <div class="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h3 class="font-bold text-gray-900 mb-1">تفعيل الموظف الذكي لهذا المكتب</h3>
          <p class="text-xs text-gray-500">عند التفعيل تُدار مجموعات الوكلاء والموردين المصنَّفة لهذا المكتب عبر آلة حالات المعاملات.</p>
        </div>
        <label class="inline-flex items-center gap-2 cursor-pointer">
          <input type="checkbox" id="se-enabled-toggle" ${enabled ? 'checked' : ''} class="w-5 h-5 accent-brand-600" />
          <span class="text-sm font-bold ${enabled ? 'text-emerald-600' : 'text-gray-400'}">${enabled ? 'مفعّل' : 'غير مفعّل'}</span>
        </label>
      </div>
      <div class="grid sm:grid-cols-3 gap-4 mt-5 pt-5 border-t border-gray-100">
        <div>
          <label class="block text-xs font-bold text-gray-500 mb-1">مهلة تذكير التأكيد (دقيقة)</label>
          <input id="se-min-confirm" type="number" min="0" value="${customer.followup_confirmation_minutes ?? 30}" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label class="block text-xs font-bold text-gray-500 mb-1">مهلة متابعة الاستضافة (دقيقة)</label>
          <input id="se-min-hosting" type="number" min="0" value="${customer.followup_hosting_minutes ?? 60}" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label class="block text-xs font-bold text-gray-500 mb-1">مهلة متابعة التأشيرة (دقيقة)</label>
          <input id="se-min-visa" type="number" min="0" value="${customer.followup_visa_minutes ?? 120}" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>

      <div class="mt-5 pt-5 border-t border-gray-100">
        <h4 class="font-bold text-gray-900 text-sm mb-1">إشارات إغلاق/رفع المعاملة</h4>
        <p class="text-xs text-gray-500 mb-3">بعض المكاتب تغلق المعاملة بكلمات مختلفة عن الكلمات الافتراضية ("ارفع"، "ارفعوا"، "رحّل"...)، أو ترسل ملصق (sticker) بدلاً من كتابة نص. حدد هنا ما يناسب مكتبك.</p>
        <label class="block text-xs font-bold text-gray-500 mb-1">كلمات/عبارات إغلاق إضافية (اختياري، مفصولة بفاصلة أو سطر جديد)</label>
        <textarea id="se-close-phrases" rows="2" placeholder="مثال: خلصوها, تم الرفع, رفعنا المعاملة" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-3">${customer.se_close_phrases || ''}</textarea>
        <label class="inline-flex items-center gap-2 cursor-pointer">
          <input type="checkbox" id="se-accept-sticker" ${customer.se_accept_sticker_as_close ? 'checked' : ''} class="w-5 h-5 accent-brand-600" />
          <span class="text-sm font-bold text-gray-700">اعتبار أي ملصق (sticker) يُرسل في مجموعة الوكيل إشارة لرفع المعاملة</span>
        </label>
      </div>

      <button onclick="saveSeSettings()" class="mt-4 bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold px-5 py-2.5 rounded-xl">حفظ الإعدادات</button>
    </div>

    <div class="flex gap-2 mb-5 border-b border-gray-100">
      <button data-se-sub="transactions" class="se-sub-btn px-4 py-2.5 text-sm font-bold border-b-2 ${seSubTab === 'transactions' ? 'border-brand-600 text-brand-600' : 'border-transparent text-gray-400'}">المعاملات</button>
      <button data-se-sub="agents" class="se-sub-btn px-4 py-2.5 text-sm font-bold border-b-2 ${seSubTab === 'agents' ? 'border-brand-600 text-brand-600' : 'border-transparent text-gray-400'}">الوكلاء</button>
      <button data-se-sub="suppliers" class="se-sub-btn px-4 py-2.5 text-sm font-bold border-b-2 ${seSubTab === 'suppliers' ? 'border-brand-600 text-brand-600' : 'border-transparent text-gray-400'}">الموردون</button>
      <button data-se-sub="groups" class="se-sub-btn px-4 py-2.5 text-sm font-bold border-b-2 ${seSubTab === 'groups' ? 'border-brand-600 text-brand-600' : 'border-transparent text-gray-400'}">تصنيف المجموعات</button>
    </div>
    <div id="se-sub-body"></div>
  `;

  document.querySelectorAll('.se-sub-btn').forEach(btn => {
    btn.addEventListener('click', () => { seSubTab = btn.dataset.seSub; renderSmartEmployeeBody(); });
  });

  const subBody = document.getElementById('se-sub-body');
  if (seSubTab === 'transactions') await renderSeTransactions(subBody);
  else if (seSubTab === 'agents') await renderSeAgents(subBody);
  else if (seSubTab === 'suppliers') await renderSeSuppliers(subBody);
  else if (seSubTab === 'groups') await renderSeGroups(subBody);
}

window.saveSeSettings = async function () {
  try {
    await axios.put(`${API}/customers/${seCustomerId}/smart-employee`, {
      enabled: document.getElementById('se-enabled-toggle').checked,
      followup_confirmation_minutes: Number(document.getElementById('se-min-confirm').value) || 0,
      followup_hosting_minutes: Number(document.getElementById('se-min-hosting').value) || 0,
      followup_visa_minutes: Number(document.getElementById('se-min-visa').value) || 0,
      se_close_phrases: document.getElementById('se-close-phrases').value || null,
      se_accept_sticker_as_close: document.getElementById('se-accept-sticker').checked
    });
    const { data } = await axios.get(`${API}/customers`);
    customersCache = data.customers;
    await renderSmartEmployeeBody();
  } catch (err) {
    if (guardAuth(err)) return;
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

// ---- Transactions sub-tab ----
async function renderSeTransactions(body, statusFilter) {
  body.innerHTML = '<div class="text-center text-gray-400 py-10"><i class="fa-solid fa-spinner fa-spin"></i></div>';
  const { data } = await axios.get(`${API}/transactions`, { params: { customer_id: seCustomerId, status: statusFilter || undefined } });
  const txs = data.transactions || [];

  body.innerHTML = `
    <div class="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-right text-gray-400 bg-gray-50 border-b border-gray-100">
          <th class="p-4 font-medium">رقم المعاملة</th><th class="p-4 font-medium">الوكيل</th>
          <th class="p-4 font-medium">المورد</th><th class="p-4 font-medium">الحالة</th>
          <th class="p-4 font-medium">آخر تحديث</th><th class="p-4 font-medium"></th>
        </tr></thead>
        <tbody>
          ${txs.map(t => `
            <tr class="border-b border-gray-50">
              <td class="p-4 font-mono font-bold">${t.transaction_code}</td>
              <td class="p-4 text-gray-500">${t.agent_name || '-'}</td>
              <td class="p-4 text-gray-500">${t.supplier_name || '-'}</td>
              <td class="p-4">${txStatusBadge(t.status)}</td>
              <td class="p-4 text-gray-400 text-xs">${fmtDate(t.updated_at)}</td>
              <td class="p-4"><button onclick="viewTransaction(${t.id})" class="text-brand-600 hover:underline text-xs font-bold">تفاصيل</button></td>
            </tr>`).join('') || '<tr><td colspan="6" class="p-8 text-center text-gray-400">لا توجد معاملات بعد</td></tr>'}
        </tbody>
      </table>
    </div>
    <div id="se-tx-detail-modal"></div>
  `;
}

window.viewTransaction = async function (id) {
  const { data } = await axios.get(`${API}/transactions/${id}`);
  const t = data.transaction;
  const modal = document.getElementById('se-tx-detail-modal');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onclick="if(event.target===this) this.remove()">
      <div class="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-6" onclick="event.stopPropagation()">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-lg">معاملة ${t.transaction_code}</h3>
          ${txStatusBadge(t.status)}
        </div>
        <div class="grid grid-cols-2 gap-3 text-sm mb-5">
          <div><span class="text-gray-400">الوكيل:</span> ${t.agent_name || '-'}</div>
          <div><span class="text-gray-400">المورد:</span> ${t.supplier_name || '-'}</div>
          <div><span class="text-gray-400">رقم المضيف:</span> ${t.host_phone || '-'}</div>
          <div><span class="text-gray-400">أُنشئت:</span> ${fmtDate(t.created_at)}</div>
        </div>
        <h4 class="font-bold text-sm mb-2">الأشخاص (${t.people.length})</h4>
        <div class="space-y-2 mb-5">
          ${t.people.map(p => `
            <div class="bg-gray-50 rounded-xl p-3 text-sm flex items-center justify-between">
              <span>${p.document_type === 'iqama' ? '🪪' : '🛂'} ${p.full_name_ar || '(بدون اسم)'} — ${p.document_number || '-'}</span>
              <span class="text-xs text-gray-400">${p.status === 'needs_review' ? '⚠️ مراجعة' : ''}</span>
            </div>`).join('') || '<p class="text-gray-400 text-xs">لا يوجد أشخاص مسجلون</p>'}
        </div>
        <h4 class="font-bold text-sm mb-2">سجل الحالات</h4>
        <div class="space-y-1 mb-5 text-xs text-gray-500">
          ${t.history.map(h => `<div>${fmtDate(h.created_at)} — ${h.from_status || 'بداية'} ← ${TX_STATUS_LABELS[h.to_status] || h.to_status} (${h.changed_by})${h.reason ? ' — ' + h.reason : ''}</div>`).join('')}
        </div>
        <div class="flex items-center gap-2 pt-4 border-t border-gray-100">
          <select id="se-tx-status-select" class="border border-gray-200 rounded-lg px-3 py-2 text-sm flex-1">
            ${Object.keys(TX_STATUS_LABELS).map(s => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${TX_STATUS_LABELS[s]}</option>`).join('')}
          </select>
          <button onclick="forceTransactionStatus(${t.id})" class="bg-gray-800 hover:bg-gray-900 text-white text-sm font-bold px-4 py-2 rounded-lg">تغيير يدوي</button>
        </div>
      </div>
    </div>
  `;
};

window.forceTransactionStatus = async function (id) {
  const status = document.getElementById('se-tx-status-select').value;
  const reason = prompt('سبب التغيير اليدوي (اختياري):') || null;
  try {
    await axios.put(`${API}/transactions/${id}/status`, { status, reason });
    document.getElementById('se-tx-detail-modal').innerHTML = '';
    await renderSeTransactions(document.getElementById('se-sub-body'));
  } catch (err) {
    if (guardAuth(err)) return;
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

// ---- Agents sub-tab ----
async function renderSeAgents(body) {
  body.innerHTML = '<div class="text-center text-gray-400 py-10"><i class="fa-solid fa-spinner fa-spin"></i></div>';
  const [{ data: agentsData }, { data: suppliersData }] = await Promise.all([
    axios.get(`${API}/agents`, { params: { customer_id: seCustomerId } }),
    axios.get(`${API}/suppliers`, { params: { customer_id: seCustomerId } })
  ]);
  seAgentsCache = agentsData.agents || [];
  seSuppliersCache = suppliersData.suppliers || [];

  body.innerHTML = `
    <div class="bg-white rounded-2xl border border-gray-100 p-5 mb-5">
      <h3 class="font-bold mb-4">إضافة وكيل جديد</h3>
      <div class="grid sm:grid-cols-2 gap-3">
        <input id="agent-name" placeholder="اسم الوكيل" class="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        <input id="agent-phone" placeholder="رقم الهاتف (اختياري)" class="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        <select id="agent-default-supplier" class="border border-gray-200 rounded-lg px-3 py-2 text-sm sm:col-span-2">
          <option value="">بدون مورد افتراضي</option>
          ${seSuppliersCache.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
        </select>
        <input id="agent-activation-code" placeholder="رمز تفعيل المجموعة (اختياري)" class="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        <input id="agent-deactivation-code" placeholder="رمز إلغاء الربط (اختياري)" class="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
      </div>
      <p class="text-xs text-gray-400 mt-2"><i class="fa-solid fa-circle-info ml-1"></i>لو حطيت رمز تفعيل، أي عضو يرسله داخل أي مجموعة واتساب يربطها تلقائياً بهذا الوكيل، بدون الحاجة لتصنيفها يدوياً من تبويب "المجموعات".</p>
      <button onclick="createSeAgent()" class="mt-3 bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold px-5 py-2 rounded-xl">إضافة</button>
    </div>
    <div class="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-right text-gray-400 bg-gray-50 border-b border-gray-100">
          <th class="p-4 font-medium">الاسم</th><th class="p-4 font-medium">الهاتف</th>
          <th class="p-4 font-medium">المورد الافتراضي</th><th class="p-4 font-medium">مجموعة الواتساب</th>
          <th class="p-4 font-medium">رمز التفعيل</th><th class="p-4 font-medium">رمز الإلغاء</th><th class="p-4 font-medium"></th>
        </tr></thead>
        <tbody>
          ${seAgentsCache.map(a => `
            <tr class="border-b border-gray-50">
              <td class="p-4 font-semibold">${a.name}</td>
              <td class="p-4 text-gray-500">${a.phone || '-'}</td>
              <td class="p-4 text-gray-500">${a.default_supplier_name || '-'}</td>
              <td class="p-4">${a.conversation_key
                ? '<span class="text-green-600 text-xs font-bold"><i class="fa-solid fa-circle-check ml-1"></i>مرتبطة</span>'
                : '<span class="text-amber-600 text-xs font-bold"><i class="fa-solid fa-triangle-exclamation ml-1"></i>غير مرتبطة</span>'}</td>
              <td class="p-4">${a.activation_code
                ? `<code class="bg-gray-50 px-2 py-1 rounded text-xs">${a.activation_code}</code>`
                : '<span class="text-gray-300 text-xs">—</span>'}</td>
              <td class="p-4">${a.deactivation_code
                ? `<code class="bg-gray-50 px-2 py-1 rounded text-xs">${a.deactivation_code}</code>`
                : '<span class="text-gray-300 text-xs">—</span>'}</td>
              <td class="p-4 whitespace-nowrap">
                <button onclick="editSeAgentCodes(${a.id}, '${(a.activation_code || '').replace(/'/g, "\\'")}', '${(a.deactivation_code || '').replace(/'/g, "\\'")}')" class="text-brand-600 hover:underline text-xs font-bold ml-3">تعديل الرموز</button>
                <button onclick="deleteSeAgent(${a.id})" class="text-red-500 hover:underline text-xs font-bold">حذف</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="7" class="p-8 text-center text-gray-400">لا يوجد وكلاء بعد</td></tr>'}
        </tbody>
      </table>
    </div>
    <p class="text-xs text-gray-400 mt-3"><i class="fa-solid fa-circle-info ml-1"></i>يمكن ربط مجموعة الوكيل إما يدوياً من تبويب "المجموعات"، أو تلقائياً بإرسال رمز التفعيل الخاص به داخل المجموعة.</p>
  `;
}

window.createSeAgent = async function () {
  const name = document.getElementById('agent-name').value.trim();
  if (!name) return alert('اسم الوكيل مطلوب');
  try {
    await axios.post(`${API}/agents`, {
      customer_id: seCustomerId, name,
      phone: document.getElementById('agent-phone').value.trim() || null,
      default_supplier_id: Number(document.getElementById('agent-default-supplier').value) || null,
      activation_code: document.getElementById('agent-activation-code').value.trim() || null,
      deactivation_code: document.getElementById('agent-deactivation-code').value.trim() || null
    });
    await renderSeAgents(document.getElementById('se-sub-body'));
  } catch (err) {
    if (guardAuth(err)) return;
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

window.editSeAgentCodes = async function (id, currentActivation, currentDeactivation) {
  const activation_code = prompt('رمز تفعيل المجموعة (اتركه فارغاً لإزالته):', currentActivation || '');
  if (activation_code === null) return;
  const deactivation_code = prompt('رمز إلغاء الربط (اتركه فارغاً لإزالته):', currentDeactivation || '');
  if (deactivation_code === null) return;
  try {
    await axios.put(`${API}/agents/${id}`, {
      activation_code: activation_code.trim() || null,
      deactivation_code: deactivation_code.trim() || null
    });
    await renderSeAgents(document.getElementById('se-sub-body'));
  } catch (err) {
    if (guardAuth(err)) return;
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

window.deleteSeAgent = async function (id) {
  if (!confirm('حذف هذا الوكيل؟')) return;
  await axios.delete(`${API}/agents/${id}`);
  await renderSeAgents(document.getElementById('se-sub-body'));
};

// ---- Suppliers sub-tab ----
async function renderSeSuppliers(body) {
  body.innerHTML = '<div class="text-center text-gray-400 py-10"><i class="fa-solid fa-spinner fa-spin"></i></div>';
  const { data } = await axios.get(`${API}/suppliers`, { params: { customer_id: seCustomerId } });
  seSuppliersCache = data.suppliers || [];

  body.innerHTML = `
    <div class="bg-white rounded-2xl border border-gray-100 p-5 mb-5">
      <h3 class="font-bold mb-4">إضافة مورد جديد</h3>
      <div class="grid sm:grid-cols-2 gap-3">
        <input id="supplier-name" placeholder="اسم المورد" class="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        <input id="supplier-phone" placeholder="رقم الهاتف (اختياري)" class="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        <input id="supplier-activation-code" placeholder="رمز تفعيل المجموعة (اختياري)" class="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        <input id="supplier-deactivation-code" placeholder="رمز إلغاء الربط (اختياري)" class="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
      </div>
      <p class="text-xs text-gray-400 mt-2"><i class="fa-solid fa-circle-info ml-1"></i>لو حطيت رمز تفعيل، أي عضو يرسله داخل أي مجموعة واتساب يربطها تلقائياً بهذا المورد، بدون الحاجة لتصنيفها يدوياً من تبويب "المجموعات".</p>
      <button onclick="createSeSupplier()" class="mt-3 bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold px-5 py-2 rounded-xl">إضافة</button>
    </div>
    <div class="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-right text-gray-400 bg-gray-50 border-b border-gray-100">
          <th class="p-4 font-medium">الاسم</th><th class="p-4 font-medium">الهاتف</th><th class="p-4 font-medium">مجموعة الواتساب</th>
          <th class="p-4 font-medium">رمز التفعيل</th><th class="p-4 font-medium">رمز الإلغاء</th><th class="p-4 font-medium"></th>
        </tr></thead>
        <tbody>
          ${seSuppliersCache.map(s => `
            <tr class="border-b border-gray-50">
              <td class="p-4 font-semibold">${s.name}</td>
              <td class="p-4 text-gray-500">${s.phone || '-'}</td>
              <td class="p-4">${s.conversation_key
                ? '<span class="text-green-600 text-xs font-bold"><i class="fa-solid fa-circle-check ml-1"></i>مرتبطة</span>'
                : '<span class="text-amber-600 text-xs font-bold"><i class="fa-solid fa-triangle-exclamation ml-1"></i>غير مرتبطة</span>'}</td>
              <td class="p-4">${s.activation_code
                ? `<code class="bg-gray-50 px-2 py-1 rounded text-xs">${s.activation_code}</code>`
                : '<span class="text-gray-300 text-xs">—</span>'}</td>
              <td class="p-4">${s.deactivation_code
                ? `<code class="bg-gray-50 px-2 py-1 rounded text-xs">${s.deactivation_code}</code>`
                : '<span class="text-gray-300 text-xs">—</span>'}</td>
              <td class="p-4 whitespace-nowrap">
                <button onclick="editSeSupplierCodes(${s.id}, '${(s.activation_code || '').replace(/'/g, "\\'")}', '${(s.deactivation_code || '').replace(/'/g, "\\'")}')" class="text-brand-600 hover:underline text-xs font-bold ml-3">تعديل الرموز</button>
                <button onclick="deleteSeSupplier(${s.id})" class="text-red-500 hover:underline text-xs font-bold">حذف</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="6" class="p-8 text-center text-gray-400">لا يوجد موردون بعد</td></tr>'}
        </tbody>
      </table>
    </div>
    <p class="text-xs text-gray-400 mt-3"><i class="fa-solid fa-circle-info ml-1"></i>يمكن ربط مجموعة المورد إما يدوياً من تبويب "المجموعات"، أو تلقائياً بإرسال رمز التفعيل الخاص به داخل المجموعة.</p>
  `;
}

window.createSeSupplier = async function () {
  const name = document.getElementById('supplier-name').value.trim();
  if (!name) return alert('اسم المورد مطلوب');
  try {
    await axios.post(`${API}/suppliers`, {
      customer_id: seCustomerId, name,
      phone: document.getElementById('supplier-phone').value.trim() || null,
      activation_code: document.getElementById('supplier-activation-code').value.trim() || null,
      deactivation_code: document.getElementById('supplier-deactivation-code').value.trim() || null
    });
    await renderSeSuppliers(document.getElementById('se-sub-body'));
  } catch (err) {
    if (guardAuth(err)) return;
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

window.editSeSupplierCodes = async function (id, currentActivation, currentDeactivation) {
  const activation_code = prompt('رمز تفعيل المجموعة (اتركه فارغاً لإزالته):', currentActivation || '');
  if (activation_code === null) return;
  const deactivation_code = prompt('رمز إلغاء الربط (اتركه فارغاً لإزالته):', currentDeactivation || '');
  if (deactivation_code === null) return;
  try {
    await axios.put(`${API}/suppliers/${id}`, {
      activation_code: activation_code.trim() || null,
      deactivation_code: deactivation_code.trim() || null
    });
    await renderSeSuppliers(document.getElementById('se-sub-body'));
  } catch (err) {
    if (guardAuth(err)) return;
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

window.deleteSeSupplier = async function (id) {
  if (!confirm('حذف هذا المورد؟')) return;
  await axios.delete(`${API}/suppliers/${id}`);
  await renderSeSuppliers(document.getElementById('se-sub-body'));
};

// ---- Groups classification sub-tab ----
// Reuses the existing /whatsapp-groups list but filtered to this office,
// letting the admin tag each linked group as agent/supplier/bot and (for
// agent groups) pin it to a specific agent record.
async function renderSeGroups(body) {
  body.innerHTML = '<div class="text-center text-gray-400 py-10"><i class="fa-solid fa-spinner fa-spin"></i></div>';
  const [{ data: groupsData }, { data: agentsData }, { data: suppliersData }] = await Promise.all([
    axios.get(`${API}/whatsapp-groups`),
    axios.get(`${API}/agents`, { params: { customer_id: seCustomerId } }),
    axios.get(`${API}/suppliers`, { params: { customer_id: seCustomerId } })
  ]);
  seGroupsCache = (groupsData.groups || []).filter(g => g.customer_id === seCustomerId);
  seAgentsCache = agentsData.agents || [];
  seSuppliersCache = suppliersData.suppliers || [];

  body.innerHTML = `
    <div class="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-right text-gray-400 bg-gray-50 border-b border-gray-100">
          <th class="p-4 font-medium">اسم المجموعة</th><th class="p-4 font-medium">النوع</th>
          <th class="p-4 font-medium">ربط بـ</th><th class="p-4 font-medium"></th>
        </tr></thead>
        <tbody>
          ${seGroupsCache.map(g => `
            <tr class="border-b border-gray-50" data-group-id="${g.id}">
              <td class="p-4 font-semibold">${g.group_name || '-'}</td>
              <td class="p-4">
                <select class="group-type-select border border-gray-200 rounded-lg px-2 py-1.5 text-xs">
                  <option value="bot" ${g.group_type === 'bot' ? 'selected' : ''}>بوت عام</option>
                  <option value="agent" ${g.group_type === 'agent' ? 'selected' : ''}>وكيل</option>
                  <option value="supplier" ${g.group_type === 'supplier' ? 'selected' : ''}>مورد</option>
                </select>
              </td>
              <td class="p-4">
                <select class="group-link-select border border-gray-200 rounded-lg px-2 py-1.5 text-xs">
                  <option value="">-</option>
                  ${seAgentsCache.map(a => `<option value="agent:${a.id}" ${g.agent_id === a.id ? 'selected' : ''}>وكيل: ${a.name}</option>`).join('')}
                  ${seSuppliersCache.map(s => `<option value="supplier:${s.id}" ${g.supplier_id === s.id ? 'selected' : ''}>مورد: ${s.name}</option>`).join('')}
                </select>
              </td>
              <td class="p-4"><button onclick="saveGroupRole(${g.id}, this)" class="text-brand-600 hover:underline text-xs font-bold">حفظ</button></td>
            </tr>`).join('') || '<tr><td colspan="4" class="p-8 text-center text-gray-400">لا توجد مجموعات مرتبطة بهذا المكتب بعد</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

window.saveGroupRole = async function (groupId, btnEl) {
  const row = btnEl.closest('tr');
  const group_type = row.querySelector('.group-type-select').value;
  const linkVal = row.querySelector('.group-link-select').value;
  let agent_id = null, supplier_id = null;
  if (linkVal.startsWith('agent:')) agent_id = Number(linkVal.split(':')[1]);
  else if (linkVal.startsWith('supplier:')) supplier_id = Number(linkVal.split(':')[1]);
  try {
    await axios.put(`${API}/whatsapp-groups/${groupId}/role`, { group_type, agent_id, supplier_id });
    alert('تم الحفظ');
  } catch (err) {
    if (guardAuth(err)) return;
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

// Init
switchTab('overview');
