import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import type { AppEnv } from './lib/types'
import authRoutes from './routes/auth'
import adminRoutes from './routes/admin'
import customerRoutes from './routes/customer'
import publicRoutes from './routes/public'
import webhookRoutes from './routes/webhook'
import { landingPage } from './pages/landing'
import { adminLoginPage, adminDashboardPage } from './pages/admin-pages'
import { customerLoginPage, customerDashboardPage } from './pages/customer-pages'

const app = new Hono<AppEnv>()

app.use('/static/*', serveStatic({ root: './public' }))
app.get('/favicon.ico', (c) => c.body(null, 204))

// ---------------------- API routes ----------------------
app.route('/api/auth', authRoutes)
app.route('/api/admin', adminRoutes)
app.route('/api/customer', customerRoutes)
app.route('/api/public', publicRoutes)
app.route('/webhook', webhookRoutes)

// ---------------------- Frontend pages ----------------------
app.get('/', (c) => c.html(landingPage()))
app.get('/admin', (c) => c.html(adminLoginPage()))
app.get('/admin/dashboard', (c) => c.html(adminDashboardPage()))
app.get('/portal', (c) => c.html(customerLoginPage()))
app.get('/portal/dashboard', (c) => c.html(customerDashboardPage()))

app.notFound((c) => c.html(landingPage(), 404))

export default app
