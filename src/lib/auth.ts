// Password hashing + JWT helpers using only Web Crypto API (Cloudflare Workers compatible)

// Fix 2026-10-04 (real production bug): several customers.email rows in
// production contain invisible Unicode bidi control characters (U+200F
// RIGHT-TO-LEFT MARK, U+202C POP DIRECTIONAL FORMATTING, etc.) — e.g.
// 'wkaltalryadblas@gmail.com\u202c\u200f'. These get silently pasted in
// when an admin on an RTL (Arabic) keyboard/browser copies an email from
// WhatsApp/a contact card into the "إضافة عميل جديد" form, whose email
// input sits inside a dir="rtl" page with no dir="ltr" override. The
// customer then types/pastes their REAL email (without the invisible
// marks) on /portal, and the strict `WHERE email = ?` lookup in
// auth.ts's /customer/login never matches — login fails with "بيانات
// الدخول غير صحيحة" even though both the email and password are, from
// the customer's own point of view, 100% correct. normalizeEmail() strips
// every bidi/invisible control character plus surrounding whitespace and
// lowercases the result, applied consistently at BOTH write time (admin
// creates/updates a customer) and read time (login lookup) so a stray
// invisible character can never again cause a false "wrong credentials".
const INVISIBLE_CHARS_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g
export function normalizeEmail(email: string): string {
  return (email || '').replace(INVISIBLE_CHARS_RE, '').trim().toLowerCase()
}

function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

export async function hashPassword(password: string, saltHex?: string): Promise<{ hash: string; salt: string }> {
  const salt = saltHex ? hexToBuf(saltHex) : crypto.getRandomValues(new Uint8Array(16))
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  )
  return { hash: bufToHex(bits), salt: bufToHex(salt.buffer as ArrayBuffer) }
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const result = await hashPassword(password, salt)
  return result.hash === hash
}

function base64url(input: ArrayBuffer | string): string {
  let bytes: Uint8Array
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input)
  } else {
    bytes = new Uint8Array(input)
  }
  let str = ''
  for (const b of bytes) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(input: string): string {
  input = input.replace(/-/g, '+').replace(/_/g, '/')
  while (input.length % 4) input += '='
  return atob(input)
}

export interface JwtPayload {
  sub: number
  role: 'admin' | 'customer'
  email: string
  name: string
  exp: number
}

export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const headerB64 = base64url(JSON.stringify(header))
  const payloadB64 = base64url(JSON.stringify(payload))
  const data = `${headerB64}.${payloadB64}`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  const sigB64 = base64url(sig)
  return `${data}.${sigB64}`
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const [headerB64, payloadB64, sigB64] = token.split('.')
    if (!headerB64 || !payloadB64 || !sigB64) return null
    const data = `${headerB64}.${payloadB64}`
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const sigBytes = Uint8Array.from(base64urlDecode(sigB64), (c) => c.charCodeAt(0))
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data))
    if (!valid) return null
    const payload: JwtPayload = JSON.parse(base64urlDecode(payloadB64))
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}
