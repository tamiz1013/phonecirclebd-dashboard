require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo').default;
const bcrypt = require('bcryptjs');

const db = require('./src/db');
const { col, BANK_ID, BANK_NAME } = db;
const {
  TYPES, EXPENSE_CATEGORIES, CONDITIONS, VERIFICATIONS_NEEDED,
  createEntry, editEntry, verifyEntry, deleteEntry,
  activeVerifications, logAction, isAdmin,
} = require('./src/entries');
const finance = require('./src/finance');

const app = express();
const PORT = process.env.PORT || 3000;

// Connect once; the session store and the listen() call both wait on this.
const clientPromise = db.connect().then(() => db.getClient());

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set — everyone gets logged out on every restart. Set it in .env.');
}

app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Docker / a reverse proxy

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  // Sessions live in MongoDB so logins survive restarts and memory stays flat.
  store: MongoStore.create({ clientPromise, dbName: db.DB_NAME }),
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000 * 60 * 60 * 24 * 7 },
}));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  db.ping().then(() => res.json({ ok: true }))
    .catch(() => res.status(503).json({ ok: false }));
});

// async route wrapper — any thrown error becomes a 500 JSON response
const h = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: 'Server error: ' + err.message });
});

// Resolve a holder id to a display name (users + the company bank).
async function nameMap() {
  const users = await col('users').find({}).toArray();
  const map = new Map(users.map((u) => [u.id, u.name]));
  map.set(BANK_ID, BANK_NAME);
  return map;
}

// ---- auth ------------------------------------------------------------------

async function currentUser(req) {
  if (!req.session.userId) return null;
  const u = await col('users').findOne({ id: req.session.userId, active: 1 });
  if (!u) return null;
  return { id: u.id, username: u.username, name: u.name, roles: u.roles };
}

function auth(fn) {
  return h(async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    req.user = user;
    return fn(req, res);
  });
}
function adminOnly(fn) {
  return auth(async (req, res) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin only' });
    return fn(req, res);
  });
}

// Simple per-IP brute-force guard: 20 failed logins per 15 minutes.
const loginFails = new Map();
const LOGIN_WINDOW = 15 * 60 * 1000, LOGIN_MAX = 20;
function tooManyFails(ip) {
  const rec = loginFails.get(ip);
  if (rec && Date.now() > rec.resetAt) loginFails.delete(ip);
  return (loginFails.get(ip)?.count || 0) >= LOGIN_MAX;
}
function recordFail(ip) {
  if (loginFails.size > 5000) {
    for (const [k, v] of loginFails) if (Date.now() > v.resetAt) loginFails.delete(k);
  }
  const rec = loginFails.get(ip) || { count: 0, resetAt: Date.now() + LOGIN_WINDOW };
  rec.count++;
  loginFails.set(ip, rec);
}

app.post('/api/login', h(async (req, res) => {
  if (tooManyFails(req.ip)) {
    return res.status(429).json({ error: 'Too many failed logins — wait 15 minutes and try again' });
  }
  const { username, password } = req.body || {};
  const user = await col('users').findOne({
    username: String(username || '').toLowerCase().trim(), active: 1,
  });
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    recordFail(req.ip);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  loginFails.delete(req.ip);
  req.session.userId = user.id;
  res.json({ id: user.id, username: user.username, name: user.name, roles: user.roles });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', h(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  res.json(user);
}));

app.post('/api/change-password', auth(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const row = await col('users').findOne({ id: req.user.id });
  if (!bcrypt.compareSync(String(oldPassword || ''), row.password_hash)) {
    return res.status(400).json({ error: 'Current password is wrong' });
  }
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  await col('users').updateOne({ id: req.user.id },
    { $set: { password_hash: bcrypt.hashSync(String(newPassword), 10) } });
  res.json({ ok: true });
}));

// ---- reference data ----------------------------------------------------------

app.get('/api/meta', auth(async (req, res) => {
  const users = await col('users').find({}).sort({ id: 1 }).toArray();
  const purchases = await col('purchases').find({}).toArray();
  const soldIds = new Set((await col('sales').find({}).toArray()).map((s) => s.purchase_id));
  res.json({
    users: users.map((u) => ({ id: u.id, username: u.username, name: u.name, roles: u.roles, active: u.active })),
    bankId: BANK_ID,
    bankName: BANK_NAME,
    expenseCategories: EXPENSE_CATEGORIES,
    conditions: CONDITIONS,
    verificationsNeeded: VERIFICATIONS_NEEDED,
    unsoldPurchases: purchases
      .filter((p) => !soldIds.has(p.id))
      .sort((a, b) => b.purchase_date.localeCompare(a.purchase_date))
      .map((p) => ({
        id: p.id, brand: p.brand, model: p.model, condition: p.condition,
        storage: p.storage, variant: p.variant, color: p.color,
        total_cost: p.price + p.repair_cost, purchase_date: p.purchase_date,
      })),
  });
}));

// ---- verifiable entries (purchases / sales / expenses / investments) --------

const strip = (r) => { const { _id, ...rest } = r; return rest; };

const LISTERS = {
  async purchases() {
    const [rows, sales, names] = await Promise.all([
      col('purchases').find({}).toArray(), col('sales').find({}).toArray(), nameMap(),
    ]);
    const saleByPurchase = new Map(sales.map((s) => [s.purchase_id, s.id]));
    return rows.map((p) => ({
      ...strip(p),
      total_cost: p.price + p.repair_cost,
      bought_by_name: names.get(p.bought_by) || '—',
      created_by_name: names.get(p.created_by) || '—',
      sale_id: saleByPurchase.get(p.id) ?? null,
    })).sort((a, b) => b.purchase_date.localeCompare(a.purchase_date) || b.id - a.id);
  },
  async sales() {
    const [rows, purchases, names] = await Promise.all([
      col('sales').find({}).toArray(), col('purchases').find({}).toArray(), nameMap(),
    ]);
    const byId = new Map(purchases.map((p) => [p.id, p]));
    return rows.map((s) => {
      const p = byId.get(s.purchase_id) || {};
      const cost = (p.price || 0) + (p.repair_cost || 0);
      return {
        ...strip(s),
        sold_by_name: names.get(s.sold_by) || '—',
        created_by_name: names.get(s.created_by) || '—',
        brand: p.brand, model: p.model, condition: p.condition,
        storage: p.storage, variant: p.variant,
        total_cost: cost, purchase_date: p.purchase_date,
        margin: s.sale_price - cost,
        days_in_stock: p.purchase_date
          ? Math.floor((Date.parse(s.sale_date) - Date.parse(p.purchase_date)) / 86400000) : 0,
      };
    }).sort((a, b) => b.sale_date.localeCompare(a.sale_date) || b.id - a.id);
  },
  async expenses() {
    const [rows, names] = await Promise.all([col('expenses').find({}).toArray(), nameMap()]);
    return rows.map((e) => ({
      ...strip(e),
      created_by_name: names.get(e.created_by) || '—',
      related_user_name: e.related_user != null ? names.get(e.related_user) || null : null,
      paid_by_name: e.paid_by != null ? names.get(e.paid_by) || null : null,
    })).sort((a, b) => b.expense_date.localeCompare(a.expense_date) || b.id - a.id);
  },
  async investments() {
    const [rows, names] = await Promise.all([col('investments').find({}).toArray(), nameMap()]);
    return rows.map((i) => ({
      ...strip(i),
      investor_name: names.get(i.investor_id) || '—',
      created_by_name: names.get(i.created_by) || '—',
      received_by_name: i.received_by != null ? names.get(i.received_by) || null : null,
    })).sort((a, b) => b.invest_date.localeCompare(a.invest_date) || b.id - a.id);
  },
  async transfers() {
    const [rows, names] = await Promise.all([col('transfers').find({}).toArray(), nameMap()]);
    return rows.map((t) => ({
      ...strip(t),
      from_name: names.get(t.from_user) || '—',
      to_name: names.get(t.to_user) || '—',
      created_by_name: names.get(t.created_by) || '—',
    })).sort((a, b) => b.transfer_date.localeCompare(a.transfer_date) || b.id - a.id);
  },
};

app.param('type', (req, res, next, type) => {
  if (!TYPES[type]) return res.status(404).json({ error: 'Unknown entry type' });
  next();
});

app.get('/api/entries/:type', auth(async (req, res) => {
  const rows = await LISTERS[req.params.type]();
  await Promise.all(rows.map(async (r) => {
    r.verifications = await activeVerifications(req.params.type, r.id);
  }));
  res.json(rows);
}));

app.post('/api/entries/:type', auth(async (req, res) => {
  const result = await createEntry(req.params.type, req.body || {}, req.user);
  if (result.errors) return res.status(400).json({ error: result.errors.join('. ') });
  res.status(201).json({ id: result.id, status: 'pending' });
}));

app.put('/api/entries/:type/:id', auth(async (req, res) => {
  const result = await editEntry(req.params.type, Number(req.params.id), req.body || {}, req.user);
  if (result.notFound) return res.status(404).json({ error: 'Entry not found' });
  if (result.errors) return res.status(400).json({ error: result.errors.join('. ') });
  res.json({ id: result.id, status: result.unchanged ? undefined : 'pending', unchanged: !!result.unchanged });
}));

app.post('/api/entries/:type/:id/verify', auth(async (req, res) => {
  const result = await verifyEntry(req.params.type, Number(req.params.id), req.user);
  if (result.notFound) return res.status(404).json({ error: 'Entry not found' });
  if (result.errors) return res.status(400).json({ error: result.errors.join('. ') });
  res.json({ id: result.id, status: result.status });
}));

app.delete('/api/entries/:type/:id', auth(async (req, res) => {
  const result = await deleteEntry(req.params.type, Number(req.params.id), req.user);
  if (result.notFound) return res.status(404).json({ error: 'Entry not found' });
  if (result.errors) return res.status(400).json({ error: result.errors.join('. ') });
  res.json({ ok: true });
}));

// ---- dashboard, analytics, audit --------------------------------------------

app.get('/api/summary', auth(async (req, res) => res.json(await finance.summary())));
app.get('/api/stock', auth(async (req, res) => res.json(await finance.stock())));
app.get('/api/analytics', auth(async (req, res) => res.json(await finance.analytics())));
app.get('/api/charts', auth(async (req, res) => res.json({ monthly: await finance.monthly() })));

app.get('/api/calendar', auth(async (req, res) => {
  const month = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  res.json(await finance.calendar(month));
}));

app.get('/api/audit', auth(async (req, res) => {
  const [rows, names] = await Promise.all([
    col('audit_log').find({}).sort({ id: -1 }).limit(500).toArray(),
    nameMap(),
  ]);
  res.json(rows.map((r) => ({ ...strip(r), user_name: names.get(r.user_id) || '#' + r.user_id })));
}));

// ---- user administration (admin only) ----------------------------------------

app.post('/api/users', adminOnly(async (req, res) => {
  const { username, name, password, roles } = req.body || {};
  const uname = String(username || '').toLowerCase().trim();
  if (!/^[a-z0-9_]{2,30}$/.test(uname)) return res.status(400).json({ error: 'Username: 2–30 chars, letters/digits/underscore' });
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const roleList = String(roles || '').split(',').map((r) => r.trim()).filter(Boolean);
  if (!roleList.length || !roleList.every((r) => ['admin', 'investor', 'operator', 'helper'].includes(r))) {
    return res.status(400).json({ error: 'Roles must be one or more of: admin, investor, operator, helper' });
  }
  if (await col('users').findOne({ username: uname })) {
    return res.status(400).json({ error: 'Username already exists' });
  }
  const id = await db.nextId('users');
  await col('users').insertOne({
    id, username: uname, name: name.trim(),
    password_hash: bcrypt.hashSync(password, 10),
    roles: roleList.join(','), active: 1, created_at: db.now(),
  });
  await logAction('users', id, req.user.id, 'user-admin', null,
    { username: uname, name: name.trim(), roles: roleList.join(',') });
  res.status(201).json({ id });
}));

app.put('/api/users/:id', adminOnly(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await col('users').findOne({ id });
  if (!existing) return res.status(404).json({ error: 'User not found' });

  const name = req.body.name?.trim() || existing.name;
  let roles = existing.roles;
  if (req.body.roles !== undefined) {
    const roleList = String(req.body.roles).split(',').map((r) => r.trim()).filter(Boolean);
    if (!roleList.length || !roleList.every((r) => ['admin', 'investor', 'operator', 'helper'].includes(r))) {
      return res.status(400).json({ error: 'Roles must be one or more of: admin, investor, operator, helper' });
    }
    roles = roleList.join(',');
  }
  let active = existing.active;
  if (req.body.active !== undefined) active = req.body.active ? 1 : 0;
  if (id === req.user.id && (!active || !roles.split(',').includes('admin'))) {
    return res.status(400).json({ error: 'You cannot deactivate yourself or drop your own admin role' });
  }

  const update = { name, roles, active };
  if (req.body.password) {
    if (req.body.password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    update.password_hash = bcrypt.hashSync(req.body.password, 10);
  }
  await col('users').updateOne({ id }, { $set: update });
  await logAction('users', id, req.user.id, 'user-admin',
    { name: existing.name, roles: existing.roles, active: existing.active },
    { name, roles, active, passwordReset: !!req.body.password });
  res.json({ ok: true });
}));

// Delete a member outright (admin). Only possible while the member has no
// records — otherwise history would break, so the answer is deactivate.
app.delete('/api/users/:id', adminOnly(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  const existing = await col('users').findOne({ id });
  if (!existing) return res.status(404).json({ error: 'User not found' });

  const refs = [
    ['purchases', { $or: [{ bought_by: id }, { created_by: id }] }],
    ['sales', { $or: [{ sold_by: id }, { created_by: id }] }],
    ['expenses', { $or: [{ related_user: id }, { paid_by: id }, { created_by: id }] }],
    ['investments', { $or: [{ investor_id: id }, { received_by: id }, { created_by: id }] }],
    ['transfers', { $or: [{ from_user: id }, { to_user: id }, { created_by: id }] }],
    ['verifications', { user_id: id }],
    ['audit_log', { user_id: id }],
  ];
  const used = [];
  for (const [table, filter] of refs) {
    if (await col(table).findOne(filter)) used.push(table);
  }
  if (used.length) {
    return res.status(400).json({
      error: `Cannot delete ${existing.name} — they appear in ${used.join(', ')}. ` +
             'Deactivate them instead so history stays intact.',
    });
  }
  await col('users').deleteOne({ id });
  await logAction('users', id, req.user.id, 'user-admin',
    { username: existing.username, name: existing.name, roles: existing.roles }, { deleted: true });
  res.json({ ok: true });
}));

let server;
clientPromise.then(() => {
  server = app.listen(PORT, () => {
    console.log(`PhoneCircle BD dashboard running at http://localhost:${PORT} (db: ${db.DB_NAME})`);
  });
}).catch((err) => {
  console.error('Could not connect to MongoDB:', err.message);
  process.exit(1);
});

// Finish in-flight requests, then close the DB connection (docker stop sends SIGTERM).
function shutdown(signal) {
  console.log(`${signal} received — shutting down`);
  const closeDb = () => db.getClient()?.close().catch(() => {}).then(() => process.exit(0));
  if (server) server.close(closeDb); else closeDb();
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
