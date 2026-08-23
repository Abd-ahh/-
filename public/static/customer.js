// Customer portal SPA logic
axios.defaults.headers.common['Authorization'] = 'Bearer ' + (localStorage.getItem('customer_token') || '');

const API = '/api/customer';
let currentTab = 'overview';
let fieldsCache = [];
let numbersCache = [];

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
    else if (currentTab === 'cumulative') await renderCumulativeLists(area);
    else if (currentTab === 'messagelists') await renderMessageLists(area);
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
  numbersCache = data.numbers;

  if (data.shared_link) {
    const link = data.shared_link;
    area.innerHTML = `
      <div class="bg-white rounded-2xl border border-amber-200 p-8 max-w-xl mx-auto text-center">
        <div class="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto mb-4">
          <i class="fa-solid fa-people-group text-xl"></i>
        </div>
        <h3 class="font-bold text-lg mb-2">مكتبك يستخدم الرقم المشترك للمنصة</h3>
        <p class="text-sm text-gray-500 mb-5">شارك هذا الرابط مع عملائك — بمجرد الضغط عليه سيُفتح واتساب مع رسالة جاهزة لربط رقمهم بمكتبك تلقائياً "${link.office_name}". لا حاجة لأي إعداد إضافي.</p>
        <div class="bg-gray-50 rounded-xl p-4 text-left mb-4 flex items-center justify-between gap-3" dir="ltr">
          <span id="shared-link-text" class="text-xs text-gray-600 break-all">${link.deep_link}</span>
          ${copyBtn(link.deep_link)}
        </div>
        <a href="${link.deep_link}" target="_blank" class="inline-block bg-emerald-500 hover:bg-emerald-600 text-white font-bold px-6 py-3 rounded-xl text-sm">
          <i class="fa-brands fa-whatsapp ml-1"></i> فتح الرابط في واتساب
        </a>
        <p class="text-xs text-gray-400 mt-5">أو أرسل عملاؤك يدوياً هذه الرسالة إلى الرقم المشترك: <br/><span class="font-bold">${link.activation_text}</span></p>
        ${link.deactivation_text ? `<p class="text-xs text-gray-400 mt-2">لإلغاء الربط يرسل عميلك: <br/><span class="font-bold">${link.deactivation_text}</span></p>` : ''}
        <p class="text-xs text-brand-600 mt-4"><i class="fa-solid fa-gear ml-1"></i> يمكنك تخصيص أوامر التفعيل والإيقاف من تبويب "الإعدادات"</p>
      </div>
      ${renderGroupsSection(data.groups || [], link.activation_text)}
    `;
    return;
  }

  area.innerHTML = `
    <div class="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-right text-gray-400 bg-gray-50 border-b border-gray-100">
          <th class="p-4 font-medium">الاسم</th><th class="p-4 font-medium">الرقم</th><th class="p-4 font-medium">الحالة</th><th class="p-4 font-medium">إعدادات الاستخراج</th>
        </tr></thead>
        <tbody>
          ${data.numbers.map(n => `
            <tr class="border-b border-gray-50">
              <td class="p-4 font-semibold">${n.display_name}</td>
              <td class="p-4">${n.phone_number}</td>
              <td class="p-4">${statusBadge(n.status)}</td>
              <td class="p-4"><button onclick="openFieldsModal(${n.id})" class="text-brand-600 hover:underline text-xs font-bold">تخصيص الحقول</button></td>
            </tr>`).join('') || '<tr><td colspan="4" class="p-8 text-center text-gray-400">لا توجد أرقام مربوطة بعد. تواصل مع الدعم لربط رقمك.</td></tr>'}
        </tbody>
      </table>
    </div>
    <div id="modal-root"></div>
  `;
}

// ---------------- WhatsApp group bridge section ----------------
// Groups are activated by a member sending the office activation text
// inside an unofficial WhatsApp group (added via a separate bridge number
// managed by the platform, since official numbers can't join groups). This
// section is read-only visibility + unlink; activation itself always
// happens from inside WhatsApp, not from this dashboard.
function renderGroupsSection(groups, activationText) {
  return `
    <div class="bg-white rounded-2xl border border-gray-100 p-6 max-w-xl mx-auto mt-6">
      <h3 class="font-bold text-gray-900 mb-1"><i class="fa-solid fa-people-group ml-1 text-brand-600"></i> مجموعات واتساب المفعّلة لمكتبك</h3>
      <p class="text-xs text-gray-400 mb-4">إذا انضم رقم البوت الخاص بالمجموعات لمجموعة واتساب لديك، يرسل أي عضو بالمجموعة "${activationText}" مرة واحدة لربطها، وبعدها يمكن لأي عضو إرسال صور الجوازات داخل المجموعة نفسها.</p>
      ${groups.length ? `
        <div class="space-y-2">
          ${groups.map(g => `
            <div class="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-3">
              <div>
                <p class="font-semibold text-sm">${g.group_name || 'مجموعة بدون اسم'}</p>
                <p class="text-xs text-gray-400">مفعّلة منذ ${fmtDate(g.created_at)}</p>
              </div>
              <button onclick="unlinkGroup(${g.id})" class="text-xs font-bold text-red-500 hover:text-red-700">إلغاء الربط</button>
            </div>
          `).join('')}
        </div>
      ` : `<p class="text-sm text-gray-400 text-center py-4">لا توجد مجموعات مفعّلة حالياً</p>`}
    </div>
  `;
}

window.unlinkGroup = async function (groupId) {
  if (!confirm('تأكيد إلغاء ربط هذه المجموعة؟ لن تُعالج صور الجوازات منها بعد الآن حتى يُعاد تفعيلها.')) return;
  try {
    await axios.delete(`${API}/groups/${groupId}`);
    render();
  } catch (err) {
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

// ---------------- Extraction fields modal ----------------
window.openFieldsModal = async function (numberId) {
  const fields = await getFields();
  const n = numbersCache.find(x => x.id === numberId);
  let currentFields = [];
  try { currentFields = n && n.extraction_fields ? JSON.parse(n.extraction_fields) : []; } catch { currentFields = []; }

  const modal = document.getElementById('modal-root');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl p-6 w-full max-w-md">
        <h3 class="font-bold text-lg mb-1">حقول استخراج البوت — ${n ? n.display_name : ''}</h3>
        <p class="text-xs text-gray-400 mb-4">اختر البيانات التي يستخرجها البوت ويرد بها على واتساب لهذا الرقم فقط. اترك الكل بدون تحديد لاستخراج جميع الحقول.</p>
        <div class="grid grid-cols-2 gap-2">
          ${fields.map(f => `
            <label class="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2 text-sm cursor-pointer">
              <input type="checkbox" class="cf-field-cb" value="${f.key}" ${currentFields.includes(f.key) ? 'checked' : ''} />
              <span>${f.emoji} ${f.label_ar}</span>
            </label>`).join('')}
        </div>
        <div class="flex gap-3 mt-5">
          <button onclick="saveNumberFields(${numberId})" class="flex-1 bg-brand-600 text-white font-bold py-2.5 rounded-xl">حفظ</button>
          <button onclick="document.getElementById('modal-root').innerHTML=''" class="flex-1 bg-gray-100 text-gray-700 font-bold py-2.5 rounded-xl">إلغاء</button>
        </div>
      </div>
    </div>
  `;
};

window.saveNumberFields = async function (numberId) {
  const selectedFields = Array.from(document.querySelectorAll('.cf-field-cb:checked')).map(cb => cb.value);
  try {
    await axios.put(`${API}/numbers/${numberId}/fields`, { extraction_fields: selectedFields.length ? selectedFields : null });
    document.getElementById('modal-root').innerHTML = '';
    render();
  } catch (err) {
    alert(err?.response?.data?.error || 'حدث خطأ');
  }
};

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
              <td class="p-4 font-semibold">${o.full_name_ar ? `<span class="inline-flex items-center gap-1">${o.full_name_ar} ${copyBtn(o.full_name_ar)}</span>` : '-'}</td>
              <td class="p-4 text-gray-500">${o.passport_number ? `<span class="inline-flex items-center gap-1">${o.passport_number} ${copyBtn(o.passport_number)}</span>` : '-'}</td>
              <td class="p-4">${statusBadge(o.status)}</td>
              <td class="p-4 text-gray-400 text-xs">${fmtDate(o.created_at)}</td>
            </tr>`).join('') || '<tr><td colspan="5" class="p-8 text-center text-gray-400">لا توجد عمليات بعد</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

// Feature 2 (cumulative running list): the numbered list is now built
// automatically in the background on every successful extraction, but by
// default no WhatsApp reply is sent for it (office must explicitly enable
// "تفعيل الاستخراج التلقائي" for the detailed WhatsApp reply). This tab is
// where the office reads the up-to-date list instead — one card per active
// conversation (private number / shared-number sender / linked group),
// each copyable in one click.
function buildCumulativeListText(items, fields) {
  if (!items.length) return '(فارغة)';
  return items.map((item, idx) => {
    const parts = fields.map(f => item[f.key]).filter(Boolean);
    return `${idx + 1}- ${parts.join(' - ')}`;
  }).join('\n');
}

async function renderCumulativeLists(area) {
  const [{ data }, fields] = await Promise.all([
    axios.get(`${API}/cumulative-lists`),
    getFields()
  ]);
  const fieldDefs = fields.filter(f => data.fields.includes(f.key));

  if (!data.lists.length) {
    area.innerHTML = `
      <div class="bg-white rounded-2xl border border-gray-100 p-10 text-center text-gray-400">
        <i class="fa-solid fa-list-ol text-3xl mb-3"></i>
        <p>لا توجد قائمة تراكمية نشطة حالياً.</p>
        <p class="text-xs mt-2">تُبنى القائمة تلقائياً مع كل جواز يُستخرج بنجاح، بشرط إرسال أمر "تفعيل القائمة" في المحادثة/المجموعة المطلوبة أولاً.</p>
      </div>`;
    return;
  }

  area.innerHTML = `
    <div class="space-y-4">
      ${data.lists.map((l, i) => `
        <div class="bg-white rounded-2xl border border-gray-100 p-6">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h3 class="font-bold text-gray-800">${l.label}</h3>
              <p class="text-xs text-gray-400 mt-0.5">${l.items.length} جواز · آخر تحديث: ${fmtDate(l.updated_at)}</p>
            </div>
            <button onclick="copyCumulativeList(${i}, this)" class="bg-brand-50 hover:bg-brand-100 text-brand-700 font-bold text-xs px-4 py-2 rounded-lg">
              <i class="fa-regular fa-copy ml-1"></i> نسخ القائمة كاملة
            </button>
          </div>
          <ol class="space-y-1.5 text-sm">
            ${l.items.map((item, idx) => `
              <li class="flex items-center gap-2 text-gray-700">
                <span class="text-gray-400 font-bold">${idx + 1}-</span>
                <span>${fieldDefs.map(f => item[f.key]).filter(Boolean).join(' - ') || '-'}</span>
              </li>`).join('')}
          </ol>
        </div>`).join('')}
    </div>
  `;

  window._cumulativeListsData = data.lists;
  window._cumulativeListFields = fieldDefs;
}

window.copyCumulativeList = function (idx, btnEl) {
  const list = window._cumulativeListsData?.[idx];
  const fields = window._cumulativeListFields || [];
  if (!list) return;
  copyValue(buildCumulativeListText(list.items, fields), btnEl);
};

async function renderSettings(area) {
  const { data } = await axios.get(`${API}/me`);
  const c = data.customer;
  const fields = await getFields();
  let cumulativeFields = ['full_name_ar', 'passport_number'];
  if (c.cumulative_list_fields) {
    try { cumulativeFields = JSON.parse(c.cumulative_list_fields); } catch {}
  }
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

      <hr class="my-6" />
      <h3 class="font-bold text-lg mb-2">أوامر الرقم المشترك (إن كان مكتبك يستخدمه)</h3>
      <p class="text-xs text-gray-400 mb-4">اترك الحقل فارغاً لاستخدام النمط الافتراضي: "${c.name} تفعيل". أمر التفعيل المخصص يحل محل هذا النمط بالكامل.</p>
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-bold text-gray-700 mb-1.5">أمر تفعيل مخصص</label>
          <input id="st-activation" value="${c.activation_code || ''}" placeholder="مثال: معالم الرياض" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
        </div>
        <div>
          <label class="block text-sm font-bold text-gray-700 mb-1.5">أمر إلغاء الربط (اختياري)</label>
          <input id="st-deactivation" value="${c.deactivation_code || ''}" placeholder="مثال: الغاء معالم الرياض" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
        </div>
      </div>

      <hr class="my-6" />
      <h3 class="font-bold text-lg mb-2">القائمة التراكمية</h3>
      <p class="text-xs text-gray-400 mb-4">بعد إرسال أمر "تفعيل القائمة" في المحادثة/المجموعة، تُبنى قائمة تراكمية مرقّمة تلقائياً وتُرسَل كرسالة واتساب في نفس المحادثة مع كل جواز يُستخرج بنجاح — هذا يعمل دائماً بشكل مستقل تماماً عن إعداد "الاستخراج التلقائي" أعلاه. يمكنك أيضاً مراجعة ونسخ القائمة من تبويب "القائمة التراكمية" في أعلى الصفحة، أو طلبها في أي وقت بكتابة "القائمة" داخل المحادثة نفسها. اختر الحقول التي تريد ظهورها في القائمة، ومتى تُصفَّر تلقائياً.</p>
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-bold text-gray-700 mb-2">الحقول الظاهرة في القائمة</label>
          <div class="grid grid-cols-2 gap-2">
            ${fields.map(f => `
              <label class="flex items-center gap-2 text-sm bg-gray-50 rounded-lg px-3 py-2 cursor-pointer">
                <input type="checkbox" class="cum-field-cb" value="${f.key}" ${cumulativeFields.includes(f.key) ? 'checked' : ''} />
                ${f.emoji} ${f.label_ar}
              </label>`).join('')}
          </div>
        </div>
        <div>
          <label class="block text-sm font-bold text-gray-700 mb-1.5">إعادة التصفير التلقائي بعد (ساعات)</label>
          <input id="st-cum-hours" type="number" min="1" value="${c.cumulative_list_reset_hours || 24}" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <p class="text-xs text-gray-400 mt-1">مثال: 24 = تبدأ القائمة من جديد كل يوم لكل محادثة/مجموعة.</p>
        </div>
      </div>

      <div id="st-error" class="hidden text-red-600 text-sm bg-red-50 rounded-lg p-3 mt-4"></div>
      <div id="st-success" class="hidden text-emerald-600 text-sm bg-emerald-50 rounded-lg p-3 mt-4">تم الحفظ بنجاح</div>
      <button onclick="saveSettings()" class="mt-5 bg-brand-600 hover:bg-brand-700 text-white font-bold px-6 py-3 rounded-xl">حفظ الإعدادات</button>
    </div>
  `;
}

// ---------------- Message Lists (قوائم رسائل) — office self-service ----------------
// Same feature as the admin's "قوائم الرسائل" tab, but always scoped to this
// office's own contacts/lists (the server derives customer_id from the JWT,
// never from anything sent by this page). WhatsApp-only, delivered via the
// unofficial bridge.
let mlContactsCache = [];
let mlListsCache = [];

async function renderMessageLists(area) {
  area.innerHTML = `
    <div class="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl p-4 mb-5">
      <i class="fa-solid fa-circle-info ml-1"></i>
      قوائم الرسائل تُرسَل عبر واتساب فقط — رسائل جماعية مجدولة حسب الوقت والتكرار (يومي/أسبوعي/شهري) لعملائك أو وكلائك.
    </div>
    <div id="ml-body"></div>
  `;
  await renderMessageListsBody();
}

async function renderMessageListsBody() {
  const body = document.getElementById('ml-body');
  body.innerHTML = '<div class="text-center text-gray-400 py-10"><i class="fa-solid fa-spinner fa-spin"></i></div>';

  const [{ data: contactsData }, { data: listsData }] = await Promise.all([
    axios.get(`${API}/message-contacts`),
    axios.get(`${API}/message-lists`)
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
window.openMlContactModal = function (id) {
  const ct = id ? mlContactsCache.find(c => c.id === id) : null;
  const modal = document.getElementById('modal-root');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl p-6 w-full max-w-md">
        <h3 class="font-bold text-lg mb-4">${ct ? 'تعديل جهة اتصال' : 'جهة اتصال جديدة'}</h3>
        <div class="space-y-3">
          <input id="mc-name" value="${ct ? ct.name : ''}" placeholder="الاسم (مثال: وكيل صنعاء - أحمد)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <select id="mc-channel" class="w-full border border-gray-200 rounded-xl px-4 py-2.5">
            <option value="number" ${!ct || ct.channel === 'number' ? 'selected' : ''}>رقم واتساب فردي</option>
            <option value="group" ${ct && ct.channel === 'group' ? 'selected' : ''}>مجموعة واتساب (JID)</option>
          </select>
          <input id="mc-value" value="${ct ? ct.value : ''}" dir="ltr" placeholder="رقم الهاتف (967778260004) أو JID المجموعة" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
          <input id="mc-region" value="${ct && ct.region ? ct.region : ''}" placeholder="المنطقة (اختياري، مثال: صنعاء)" class="w-full border border-gray-200 rounded-xl px-4 py-2.5" />
        </div>
        <div id="mc-error" class="hidden text-red-600 text-xs bg-red-50 rounded-lg p-2 mt-3"></div>
        <div class="flex gap-3 mt-5">
          <button onclick="submitMlContact(${id || 'null'})" class="flex-1 bg-brand-600 text-white font-bold py-2.5 rounded-xl">حفظ</button>
          <button onclick="document.getElementById('modal-root').innerHTML=''" class="flex-1 bg-gray-100 text-gray-700 font-bold py-2.5 rounded-xl">إلغاء</button>
        </div>
      </div>
    </div>
  `;
};

window.submitMlContact = async function (id) {
  const payload = {
    name: document.getElementById('mc-name').value.trim(),
    channel: document.getElementById('mc-channel').value,
    value: document.getElementById('mc-value').value.trim(),
    region: document.getElementById('mc-region').value.trim() || null
  };
  const errEl = document.getElementById('mc-error');
  try {
    if (id) await axios.put(`${API}/message-contacts/${id}`, payload);
    else await axios.post(`${API}/message-contacts`, payload);
    document.getElementById('modal-root').innerHTML = '';
    renderMessageListsBody();
  } catch (err) {
    if (guardAuth(err)) return;
    errEl.textContent = err?.response?.data?.error || 'حدث خطأ';
    errEl.classList.remove('hidden');
  }
};

window.deleteMlContact = async function (id) {
  if (!confirm('حذف جهة الاتصال هذه؟')) return;
  await axios.delete(`${API}/message-contacts/${id}`);
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
          <button onclick="document.getElementById('modal-root').innerHTML=''" class="flex-1 bg-gray-100 text-gray-700 font-bold py-2.5 rounded-xl">إلغاء</button>
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
    document.getElementById('modal-root').innerHTML = '';
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

window.saveSettings = async function () {
  const cumulativeFields = Array.from(document.querySelectorAll('.cum-field-cb:checked')).map(cb => cb.value);
  const payload = {
    phone: document.getElementById('st-phone').value,
    reply_language: document.getElementById('st-lang').value,
    welcome_message: document.getElementById('st-welcome').value,
    activation_code: document.getElementById('st-activation').value,
    deactivation_code: document.getElementById('st-deactivation').value,
    cumulative_list_fields: cumulativeFields,
    cumulative_list_reset_hours: document.getElementById('st-cum-hours').value
  };
  const errEl = document.getElementById('st-error');
  const okEl = document.getElementById('st-success');
  errEl.classList.add('hidden');
  try {
    await axios.put(`${API}/settings`, payload);
    okEl.classList.remove('hidden');
    setTimeout(() => okEl.classList.add('hidden'), 2500);
  } catch (err) {
    errEl.textContent = err?.response?.data?.error || 'حدث خطأ';
    errEl.classList.remove('hidden');
  }
};

render();
