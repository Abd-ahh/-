import { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import { verifyJwt } from './auth'
import type { AppEnv } from './types'

export async function requireAdmin(c: Context<AppEnv>, next: Next) {
  const token = getCookie(c, 'admin_session') || (c.req.header('Authorization') || '').replace('Bearer ', '')
  const secret = c.env.JWT_SECRET || 'dev-secret-change-me'
  const payload = token ? await verifyJwt(token, secret) : null
  if (!payload || payload.role !== 'admin') {
    return c.json({ error: 'غير مصرح لك بالدخول' }, 401)
  }
  c.set('admin', { id: payload.sub, email: payload.email, name: payload.name })
  await next()
}

export async function requireCustomer(c: Context<AppEnv>, next: Next) {
  const token = getCookie(c, 'customer_session') || (c.req.header('Authorization') || '').replace('Bearer ', '')
  const secret = c.env.JWT_SECRET || 'dev-secret-change-me'
  const payload = token ? await verifyJwt(token, secret) : null
  if (!payload || payload.role !== 'customer') {
    return c.json({ error: 'غير مصرح لك بالدخول' }, 401)
  }
  c.set('customer', { id: payload.sub, email: payload.email, name: payload.name })
  await next()
}
