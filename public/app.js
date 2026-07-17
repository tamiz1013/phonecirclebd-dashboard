/* PhoneCircle BD — single-page dashboard */
'use strict';

const $app = document.getElementById('app');
let me = null;          // logged-in user
let meta = null;        // users, categories, conditions, unsold phones
let currentTab = 'dashboard';
let calMonth = new Date().toISOString().slice(0, 7); // YYYY-MM shown in the calendar

// ---------- helpers ----------

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login' && path !== '/me') {
    // session expired — back to the login screen instead of a dead error page
    me = null;
    renderLogin();
    throw new Error(data.error || 'Session expired — please log in again');
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const taka = (n) => (n < 0 ? '−৳' : '৳') + nf.format(Math.abs(Math.round(n || 0)));
const takaShort = (n) => {
  const a = Math.abs(n);
  const s = a >= 100000 ? (a / 100000).toFixed(1).replace(/\.0$/, '') + 'L'
    : a >= 1000 ? (a / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(Math.round(a));
  return (n < 0 ? '−' : '') + s;
};
const pct = (x) => (x * 100).toFixed(1) + '%';
const today = () => new Date().toISOString().slice(0, 10);
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => MONTH_NAMES[Number(ym.slice(5, 7)) - 1] + ' ’' + ym.slice(2, 4);

const isAdmin = (u) => (u?.roles || '').split(',').includes('admin');
const roleLabel = (roles) => roles.split(',').map((r) => r[0].toUpperCase() + r.slice(1)).join(' + ');

function badge(status) {
  return status === 'verified'
    ? '<span class="badge verified">✓ Verified</span>'
    : '<span class="badge pending">⏳ Pending</span>';
}

function signed(n, formatted) {
  const cls = n > 0 ? 'pos' : n < 0 ? 'neg' : '';
  return `<span class="${cls}">${formatted ?? taka(n)}</span>`;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ---------- login ----------

function renderLogin() {
  $app.innerHTML = `
    <div class="login-wrap">
      <div class="card login-box">
        <h1>📱 PhoneCircle BD</h1>
        <p>Phone reselling — team dashboard</p>
        <form id="login-form">
          <div class="field"><label>Username</label>
            <input name="username" autocomplete="username" required autofocus></div>
          <div class="field"><label>Password</label>
            <input name="password" type="password" autocomplete="current-password" required></div>
          <button class="btn" style="width:100%">Log in</button>
          <div class="form-error" id="login-error"></div>
        </form>
      </div>
    </div>`;
  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      me = await api('/login', { method: 'POST', body: { username: fd.get('username'), password: fd.get('password') } });
      await boot();
    } catch (err) {
      document.getElementById('login-error').textContent = err.message;
    }
  };
}

// ---------- shell ----------

const TABS = [
  ['dashboard', 'Dashboard'],
  ['purchases', 'Purchases'],
  ['sales', 'Sales'],
  ['expenses', 'Expenses'],
  ['transfers', 'Transfers'],
  ['investments', 'Investments'],
  ['members', 'Members'],
  ['analytics', 'Analytics'],
  ['audit', 'Audit log'],
];

function renderShell() {
  $app.innerHTML = `
    <header class="topbar">
      <div class="brand">📱 PhoneCircle <small>BD</small></div>
      <nav class="tabs">
        ${TABS.map(([id, label]) =>
          `<button data-tab="${id}" class="${id === currentTab ? 'active' : ''}">${label}</button>`).join('')}
      </nav>
      <span class="who">${esc(me.name)} · ${roleLabel(me.roles)}</span>
      <button class="btn secondary small" id="logout-btn">Log out</button>
    </header>
    <main id="view"></main>`;
  $app.querySelector('nav.tabs').onclick = (e) => {
    const tab = e.target.dataset?.tab;
    if (tab) { currentTab = tab; renderShell(); renderTab(); }
  };
  document.getElementById('logout-btn').onclick = async () => {
    await api('/logout', { method: 'POST' });
    me = null;
    renderLogin();
  };
}

async function renderTab() {
  const view = document.getElementById('view');
  view.innerHTML = '<p class="muted">Loading…</p>';
  try {
    meta = await api('/meta'); // refresh users + unsold list on every tab switch
    if (currentTab === 'dashboard') await renderDashboard(view);
    else if (currentTab === 'members') await renderMembers(view);
    else if (currentTab === 'analytics') await renderAnalytics(view);
    else if (currentTab === 'audit') await renderAudit(view);
    else await renderEntries(view, currentTab);
  } catch (err) {
    view.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
  }
}

// ---------- SVG charts ----------
// Grouped column chart: months on x, up to 2 series. Thin marks, rounded
// data-ends, hairline grid, legend above, native hover tooltips.

function columnChart({ data, series, valueFmt = takaShort, height = 220 }) {
  if (!data.length) return '<p class="muted">No data yet.</p>';
  const W = Math.max(420, data.length * 64), H = height;
  const padL = 46, padR = 8, padT = 12, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  let max = 0, min = 0;
  for (const d of data) for (const s of series) {
    max = Math.max(max, s.get(d)); min = Math.min(min, s.get(d));
  }
  if (max === 0 && min === 0) max = 1;
  const range = max - min || 1;
  const y = (v) => padT + plotH - ((v - min) / range) * plotH;
  const zeroY = y(0);

  const ticks = 4;
  let grid = '';
  const seen = new Set();
  for (let i = 0; i <= ticks; i++) {
    const v = min + (range * i) / ticks;
    const label = valueFmt(v);
    if (seen.has(label)) continue; // skip duplicate labels on small integer axes
    seen.add(label);
    const yy = y(v);
    grid += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${yy + 3}" text-anchor="end" font-size="10" fill="var(--muted)">${label}</text>`;
  }

  const groupW = plotW / data.length;
  const barW = Math.min(22, (groupW - 10) / series.length);
  let bars = '', labels = '';
  data.forEach((d, i) => {
    const cx = padL + groupW * i + groupW / 2;
    const startX = cx - (barW * series.length + 2 * (series.length - 1)) / 2;
    series.forEach((s, si) => {
      const v = s.get(d);
      const x = startX + si * (barW + 2);
      const top = Math.min(y(v), zeroY), bottom = Math.max(y(v), zeroY);
      const h = Math.max(bottom - top, v === 0 ? 0 : 2);
      const r = Math.min(4, barW / 2, h);
      const isNeg = v < 0;
      // rounded corners on the data end only, flat at the zero baseline
      const path = isNeg
        ? `M${x},${top} h${barW} v${h - r} a${r},${r} 0 0 1 -${r},${r} h-${barW - 2 * r} a${r},${r} 0 0 1 -${r},-${r} z`
        : `M${x},${top + r} a${r},${r} 0 0 1 ${r},-${r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} h-${barW} z`;
      bars += `<path d="${path}" fill="${isNeg && s.negColor ? s.negColor : s.color}">
        <title>${d.tooltipLabel || d.month}: ${s.name} ${s.tooltipFmt ? s.tooltipFmt(v) : valueFmt(v)}</title></path>`;
    });
    labels += `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--muted)">${monthLabel(d.month)}</text>`;
  });

  const legend = series.length > 1 ? `<div class="chart-legend">
    ${series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('')}
  </div>` : '';

  return `${legend}<div class="table-wrap"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">
    ${grid}
    <line x1="${padL}" x2="${W - padR}" y1="${zeroY}" y2="${zeroY}" stroke="var(--baseline)" stroke-width="1"/>
    ${bars}${labels}
  </svg></div>`;
}

// Horizontal magnitude bars (sequential single hue) with direct value labels.
function hBars(rows, { label = (r) => r.name, value = (r) => r.cash, fmt = taka } = {}) {
  if (!rows.length) return '<p class="muted">No data yet.</p>';
  const max = Math.max(...rows.map((r) => Math.abs(value(r))), 1);
  return `<div class="hbars">
    ${rows.map((r) => {
      const v = value(r);
      return `<div class="hbar-row">
        <span class="hbar-label">${esc(label(r))}</span>
        <div class="hbar-track">
          <div class="bar ${v < 0 ? 'neg' : ''}" style="width:${Math.max(Math.round(Math.abs(v) / max * 100), 1)}%"></div>
        </div>
        <span class="hbar-val ${v < 0 ? 'neg' : ''}">${fmt(v)}</span>
      </div>`;
    }).join('')}
  </div>`;
}

// ---------- dashboard ----------

async function renderDashboard(view) {
  const [sum, stock, charts, cal] = await Promise.all([
    api('/summary'), api('/stock'), api('/charts'), api('/calendar?month=' + calMonth),
  ]);
  const t = sum.totals;
  const stockValue = stock.reduce((s, r) => s + r.total_cost, 0);
  const aging = stock.filter((r) => r.days_in_stock > 30);
  const thisMonth = charts.monthly.find((m) => m.month === today().slice(0, 7)) ||
    { bought: 0, sold: 0, margin: 0, net: 0, revenue: 0, boughtCost: 0, expenses: 0 };

  const tile = (label, value, sub, neg) => `
    <div class="tile">
      <div class="label">${label}</div>
      <div class="value ${neg ? 'neg' : ''}">${value}</div>
      <div class="sub">${sub}</div>
    </div>`;

  const plRow = (label, v, strong = false) => `
    <tr>
      <td ${strong ? 'style="font-weight:700"' : ''}>${label}</td>
      <td class="num" ${strong ? 'style="font-weight:700"' : ''}>${signed(v)}</td>
    </tr>`;

  view.innerHTML = `
    <div class="kpis">
      ${tile('Cash remaining', taka(t.cash), `${taka(t.investments)} invested in total`, t.cash < 0)}
      ${tile('Net profit', taka(t.netProfit), `gross ${taka(t.grossProfit)} − costs`, t.netProfit < 0)}
      ${tile('Phones in stock', stock.length, `${taka(stockValue)} tied up`)}
      ${tile('This month', `${thisMonth.sold} sold · ${thisMonth.bought} bought`, `month P&amp;L ${taka(thisMonth.net)}`, thisMonth.net < 0)}
      ${tile('Afzal / operators', taka(t.salary + t.operatorPool), 'salary + 50% of net', (t.salary + t.operatorPool) < 0)}
      ${tile('Investor pool', taka(t.investorPool), '50% of net, split by ownership', t.investorPool < 0)}
    </div>

    <div class="grid-2">
      <div class="card">
        <h2>Phones bought vs sold — monthly</h2>
        ${columnChart({
          data: charts.monthly,
          valueFmt: (v) => String(Math.round(v)),
          series: [
            { name: 'Bought', color: 'var(--accent)', get: (d) => d.bought },
            { name: 'Sold', color: 'var(--series-green)', get: (d) => d.sold },
          ],
        })}
      </div>
      <div class="card">
        <h2>Net profit — monthly</h2>
        ${columnChart({
          data: charts.monthly,
          series: [
            { name: 'Net profit', color: 'var(--accent)', negColor: 'var(--critical)', get: (d) => d.net, tooltipFmt: taka },
          ],
        })}
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <h2>Money flow — monthly</h2>
        ${columnChart({
          data: charts.monthly,
          series: [
            { name: 'Sales revenue', color: 'var(--series-green)', get: (d) => d.revenue, tooltipFmt: taka },
            { name: 'Buying cost', color: 'var(--accent)', get: (d) => d.boughtCost, tooltipFmt: taka },
          ],
        })}
      </div>
      <div class="card">
        <h2>Who is holding the cash</h2>
        ${hBars(sum.holdings.filter((h) => h.roles === 'bank' || h.cash !== 0))}
        <p class="muted small">Cash only — phones in stock are counted separately. All investments land in the ${esc(meta?.bankName || 'company bank')}; Tamiz transfers operating money out to members from the Transfers tab. Sales cash stays with the seller until transferred back.</p>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <h2>Profit &amp; loss</h2>
        <div class="table-wrap"><table>
          <tbody>
            ${plRow('Sales revenue', t.salesRevenue)}
            ${plRow('− Cost of phones sold (incl. repairs)', -t.costOfSold)}
            ${plRow('Gross profit', t.grossProfit, true)}
            ${plRow('− Expenses (food, transport, accessories, other)', -t.otherExpenses)}
            ${plRow('− Salary', -t.salary)}
            ${plRow('Net profit', t.netProfit, true)}
            ${plRow('Afzal / operator pool (salary + 50%)', t.salary + t.operatorPool, true)}
            ${plRow('Investor pool (50%)', t.investorPool, true)}
          </tbody>
        </table></div>
      </div>

      <div class="card">
        <h2>Member profit &amp; loss</h2>
        <div class="table-wrap"><table>
          <thead><tr>
            <th>Member</th><th class="num">Invested</th><th class="num">Own %</th><th class="num">Total P&amp;L</th>
          </tr></thead>
          <tbody>
            ${sum.members.filter((m) => !m.roles.includes('helper')).map((m) => `<tr>
              <td>${esc(m.name)} <span class="muted small">${roleLabel(m.roles)}</span></td>
              <td class="num">${taka(m.invested)}</td>
              <td class="num">${pct(m.ownershipPct)}</td>
              <td class="num" style="font-weight:700">${signed(m.total)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>
    </div>

    ${aging.length ? `
    <div class="card">
      <h2>⚠️ Slow stock — in hand over 30 days</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Phone</th><th class="num">Total cost</th><th>Bought on</th><th class="num">Days in stock</th></tr></thead>
        <tbody>${aging.map((r) => `<tr>
          <td>${esc(r.brand)} ${esc(r.model)} ${esc(r.storage)}</td>
          <td class="num">${taka(r.total_cost)}</td>
          <td>${r.purchase_date}</td>
          <td class="num neg" style="font-weight:700">${r.days_in_stock}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">Money sitting in old stock is money not making margin — consider dropping the price.</p>
    </div>` : ''}

    <div class="card">
      <h2>Phones in stock (${stock.length})</h2>
      ${stock.length === 0 ? '<p class="muted">No phones in stock.</p>' : `
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Phone</th><th>Storage</th><th>Condition</th><th class="num">Total cost</th>
          <th>Bought on</th><th>By</th><th class="num">Days in stock</th><th>Status</th>
        </tr></thead>
        <tbody>
          ${stock.map((r) => `<tr>
            <td>${esc(r.brand)} ${esc(r.model)} ${r.color ? `<span class="muted small">${esc(r.color)}</span>` : ''}</td>
            <td>${esc(r.storage) || '<span class="muted">—</span>'}</td>
            <td>${esc(r.condition)}</td>
            <td class="num">${taka(r.total_cost)}</td>
            <td>${r.purchase_date}</td>
            <td>${esc(r.bought_by_name)}</td>
            <td class="num ${r.days_in_stock > 30 ? 'neg' : ''}">${r.days_in_stock}</td>
            <td>${badge(r.status)}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>`}
    </div>

    <div class="card" id="cal-card">
      ${calendarHTML(cal)}
    </div>`;

  wireCalendar(view);
}

// ---------- calendar ----------

function calendarHTML(days) {
  const [yy, mm] = calMonth.split('-').map(Number);
  const first = new Date(Date.UTC(yy, mm - 1, 1));
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const startDow = first.getUTCDay(); // 0 = Sunday
  const monthName = first.toLocaleString('en', { month: 'long', timeZone: 'UTC' }) + ' ' + yy;
  const todayStr = today();

  let cells = '';
  for (let i = 0; i < startDow; i++) cells += '<div class="cal-cell empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calMonth}-${String(d).padStart(2, '0')}`;
    const info = days[dateStr];
    cells += `<div class="cal-cell ${dateStr === todayStr ? 'today' : ''}">
      <div class="cal-date">${d}</div>
      ${info ? `
        <div class="cal-line">🛒 ${info.bought} bought</div>
        <div class="cal-line">💰 ${info.sold} sold</div>
        <div class="cal-line ${info.pnl > 0 ? 'pos' : info.pnl < 0 ? 'neg' : 'muted'}">${taka(info.pnl)}</div>
      ` : '<div class="cal-line muted">—</div>'}
    </div>`;
  }

  return `
    <div class="row-head">
      <h2>📅 Daily activity — ${monthName}</h2>
      <div>
        <button class="btn small secondary" id="cal-prev">‹ Prev</button>
        <button class="btn small secondary" id="cal-next">Next ›</button>
      </div>
    </div>
    <div class="cal-grid cal-head">
      ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div>${d}</div>`).join('')}
    </div>
    <div class="cal-grid">${cells}</div>
    <p class="muted small">Per day: phones bought, phones sold, and day P&amp;L (sale margins − expenses that day).</p>`;
}

function wireCalendar(view) {
  const shift = (delta) => async () => {
    const [yy, mm] = calMonth.split('-').map(Number);
    const d = new Date(Date.UTC(yy, mm - 1 + delta, 1));
    calMonth = d.toISOString().slice(0, 7);
    const cal = await api('/calendar?month=' + calMonth);
    view.querySelector('#cal-card').innerHTML = calendarHTML(cal);
    wireCalendar(view);
  };
  view.querySelector('#cal-prev').onclick = shift(-1);
  view.querySelector('#cal-next').onclick = shift(1);
}

// ---------- entry tabs ----------

const userOptions = (selected) => meta.users.filter((u) => u.active)
  .map((u) => `<option value="${u.id}" ${u.id === Number(selected) ? 'selected' : ''}>${esc(u.name)}</option>`).join('');

// members + the company bank (for the "To" side of a transfer)
const holderOptions = (selected) =>
  `<option value="${meta.bankId}" ${Number(selected) === meta.bankId ? 'selected' : ''}>${esc(meta.bankName)}</option>` +
  userOptions(selected);

// Attribution is automatic: whoever creates the entry is the one who paid /
// received the cash. Shown as a locked field so it stays obvious.
const fixedField = (label, text) =>
  `<div class="field"><label>${label}</label><input value="${esc(text)}" disabled></div>`;

const ENTRY_CONFIG = {
  purchases: {
    title: 'Phone purchases',
    formFields: (r = {}) => `
      <div class="field"><label>Brand</label><input name="brand" required value="${esc(r.brand)}" placeholder="Samsung"></div>
      <div class="field"><label>Model</label><input name="model" required value="${esc(r.model)}" placeholder="Galaxy A52"></div>
      <div class="field"><label>Variant</label><input name="variant" value="${esc(r.variant)}" placeholder="8/128, official BD…"></div>
      <div class="field"><label>Storage</label><input name="storage" value="${esc(r.storage)}" placeholder="128 GB"></div>
      <div class="field"><label>Color</label><input name="color" value="${esc(r.color)}"></div>
      <div class="field"><label>Condition</label><select name="condition">
        ${meta.conditions.map((c) => `<option ${c === r.condition ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Battery health</label><input name="battery_health" value="${esc(r.battery_health)}" placeholder="e.g. 87%"></div>
      <div class="field"><label>Buying price (৳)</label><input name="price" type="number" min="1" step="1" required value="${r.price ?? ''}"></div>
      <div class="field"><label>Repair &amp; other cost (৳)</label><input name="repair_cost" type="number" min="0" step="1" value="${r.repair_cost ?? 0}"></div>
      <div class="field"><label>Purchase date</label><input name="purchase_date" type="date" required value="${r.purchase_date || today()}"></div>
      <div class="field"><label>Buying location</label><input name="location" value="${esc(r.location)}" placeholder="Uttara, Mirpur…"></div>
      <div class="field"><label>Seller name</label><input name="seller_name" value="${esc(r.seller_name)}"></div>
      <div class="field"><label>Seller phone no.</label><input name="seller_phone" value="${esc(r.seller_phone)}" placeholder="01…"></div>
      <div class="field"><label>IMEI 1</label><input name="imei1" value="${esc(r.imei1)}"></div>
      <div class="field"><label>IMEI 2</label><input name="imei2" value="${esc(r.imei2)}"></div>
      ${fixedField('Bought by (paid the cash)', r.id ? r.bought_by_name : `You — ${me.name}`)}
      <div class="field wide"><label>Parts &amp; service history</label><input name="service_history" value="${esc(r.service_history)}" placeholder="display changed, battery replaced…"></div>
      <div class="field wide"><label>Notes</label><input name="notes" value="${esc(r.notes)}"></div>`,
    columns: ['Phone', 'Specs', 'Condition', 'Total cost', 'Date', 'Seller / place', 'IMEI', 'Bought by', 'Status'],
    row: (r) => `
      <td>${esc(r.brand)} ${esc(r.model)} ${r.sale_id ? '<span class="muted small">· sold</span>' : ''}
        ${r.color ? `<div class="muted small">${esc(r.color)}</div>` : ''}</td>
      <td class="small">${[r.storage, r.variant, r.battery_health && ('🔋' + r.battery_health)].filter(Boolean).map(esc).join(' · ') || '<span class="muted">—</span>'}</td>
      <td>${esc(r.condition)}</td>
      <td class="num">${taka(r.total_cost)}${r.repair_cost ? `<div class="muted small">${taka(r.price)} + ${taka(r.repair_cost)} repair</div>` : ''}</td>
      <td>${r.purchase_date}</td>
      <td class="small">${[r.seller_name, r.seller_phone, r.location].filter(Boolean).map(esc).join('<br>') || '<span class="muted">—</span>'}</td>
      <td class="small">${[r.imei1, r.imei2].filter(Boolean).map(esc).join('<br>') || '<span class="muted">—</span>'}</td>
      <td>${esc(r.bought_by_name)}</td>`,
  },

  sales: {
    title: 'Phone sales',
    formFields: (r = {}) => {
      const phones = [...meta.unsoldPurchases];
      if (r.purchase_id && !phones.some((p) => p.id === r.purchase_id)) {
        phones.unshift({ id: r.purchase_id, brand: r.brand, model: r.model, condition: r.condition, storage: r.storage, total_cost: r.total_cost, purchase_date: r.purchase_date });
      }
      return `
      <div class="field wide"><label>Phone (purchase)</label><select name="purchase_id" required>
        <option value="">— select a phone in stock —</option>
        ${phones.map((p) => `<option value="${p.id}" ${p.id === r.purchase_id ? 'selected' : ''}>
          #${p.id} · ${esc(p.brand)} ${esc(p.model)} ${esc(p.storage || '')} · ${esc(p.condition)} · cost ${taka(p.total_cost)} · ${p.purchase_date}</option>`).join('')}
      </select></div>
      <div class="field"><label>Sale price (৳)</label><input name="sale_price" type="number" min="1" step="1" required value="${r.sale_price ?? ''}"></div>
      <div class="field"><label>Date</label><input name="sale_date" type="date" required value="${r.sale_date || today()}"></div>
      <div class="field"><label>Buyer</label><input name="buyer" value="${esc(r.buyer)}"></div>
      ${fixedField('Sold by (received the cash)', r.id ? r.sold_by_name : `You — ${me.name}`)}
      <div class="field wide"><label>Notes</label><input name="notes" value="${esc(r.notes)}"></div>`;
    },
    columns: ['Phone', 'Sale price', 'Margin', 'Days in stock', 'Date', 'Buyer', 'Sold by', 'Status'],
    row: (r) => `
      <td>${esc(r.brand)} ${esc(r.model)} <span class="muted small">cost ${taka(r.total_cost)}</span></td>
      <td class="num">${taka(r.sale_price)}</td>
      <td class="num">${signed(r.margin)}</td>
      <td class="num">${r.days_in_stock}</td>
      <td>${r.sale_date}</td>
      <td>${esc(r.buyer) || '<span class="muted">—</span>'}</td>
      <td>${esc(r.sold_by_name)}</td>`,
  },

  expenses: {
    title: 'Expenses',
    formFields: (r = {}) => `
      <div class="field"><label>Category</label><select name="category" onchange="
        this.closest('form').querySelector('[name=related_user]').closest('.field').style.display = this.value === 'salary' ? '' : 'none'">
        ${meta.expenseCategories.map((c) => `<option ${c === r.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Amount (৳)</label><input name="amount" type="number" min="1" step="1" required value="${r.amount ?? ''}"></div>
      <div class="field"><label>Date</label><input name="expense_date" type="date" required value="${r.expense_date || today()}"></div>
      ${fixedField('Paid from whose cash', r.id ? (r.paid_by_name || '—') : `You — ${me.name}`)}
      <div class="field" style="${(r.category || 'food') === 'salary' ? '' : 'display:none'}"><label>Paid to (salary)</label>
        <select name="related_user"><option value="">—</option>${userOptions(r.related_user)}</select></div>
      <div class="field wide"><label>Description</label><input name="description" placeholder="e.g. lunch during Uttara trip" value="${esc(r.description)}"></div>`,
    columns: ['Category', 'Amount', 'Date', 'Paid from', 'Description', 'Status'],
    row: (r) => `
      <td>${esc(r.category)}${r.related_user_name ? ` <span class="muted small">→ ${esc(r.related_user_name)}</span>` : ''}</td>
      <td class="num">${taka(r.amount)}</td>
      <td>${r.expense_date}</td>
      <td>${esc(r.paid_by_name || '')} </td>
      <td>${esc(r.description) || '<span class="muted">—</span>'}</td>`,
  },

  transfers: {
    title: 'Money transfers',
    formFields: (r = {}) => `
      ${r.id
        // editing: the source never changes — it stays whoever originally sent it
        ? fixedField('From (gave the cash)', r.from_name)
        : isAdmin(me)
          ? `<div class="field"><label>From (gave the cash)</label><select name="from_bank">
              <option value="1">${esc(meta.bankName)}</option>
              <option value="0">My cash — ${esc(me.name)}</option>
            </select></div>`
          : fixedField('From (gave the cash)', `You — ${me.name}`)}
      <div class="field"><label>To (received the cash)</label><select name="to_user">${holderOptions(r.to_user)}</select></div>
      <div class="field"><label>Amount (৳)</label><input name="amount" type="number" min="1" step="1" required value="${r.amount ?? ''}"></div>
      <div class="field"><label>Date</label><input name="transfer_date" type="date" required value="${r.transfer_date || today()}"></div>
      <div class="field wide"><label>Notes</label><input name="notes" placeholder="e.g. buying money for Afzal's Mirpur trip" value="${esc(r.notes)}"></div>`,
    columns: ['From', 'To', 'Amount', 'Date', 'Notes', 'Status'],
    row: (r) => `
      <td>${esc(r.from_name)}</td>
      <td>→ ${esc(r.to_name)}</td>
      <td class="num">${taka(r.amount)}</td>
      <td>${r.transfer_date}</td>
      <td>${esc(r.notes) || '<span class="muted">—</span>'}</td>`,
  },

  investments: {
    title: 'Investments',
    formFields: (r = {}) => `
      ${fixedField('Investor', r.id ? r.investor_name : `You — ${me.name}`)}
      <div class="field"><label>Amount (৳)</label><input name="amount" type="number" min="1" step="1" required value="${r.amount ?? ''}"></div>
      <div class="field"><label>Date</label><input name="invest_date" type="date" required value="${r.invest_date || today()}"></div>
      ${fixedField('Cash goes to', r.id ? (r.received_by_name || '—') : meta.bankName)}
      <div class="field wide"><label>Notes</label><input name="notes" value="${esc(r.notes)}"></div>`,
    columns: ['Investor', 'Amount', 'Date', 'Held by', 'Notes', 'Status'],
    row: (r) => `
      <td>${esc(r.investor_name)}</td>
      <td class="num">${taka(r.amount)}</td>
      <td>${r.invest_date}</td>
      <td>${esc(r.received_by_name || '')}</td>
      <td>${esc(r.notes) || '<span class="muted">—</span>'}</td>`,
  },
};

function canVerify(row) {
  if (row.status === 'verified') return false;
  if (row.created_by === me.id) return false; // never your own entry — admin included
  if (row.verifications.some((v) => v.user_id === me.id)) return false;
  return true;
}

// The creator can delete their own entry only while it is still pending.
function canDelete(row) {
  return row.created_by === me.id && row.status !== 'verified';
}

function canEdit(row) {
  return row.created_by === me.id || isAdmin(me);
}

async function renderEntries(view, type) {
  const cfg = ENTRY_CONFIG[type];
  const rows = await api('/entries/' + type);
  const need = meta.verificationsNeeded;

  view.innerHTML = `
    <div class="card">
      <div class="row-head">
        <h2>Add ${cfg.title.toLowerCase().replace(/s$/, '')}</h2>
        <span class="muted small">Recorded as yours automatically. ⏳ Pending until ${need} other members (or an admin) verify — you can delete your own entry while it's pending.</span>
      </div>
      <form class="entry-form" id="add-form">
        ${cfg.formFields()}
        <div class="field"><button class="btn">Add entry</button></div>
      </form>
      <div class="form-error" id="add-error"></div>
    </div>

    <div class="card">
      <div class="row-head"><h2>${cfg.title} (${rows.length})</h2></div>
      ${rows.length === 0 ? '<p class="muted">Nothing recorded yet.</p>' : `
      <div class="table-wrap"><table>
        <thead><tr>${cfg.columns.map((c) => `<th ${['Price', 'Amount', 'Sale price', 'Margin', 'Days in stock', 'Total cost'].includes(c) ? 'class="num"' : ''}>${c}</th>`).join('')}<th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr data-id="${r.id}">
            ${cfg.row(r)}
            <td>${badge(r.status)}
              <div class="verifiers">${r.verifications.map((v) => '✓ ' + esc(v.name)).join(' · ')}</div>
              <div class="verifiers muted">by ${esc(r.created_by_name)}</div>
            </td>
            <td class="num" style="white-space:nowrap">
              ${canVerify(r) ? `<button class="btn small verify" data-verify="${r.id}">Verify</button>` : ''}
              ${canEdit(r) ? `<button class="btn small secondary" data-edit="${r.id}">Edit</button>` : ''}
              ${canDelete(r) ? `<button class="btn small secondary" style="color:var(--critical)" data-del="${r.id}">Delete</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>`}
    </div>`;

  document.getElementById('add-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/entries/' + type, { method: 'POST', body: formData(e.target) });
      toast('Added — pending verification');
      renderTab();
    } catch (err) {
      document.getElementById('add-error').textContent = err.message;
    }
  };

  view.onclick = async (e) => {
    const verifyId = e.target.dataset?.verify;
    const editId = e.target.dataset?.edit;
    const delId = e.target.dataset?.del;
    if (verifyId) {
      try {
        const r = await api(`/entries/${type}/${verifyId}/verify`, { method: 'POST' });
        toast(r.status === 'verified' ? 'Entry is now verified ✓' : 'Verified — more verifications still needed');
        renderTab();
      } catch (err) { toast(err.message); }
    } else if (editId) {
      openEditDialog(type, rows.find((r) => r.id === Number(editId)));
    } else if (delId) {
      if (!window.confirm(`Delete entry #${delId}? This only works while it is still pending.`)) return;
      try {
        await api(`/entries/${type}/${delId}`, { method: 'DELETE' });
        toast('Entry deleted');
        renderTab();
      } catch (err) { toast(err.message); }
    }
  };
}

function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form)) out[k] = v;
  return out;
}

function openEditDialog(type, row) {
  const cfg = ENTRY_CONFIG[type];
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h2>Edit entry #${row.id}</h2>
    <p class="muted small">Saving an edit resets the entry to ⏳ Pending and clears verifications. Every change is logged.</p>
    <form class="entry-form" method="dialog">
      ${cfg.formFields(row)}
      <div class="field" style="flex-direction:row; gap:8px">
        <button class="btn" value="save">Save</button>
        <button class="btn secondary" value="cancel" formnovalidate>Cancel</button>
      </div>
    </form>
    <div class="form-error"></div>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  const form = dlg.querySelector('form');
  form.onsubmit = async (e) => {
    if (e.submitter?.value !== 'save') { dlg.remove(); return; }
    e.preventDefault();
    try {
      const r = await api(`/entries/${type}/${row.id}`, { method: 'PUT', body: formData(form) });
      dlg.remove();
      toast(r.unchanged ? 'No changes' : 'Saved — back to pending for re-verification');
      renderTab();
    } catch (err) {
      dlg.querySelector('.form-error').textContent = err.message;
    }
  };
  dlg.onclose = () => dlg.remove();
}

// ---------- members ----------

async function renderMembers(view) {
  const sum = await api('/summary');
  const admin = isAdmin(me);

  view.innerHTML = `
    <div class="card">
      <h2>Members &amp; individual P&amp;L</h2>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Member</th><th>Roles</th>
          <th class="num">Invested</th><th class="num">Ownership</th>
          <th class="num">Cash in hand</th>
          <th class="num">Salary</th><th class="num">Profit share</th>
          <th class="num">Total P&amp;L</th>
          ${admin ? '<th></th>' : ''}
        </tr></thead>
        <tbody>
          ${sum.members.map((m) => {
            const u = meta.users.find((u) => u.id === m.user_id);
            const hold = sum.holdings.find((h) => h.user_id === m.user_id);
            return `<tr>
              <td>${esc(m.name)} ${u && !u.active ? '<span class="muted small">(inactive)</span>' : ''}</td>
              <td class="small muted">${roleLabel(m.roles)}</td>
              <td class="num">${taka(m.invested)}</td>
              <td class="num">${pct(m.ownershipPct)}</td>
              <td class="num" style="font-weight:600">${signed(hold?.cash || 0)}</td>
              <td class="num">${taka(m.salary)}</td>
              <td class="num">${signed(m.operatorShare + m.investorShare)}</td>
              <td class="num" style="font-weight:700">${signed(m.total)}</td>
              ${admin ? `<td class="num" style="white-space:nowrap">
                <button class="btn small secondary" data-edit-user="${m.user_id}">Edit</button>
                <button class="btn small secondary" style="color:var(--critical)" data-del-user="${m.user_id}">Delete</button>
              </td>` : ''}
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
      <p class="muted small">Profit share = operator pool (50% of net, split among operators) + investor pool (50% of net, split by ownership %). Cash in hand shows who is physically holding company money right now.</p>
    </div>

    ${admin ? `
    <div class="card">
      <h2>Add member (admin)</h2>
      <p class="muted small">Roles: <b>investor</b>, <b>operator</b>, <b>admin</b>, or <b>helper</b> — a helping-hand person who can hold cash and verify entries.</p>
      <form class="entry-form" id="add-user-form">
        <div class="field"><label>Username</label><input name="username" required pattern="[a-z0-9_]{2,30}"></div>
        <div class="field"><label>Full name</label><input name="name" required></div>
        <div class="field"><label>Password (min 8)</label><input name="password" type="password" required minlength="8"></div>
        <div class="field"><label>Roles (comma separated)</label><input name="roles" value="helper" placeholder="admin,investor,operator,helper"></div>
        <div class="field"><button class="btn">Create</button></div>
      </form>
      <div class="form-error" id="add-user-error"></div>
    </div>` : ''}

    <div class="card">
      <h2>Change my password</h2>
      <form class="entry-form" id="pw-form">
        <div class="field"><label>Current password</label><input name="oldPassword" type="password" required></div>
        <div class="field"><label>New password (min 8)</label><input name="newPassword" type="password" required minlength="8"></div>
        <div class="field"><button class="btn">Change</button></div>
      </form>
      <div class="form-ok" id="pw-msg"></div>
    </div>`;

  document.getElementById('pw-form').onsubmit = async (e) => {
    e.preventDefault();
    const msg = document.getElementById('pw-msg');
    try {
      await api('/change-password', { method: 'POST', body: formData(e.target) });
      msg.className = 'form-ok'; msg.textContent = 'Password changed ✓';
      e.target.reset();
    } catch (err) {
      msg.className = 'form-error'; msg.textContent = err.message;
    }
  };

  if (admin) {
    document.getElementById('add-user-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/users', { method: 'POST', body: formData(e.target) });
        toast('Member created');
        renderTab();
      } catch (err) {
        document.getElementById('add-user-error').textContent = err.message;
      }
    };
    view.onclick = (e) => {
      const editId = e.target.dataset?.editUser;
      const delId = e.target.dataset?.delUser;
      if (editId) openUserDialog(meta.users.find((u) => u.id === Number(editId)));
      if (delId) openDeleteUserDialog(meta.users.find((u) => u.id === Number(delId)));
    };
  }
}

function openDeleteUserDialog(u) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h2>Delete ${esc(u.name)}?</h2>
    <p>This permanently removes the member <b>${esc(u.name)}</b> (@${esc(u.username)}).</p>
    <p class="muted small">Deletion only works while they have no recorded entries, verifications or history —
      otherwise the books would break, and you should <b>deactivate</b> them instead (Edit → Inactive).
      The deletion itself is written to the audit log.</p>
    <form method="dialog" style="display:flex; gap:8px; margin-top:12px">
      <button class="btn" style="background:var(--critical)" value="delete">Yes, delete</button>
      <button class="btn secondary" value="cancel">Cancel</button>
    </form>
    <div class="form-error"></div>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.querySelector('form').onsubmit = async (e) => {
    if (e.submitter?.value !== 'delete') { dlg.remove(); return; }
    e.preventDefault();
    try {
      await api('/users/' + u.id, { method: 'DELETE' });
      dlg.remove(); toast('Member deleted'); renderTab();
    } catch (err) {
      dlg.querySelector('.form-error').textContent = err.message;
    }
  };
  dlg.onclose = () => dlg.remove();
}

function openUserDialog(u) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h2>Edit member — ${esc(u.name)}</h2>
    <form class="entry-form" method="dialog">
      <div class="field"><label>Full name</label><input name="name" value="${esc(u.name)}"></div>
      <div class="field"><label>Roles</label><input name="roles" value="${esc(u.roles)}"></div>
      <div class="field"><label>New password (blank = keep)</label><input name="password" type="password"></div>
      <div class="field"><label>Active</label><select name="active">
        <option value="1" ${u.active ? 'selected' : ''}>Active</option>
        <option value="0" ${!u.active ? 'selected' : ''}>Inactive</option></select></div>
      <div class="field" style="flex-direction:row; gap:8px">
        <button class="btn" value="save">Save</button>
        <button class="btn secondary" value="cancel" formnovalidate>Cancel</button>
      </div>
    </form>
    <div class="form-error"></div>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  const form = dlg.querySelector('form');
  form.onsubmit = async (e) => {
    if (e.submitter?.value !== 'save') { dlg.remove(); return; }
    e.preventDefault();
    const body = formData(form);
    body.active = body.active === '1';
    if (!body.password) delete body.password;
    try {
      await api('/users/' + u.id, { method: 'PUT', body });
      dlg.remove(); toast('Member updated'); renderTab();
    } catch (err) {
      dlg.querySelector('.form-error').textContent = err.message;
    }
  };
  dlg.onclose = () => dlg.remove();
}

// ---------- analytics ----------

function barTable(title, rows, hint, keyHeader = 'Name') {
  if (!rows.length) return `<div class="card"><h2>${title}</h2><p class="muted">No sales yet.</p></div>`;
  const max = Math.max(...rows.map((r) => Math.abs(r.avgMargin)), 1);
  return `<div class="card">
    <h2>${title}</h2>
    ${hint ? `<p class="muted small" style="margin-top:-6px">${hint}</p>` : ''}
    <div class="table-wrap"><table>
      <thead><tr><th>${keyHeader}</th><th>Avg margin per phone</th>
        <th class="num">Sold</th><th class="num">Total margin</th><th class="num">Avg days in stock</th></tr></thead>
      <tbody>
        ${rows.map((r) => `<tr>
          <td>${esc(r.key)}</td>
          <td><div class="barcell">
            <div class="bar ${r.avgMargin < 0 ? 'neg' : ''}" style="width:${Math.round(Math.abs(r.avgMargin) / max * 140)}px"></div>
            <span class="val">${taka(r.avgMargin)}</span>
          </div></td>
          <td class="num">${r.count}</td>
          <td class="num">${signed(r.totalMargin)}</td>
          <td class="num">${r.avgDays.toFixed(0)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>`;
}

async function renderAnalytics(view) {
  const a = await api('/analytics');
  view.innerHTML = `
    <div class="kpis">
      <div class="tile"><div class="label">Phones sold</div><div class="value">${a.totalSold}</div><div class="sub">all time</div></div>
      <div class="tile"><div class="label">Avg margin / phone</div>
        <div class="value ${a.avgMargin < 0 ? 'neg' : ''}">${taka(a.avgMargin)}</div><div class="sub">after repair costs</div></div>
      <div class="tile"><div class="label">Avg days in stock</div><div class="value">${a.avgDaysInStock.toFixed(0)}</div><div class="sub">purchase → sale</div></div>
    </div>
    ${barTable('Best-margin brands', a.byBrand, 'Buy more of what sits at the top — high margin, low days-in-stock.')}
    ${barTable('Best-margin models', a.byModel)}
    ${barTable('Condition vs margin', a.byCondition, 'Which condition grade is actually worth buying.', 'Condition')}
    ${barTable('Sales by member', a.bySeller, 'Who is closing the most profitable deals.', 'Member')}`;
}

// ---------- audit log ----------

function diffText(oldV, newV) {
  const o = oldV ? JSON.parse(oldV) : null;
  const n = newV ? JSON.parse(newV) : null;
  if (!o && n) return Object.entries(n).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}: ${v}`).join('\n');
  if (o && n) {
    const lines = [];
    for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
      if (JSON.stringify(o[k]) !== JSON.stringify(n[k])) lines.push(`${k}: ${o[k] ?? '—'} → ${n[k] ?? '—'}`);
    }
    return lines.join('\n') || '(no field changes)';
  }
  return '';
}

async function renderAudit(view) {
  const rows = await api('/audit');
  const typeLabel = { purchases: 'Purchase', sales: 'Sale', expenses: 'Expense', investments: 'Investment', transfers: 'Transfer', users: 'Member' };
  view.innerHTML = `
    <div class="card">
      <h2>Audit log <span class="muted small">(every create, edit and verify — nothing is ever deleted)</span></h2>
      ${rows.length === 0 ? '<p class="muted">No activity yet.</p>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>When (UTC)</th><th>Who</th><th>Action</th><th>Entry</th><th>Change</th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr>
            <td class="small" style="white-space:nowrap">${r.created_at}</td>
            <td>${esc(r.user_name)}</td>
            <td><span class="badge ${r.action === 'verify' ? 'verified' : 'pending'}">${r.action}</span></td>
            <td>${typeLabel[r.entry_type] || r.entry_type} #${r.entry_id}</td>
            <td><div class="audit-diff">${esc(diffText(r.old_value, r.new_value))}</div></td>
          </tr>`).join('')}
        </tbody>
      </table></div>`}
    </div>`;
}

// ---------- boot ----------

async function boot() {
  renderShell();
  await renderTab();
}

(async () => {
  try {
    me = await api('/me');
    await boot();
  } catch {
    renderLogin();
  }
})();
