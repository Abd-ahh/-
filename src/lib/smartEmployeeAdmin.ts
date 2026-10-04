// =========================================================================
// "الموظف الذكي" (Smart Employee, migration 0013) — admin dashboard API
// helpers: agents, suppliers, transactions (list/detail), per-office
// settings, and the WhatsApp-group role classification. Kept in its own
// module (mirrors the pattern used by messageLists.ts/knowledgeBase.ts) so
// admin.ts stays a thin router rather than growing indefinitely.
// =========================================================================

// Per-agent/per-supplier self-service activation/deactivation codes
// (migration 0016) must be unique ACROSS BOTH tables (an incoming WhatsApp
// text is matched against a single combined candidate pool in webhook.ts,
// so two different records sharing one code would be genuinely ambiguous —
// exactly the same rationale as customers.activation_code's uniqueness
// check in admin.ts, just spanning two tables instead of one).
async function checkDuplicateAgentSupplierCode(
  DB: D1Database,
  field: 'activation_code' | 'deactivation_code',
  value: string,
  exclude?: { table: 'agents' | 'suppliers'; id: number }
): Promise<boolean> {
  const agentQuery = exclude?.table === 'agents'
    ? DB.prepare(`SELECT id FROM agents WHERE ${field} = ? AND id != ?`).bind(value, exclude.id)
    : DB.prepare(`SELECT id FROM agents WHERE ${field} = ?`).bind(value)
  const supplierQuery = exclude?.table === 'suppliers'
    ? DB.prepare(`SELECT id FROM suppliers WHERE ${field} = ? AND id != ?`).bind(value, exclude.id)
    : DB.prepare(`SELECT id FROM suppliers WHERE ${field} = ?`).bind(value)
  const [agentHit, supplierHit] = await Promise.all([agentQuery.first(), supplierQuery.first()])
  return !!agentHit || !!supplierHit
}

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
  const activation_code = body.activation_code?.trim() || null
  const deactivation_code = body.deactivation_code?.trim() || null
  if (activation_code && (await checkDuplicateAgentSupplierCode(DB, 'activation_code', activation_code))) {
    throw new Error('رمز التفعيل مستخدم بالفعل من وكيل/مورد آخر، الرجاء اختيار رمز مختلف')
  }
  if (deactivation_code && (await checkDuplicateAgentSupplierCode(DB, 'deactivation_code', deactivation_code))) {
    throw new Error('رمز الإلغاء مستخدم بالفعل من وكيل/مورد آخر، الرجاء اختيار رمز مختلف')
  }
  const insert = await DB.prepare(
    `INSERT INTO agents (customer_id, name, conversation_key, phone, notes, default_supplier_id, activation_code, deactivation_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(customerId, name.trim(), conversation_key || null, phone || null, notes || null, default_supplier_id || null, activation_code, deactivation_code).run()
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
  const activation_code = body.activation_code !== undefined ? (body.activation_code?.trim() || null) : existing.activation_code
  const deactivation_code = body.deactivation_code !== undefined ? (body.deactivation_code?.trim() || null) : existing.deactivation_code
  if (activation_code && (await checkDuplicateAgentSupplierCode(DB, 'activation_code', activation_code, { table: 'agents', id }))) {
    throw new Error('رمز التفعيل مستخدم بالفعل من وكيل/مورد آخر، الرجاء اختيار رمز مختلف')
  }
  if (deactivation_code && (await checkDuplicateAgentSupplierCode(DB, 'deactivation_code', deactivation_code, { table: 'agents', id }))) {
    throw new Error('رمز الإلغاء مستخدم بالفعل من وكيل/مورد آخر، الرجاء اختيار رمز مختلف')
  }
  await DB.prepare(
    `UPDATE agents SET name=?, conversation_key=?, phone=?, notes=?, default_supplier_id=?, is_active=?, activation_code=?, deactivation_code=?, updated_at=datetime('now') WHERE id=?`
  ).bind(name, conversation_key, phone, notes, default_supplier_id, is_active, activation_code, deactivation_code, id).run()
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
  const activation_code = body.activation_code?.trim() || null
  const deactivation_code = body.deactivation_code?.trim() || null
  if (activation_code && (await checkDuplicateAgentSupplierCode(DB, 'activation_code', activation_code))) {
    throw new Error('رمز التفعيل مستخدم بالفعل من وكيل/مورد آخر، الرجاء اختيار رمز مختلف')
  }
  if (deactivation_code && (await checkDuplicateAgentSupplierCode(DB, 'deactivation_code', deactivation_code))) {
    throw new Error('رمز الإلغاء مستخدم بالفعل من وكيل/مورد آخر، الرجاء اختيار رمز مختلف')
  }
  const insert = await DB.prepare(
    `INSERT INTO suppliers (customer_id, name, conversation_key, phone, notes, activation_code, deactivation_code) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(customerId, name.trim(), conversation_key || null, phone || null, notes || null, activation_code, deactivation_code).run()
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
  const activation_code = body.activation_code !== undefined ? (body.activation_code?.trim() || null) : existing.activation_code
  const deactivation_code = body.deactivation_code !== undefined ? (body.deactivation_code?.trim() || null) : existing.deactivation_code
  if (activation_code && (await checkDuplicateAgentSupplierCode(DB, 'activation_code', activation_code, { table: 'suppliers', id }))) {
    throw new Error('رمز التفعيل مستخدم بالفعل من وكيل/مورد آخر، الرجاء اختيار رمز مختلف')
  }
  if (deactivation_code && (await checkDuplicateAgentSupplierCode(DB, 'deactivation_code', deactivation_code, { table: 'suppliers', id }))) {
    throw new Error('رمز الإلغاء مستخدم بالفعل من وكيل/مورد آخر، الرجاء اختيار رمز مختلف')
  }
  await DB.prepare(
    `UPDATE suppliers SET name=?, conversation_key=?, phone=?, notes=?, is_active=?, activation_code=?, deactivation_code=?, updated_at=datetime('now') WHERE id=?`
  ).bind(name, conversation_key, phone, notes, is_active, activation_code, deactivation_code, id).run()
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
