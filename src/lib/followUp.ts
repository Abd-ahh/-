// =========================================================================
// "الموظف الذكي" (Smart Employee, migration 0013) — follow-up task runner.
// Polled by the VPS bridge process exactly like umrah_visa_checks /
// message_lists / knowledge_base (see webhook.ts GET /follow-up/tick and
// bridge/bridge.js's tick* functions) — this is the direct replacement for
// the Redis+BullMQ approach the original spec proposed, using the same
// proven "external process polls a Worker endpoint on a timer" pattern
// already running in production for three other features.
// =========================================================================
import { deliverToConversation } from './deliver'

export interface FollowUpRunResult {
  sent: number
  failed: number
}

export async function runDueFollowUpTasks(DB: D1Database): Promise<FollowUpRunResult> {
  const due = await DB.prepare(
    `SELECT * FROM follow_up_tasks WHERE status = 'pending' AND datetime(due_at) <= datetime('now') ORDER BY due_at ASC LIMIT 20`
  ).all<any>()
  const rows = due.results || []

  let sent = 0
  let failed = 0

  for (const row of rows) {
    // Re-verify the transaction is still in the watched status right before
    // sending — it may have advanced between scheduling and now via a path
    // that didn't go through transitionTransaction's cancellation (should
    // not normally happen, but this guard costs nothing and prevents a
    // stale reminder from firing after the fact).
    const tx = await DB.prepare('SELECT status FROM transactions WHERE id = ?').bind(row.transaction_id).first<{ status: string }>()
    if (!tx || tx.status !== row.watched_status) {
      await DB.prepare(`UPDATE follow_up_tasks SET status='cancelled', updated_at=datetime('now') WHERE id = ?`).bind(row.id).run()
      continue
    }

    const result = await deliverToConversation(DB, row.target_conversation_key, { kind: 'text', text: row.message_text }).catch((err) => ({ ok: false, channel: 'number' as const, error: String(err?.message || err) }))

    if (result.ok) {
      sent++
      await DB.prepare(
        `UPDATE follow_up_tasks SET status='sent', attempt_count = attempt_count + 1, updated_at=datetime('now') WHERE id = ?`
      ).bind(row.id).run()
    } else {
      failed++
      // Retry in 5 minutes rather than giving up permanently on a transient
      // delivery failure (same philosophy as umrah_visa_checks retries).
      const nextDue = new Date(Date.now() + 5 * 60 * 1000).toISOString()
      await DB.prepare(
        `UPDATE follow_up_tasks SET due_at = ?, attempt_count = attempt_count + 1, updated_at=datetime('now') WHERE id = ?`
      ).bind(nextDue, row.id).run()
    }
  }

  return { sent, failed }
}
