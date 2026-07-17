# PhoneCircle BD 📱

Web dashboard for a 5-person mobile phone reselling business: phone purchases & sales,
expenses, investments, money transfers between members, a verification workflow,
a permanent audit log, and an automatic profit split.

## Run it

Secrets live in `.env` (never committed — see `.gitignore`). First time:

```bash
cp .env.example .env   # then fill in MONGODB_URI and SESSION_SECRET
npm install
npm start              # http://localhost:3000
```

Environment variables (all read from `.env`):

| Variable | Meaning |
|---|---|
| `MONGODB_URI` | Atlas connection string — **required**, contains the DB password |
| `SESSION_SECRET` | signs login cookies; generate with `openssl rand -hex 32` |
| `PHONECIRCLE_DB_NAME` | database name (default `phonecircle`; use another for testing) |
| `PORT` | default 3000 (the Docker container uses 3008) |

Data is stored in **MongoDB Atlas**. Login sessions are stored there too, so
restarts don't log anyone out. On first run against an empty database, the old
local SQLite file in `data/` is imported automatically (kept untouched as a backup).

## Deploy with Docker

The container listens on **3008**; the server publishes it on host port **3009**:

```bash
docker compose up -d --build   # http://<server>:3009
docker compose logs -f         # watch it start
```

`.env` must exist next to `docker-compose.yml` (it is passed via `env_file`,
never baked into the image). A `/api/health` endpoint drives the container
healthcheck. If you put HTTPS in front (nginx/Caddy), proxy to port 3009 —
`trust proxy` is already set so secure cookies work.

## Accounts

Seeded on first run — **all with password `phonecircle123`** (change it from the
Members tab):

| Username | Role |
|---|---|
| `tamiz` | admin + investor |
| `abir` | investor |
| `atik` | investor |
| `obayed` | investor |
| `afzal` | operator |

Admins can add more members, including **helpers** — helping-hand people who can
hold cash, make entries, and verify.

## How verification works

1. Any member creates an entry (purchase / sale / expense / transfer / investment)
   → it shows immediately, marked **⏳ Pending**, and is **always attributed to its
   creator** — there is no "who did this" selector. If you record it, it's yours.
2. Other members click **Verify**. **Three** verifications from members other than
   the creator → **✓ Verified**. An admin verifying **someone else's** entry
   verifies it instantly.
3. **Nobody can verify their own entry — not even an admin.**
4. The creator can **delete** their own entry while it is still Pending. Once
   verified, it can never be deleted (the delete itself is audit-logged).
5. Only the creator (or an admin) can edit an entry. Editing resets it to Pending
   and invalidates its verifications (kept in the database, never deleted).
   Attribution never changes on edit.
6. Every create / edit / verify / delete is written to the **Audit log** with
   user, timestamp, and old → new values.

Dashboard totals include **all** entries, verified or pending — each entry's badge
lives on its own tab.

## Who is holding the cash

Cash only — a phone in stock is stock value, never cash. Every money movement is
attributed automatically, so the dashboard always shows who physically holds
company money:

- **Investment** → always credited to the **🏦 Company bank** account
- **Sale** → credited to the seller (the entry's creator)
- **Purchase** (price + repair) → deducted from the buyer (the entry's creator)
- **Expense** → deducted from the creator's cash
- **Transfer** → moves cash between members and/or the company bank.
  Only an admin (Tamiz — bank access) can send **from** the bank; anyone can
  deposit their cash back **to** the bank.

The flow: investors' money sits in the company bank → Tamiz transfers operating
cash to whoever needs it → they buy/spend from their own cash → sale money stays
with the seller until transferred back. The per-holder balances always sum to
company cash remaining.

## The money math

```
Total phone cost = Buying price + Repair & other cost
Gross profit     = Sales revenue − Cost of the phones that were sold
Net profit       = Gross profit − (transport + food + accessories + other) − Salary

Afzal            = Salary + 50% × Net profit
Investor pool    = 50% × Net profit
Each investor    = (their investment ÷ total investment) × Investor pool

Cash             = Investments + Sales revenue − Purchases − Expenses − Salary
```

Ownership % recalculates automatically whenever any investment changes.
Salary is an expense with category `salary`, tagged with who was paid.

## Tabs

- **Dashboard** — KPI tiles, monthly bought-vs-sold / net-profit / money-flow charts,
  cash-by-holder, P&L, member P&L, slow-stock alerts (>30 days), phones in stock,
  and a **daily calendar** (phones bought, sold, and P&L per day).
- **Purchases** — full tracking: brand, model, variant, storage, color, condition,
  battery health, buying price, repair cost (total auto-calculated), date, location,
  seller name & phone, IMEI 1/2, parts & service history, notes.
- **Sales** — link to a phone in stock; margin (after repair costs) and days-in-stock
  are automatic.
- **Expenses / Transfers / Investments** — with cash-holder attribution.
- **Members** — individual P&L, cash in hand, add/edit members; **Delete** (with
  confirmation) works only while a member has no records — otherwise deactivate,
  so history stays intact. Deletions are audit-logged.
- **Analytics** — best-margin brands & models, condition vs margin, sales by member,
  average days in stock.
- **Audit log** — the permanent record of every action.

## Notes for the admin

- The business record now lives in MongoDB Atlas (`phonecircle` database) —
  the old `data/` folder is the pre-migration backup; keep it.
- Set `SESSION_SECRET` so everyone stays logged in across server restarts.
