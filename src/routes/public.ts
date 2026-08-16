import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'

const pub = new Hono<AppEnv>()

// Public list of active packages, for the landing page pricing section
pub.get('/packages', async (c) => {
  const { DB } = c.env
  const result = await DB.prepare('SELECT * FROM packages WHERE is_active = 1 ORDER BY sort_order ASC, id ASC').all()
  return c.json({ packages: result.results })
})

export default pub
