const { col, BANK_ID, BANK_NAME } = require('./db');

// All figures include every entry, verified or pending — each entry still
// carries its own status badge on its tab. Phone cost = price + repair_cost.
// The data set is small (one team's books), so everything is computed in JS
// from full collection reads.

async function loadAll() {
  const [users, purchases, sales, expenses, investments, transfers] = await Promise.all(
    ['users', 'purchases', 'sales', 'expenses', 'investments', 'transfers']
      .map((c) => col(c).find({}).toArray()),
  );
  return { users, purchases, sales, expenses, investments, transfers };
}

const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0);
const phoneCost = (p) => p.price + p.repair_cost;
const DAY = 86400000;
const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / DAY);

function scopeTotals(d) {
  const investments = sum(d.investments, (r) => r.amount);
  const purchases = sum(d.purchases, phoneCost);
  const salesRevenue = sum(d.sales, (r) => r.sale_price);
  const byId = new Map(d.purchases.map((p) => [p.id, p]));
  const costOfSold = sum(d.sales, (s) => (byId.get(s.purchase_id) ? phoneCost(byId.get(s.purchase_id)) : 0));
  const salary = sum(d.expenses.filter((e) => e.category === 'salary'), (e) => e.amount);
  const otherExpenses = sum(d.expenses.filter((e) => e.category !== 'salary'), (e) => e.amount);

  const grossProfit = salesRevenue - costOfSold;
  const netProfit = grossProfit - otherExpenses - salary;
  const cash = investments + salesRevenue - purchases - otherExpenses - salary;

  return {
    investments, purchases, salesRevenue, costOfSold,
    salary, otherExpenses,
    grossProfit, netProfit, cash,
    operatorPool: netProfit * 0.5,
    investorPool: netProfit * 0.5,
  };
}

// Ownership % per investor = their investment / total investment.
function ownership(d) {
  const map = new Map();
  for (const i of d.investments) map.set(i.investor_id, (map.get(i.investor_id) || 0) + i.amount);
  const total = [...map.values()].reduce((s, v) => s + v, 0);
  return [...map.entries()].map(([user_id, invested]) => ({
    user_id,
    name: d.users.find((u) => u.id === user_id)?.name || '#' + user_id,
    invested,
    pct: total > 0 ? invested / total : 0,
  }));
}

// Per-member P&L. Operators split the 50% operator pool equally (with one
// operator — Afzal — that is exactly "salary + 50% of net profit"). Investors
// take the other 50% pro-rata by ownership.
function memberBreakdown(d) {
  const totals = scopeTotals(d);
  const own = ownership(d);
  const users = d.users.filter((u) => u.active === 1);
  const operators = users.filter((u) => u.roles.split(',').includes('operator'));

  const salaryByUser = {};
  for (const e of d.expenses) {
    if (e.category === 'salary' && e.related_user != null) {
      salaryByUser[e.related_user] = (salaryByUser[e.related_user] || 0) + e.amount;
    }
  }

  return users.map((u) => {
    const inv = own.find((o) => o.user_id === u.id);
    const invested = inv ? inv.invested : 0;
    const pct = inv ? inv.pct : 0;
    const investorShare = totals.investorPool * pct;
    const isOperator = operators.some((o) => o.id === u.id);
    const operatorShare = isOperator && operators.length > 0
      ? totals.operatorPool / operators.length : 0;
    const salaryPaid = salaryByUser[u.id] || 0;
    return {
      user_id: u.id,
      name: u.name,
      roles: u.roles,
      invested,
      ownershipPct: pct,
      salary: salaryPaid,
      operatorShare,
      investorShare,
      total: salaryPaid + operatorShare + investorShare,
    };
  });
}

// Who is holding the company's CASH right now (phones in stock are counted
// separately as stock value — a phone is not cash).
//   + investment  -> received_by (the company bank)   - purchase -> bought_by
//   + sale        -> sold_by                          - expense  -> paid_by
//   transfer: - from_user, + to_user  (either side may be the company bank)
// The balances always sum to company cash remaining.
function holdings(d) {
  let unassigned = 0; // entries recorded before holder tracking existed
  const map = new Map();
  const add = (id, amt) => {
    if (id == null) unassigned += amt;
    else map.set(id, (map.get(id) || 0) + amt);
  };
  for (const r of d.investments) add(r.received_by, r.amount);
  for (const r of d.sales) add(r.sold_by, r.sale_price);
  for (const r of d.purchases) add(r.bought_by, -phoneCost(r));
  for (const r of d.expenses) add(r.paid_by, -r.amount);
  for (const r of d.transfers) { add(r.from_user, -r.amount); add(r.to_user, r.amount); }

  const rows = [{
    user_id: BANK_ID, name: BANK_NAME, roles: 'bank', cash: map.get(BANK_ID) || 0,
  }];
  rows.push(...d.users.filter((u) => u.active === 1)
    .map((u) => ({ user_id: u.id, name: u.name, roles: u.roles, cash: map.get(u.id) || 0 }))
    .sort((a, b) => b.cash - a.cash));
  if (unassigned !== 0) {
    rows.push({ user_id: null, name: 'Unassigned (edit old entries to set holder)', roles: '', cash: unassigned });
  }
  return rows;
}

async function summary() {
  const d = await loadAll();
  return {
    totals: scopeTotals(d),
    members: memberBreakdown(d),
    ownership: ownership(d),
    holdings: holdings(d),
  };
}

// ---- stock, charts, calendar, analytics -----------------------------------

async function stock() {
  const d = await loadAll();
  const soldIds = new Set(d.sales.map((s) => s.purchase_id));
  const today = new Date().toISOString().slice(0, 10);
  return d.purchases
    .filter((p) => !soldIds.has(p.id))
    .map((p) => ({
      ...p,
      total_cost: phoneCost(p),
      bought_by_name: d.users.find((u) => u.id === p.bought_by)?.name || '#' + p.bought_by,
      days_in_stock: daysBetween(p.purchase_date, today),
    }))
    .sort((a, b) => a.purchase_date.localeCompare(b.purchase_date));
}

// Monthly aggregates for the dashboard charts (last 12 months with activity).
async function monthly() {
  const d = await loadAll();
  const months = {};
  const m = (dt) => dt.slice(0, 7);
  const bucket = (k) => (months[k] ||= {
    month: k, bought: 0, boughtCost: 0, sold: 0, revenue: 0, margin: 0, expenses: 0,
  });
  const byId = new Map(d.purchases.map((p) => [p.id, p]));

  for (const r of d.purchases) {
    const b = bucket(m(r.purchase_date)); b.bought++; b.boughtCost += phoneCost(r);
  }
  for (const s of d.sales) {
    const p = byId.get(s.purchase_id);
    if (!p) continue;
    const b = bucket(m(s.sale_date));
    b.sold++; b.revenue += s.sale_price; b.margin += s.sale_price - phoneCost(p);
  }
  for (const e of d.expenses) bucket(m(e.expense_date)).expenses += e.amount;

  return Object.values(months)
    .map((b) => ({ ...b, net: b.margin - b.expenses }))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-12);
}

// Per-day aggregates for one calendar month (YYYY-MM):
// phones bought, phones sold, and day P&L = sale margins − expenses that day.
async function calendar(month) {
  const d = await loadAll();
  const days = {};
  const day = (dt) => (days[dt] ||= { bought: 0, sold: 0, margin: 0, expenses: 0 });
  const inMonth = (dt) => typeof dt === 'string' && dt.startsWith(month + '-');
  const byId = new Map(d.purchases.map((p) => [p.id, p]));

  for (const r of d.purchases) if (inMonth(r.purchase_date)) day(r.purchase_date).bought++;
  for (const s of d.sales) {
    if (!inMonth(s.sale_date)) continue;
    const p = byId.get(s.purchase_id);
    day(s.sale_date).sold++;
    if (p) day(s.sale_date).margin += s.sale_price - phoneCost(p);
  }
  for (const e of d.expenses) if (inMonth(e.expense_date)) day(e.expense_date).expenses += e.amount;

  for (const k of Object.keys(days)) days[k].pnl = days[k].margin - days[k].expenses;
  return days;
}

// Analytics over all sold phones. Margin uses total cost (price + repairs).
async function analytics() {
  const d = await loadAll();
  const byId = new Map(d.purchases.map((p) => [p.id, p]));
  const sold = d.sales.flatMap((s) => {
    const p = byId.get(s.purchase_id);
    if (!p) return [];
    return [{
      id: s.id, sale_price: s.sale_price, sale_date: s.sale_date, sold_by: s.sold_by,
      brand: p.brand, model: p.model, condition: p.condition,
      total_cost: phoneCost(p), purchase_date: p.purchase_date,
      margin: s.sale_price - phoneCost(p),
      days_in_stock: daysBetween(p.purchase_date, s.sale_date),
    }];
  });

  const group = (keyFn) => {
    const map = new Map();
    for (const r of sold) {
      const k = keyFn(r);
      if (!map.has(k)) map.set(k, { key: k, count: 0, totalMargin: 0, totalDays: 0, revenue: 0 });
      const g = map.get(k);
      g.count++; g.totalMargin += r.margin; g.totalDays += r.days_in_stock; g.revenue += r.sale_price;
    }
    return [...map.values()]
      .map((g) => ({ ...g, avgMargin: g.totalMargin / g.count, avgDays: g.totalDays / g.count }))
      .sort((a, b) => b.avgMargin - a.avgMargin);
  };

  const totalSold = sold.length;
  return {
    totalSold,
    avgMargin: totalSold ? sold.reduce((s, r) => s + r.margin, 0) / totalSold : 0,
    avgDaysInStock: totalSold ? sold.reduce((s, r) => s + r.days_in_stock, 0) / totalSold : 0,
    byBrand: group((r) => r.brand),
    byModel: group((r) => `${r.brand} ${r.model}`),
    byCondition: group((r) => r.condition),
    bySeller: group((r) => d.users.find((u) => u.id === r.sold_by)?.name || '#' + r.sold_by),
  };
}

module.exports = { summary, stock, analytics, monthly, calendar, holdings, loadAll };
