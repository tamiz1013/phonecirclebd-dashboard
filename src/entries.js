const { col, nextId, now, BANK_ID, BANK_NAME } = require('./db');

// ---- entry-type registry -------------------------------------------------
// Each verifiable entry type declares its editable fields.
//
// Cash rules (who did it = who created the entry, always):
//   purchase    -> paid from the creator's cash          (bought_by = creator)
//   sale        -> cash received by the creator          (sold_by   = creator)
//   expense     -> paid from the creator's cash          (paid_by   = creator)
//   investment  -> invested by the creator, money lands in the company bank
//   transfer    -> from the creator's cash; an admin (bank access) may send
//                  from the company bank instead. Anyone may send TO the bank.

const EXPENSE_CATEGORIES = ['food', 'transport', 'accessories', 'salary', 'other'];
const CONDITIONS = ['New', 'Like New', 'Good', 'Fair', 'Poor'];
const VERIFICATIONS_NEEDED = 3; // distinct members other than the creator

const str = (v) => (v == null ? '' : String(v).trim());

// ctx = { user (logged-in), existing (row being edited, or null) }
// The actor is the original creator: on create that's the logged-in user, on
// edit the attribution sticks with whoever created the entry.
const actorId = (ctx) => (ctx.existing ? ctx.existing.created_by : ctx.user.id);

const TYPES = {
  purchases: {
    fields: [
      'brand', 'model', 'condition', 'price', 'repair_cost', 'purchase_date',
      'battery_health', 'storage', 'variant', 'color', 'imei1', 'imei2',
      'location', 'seller_name', 'seller_phone', 'service_history',
      'bought_by', 'notes',
    ],
    async validate(body) {
      const errors = [];
      if (!str(body.brand)) errors.push('Brand is required');
      if (!str(body.model)) errors.push('Model is required');
      if (!CONDITIONS.includes(body.condition)) errors.push('Condition must be one of: ' + CONDITIONS.join(', '));
      if (!(Number(body.price) > 0)) errors.push('Buying price must be a positive number');
      if (Number(body.repair_cost || 0) < 0 || isNaN(Number(body.repair_cost || 0))) errors.push('Repair & other cost must be zero or more');
      if (!isDate(body.purchase_date)) errors.push('Purchase date is required (YYYY-MM-DD)');
      return errors;
    },
    clean: (b, ctx) => ({
      brand: str(b.brand), model: str(b.model), condition: b.condition,
      price: Number(b.price), repair_cost: Number(b.repair_cost || 0),
      purchase_date: b.purchase_date,
      battery_health: str(b.battery_health), storage: str(b.storage),
      variant: str(b.variant), color: str(b.color),
      imei1: str(b.imei1), imei2: str(b.imei2),
      location: str(b.location), seller_name: str(b.seller_name),
      seller_phone: str(b.seller_phone), service_history: str(b.service_history),
      bought_by: ctx.existing ? ctx.existing.bought_by : ctx.user.id,
      notes: str(b.notes),
    }),
  },

  sales: {
    fields: ['purchase_id', 'sale_price', 'sale_date', 'buyer', 'sold_by', 'notes'],
    async validate(body, existingId) {
      const errors = [];
      const purchase = await col('purchases').findOne({ id: Number(body.purchase_id) });
      if (!purchase) errors.push('Sale must link to an existing purchased phone');
      else {
        const taken = await col('sales').findOne({ purchase_id: Number(body.purchase_id) });
        if (taken && taken.id !== existingId) errors.push('That phone is already sold (sale #' + taken.id + ')');
        if (isDate(body.sale_date) && body.sale_date < purchase.purchase_date) {
          errors.push('Sale date cannot be before the purchase date');
        }
      }
      if (!(Number(body.sale_price) > 0)) errors.push('Sale price must be a positive number');
      if (!isDate(body.sale_date)) errors.push('Sale date is required (YYYY-MM-DD)');
      return errors;
    },
    clean: (b, ctx) => ({
      purchase_id: Number(b.purchase_id), sale_price: Number(b.sale_price),
      sale_date: b.sale_date, buyer: str(b.buyer),
      sold_by: ctx.existing ? ctx.existing.sold_by : ctx.user.id,
      notes: str(b.notes),
    }),
  },

  expenses: {
    fields: ['category', 'amount', 'expense_date', 'description', 'related_user', 'paid_by'],
    async validate(body) {
      const errors = [];
      if (!EXPENSE_CATEGORIES.includes(body.category)) errors.push('Category must be one of: ' + EXPENSE_CATEGORIES.join(', '));
      if (!(Number(body.amount) > 0)) errors.push('Amount must be a positive number');
      if (!isDate(body.expense_date)) errors.push('Expense date is required (YYYY-MM-DD)');
      if (body.category === 'salary' && !(await userExists(body.related_user))) errors.push('Salary must name the member who was paid');
      return errors;
    },
    clean: (b, ctx) => ({
      category: b.category, amount: Number(b.amount), expense_date: b.expense_date,
      description: str(b.description),
      related_user: b.related_user ? Number(b.related_user) : null,
      paid_by: ctx.existing ? ctx.existing.paid_by : ctx.user.id,
    }),
  },

  investments: {
    fields: ['investor_id', 'amount', 'invest_date', 'received_by', 'notes'],
    async validate(body) {
      const errors = [];
      if (!(Number(body.amount) > 0)) errors.push('Amount must be a positive number');
      if (!isDate(body.invest_date)) errors.push('Investment date is required (YYYY-MM-DD)');
      return errors;
    },
    clean: (b, ctx) => ({
      investor_id: ctx.existing ? ctx.existing.investor_id : ctx.user.id,
      amount: Number(b.amount),
      invest_date: b.invest_date,
      received_by: ctx.existing ? ctx.existing.received_by : BANK_ID, // all investment cash sits in the company bank
      notes: str(b.notes),
    }),
  },

  transfers: {
    fields: ['from_user', 'to_user', 'amount', 'transfer_date', 'notes'],
    async validate(body, existingId, ctx) {
      const errors = [];
      const from = fromForTransfer(body, ctx);
      const to = Number(body.to_user);
      if (from === BANK_ID && !isAdmin(actorUser(ctx))) {
        errors.push('Only an admin (bank access) can send money from the company bank');
      }
      if (to !== BANK_ID && !(await userExists(to))) errors.push('"To" must be an existing member or the company bank');
      if (from === to) errors.push('From and To cannot be the same');
      if (!(Number(body.amount) > 0)) errors.push('Amount must be a positive number');
      if (!isDate(body.transfer_date)) errors.push('Transfer date is required (YYYY-MM-DD)');
      return errors;
    },
    clean: (b, ctx) => ({
      from_user: fromForTransfer(b, ctx),
      to_user: Number(b.to_user),
      amount: Number(b.amount), transfer_date: b.transfer_date,
      notes: str(b.notes),
    }),
  },
};

// A transfer always leaves the creator's own cash — except an admin, who may
// pick the company bank as the source (from_bank flag from the form).
function fromForTransfer(body, ctx) {
  if (ctx.existing) return ctx.existing.from_user;
  return String(body.from_bank) === '1' ? BANK_ID : ctx.user.id;
}
// For edits the rules are checked against the original creator, not the editor.
function actorUser(ctx) {
  return ctx.existingCreator || ctx.user;
}

function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}
async function userExists(id) {
  if (!id) return false;
  return !!(await col('users').findOne({ id: Number(id), active: 1 }));
}
function isAdmin(user) {
  return String(user.roles || '').split(',').includes('admin');
}

// ---- audit log -----------------------------------------------------------

async function logAction(entryType, entryId, userId, action, oldValue, newValue) {
  await col('audit_log').insertOne({
    id: await nextId('audit_log'),
    entry_type: entryType, entry_id: entryId, user_id: userId, action,
    old_value: oldValue == null ? null : JSON.stringify(oldValue),
    new_value: newValue == null ? null : JSON.stringify(newValue),
    created_at: now(),
  });
}

// ---- verification workflow -----------------------------------------------

async function activeVerifications(type, id) {
  const vers = await col('verifications')
    .find({ entry_type: type, entry_id: id, invalidated_at: null })
    .sort({ created_at: 1 }).toArray();
  const users = await col('users').find({ id: { $in: vers.map((v) => v.user_id) } }).toArray();
  return vers.map((v) => ({
    user_id: v.user_id,
    name: users.find((u) => u.id === v.user_id)?.name || '#' + v.user_id,
    created_at: v.created_at,
  }));
}

// Verified when VERIFICATIONS_NEEDED distinct members other than the creator
// have verified, or when an admin (other than the creator) has verified.
// The creator's own verification never counts — not even an admin's.
async function computeStatus(type, id, createdBy) {
  const vers = (await activeVerifications(type, id)).filter((v) => v.user_id !== createdBy);
  if (vers.length >= VERIFICATIONS_NEEDED) return 'verified';
  const verifiers = await col('users').find({ id: { $in: vers.map((v) => v.user_id) } }).toArray();
  return verifiers.some((u) => isAdmin(u)) ? 'verified' : 'pending';
}

async function refreshStatus(type, id) {
  const row = await col(type).findOne({ id });
  const status = await computeStatus(type, id, row.created_by);
  if (status !== row.status) await col(type).updateOne({ id }, { $set: { status } });
  return status;
}

// ---- create / edit / verify / delete -------------------------------------

async function createEntry(type, body, user) {
  const t = TYPES[type];
  const ctx = { user, existing: null };
  const errors = await t.validate(body, null, ctx);
  if (errors.length) return { errors };

  const values = t.clean(body, ctx);
  const id = await nextId(type);
  await col(type).insertOne({
    id, ...values, status: 'pending', created_by: user.id, created_at: now(),
  });
  await logAction(type, id, user.id, 'create', null, values);
  return { id };
}

// Edit resets status to pending and invalidates prior verifications (kept, not
// deleted). Only the creator or an admin can edit; attribution never changes.
async function editEntry(type, id, body, user) {
  const t = TYPES[type];
  const existing = await col(type).findOne({ id });
  if (!existing) return { notFound: true };
  if (existing.created_by !== user.id && !isAdmin(user)) {
    return { errors: ['Only the person who made this entry (or an admin) can edit it'] };
  }

  const merged = { ...existing, ...body };
  const existingCreator = await col('users').findOne({ id: existing.created_by });
  const ctx = { user, existing, existingCreator };
  const errors = await t.validate(merged, id, ctx);
  if (errors.length) return { errors };

  const values = t.clean(merged, ctx);
  const oldValues = {};
  for (const c of t.fields) oldValues[c] = existing[c];

  const changed = t.fields.some((c) => values[c] !== existing[c]);
  if (!changed) return { id, unchanged: true };

  await col(type).updateOne({ id }, { $set: { ...values, status: 'pending' } });
  await col('verifications').updateMany(
    { entry_type: type, entry_id: id, invalidated_at: null },
    { $set: { invalidated_at: now() } },
  );
  await logAction(type, id, user.id, 'edit', oldValues, values);
  return { id };
}

async function verifyEntry(type, id, user) {
  const existing = await col(type).findOne({ id });
  if (!existing) return { notFound: true };
  if (existing.created_by === user.id) {
    return { errors: ['You cannot verify your own entry — another member must check it'] };
  }
  const already = await col('verifications').findOne({
    entry_type: type, entry_id: id, user_id: user.id, invalidated_at: null,
  });
  if (already) return { errors: ['You have already verified this entry'] };

  await col('verifications').insertOne({
    id: await nextId('verifications'),
    entry_type: type, entry_id: id, user_id: user.id,
    created_at: now(), invalidated_at: null,
  });
  const status = await refreshStatus(type, id);
  await logAction(type, id, user.id, 'verify', { status: existing.status }, { status });
  return { id, status };
}

// The creator can delete their own entry while it is still pending. Once
// verified it is part of the books and can no longer be deleted.
async function deleteEntry(type, id, user) {
  const existing = await col(type).findOne({ id });
  if (!existing) return { notFound: true };
  if (existing.created_by !== user.id) {
    return { errors: ['Only the person who made this entry can delete it'] };
  }
  if (existing.status === 'verified') {
    return { errors: ['This entry is verified and can no longer be deleted'] };
  }
  if (type === 'purchases') {
    const sale = await col('sales').findOne({ purchase_id: id });
    if (sale) return { errors: [`This phone has a sale recorded (sale #${sale.id}) — delete that sale first`] };
  }

  const snapshot = { ...existing };
  delete snapshot._id;
  await col(type).deleteOne({ id });
  await col('verifications').updateMany(
    { entry_type: type, entry_id: id, invalidated_at: null },
    { $set: { invalidated_at: now() } },
  );
  await logAction(type, id, user.id, 'delete', snapshot, null);
  return { id };
}

module.exports = {
  TYPES, EXPENSE_CATEGORIES, CONDITIONS, VERIFICATIONS_NEEDED,
  createEntry, editEntry, verifyEntry, deleteEntry,
  activeVerifications, logAction, isAdmin, BANK_ID, BANK_NAME,
};
