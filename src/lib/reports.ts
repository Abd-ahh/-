// Per-conversation daily/monthly/yearly reports: visa-check count + names +
// status (issued / not yet), scoped strictly to the requesting conversation
// (never other conversations of the same office, per the confirmed scope).

export function reportDateRange(period: 'daily' | 'monthly' | 'yearly'): { from: string; label: string } {
  const now = new Date()
  let from: Date
  let label: string
  if (period === 'daily') {
    from = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    label = 'اليوم'
  } else if (period === 'monthly') {
    from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    label = 'هذا الشهر'
  } else {
    from = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)
    label = 'هذا العام'
  }
  return { from: from.toISOString(), label }
}

export interface VisaReportRow {
  first_name: string
  passport_number: string
  status: string // pending | checking | found | failed | cancelled
  created_at: string
}

export function buildReportTextMessage(rows: VisaReportRow[], label: string, lang: 'ar' | 'en'): string {
  const issued = rows.filter((r) => r.status === 'found').length
  const header = lang === 'en'
    ? `📊 Visa report (${label}) — total: ${rows.length}, issued: ${issued}`
    : `📊 تقرير التأشيرات (${label}) — العدد: ${rows.length}، تم الإصدار: ${issued}`

  if (rows.length === 0) {
    return `${header}\n${lang === 'en' ? '(no records)' : '(لا توجد سجلات)'}`
  }

  const lines = [header, '']
  rows.forEach((r, idx) => {
    const statusLabel = r.status === 'found'
      ? (lang === 'en' ? 'Issued ✅' : 'تم الإصدار ✅')
      : (lang === 'en' ? 'Not issued yet ⏳' : 'لم يتم الإصدار ⏳')
    lines.push(`${idx + 1}- ${r.first_name} (${r.passport_number}) — ${statusLabel}`)
  })
  return lines.join('\n')
}

// Simple HTML used for the PDF-format report (rendered to PDF on the VPS via
// Playwright's page.pdf(), same technique proven in the feasibility test —
// this Worker only builds the HTML string; the VPS process converts+sends it).
export function buildReportHtml(rows: VisaReportRow[], label: string, officeName: string): string {
  const issued = rows.filter((r) => r.status === 'found').length
  const rowsHtml = rows.map((r, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${r.first_name}</td>
      <td>${r.passport_number}</td>
      <td>${r.status === 'found' ? 'تم الإصدار' : 'لم يتم الإصدار'}</td>
    </tr>`).join('')

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; padding: 24px; }
  h1 { font-size: 20px; } h2 { font-size: 14px; color: #555; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { border: 1px solid #ccc; padding: 8px; text-align: right; font-size: 13px; }
  th { background: #f0f0f0; }
</style></head>
<body>
  <h1>تقرير التأشيرات — ${officeName}</h1>
  <h2>${label} — العدد الإجمالي: ${rows.length}، تم الإصدار: ${issued}</h2>
  <table>
    <thead><tr><th>#</th><th>الاسم</th><th>رقم الجواز</th><th>الحالة</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body></html>`
}
