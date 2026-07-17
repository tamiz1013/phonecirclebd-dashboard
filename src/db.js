const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

// Data lives in MongoDB Atlas. The connection string holds the database
// password, so it comes from the environment (.env) — never from code.
// Use PHONECIRCLE_DB_NAME to point at a test database without touching live.
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.PHONECIRCLE_DB_NAME || 'phonecircle';

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// The company bank account is a cash holder but not a user. All investment
// money lands here; only an admin (Tamiz — bank access) can transfer out of it.
const BANK_ID = 0;
const BANK_NAME = '🏦 Company bank';

const ENTRY_COLLECTIONS = ['purchases', 'sales', 'expenses', 'investments', 'transfers'];
const ALL_COLLECTIONS = ['users', ...ENTRY_COLLECTIONS, 'verifications', 'audit_log'];

let client = null;
let db = null;

function col(name) {
  if (!db) throw new Error('Database not connected yet');
  return db.collection(name);
}

// Sequential numeric ids (like SQLite AUTOINCREMENT) so URLs, audit rows and
// the imported history keep working unchanged.
async function nextId(name) {
  const r = await col('counters').findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return r.seq;
}

async function setCounterAtLeast(name, value) {
  await col('counters').updateOne({ _id: name }, { $max: { seq: value } }, { upsert: true });
}

async function ensureIndexes() {
  await col('users').createIndex({ username: 1 }, { unique: true });
  for (const c of ALL_COLLECTIONS) await col(c).createIndex({ id: 1 }, { unique: true });
  await col('verifications').createIndex({ entry_type: 1, entry_id: 1 });
  await col('audit_log').createIndex({ id: -1 });
}

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// ---- one-time import of the old local SQLite database ----------------------
// Runs only when Mongo is completely empty and the old data/ file exists.
// The SQLite file is opened read-only and never modified.
async function importFromSqlite() {
  const sqlitePath = path.join(
    process.env.PHONECIRCLE_DATA_DIR || path.join(__dirname, '..', 'data'),
    'phonecircle.db',
  );
  if (!fs.existsSync(sqlitePath)) return false;

  let Database;
  try { Database = require('better-sqlite3'); } catch { return false; }
  const sq = new Database(sqlitePath, { readonly: true });

  try {
    const tables = {};
    for (const t of ALL_COLLECTIONS) tables[t] = sq.prepare(`SELECT * FROM ${t}`).all();

    // Align old rows with the new cash rules:
    //  - an expense is always paid from its creator's cash
    //  - investment money always sits in the company bank account
    for (const e of tables.expenses) if (e.paid_by == null) e.paid_by = e.created_by;
    for (const i of tables.investments) if (i.received_by == null) i.received_by = BANK_ID;

    for (const [name, rows] of Object.entries(tables)) {
      if (rows.length) await col(name).insertMany(rows);
      const maxId = rows.reduce((m, r) => Math.max(m, r.id || 0), 0);
      await setCounterAtLeast(name, maxId);
    }
    console.log(`Imported existing data from ${sqlitePath} into MongoDB (${DB_NAME}).`);
    return true;
  } finally {
    sq.close();
  }
}

async function seedUsers() {
  const hash = bcrypt.hashSync('phonecircle123', 10);
  const seed = [
    ['tamiz', 'Tamiz', 'admin,investor'],
    ['abir', 'ABIR', 'investor'],
    ['atik', 'ATIK', 'investor'],
    ['obayed', 'OBAYED', 'investor'],
    ['afzal', 'Afzal', 'operator'],
  ];
  for (const [username, name, roles] of seed) {
    await col('users').insertOne({
      id: await nextId('users'), username, name, password_hash: hash,
      roles, active: 1, created_at: now(),
    });
  }
  console.log('Seeded 5 users (password for all: phonecircle123 — change after first login).');
}

async function connect() {
  if (db) return db;
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await ensureIndexes();

  const userCount = await col('users').countDocuments();
  if (userCount === 0) {
    const imported = await importFromSqlite();
    if (!imported) await seedUsers();
  }
  return db;
}

const getClient = () => client;
const ping = async () => col('users').estimatedDocumentCount();

module.exports = {
  connect, col, nextId, now, getClient, ping,
  BANK_ID, BANK_NAME, ENTRY_COLLECTIONS, DB_NAME,
};
