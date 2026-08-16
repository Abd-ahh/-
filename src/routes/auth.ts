import { Hono } from 'hono'
import { setCookie, deleteCookie } from 'hono/cookie'
import { hashPassword, verifyPassword, signJwt } from '../lib/auth'
import type { AppEnv } from '../lib/types'

const auth = new Hono<AppEnv>()

const SESSION_SECONDS = 60 * 60 * 24 * 7 // 7 days

// ---------- Admin bootstrap (only works if there are zero admins) ----------
auth.post('/admin/bootstrap', async (c) => {
  const { DB } = c.env
  const existing = await DB.prepare('SELECT COUNT(*) as cnt FROM admins').first<{ cnt: number }>()
  if (existing && existing.cnt > 0) {
    return c.json({ error: 'تم إعداد حساب المدير بالفعل' }, 400)
  }
  const { name, email, password } = await c.req.json()
  if (!name || !email || !password) {
    return c.json({ error: 'الرجاء تعبئة جميع الحقول' }, 400)
  }
  const { hash, salt } = await hashPassword(password)
  await DB.prepare('INSERT INTO admins (name, email, password_hash, password_salt) VALUES (?, ?, ?, ?)')
    .bind(name, email, hash, salt)
    .run()
  return c.json({ success: true })
})

auth.get('/admin/bootstrap-status', async (c) => {
  const { DB } = c.env
  const existing = await DB.prepare('SELECT COUNT(*) as cnt FROM admins').first<{ cnt: number }>()
  return c.json({ needs_bootstrap: !existing || existing.cnt === 0 })
})

// ---------- Admin login ----------
auth.post('/admin/login', async (c) => {
  const { DB, JWT_SECRET } = c.env
  const { email, password } = await c.req.json()
  const admin = await DB.prepare('SELECT * FROM admins WHERE email = ?').bind(email).first<any>()
  if (!admin) return c.json({ error: 'بيانات الدخول غير صحيحة' }, 401)
  const ok = await verifyPassword(password, admin.password_hash, admin.password_salt)
  if (!ok) return c.json({ error: 'بيانات الدخول غير صحيحة' }, 401)

  const token = await signJwt(
    { sub: admin.id, role: 'admin', email: admin.email, name: admin.name, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS },
    JWT_SECRET || 'dev-secret-change-me'
  )
  setCookie(c, 'admin_session', token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_SECONDS })
  return c.json({ success: true, token, admin: { id: admin.id, name: admin.name, email: admin.email } })
})

auth.post('/admin/logout', async (c) => {
  deleteCookie(c, 'admin_session', { path: '/' })
  return c.json({ success: true })
})

// ---------- Customer login ----------
auth.post('/customer/login', async (c) => {
  const { DB, JWT_SECRET } = c.env
  const { email, password } = await c.req.json()
  const customer = await DB.prepare('SELECT * FROM customers WHERE email = ?').bind(email).first<any>()
  if (!customer) return c.json({ error: 'بيانات الدخول غير صحيحة' }, 401)
  if (customer.status !== 'active') return c.json({ error: 'حسابك موقوف حالياً، تواصل مع الدعم' }, 403)
  const ok = await verifyPassword(password, customer.password_hash, customer.password_salt)
  if (!ok) return c.json({ error: 'بيانات الدخول غير صحيحة' }, 401)

  const token = await signJwt(
    { sub: customer.id, role: 'customer', email: customer.email, name: customer.name, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS },
    JWT_SECRET || 'dev-secret-change-me'
  )
  setCookie(c, 'customer_session', token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_SECONDS })
  return c.json({ success: true, token, customer: { id: customer.id, name: customer.name, email: customer.email } })
})

auth.post('/customer/logout', async (c) => {
  deleteCookie(c, 'customer_session', { path: '/' })
  return c.json({ success: true })
})

export default auth
