// =========================================================================
// "الموظف الذكي" (Smart Employee, migration 0013) — Umrah transaction
// lifecycle: state machine, transaction-code generation, and follow-up task
// scheduling. Used by webhook.ts's agent/supplier group handlers.
//
// Design notes:
//  - The state machine is intentionally permissive about WHICH transitions
//    are "normal" vs "exception" rather than hard-blocking illegal ones —
//    an office's real workflow has edge cases (wrong person sent, document
//    missing, supplier failed to forward) that must always be reachable
//    from any state via transitionTransaction(). What IS enforced is: every
//    transition is logged (transaction_status_log) and automatically
//    cancels any follow-up task that was only watching the status being
//    left, then schedules the next one if the new status needs one.
//  - Timestamps (confirmed_at, sent_to_supplier_at, etc.) are written
//    opportunistically for whichever column matches the transition, purely
//    for admin-dashboard display — no logic depends on them.
// =========================================================================
import type { TransactionStatus, FollowUpTaskKind } from './types'

// ---------------------- Transaction code generation ----------------------
// Format: UMR-<2-digit year><4-digit sequence>, e.g. UMR-260001.
// Sequence resets every year, independently PER OFFICE (transaction_counters
// is keyed by customer_id+year_key) so one office's volume never affects
// another's numbering series.
export async function generateTransactionCode(DB: D1Database, customerId: number): Promise<string> {
  const year = new Date().getFullYear() % 100
  const yearKey = String(year).padStart(2, '0')

  // D1 has no multi-statement transactions with read-then-write isolation
  // guarantees across a Worker invocation boundary, but INSERT ... ON
  // CONFLICT DO UPDATE ... RETURNING gives us an atomic read-increment-write
  // in one statement, which is what matters here (two near-simultaneous
  // transactions for the same office must never get the same number).
  const row = await DB.prepare(
    `INSERT INTO transaction_counters (customer_id, year_key, next_seq) VALUES (?, ?, 2)
     ON CONFLICT(customer_id, year_key) DO UPDATE SET next_seq = next_seq + 1
     RETURNING next_seq`
  ).bind(customerId, yearKey).first<{ next_seq: number }>()

  // next_seq here is the value AFTER increment; the sequence number to use
  // is one less than that (first call inserts next_seq=2, meaning seq=1 was
  // just consumed).
  const seq = (row?.next_seq || 2) - 1
  return `UMR-${yearKey}${String(seq).padStart(4, '0')}`
}

// ---------------------- Follow-up task scheduling ----------------------
// Maps a transaction status to the follow-up it should schedule upon
// entering that status (if any), and which per-office timer setting (in
// minutes) governs its delay. Statuses not listed here get no automatic
// follow-up (e.g. terminal states, or states where no external party needs
// chasing).
const FOLLOWUP_RULES: Partial<Record<TransactionStatus, { kind: FollowUpTaskKind; minutesField: 'followup_confirmation_minutes' | 'followup_hosting_minutes' | 'followup_visa_minutes' }>> = {
  WAITING_AGENT_CONFIRMATION: { kind: 'agent_confirmation_reminder', minutesField: 'followup_confirmation_minutes' },
  WAITING_HOSTING: { kind: 'hosting_followup', minutesField: 'followup_hosting_minutes' },
  VISA_WAITING: { kind: 'visa_followup', minutesField: 'followup_visa_minutes' }
}

function followupMessage(kind: FollowUpTaskKind, code: string): string {
  switch (kind) {
    case 'agent_confirmation_reminder':
      return `⏰ تذكير: المعاملة ${code} بانتظار تأكيدكم منذ فترة. هل نرفع المعاملة؟ (أرسل "نعم" للتأكيد)`
    case 'hosting_followup':
      return `⏰ متابعة: لا يزال بانتظار استلام الاستضافة للمعاملة ${code}. برجاء التحديث.`
    case 'visa_followup':
      return `⏰ متابعة: لا تزال التأشيرة معلّقة للمعاملة ${code}. برجاء التحديث.`
  }
}

// Cancels any still-pending follow-up task for this transaction that was
// watching a status the transaction is now leaving. Safe to call even if
// no such task exists.
async function cancelFollowUpsForTransaction(DB: D1Database, transactionId: number): Promise<void> {
  await DB.prepare(
    `UPDATE follow_up_tasks SET status='cancelled', updated_at=datetime('now') WHERE transaction_id = ? AND status = 'pending'`
  ).bind(transactionId).run()
}

// Schedules the follow-up task (if any) appropriate for the transaction's
// new status, using the office's configured timer. Call AFTER updating
// transactions.status in the DB.
async function scheduleFollowUpIfNeeded(
  DB: D1Database,
  transactionId: number,
  customerId: number,
  newStatus: TransactionStatus,
  transactionCode: string,
  conversationKey: string
): Promise<void> {
  const rule = FOLLOWUP_RULES[newStatus]
  if (!rule) return

  const customer = await DB.prepare(`SELECT ${rule.minutesField} as minutes FROM customers WHERE id = ?`)
    .bind(customerId).first<{ minutes: number }>()
  const minutes = customer?.minutes ?? 60
  if (!minutes || minutes <= 0) return // 0/disabled -> no follow-up for this office

  const dueAt = new Date(Date.now() + minutes * 60 * 1000).toISOString()
  await DB.prepare(
    `INSERT INTO follow_up_tasks (transaction_id, customer_id, kind, watched_status, due_at, message_text, target_conversation_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    transactionId, customerId, rule.kind, newStatus, dueAt,
    followupMessage(rule.kind, transactionCode), conversationKey
  ).run()
}

// ---------------------- Core transition function ----------------------
export interface TransitionResult {
  ok: boolean
  transaction: any
}

// Moves a transaction to a new status: updates the row (status + the
// matching timestamp column, if any), writes transaction_status_log, and
// re-schedules follow-up tasks for the new status (cancelling the old
// pending one first). `changedBy` is a free-text actor label for the audit
// trail ('agent' | 'supplier' | 'system' | 'ai' | 'admin:<email>').
export async function transitionTransaction(
  DB: D1Database,
  transactionId: number,
  toStatus: TransactionStatus,
  reason: string | null,
  changedBy: string
): Promise<TransitionResult> {
  const tx = await DB.prepare('SELECT * FROM transactions WHERE id = ?').bind(transactionId).first<any>()
  if (!tx) return { ok: false, transaction: null }

  const fromStatus = tx.status as string
  const timestampColumnByStatus: Partial<Record<TransactionStatus, string>> = {
    WAITING_AGENT_CONFIRMATION: 'confirmed_at', // set when the agent is ASKED, timestamp semantics kept loose for dashboard display
    SENT_TO_SUPPLIER: 'sent_to_supplier_at',
    HOSTING_RECEIVED: 'hosting_received_at',
    HOSTING_SENT_TO_AGENT: 'hosting_sent_to_agent_at',
    VISA_RECEIVED: 'visa_received_at',
    VISA_SENT_TO_AGENT: 'visa_sent_to_agent_at',
    COMPLETED: 'completed_at',
    CANCELLED: 'cancelled_at'
  }
  const tsColumn = timestampColumnByStatus[toStatus]

  const sets = ['status = ?', `updated_at = datetime('now')`]
  const binds: any[] = [toStatus]
  if (tsColumn) {
    sets.push(`${tsColumn} = datetime('now')`)
  }
  if (toStatus === 'NEEDS_REVIEW' && reason) {
    sets.push('needs_review_reason = ?')
    binds.push(reason)
  }
  binds.push(transactionId)

  await DB.batch([
    DB.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`).bind(...binds),
    DB.prepare(
      `INSERT INTO transaction_status_log (transaction_id, from_status, to_status, reason, changed_by) VALUES (?, ?, ?, ?, ?)`
    ).bind(transactionId, fromStatus, toStatus, reason || null, changedBy)
  ])

  await cancelFollowUpsForTransaction(DB, transactionId)
  await scheduleFollowUpIfNeeded(DB, transactionId, tx.customer_id, toStatus, tx.transaction_code, tx.conversation_key)

  const updated = await DB.prepare('SELECT * FROM transactions WHERE id = ?').bind(transactionId).first<any>()
  return { ok: true, transaction: updated }
}

// ---------------------- Completeness check ----------------------
// A transaction is "complete enough" to ask for confirmation once it has at
// least one passport person AND a host phone number. The iqama is
// deliberately NOT required (spec section 3 lists it as part of a typical
// transaction but doesn't make it a hard precondition — offices sometimes
// confirm before the iqama arrives and send it separately).
export async function isTransactionReadyForConfirmation(DB: D1Database, transactionId: number): Promise<boolean> {
  const tx = await DB.prepare('SELECT host_phone FROM transactions WHERE id = ?').bind(transactionId).first<{ host_phone: string | null }>()
  if (!tx?.host_phone) return false
  // BUGFIX (2026-10-02, real-world field test): originally only counted
  // document_type='passport', which meant a transaction whose agent sent
  // an IQAMA (residency card) instead of a passport — the common case per
  // the actual screenshots supplied by the user — could NEVER become ready
  // for confirmation. Both document types are valid identity documents for
  // this transaction type.
  const people = await DB.prepare(
    `SELECT COUNT(*) as cnt FROM transaction_people WHERE transaction_id = ? AND document_type IN ('passport', 'iqama')`
  ).bind(transactionId).first<{ cnt: number }>()
  return (people?.cnt || 0) > 0
}

// ---------------------- Summary builder (for WhatsApp replies) ----------------------
export async function buildTransactionSummary(DB: D1Database, transactionId: number): Promise<string> {
  const tx = await DB.prepare('SELECT * FROM transactions WHERE id = ?').bind(transactionId).first<any>()
  if (!tx) return ''
  const people = await DB.prepare(
    `SELECT document_type, full_name_ar, document_number FROM transaction_people WHERE transaction_id = ? ORDER BY id ASC`
  ).bind(transactionId).all<any>()

  const lines = [`📋 معاملة ${tx.transaction_code}`]
  for (const p of people.results || []) {
    const docLabel = p.document_type === 'iqama' ? 'إقامة' : 'جواز'
    lines.push(`${docLabel === 'إقامة' ? '🪪' : '🛂'} ${p.full_name_ar || '(بدون اسم)'} — ${docLabel} ${p.document_number || '(بدون رقم)'}`)
  }
  if (tx.host_phone) lines.push(`📞 رقم المضيف: ${tx.host_phone}`)
  return lines.join('\n')
}

export const CONFIRMATION_PROMPT = 'هل نرفع المعاملة؟ (أرسل "نعم" للتأكيد أو "لا" للإلغاء)'
