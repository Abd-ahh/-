// =========================================================================
// "الموظف الذكي" (Smart Employee, migration 0013) — admin dashboard API
// helpers: agents, suppliers, transactions (list/detail), per-office
// settings, and the WhatsApp-group role classification. Kept in its own
// module (mirrors the pattern used by messageLists.ts/knowledgeBase.ts) so
// admin.ts stays a thin router rather than growing indefinitely.
// =========================================================================

// ---------------------- Agents ----------------------
export async function listAgents(DB: D1Database, customerId: number) {
  const result = await DB.prepare(
    `SELECT a.*, s.name as default_supplier_name FROM agents a
     LEFT JOIN suppliers s ON s.id = a.default_supplier_id
     WHERE a.customer_id = ? ORDER BY a.created_at DESC`
  ).bind(customerId).all()
  return result.results || []
}

export async function createAgent(DB: D1Database, customerId: number, body: any) {
  const { name, conversation_key, phone, notes, default_supplier_id } = body
  if (!name || !String(name).trim()) throw new Error('اسم الوكيل مطلوب')
  const insert = await DB.prepare(
    `INSERT INTO agents (customer_id, name, conversation_key, phone, notes, default_supplier_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(customerId, name.trim(), conversation_key || null, phone || null, notes || null, default_supplier_id || null).run()
  return insert.meta.last_row_id
}

export async function updateAgent(DB: D1Database, id: number, body: any) {
  const existing = await DB.prepare('SELECT * FROM agents WHERE id = ?').bind(id).first<any>()
  if (!existing) throw new Error('الوكيل غير موجود')
  const name = body.name !== undefined ? body.name : existing.name
  const conversation_key = body.conversation_key !== undefined ? body.conversation_key : existing.conversation_key
  const phone = body.phone !== undefined ? body.phone : existing.phone
  const notes = body.notes !== undefined ? body.notes : existing.notes
  const default_supplier_id = body.default_supplier_id !== undefined ? body.default_supplier_id : existing.default_supplier_id
  const is_active = body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active
  await DB.prepare(
    `UPDATE agents SET name=?, conversation_key=?, phone=?, notes=?, default_supplier_id=?, is_active=?, updated_at=datetime('now') WHERE id=?`
  ).bind(name, conversation_key, phone, notes, default_supplier_id, is_active, id).run()
}

export async function deleteAgent(DB: D1Database, id: number) {
  await DB.prepare('DELETE FROM agents WHERE id = ?').bind(id).run()
}

// ---------------------- Suppliers ----------------------
export async function listSuppliers(DB: D1Database, customerId: number) {
  const result = await DB.prepare('SELECT * FROM suppliers WHERE customer_id = ? ORDER BY created_at DESC').bind(customerId).all()
  return result.results || []
}

export async function createSupplier(DB: D1Database, customerId: number, body: any) {
  const { name, conversation_key, phone, notes } = body
  if (!name || !String(name).trim()) throw new Error('اسم المورد مطلوب')
  const insert = await DB.prepare(
    `INSERT INTO suppliers (customer_id, name, conversation_key, phone, notes) VALUES (?, ?, ?, ?, ?)`
  ).bind(customerId, name.trim(), conversation_key || null, phone || null, notes || null).run()
  return insert.meta.last_row_id
}

export async function updateSupplier(DB: D1Database, id: number, body: any) {
  const existing = await DB.prepare('SELECT * FROM suppliers WHERE id = ?').bind(id).first<any>()
  if (!existing) throw new Error('المورد غير موجود')
  const name = body.name !== undefined ? body.name : existing.name
  const conversation_key = body.conversation_key !== undefined ? body.conversation_key : existing.conversation_key
  const phone = body.phone !== undefined ? body.phone : existing.phone
  const notes = body.notes !== undefined ? body.notes : existing.notes
  const is_active = body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active
  await DB.prepare(
    `UPDATE suppliers SET name=?, conversation_key=?, phone=?, notes=?, is_active=?, updated_at=datetime('now') WHERE id=?`
  ).bind(name, conversation_key, phone, notes, is_active, id).run()
}

export async function deleteSupplier(DB: D1Database, id: number) {
  await DB.prepare('DELETE FROM suppliers WHERE id = ?').bind(id).run()
}

// ---------------------- Transactions (read/admin-override) ----------------------
export async function listTransactions(DB: D1Database, customerId: number, status?: string | null) {
  const query = status
    ? DB.prepare(
        `SELECT t.*, a.name as agent_name, s.name as supplier_name FROM transactions t
         LEFT JOIN agents a ON a.id = t.agent_id LEFT JOIN suppliers s ON s.id = t.supplier_id
         WHERE t.customer_id = ? AND t.status = ? ORDER BY t.created_at DESC LIMIT 200`
      ).bind(customerId, status)
    : DB.prepare(
        `SELECT t.*, a.name as agent_name, s.name as supplier_name FROM transactions t
         LEFT JOIN agents a ON a.id = t.agent_id LEFT JOIN suppliers s ON s.id = t.supplier_id
         WHERE t.customer_id = ? ORDER BY t.created_at DESC LIMIT 200`
      ).bind(customerId)
  const result = await query.all()
  return result.results || []
}

export async function getTransactionDetail(DB: D1Database, id: number) {
  const tx = await DB.prepare(
    `SELECT t.*, a.name as agent_name, s.name as supplier_name FROM transactions t
     LEFT JOIN agents a ON a.id = t.agent_id LEFT JOIN suppliers s ON s.id = t.supplier_id
     WHERE t.id = ?`
  ).bind(id).first<any>()
  if (!tx) return null
  const people = await DB.prepare('SELECT * FROM transaction_people WHERE transaction_id = ? ORDER BY id ASC').bind(id).all()
  const history = await DB.prepare('SELECT * FROM transaction_status_log WHERE transaction_id = ? ORDER BY created_at ASC').bind(id).all()
  const followUps = await DB.prepare('SELECT * FROM follow_up_tasks WHERE transaction_id = ? ORDER BY created_at DESC').bind(id).all()
  return { ...tx, people: people.results || [], history: history.results || [], follow_ups: followUps.results || [] }
}

// Admin manual override — lets the admin force-move a stuck transaction
// (e.g. out of NEEDS_REVIEW) without needing WhatsApp access.
import { transitionTransaction } from './transactions'
export async function adminTransitionTransaction(DB: D1Database, id: number, toStatus: string, reason: string | null, adminEmail: string) {
  return transitionTransaction(DB, id, toStatus as any, reason, `admin:${adminEmail}`)
}
