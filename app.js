// Lumen Research Tracker — single-file frontend app

// Bump on each deploy. Shown in the sidebar footer so you can confirm at a
// glance which build is actually live (handy when cache / deploy is in doubt).
const BUILD_VERSION = '2026-10-09.4';

const STORAGE_KEY = 'lumen-tracker-v1';
const $ = (s, ctx = document) => ctx.querySelector(s);
const $$ = (s, ctx = document) => Array.from(ctx.querySelectorAll(s));
// Stamp the build tag as soon as the DOM is ready.
(function stampBuild() {
  const set = () => { const el = document.getElementById('buildTag'); if (el) el.textContent = 'Build ' + BUILD_VERSION; };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', set);
  else set();
})();

// ---------- Product categories ----------
// Products split three ways so reporting can separate the two real product
// lines from the things that aren't products at all (syringes, bac water, the
// loyalty discount line item). Every product carries an explicit `category`;
// items created before this existed get one from classifyProduct() on load and
// the user can override any of them in the product editor.
const CATEGORIES = [
  { key: 'peptides', label: 'Peptides' },
  { key: 'gear',     label: 'Gear' },
  { key: 'other',    label: 'Other' },
];
const CATEGORY_KEYS = CATEGORIES.map(c => c.key);
const DEFAULT_CATEGORY = 'other';
function categoryLabel(key) {
  const c = CATEGORIES.find(x => x.key === key);
  return c ? c.label : 'Other';
}

// Name-matching rules for the one-time backfill. Order matters: the first
// list whose pattern matches wins, so `other` is checked first to keep
// supplies out of the product lines (e.g. "Hospira Bac Water" must not fall
// through to a peptide match).
const CATEGORY_RULES = [
  // Not products: injection supplies, solvents, and the discount line item.
  ['other', [
    /syringe/i, /needle/i, /bac\s*water/i, /bacteriostatic/i, /luer|leur/i,
    /loyalty/i, /discount/i, /shipping/i, /^other$/i,
    // Ancillary pharma that is neither a peptide nor an anabolic.
    /isotretinoin|accutane/i, /modafinil/i, /sildenafil|viagra/i, /tadalafil|cialis/i,
  ]],
  // Anabolics, orals, and cycle ancillaries.
  ['gear', [
    /\btest\s*(c|e|p|cyp|prop|enanth)/i, /testosterone/i, /sustanon/i,
    /\btren\b|trenbolone/i, /\bnpp\b/i, /\bdeca\b|nandrolone/i,
    /anavar|oxandrolone/i, /\bdbol\b|dianabol|methandrostenolone/i,
    /winstrol|stanozolol/i, /masteron|drostanolone/i, /primo|methenolone/i,
    /\beq\b|boldenone|equipoise/i, /anadrol|oxymetholone/i,
    /superdrol|methasterone/i, /turinabol/i, /halotestin/i, /proviron/i,
    // Aromatase inhibitors / SERMs / PCT — bought and sold with a cycle.
    /\badex\b|anastrozole|arimidex/i, /aromasin|exemestane/i, /letro|letrozole/i,
    /nolva|tamoxifen/i, /clomid|clomiphene/i, /\bhcg\b/i,
    // Orally active non-peptide performance compounds.
    /mk-?677|ibutamoren/i, /gw-?50156|cardarine/i, /rad-?140|lgd-?4033|ostarine|mk-?2866|s-?23|yk-?11/i,
  ]],
  // Everything else that is an actual peptide / peptide-hormone product.
  ['peptides', [
    /bpc-?157/i, /tb-?500|thymosin/i, /\bkpv\b/i, /ghk-?cu/i, /larazotide/i,
    /retatrutide|tirzepatide|semaglutide|glp/i, /tesamorelin/i, /ipamorelin|cjc/i,
    /sermorelin/i, /ghrp/i, /hexarelin/i, /pt-?141|bremelanotide/i,
    /\bmt-?2\b|melanotan/i, /mots-?c/i, /ss-?31|elamipretide/i, /epitalon/i,
    /selank|semax/i, /dsip/i, /aod-?9604/i, /igf-?1|lr3/i, /\bhgh\b|somatropin/i,
    /klow/i, /glow/i, /wolverine/i,
    // Injectable wellness items sold as part of the peptide line.
    /nad\+?/i, /\bb-?12\b/i,
  ]],
];

// Best-guess category for a product name. Used only to seed `category` on
// products that don't have one yet — never to override an explicit choice.
function classifyProduct(name) {
  const n = (name || '').trim();
  if (!n) return DEFAULT_CATEGORY;
  for (const [key, patterns] of CATEGORY_RULES) {
    if (patterns.some(re => re.test(n))) return key;
  }
  return DEFAULT_CATEGORY;
}

// Read a product's category, falling back to the name-based guess so callers
// never have to deal with a missing value.
function stockCategory(s) {
  const c = s && s.category;
  return CATEGORY_KEYS.includes(c) ? c : classifyProduct(s && s.name);
}

// Backfill `category` on any product that predates the field.
function migrateStock(stock) {
  return (stock || []).map(s => (
    CATEGORY_KEYS.includes(s && s.category) ? s : { ...s, category: classifyProduct(s && s.name) }
  ));
}

// Category of a sold item, resolved through the inventory record so historical
// order lines pick up whatever the product is categorized as today. Falls back
// to the name guess for products that have since been deleted from inventory.
function itemCategory(productName) {
  const target = (productName || '').toLowerCase().trim();
  const product = state.stock.find(p => (p.name || '').toLowerCase().trim() === target);
  return product ? stockCategory(product) : classifyProduct(productName);
}

// ---------- Expense categories ----------
// Bookkeeping buckets for money going OUT. These map onto the lines an
// accountant actually files, so a CSV export can be handed over without a
// translation pass. Every expense carries an explicit `category`; anything
// that predates the field gets one from classifyExpense() on load, and any of
// them can be reassigned inline on the Expenses page.
const EXPENSE_CATEGORIES = [
  { key: 'inventory', label: 'Inventory / Product Purchases', short: 'Inventory' },
  { key: 'packaging', label: 'Packaging & Shipping Supplies', short: 'Packaging' },
  { key: 'labsupply', label: 'Lab & Medical Supplies',        short: 'Lab Supplies' },
  { key: 'equipment', label: 'Equipment & Hardware',          short: 'Equipment' },
  { key: 'software',  label: 'Software & Web Services',       short: 'Software' },
  { key: 'vehicle',   label: 'Vehicle & Transportation',      short: 'Vehicle' },
  { key: 'marketing', label: 'Marketing & Advertising',       short: 'Marketing' },
  { key: 'fees',      label: 'Professional & Bank Fees',      short: 'Fees' },
  { key: 'ownerdraw', label: 'Owner Draw / Personal',         short: 'Owner Draw' },
  { key: 'otherexp',  label: 'Other',                         short: 'Other' },
];
const EXPENSE_CATEGORY_KEYS = EXPENSE_CATEGORIES.map(c => c.key);
const DEFAULT_EXPENSE_CATEGORY = 'otherexp';
function expenseCategoryLabel(key) {
  const c = EXPENSE_CATEGORIES.find(x => x.key === key);
  return c ? c.label : 'Other';
}
function expenseCategoryShort(key) {
  const c = EXPENSE_CATEGORIES.find(x => x.key === key);
  return c ? c.short : 'Other';
}

// Name-matching rules for the one-time backfill. Order matters — the first
// bucket whose pattern hits wins. The specific overhead buckets are checked
// before the product buckets so "Printer Toner" files under Packaging (it
// prints shipping labels) instead of falling through to Equipment, and
// "Bac Water" lands in Lab Supplies rather than reading as a peptide purchase.
const EXPENSE_CATEGORY_RULES = [
  ['vehicle', [
    /vehicle|\btruck\b|\bvan\b|\bcar\b|\bauto\b|dash ?cam/i,
    /\bgas\b|\bfuel\b|mileage|\btolls?\b|parking|\btires?\b|oil change/i,
    /registration|\bdmv\b|\buber\b|\blyft\b|car wash|roadside/i,
    // Travel rides here too — it lands on the same transportation line.
    /\bflights?\b|plane ticket|airfare|airline|\bbaggage\b/i,
    /\bhotel\b|lodging|airbnb|rental car|amtrak|train ticket|\btravel\b/i,
  ]],
  ['software', [
    /website|web ?site|hosting|\bdomain\b|godaddy|namecheap|vercel|netlify/i,
    /squarespace|shopify|\bwix\b|wordpress|subscription|\bsaas\b/i,
    /adobe|canva|google workspace|microsoft ?365|\bzoom\b|quickbooks|\bslack\b/i,
    /software|\bapi\b|openai|anthropic|supabase/i,
  ]],
  ['marketing', [
    /advertis|marketing|\bads?\b|promo(tion)?\b|sponsor|influencer/i,
    /business cards?|flyers?|\bbanner\b|signage|giveaway/i,
  ]],
  ['fees', [
    /accountant|\bcpa\b|bookkeep|tax prep|attorney|lawyer|\blegal\b/i,
    /bank fee|merchant fee|processing fee|wire fee|\bstripe\b|paypal fee/i,
    /\bllc\b|registered agent|\blicense\b|\bpermit\b|filing fee|franchise tax/i,
    /\binsurance\b|consulting fee/i,
    // Card and loan payments are transfers rather than true expenses, but
    // filing them here puts them in front of the accountant to reclassify
    // instead of burying them in Other.
    /\bcc payments?\b|card payments?|credit card payment|loan payment|\binterest\b/i,
  ]],
  ['packaging', [
    /\blabels?\b|toner|\bink\b|cartridges?|\bcmyk\b|\bpaper\b|thermal|sticker/i,
    /box(es)?\b|bubble|mailer|envelope|packag|poly ?bag|pouch|shrink ?wrap/i,
    /\btape\b|shipping suppl|postage|\bstamps?\b|\bshipping\b|\bups\b|\bfedex\b|\busps\b/i,
  ]],
  ['labsupply', [
    /needle|syringe|bac(teriostatic)? ?water|sterile water|alcohol (pad|wipe|swab)/i,
    /\bswabs?\b|\bvials?\b|stopper|crimp|\bglove/i,
    /sharps|\bfilters?\b|desiccant|ice ?pack|dry ice|gauze|\bpipette/i,
    /carewell|health ?warehouse|medical suppl|\bsuppl(y|ies)\b/i,
  ]],
  ['equipment', [
    /freezer|fridge|refrigerat|\bprinter\b|laptop|computer|monitor|scanner/i,
    /\bscale\b|camera|\bipad\b|\bdesk\b|\bchair\b|shelv|storage rack|\bsafe\b/i,
    /centrifuge|heat sealer|vacuum sealer|equipment|\bhardware\b|\btoolbox\b/i,
    // Desk peripherals and small office fit-out.
    /\bmouse\b|keyboard|webcam|headset|\bcables?\b|charger|\busb\b|docking/i,
    /electrical|\blight(s|ing|bulbs?)?\b|\boutlets?\b|wiring|\bfixtures?\b/i,
  ]],
  ['ownerdraw', [
    /owner draw|\bpersonal\b|reimburse|withdraw(al)?\b|\bpayroll\b|\bsalary\b/i,
    /\bsbd\b|lifting belt|\bapparel\b|clothing|\bshoes\b/i,
    // Personal and family spend that ran through the business card.
    /graduation|\bgifts?\b|\bdrinks?\b|birthday|\bparty\b|celebration|\bwedding\b/i,
    /nintendo|playstation|\bxbox\b|steam deck|\bconsole\b/i,
    /landscap|\blawn\b|\bgarden\b|\bmulch\b|top dressing|\bsod\b/i,
  ]],
  ['inventory', [
    /\bgear\b|\border\b|research|\bgmr\b|\baps\b|ancillary|restock|wholesale/i,
    /\bbulk\b|\bpeptides?\b|\braws?\b|\bkits?\b/i,
    // Purchase-order shorthand for products we stock — R10 / R20 (Retatrutide),
    // Tesa10, CU100 (GHK-Cu), MOT10 (MOTS-C), KLOW/GLOW blends. These never
    // appear under the catalog name on a receipt, so the product classifier
    // can't see them.
    /\br-?\d{1,3}\b|\btesa-?\d*\b|\bcu-?\d{2,3}\b|\bmots?-?c?-?\d{1,3}\b/i,
    /\bklow\s?\d*\b|\bglow\s?\d*\b/i,
    // Resale pharma that isn't a peptide or an anabolic.
    /modafinil|sildenafil|tadalafil|isotretinoin|accutane/i,
  ]],
];

// Everything an expense knows about itself flattened into one searchable
// string — vendor plus every line item — so the classifier sees the full
// picture ("Amazon" alone says nothing, "Amazon · dashcam" says Vehicle).
function expenseText(e) {
  const items = Array.isArray(e && e.items) ? e.items : [];
  return [(e && e.vendor) || '', ...items.map(it => (it && it.product) || ''), (e && e.product) || '']
    .join(' ')
    .trim();
}

// Best-guess bucket for an expense. Used only to seed `category` on records
// that don't have one — never to override an explicit choice. Falls back to
// the product classifier so anything recognizable as a peptide or gear order
// files as Inventory even when the description is just the compound name.
function classifyExpense(text) {
  const t = (text || '').trim();
  if (!t) return DEFAULT_EXPENSE_CATEGORY;
  for (const [key, patterns] of EXPENSE_CATEGORY_RULES) {
    if (patterns.some(re => re.test(t))) return key;
  }
  const guess = classifyProduct(t);
  if (guess === 'peptides' || guess === 'gear') return 'inventory';
  return DEFAULT_EXPENSE_CATEGORY;
}

// Read an expense's category, falling back to the name-based guess so callers
// never have to deal with a missing value.
function expenseCategory(e) {
  const c = e && e.category;
  return EXPENSE_CATEGORY_KEYS.includes(c) ? c : classifyExpense(expenseText(e));
}

// ---------- Capital / owner-funded spend ----------
// Purchases the business books but that never came out of the business account
// — the vehicle, owner-funded equipment. Real money, and the accountant needs
// them, but deducting them from Net Profit misstates how the operation itself
// is performing. Flagged expenses drop out of Operating Expenses and roll up
// into their own line instead; All-In Position puts them back.
function expenseExcluded(e) { return !!(e && e.excludeFromNet); }
function expenseOperatingCost(e) { return expenseExcluded(e) ? 0 : expenseCost(e); }
function expenseCapitalCost(e) { return expenseExcluded(e) ? expenseCost(e) : 0; }
function sumExpenses(list) { return round2((list || []).reduce((s, e) => s + expenseCost(e), 0)); }
function sumOperating(list) { return round2((list || []).reduce((s, e) => s + expenseOperatingCost(e), 0)); }
function sumCapital(list) { return round2((list || []).reduce((s, e) => s + expenseCapitalCost(e), 0)); }

// Per-category totals for a set of expenses, ordered by EXPENSE_CATEGORIES and
// dropping buckets with nothing in them. Operating and capital are kept apart
// so a category that is entirely owner-funded still reads correctly.
function expenseCategoryTotals(list) {
  const by = new Map();
  for (const e of (list || [])) {
    const key = expenseCategory(e);
    let row = by.get(key);
    if (!row) { row = { key, total: 0, operating: 0, capital: 0, count: 0 }; by.set(key, row); }
    row.total += expenseCost(e);
    row.operating += expenseOperatingCost(e);
    row.capital += expenseCapitalCost(e);
    row.count++;
  }
  return EXPENSE_CATEGORIES
    .map(c => by.get(c.key))
    .filter(Boolean)
    .map(r => ({ ...r, total: round2(r.total), operating: round2(r.operating), capital: round2(r.capital) }));
}

// ---------- State ----------
let state = loadState();

function loadState() {
  let s;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) s = JSON.parse(raw);
  } catch (e) {}
  if (!s) s = JSON.parse(JSON.stringify(window.SEED_DATA));
  s.orders = migrateOrders(s.orders || []);
  s.expenses = migrateExpenses(s.expenses || []);
  s.shipments = migrateShipments(s.shipments || []);
  s.stock = migrateStock(s.stock || []);
  if (!Array.isArray(s.customers)) s.customers = [];
  s.customers = migrateCustomers(s.customers);
  // Auto-create stub customer profiles for any name on an order that doesn't
  // have one yet — so the Customers tab is useful immediately with existing
  // data, no manual setup required.
  s.customers = ensureCustomersFromOrders(s.customers, s.orders);
  return s;
}
// Normalize customer records and snap fields to consistent shapes.
function migrateCustomers(customers) {
  const normalized = (customers || []).map(c => ({
    id: c && c.id ? c.id : 'c-' + Math.random().toString(36).slice(2, 10),
    name: (c && c.name) || '',
    phone: (c && c.phone) || '',
    email: (c && c.email) || '',
    address: (c && c.address) || '',
    notes: (c && c.notes) || '',
    createdAt: (c && c.createdAt) || null,
  })).filter(c => (c.name || '').trim());
  // Historically, ensureCustomersFromOrders (below) minted a random id per
  // device/session for any order customer missing a profile — on a fresh
  // browser that hadn't yet pulled the cloud copy, that meant the same person
  // got a brand-new duplicate row instead of reusing the existing one. Collapse
  // same-name records down to one here (keeping whichever copy has the most
  // filled-in detail) so old duplicate rows already in Supabase don't show up
  // as repeated entries in the customer list or search.
  const byKey = new Map();
  const filledCount = (c) => ['phone', 'email', 'address', 'notes'].filter(f => (c[f] || '').trim()).length;
  for (const c of normalized) {
    const key = customerKey(c.name);
    const prev = byKey.get(key);
    if (!prev || filledCount(c) > filledCount(prev)) byKey.set(key, c);
  }
  return [...byKey.values()];
}
// Match customers to orders by lower-cased trimmed name so a customer record
// and the customer field on orders stay linked even if capitalization varies.
function customerKey(name) { return (name || '').toLowerCase().trim(); }
// Deterministic id derived from the customer's name, used when auto-creating
// a profile from order history (see ensureCustomersFromOrders). Independent
// sessions that each need to backfill the same missing customer land on the
// same id and upsert onto the same Supabase row instead of each minting a new
// random id and creating a duplicate.
function customerIdFromName(name) {
  const slug = customerKey(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return 'c-auto-' + (slug || 'customer');
}
function ensureCustomersFromOrders(customers, orders) {
  const existing = new Set((customers || []).map(c => customerKey(c.name)));
  const out = [...customers];
  for (const o of (orders || [])) {
    const name = (o.customer || '').trim();
    if (!name) continue;
    const key = customerKey(name);
    if (existing.has(key)) continue;
    existing.add(key);
    out.push({
      id: customerIdFromName(name),
      name, phone: '', email: '', address: '', notes: '',
      createdAt: o.date || null,
    });
  }
  return out;
}
// Look up a customer profile by case-insensitive name match.
function findCustomerByName(name) {
  const key = customerKey(name);
  if (!key) return null;
  return (state.customers || []).find(c => customerKey(c.name) === key) || null;
}

// Default existing shipments to unit='kits' so the legacy 1:1 behavior is
// preserved for old records (they're below the cutoff anyway, so no inventory
// delta is applied).
function migrateShipments(shipments) {
  return shipments.map(s => {
    const r = (s.unit === 'qty' || s.unit === 'kits') ? { ...s } : { ...s, unit: 'kits' };
    // Received date postdates the original schema. Left blank for historical
    // records — transit time simply reads as unknown rather than being faked
    // from the order date.
    if (typeof r.dateReceived !== 'string') r.dateReceived = '';
    return r;
  });
}

// Convert legacy single-product orders into multi-item orders
function migrateOrders(orders) {
  return orders.map(o => {
    let r;
    if (Array.isArray(o.items)) {
      if (o.notes == null) o.notes = '';
      if (o.shipping == null) o.shipping = 0;
      r = o;
    } else {
      const item = {
        product: o.product || '',
        qty: Number(o.qty) || 0,
        price: Number(o.price) || 0,
        cogs: Number(o.cogs) || 0,
      };
      r = {
        id: o.id,
        customer: o.customer,
        date: o.date,
        paid: !!o.paid,
        delivered: !!o.delivered,
        items: [item],
        notes: o.notes || '',
        shipping: Number(o.shipping) || 0,
      };
    }
    // Snap every money field to whole cents so any prior floating-point noise
    // gets cleaned up the next time the file is saved. Cheap and idempotent.
    r.shipping = round2(r.shipping);
    if (Array.isArray(r.items)) {
      r.items = r.items.map(it => {
        // Normalize per-line discount to { type, value } | null. Legacy bare
        // numbers (older saves) get promoted to {type:'amount', value:N}.
        let discount = null;
        const raw = it && it.discount;
        if (typeof raw === 'number' && raw > 0) {
          discount = { type: 'amount', value: Math.ceil(raw - 1e-9) };
        } else if (raw && typeof raw === 'object' && Number(raw.value) > 0) {
          const type = raw.type === 'percent' ? 'percent' : 'amount';
          const value = Number(raw.value);
          discount = { type, value: type === 'percent' ? value : Math.ceil(value - 1e-9) };
        }
        return {
          ...it,
          price: round2(it && it.price),
          cogs: round2(it && it.cogs),
          discount,
        };
      });
    }
    // Discount: normalize to { type:'percent'|'amount', value } or null.
    if (r.discount && (r.discount.type === 'percent' || r.discount.type === 'amount') && Number(r.discount.value) > 0) {
      r.discount = { type: r.discount.type, value: round2(r.discount.value) };
    } else {
      r.discount = null;
    }
    // Payments array — sum represents how much the customer has paid. Legacy
    // "paid" boolean is preserved for backwards compat: if the order was fully
    // paid but has no payment records, synthesize one for the full total dated
    // to the order date so all the new accounting helpers line up.
    if (!Array.isArray(r.payments)) r.payments = [];
    r.payments = r.payments.map(p => ({ ...p, amount: round2(p && p.amount) }));
    if (r.paid && r.payments.length === 0) {
      const total = orderTotal(r);
      if (total > 0) {
        const d = new Date();
        const fallbackDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        r.payments.push({
          id: 'p-legacy-' + (r.id || Math.random().toString(36).slice(2, 8)),
          amount: total,
          date: r.date || fallbackDate,
          method: '',
          note: '',
        });
      }
    }
    syncOrderPaidFlag(r);
    // Inventory-applied flag tracks whether this order is currently deducted
    // from stock. For pre-existing orders without the flag, fall back to the
    // OLD rule (paid → deducted) so we don't double-restore or double-deduct
    // stock when the new "paid AND delivered" rule kicks in. Going forward,
    // reconcileOrderInventory() keeps the flag and stock in sync.
    if (typeof r.inventoryApplied !== 'boolean') r.inventoryApplied = !!r.paid;
    return r;
  });
}

// Convert legacy single-product expenses into multi-item expenses, and
// backfill `vendor` / `costMode` / `totalCost` for entries that pre-date them.
function migrateExpenses(expenses) {
  return expenses.map(e => {
    let r;
    if (Array.isArray(e.items) && e.items.length) {
      r = { ...e };
    } else {
      r = {
        id: e.id,
        dateOrdered: e.dateOrdered || '',
        dateReceived: e.dateReceived || '',
        items: [{ product: e.product || '', cost: Number(e.cost) || 0 }],
      };
    }
    if (typeof r.vendor !== 'string') r.vendor = '';
    if (r.costMode !== 'total' && r.costMode !== 'perItem') r.costMode = 'perItem';
    if (typeof r.totalCost !== 'number') {
      r.totalCost = (r.items || []).reduce((s, it) => s + (Number(it.cost) || 0), 0);
    }
    // Backfill the bookkeeping bucket for anything that predates categories.
    if (!EXPENSE_CATEGORY_KEYS.includes(r.category)) r.category = classifyExpense(expenseText(r));
    r.excludeFromNet = !!r.excludeFromNet;
    return r;
  });
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------- Cloud sync (Supabase) ----------
const sb = (window.SUPABASE_CONFIG && window.supabase)
  ? window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.key)
  : null;

// Map between local JS shape and Postgres column names
const Adapters = {
  customers: {
    toRow: (c) => ({
      id: c.id,
      name: c.name || '',
      phone: c.phone || '',
      email: c.email || '',
      address: c.address || '',
      notes: c.notes || '',
      created_at: c.createdAt || null,
    }),
    fromRow: (r) => ({
      id: r.id,
      name: r.name || '',
      phone: r.phone || '',
      email: r.email || '',
      address: r.address || '',
      notes: r.notes || '',
      createdAt: r.created_at || null,
    }),
  },
  stock: {
    toRow: (s) => {
      const row = {
        id: s.id, name: s.name,
        cost: numOrNull(s.cost), price: numOrNull(s.price),
        qty: intOrNull(s.qty), status: s.status,
      };
      // Optional columns — only send if Supabase is known to have them, so an
      // older schema without `reorder` / `original_price` doesn't reject the
      // whole row. (Original price is the "was" / list price; `price` is the
      // active selling price. When original > price, the item is on sale.)
      if (orderColumnAvailable('reorder')) row.reorder = intOrNull(s.reorder);
      if (orderColumnAvailable('original_price')) row.original_price = numOrNull(s.originalPrice);
      // Product line (peptides / gear / other). Older schemas without the
      // column keep working — the value is re-derived from the name on load.
      if (orderColumnAvailable('category')) row.category = stockCategory(s);
      return row;
    },
    fromRow: (r) => ({
      id: r.id, name: r.name,
      cost: r.cost ?? 0, price: r.price ?? 0,
      qty: r.qty ?? 0, status: r.status || 'ACTIVE',
      reorder: r.reorder == null ? null : (Number(r.reorder) || 0),
      originalPrice: r.original_price == null ? null : (Number(r.original_price) || 0),
      category: CATEGORY_KEYS.includes(r.category) ? r.category : classifyProduct(r.name),
    }),
  },
  orders: {
    toRow: (o) => {
      const row = {
        id: o.id, customer: o.customer || '',
        date: o.date || null,
        paid: !!o.paid, delivered: !!o.delivered,
        items: Array.isArray(o.items) ? o.items : [],
        notes: o.notes || '',
        shipping: Number(o.shipping) || 0,
      };
      // Only send optional columns if Supabase is known to have them — older
      // schemas without them would reject the whole row. See
      // missingOptionalOrderColumn() / orderColumnAvailable() above.
      if (orderColumnAvailable('payments')) {
        row.payments = Array.isArray(o.payments) ? o.payments : [];
      }
      if (orderColumnAvailable('discount')) {
        row.discount = o.discount || null;
      }
      // Sync the "is this order's inventory currently deducted from stock?" flag
      // so all devices agree on whether to apply or skip the inventory delta.
      if (orderColumnAvailable('inventory_applied')) {
        row.inventory_applied = !!o.inventoryApplied;
      }
      return row;
    },
    fromRow: (r) => ({
      id: r.id, customer: r.customer || '',
      date: r.date || '',
      paid: !!r.paid, delivered: !!r.delivered,
      items: Array.isArray(r.items) ? r.items : [],
      payments: Array.isArray(r.payments) ? r.payments : [],
      discount: r.discount || null,
      notes: r.notes || '',
      shipping: Number(r.shipping) || 0,
      // `undefined` (column missing or never set) is preserved so migrateOrders
      // can initialize it from the legacy paid flag on first load.
      inventoryApplied: (typeof r.inventory_applied === 'boolean') ? r.inventory_applied : undefined,
    }),
  },
  shipments: {
    toRow: (s) => {
      const row = {
        id: s.id, vendor: s.vendor || '',
        date_ordered: s.dateOrdered || null,
        delivered: !!s.delivered,
        product: s.product || '', kits: s.kits == null ? '' : String(s.kits),
        unit: (s.unit === 'qty' || s.unit === 'kits') ? s.unit : 'kits',
        tracking: s.tracking || '',
      };
      // Optional column — dropped automatically if Supabase doesn't have it
      // yet, so the rest of the row still syncs. See ALL_OPTIONAL_COLUMNS.
      if (orderColumnAvailable('date_received')) row.date_received = s.dateReceived || null;
      return row;
    },
    fromRow: (r) => ({
      id: r.id, vendor: r.vendor || '',
      dateOrdered: r.date_ordered || '',
      dateReceived: r.date_received || '',
      delivered: !!r.delivered,
      product: r.product || '', kits: r.kits || '',
      unit: (r.unit === 'qty' || r.unit === 'kits') ? r.unit : 'kits',
      tracking: r.tracking || '',
    }),
  },
  expenses: {
    toRow: (e) => {
      const items = Array.isArray(e.items) ? e.items : [];
      const mode = (e.costMode === 'total' || e.costMode === 'perItem') ? e.costMode : 'perItem';
      const totalCost = mode === 'total'
        ? Number(e.totalCost) || 0
        : items.reduce((s, it) => s + (Number(it.cost) || 0), 0);
      const summary = items.length
        ? items.map(it => it.product).filter(Boolean).join(', ').slice(0, 200)
        : (e.product || '');
      const row = {
        id: e.id,
        vendor: e.vendor || '',
        product: summary,
        date_ordered: e.dateOrdered || null,
        date_received: e.dateReceived || null,
        cost: numOrNull(totalCost),
        cost_mode: mode,
        items,
      };
      // Optional columns — dropped automatically if Supabase doesn't have them
      // yet, so the rest of the row still syncs. See ALL_OPTIONAL_COLUMNS.
      if (orderColumnAvailable('exp_category')) row.exp_category = expenseCategory(e);
      if (orderColumnAvailable('exclude_from_net')) row.exclude_from_net = !!e.excludeFromNet;
      return row;
    },
    fromRow: (r) => {
      const cost = Number(r.cost) || 0;
      const items = Array.isArray(r.items) ? r.items : [];
      const itemSum = items.reduce((s, it) => s + (Number(it.cost) || 0), 0);
      // Honor an explicit cost_mode if the schema has it. Otherwise fall back:
      // when the stored cost doesn't match the item sum the expense must have
      // been saved in "total" mode (item costs are 0) — preserve that so a
      // missing cost_mode column doesn't zero out the displayed amount.
      let costMode;
      if (r.cost_mode === 'total' || r.cost_mode === 'perItem') {
        costMode = r.cost_mode;
      } else if (cost > 0 && Math.abs(itemSum - cost) > 0.01) {
        costMode = 'total';
      } else {
        costMode = 'perItem';
      }
      return {
        id: r.id,
        vendor: r.vendor || '',
        product: r.product || '',
        dateOrdered: r.date_ordered || '',
        dateReceived: r.date_received || '',
        cost,
        costMode,
        totalCost: cost,
        items,
        // Left blank when the column is missing — migrateExpenses() then fills
        // it in from the name-based classifier.
        category: r.exp_category || '',
        excludeFromNet: !!r.exclude_from_net,
      };
    },
  },
};
function numOrNull(v) { return v == null || v === '' ? null : Number(v); }
function intOrNull(v) { return v == null || v === '' ? null : parseInt(v, 10); }

// ---------- Schema-presence detection (optional orders columns) ----------
// Columns added after the initial schema (payments, discount). If the Supabase
// orders table doesn't have one yet, an upsert that includes it fails and the
// whole row won't sync. We detect that once, remember it in localStorage, and
// drop just that column from future writes so everything else still syncs. The
// data stays in the local cache and repopulates cloud the moment the column is
// added (run the ALTER TABLE noted in the tooltip).
const OPTIONAL_ORDER_COLUMNS = ['payments', 'discount', 'inventory_applied'];
const OPTIONAL_STOCK_COLUMNS = ['reorder', 'original_price', 'category'];
const OPTIONAL_EXPENSE_COLUMNS = ['exp_category', 'exclude_from_net'];
const OPTIONAL_SHIPMENT_COLUMNS = ['date_received'];
// Every optional column across tables, so the missing-column detector and the
// upsert retry loop work for stock as well as orders. Column names are unique
// across our tables, so a single localStorage flag per name is unambiguous.
// `exp_category` is listed before stock's `category` because the missing-column
// detector matches by substring — "category" would otherwise swallow it and
// disable the wrong column.
const ALL_OPTIONAL_COLUMNS = [
  ...OPTIONAL_ORDER_COLUMNS, ...OPTIONAL_EXPENSE_COLUMNS,
  ...OPTIONAL_SHIPMENT_COLUMNS, ...OPTIONAL_STOCK_COLUMNS,
];
// A column marked missing used to stay missing forever in that browser, so
// running the ALTER TABLE in Supabase did nothing until site data was cleared.
// The flag now stores when it was set and expires, so the column gets retried
// on its own and starts syncing shortly after it exists.
const MISSING_COLUMN_RETRY_MS = 60 * 60 * 1000;
function orderColumnAvailable(col) {
  try {
    const raw = localStorage.getItem('lumen-supabase-missing-' + col);
    if (!raw) return true;
    const ts = Number(raw);
    // Legacy flags were the literal '1' — treat those as due for a retry.
    if (!Number.isFinite(ts) || ts <= 1) return true;
    return (Date.now() - ts) > MISSING_COLUMN_RETRY_MS;
  } catch { return true; }
}
function markOrderColumnMissing(col) {
  try { localStorage.setItem('lumen-supabase-missing-' + col, String(Date.now())); } catch {}
}
// Migrate the old payments-specific flag to the generic scheme.
(function migrateColumnFlags() {
  try {
    if (localStorage.getItem('lumen-supabase-payments-column') === 'missing') {
      localStorage.setItem('lumen-supabase-missing-payments', '1');
      localStorage.removeItem('lumen-supabase-payments-column');
    }
  } catch {}
})();
// If `error` is a missing-column error for one of our optional columns (and
// that column is still enabled), return its name; otherwise null. Postgres
// undefined-column is SQLSTATE 42703.
function missingOptionalOrderColumn(error) {
  if (!error) return null;
  const msg = String(error.message || '').toLowerCase();
  const code = String(error.code || '');
  if (code !== '42703' && !msg.includes('column')) return null;
  for (const col of ALL_OPTIONAL_COLUMNS) {
    if (orderColumnAvailable(col) && msg.includes(col)) return col;
  }
  return null;
}

function setCloudStatus(kind, text) {
  const el = $('#cloudStatus');
  const t = $('#cloudStatusText');
  if (!el || !t) return;
  el.classList.remove('online', 'offline', 'syncing');
  if (kind) el.classList.add(kind);
  t.textContent = text;
}

// Ids of stock rows that came back from Supabase without a stored category —
// they predate the column, so `fromRow` gave them a name-based guess. Recorded
// on fetch and written back once by backfillStockCategories() below.
let pendingCategoryBackfill = [];

// Persist the guessed categories for those rows, so every device agrees on the
// split and a manual override has a stored value to replace. Runs at most once
// per fetch: after the write the rows come back with a category and drop out.
function backfillStockCategories() {
  const ids = pendingCategoryBackfill;
  pendingCategoryBackfill = [];
  if (!sb || !ids.length || !orderColumnAvailable('category')) return;
  const rows = state.stock.filter(p => ids.includes(p.id));
  if (rows.length) cloudUpsertMany('stock', rows);
}

async function cloudFetchAll() {
  if (!sb) throw new Error('Supabase not configured');
  const [stock, orders, shipments, expenses, customers] = await Promise.all([
    sb.from('stock').select('*'),
    sb.from('orders').select('*'),
    sb.from('shipments').select('*'),
    sb.from('expenses').select('*'),
    // Customers is optional — if the table doesn't exist yet we just ignore
    // the error and treat it as an empty set. The app still functions; the
    // user just won't get cross-device sync of customer profiles until they
    // run the `create table customers …` SQL.
    sb.from('customers').select('*').then(r => r, err => ({ data: [], error: err })),
  ]);
  for (const r of [stock, orders, shipments, expenses]) {
    if (r.error) throw r.error;
  }
  const customerRows = (customers && !customers.error && Array.isArray(customers.data))
    ? customers.data
    : [];
  pendingCategoryBackfill = stock.data
    .filter(r => !CATEGORY_KEYS.includes(r.category))
    .map(r => r.id);
  return {
    stock: migrateStock(stock.data.map(Adapters.stock.fromRow)),
    orders: migrateOrders(orders.data.map(Adapters.orders.fromRow)),
    shipments: migrateShipments(shipments.data.map(Adapters.shipments.fromRow)),
    expenses: migrateExpenses(expenses.data.map(Adapters.expenses.fromRow)),
    customers: migrateCustomers(customerRows.map(Adapters.customers.fromRow)),
  };
}

async function cloudPushAll(s) {
  if (!sb) return;
  const tables = [
    ['stock', s.stock],
    ['orders', s.orders],
    ['shipments', s.shipments],
    ['expenses', s.expenses],
    ['customers', s.customers],
  ];
  for (const [t, items] of tables) {
    for (let i = 0; i < (items || []).length; i += 200) {
      const slice = items.slice(i, i + 200);
      // Retry while Supabase reports a missing optional column — drop it and
      // try again (up to once per optional column).
      let attempts = ALL_OPTIONAL_COLUMNS.length + 1;
      while (attempts-- > 0) {
        const { error } = await sb.from(t).upsert(slice.map(Adapters[t].toRow));
        if (!error) break;
        // If the customers TABLE doesn't exist yet, skip silently — the app
        // still works locally; user can add the table when ready.
        if (t === 'customers' && error && (
              /relation .* does not exist/i.test(String(error.message || '')) ||
              error.code === '42P01'
            )) {
          break;
        }
        const col = missingOptionalOrderColumn(error);
        if (col && attempts > 0) { markOrderColumnMissing(col); continue; }
        throw error;
      }
    }
  }
}

// Upsert with automatic recovery from missing optional `orders` columns: if the
// write fails because Supabase doesn't have a column (payments / discount), we
// drop that column and retry. Data stays cached locally and syncs once the
// column is added. `cb(error)` runs with the final error (or null on success).
function upsertWithColumnRetry(table, items, attemptsLeft, cb) {
  sb.from(table).upsert(items.map(Adapters[table].toRow)).then(({ error }) => {
    if (error && attemptsLeft > 0) {
      const col = missingOptionalOrderColumn(error);
      if (col) {
        markOrderColumnMissing(col);
        toast(`Tip: add a \`${col}\` column to Supabase so it syncs to the cloud.`);
        upsertWithColumnRetry(table, items, attemptsLeft - 1, cb);
        return;
      }
    }
    // Tolerate the customers TABLE not existing yet — local cache still works
    // and the app should keep functioning without scary errors.
    if (error && table === 'customers' && (
          /relation .* does not exist/i.test(String(error.message || '')) ||
          error.code === '42P01'
        )) {
      cb(null);
      return;
    }
    cb(error || null);
  });
}

function cloudUpsert(table, item) {
  if (!sb) return;
  setCloudStatus('syncing', 'Syncing…');
  upsertWithColumnRetry(table, [item], ALL_OPTIONAL_COLUMNS.length, (error) => {
    if (error) {
      console.error('cloud upsert failed', { table, item, error });
      setCloudStatus('offline', 'Sync error');
      toast(`Cloud save failed: ${error.message}`);
    } else {
      setCloudStatus('online', 'Synced');
    }
  });
}
function cloudUpsertMany(table, items) {
  if (!sb || !items.length) return;
  setCloudStatus('syncing', 'Syncing…');
  upsertWithColumnRetry(table, items, ALL_OPTIONAL_COLUMNS.length, (error) => {
    if (error) {
      console.error('cloud upsertMany failed', { table, count: items.length, error });
      setCloudStatus('offline', 'Sync error');
      toast(`Cloud save failed: ${error.message}`);
    } else {
      setCloudStatus('online', 'Synced');
    }
  });
}
function cloudDelete(table, id) {
  if (!sb) return;
  setCloudStatus('syncing', 'Syncing…');
  // .select() returns the deleted rows so we can verify something was actually removed
  sb.from(table).delete().eq('id', id).select().then(({ data, error }) => {
    if (error) {
      console.error('cloud delete failed', { table, id, error });
      setCloudStatus('offline', 'Sync error');
      toast(`Cloud delete failed: ${error.message}`);
      return;
    }
    if (!data || data.length === 0) {
      console.warn('cloud delete: no row matched', { table, id });
      setCloudStatus('online', 'Synced');
      toast(`No matching row in cloud (id ${id}). Try Sync now.`);
      return;
    }
    console.log('cloud delete OK', { table, id, count: data.length });
    setCloudStatus('online', 'Synced');
  });
}

// Merge cloud orders with the local cache, preferring the local `payments`
// array whenever the cloud row's payments are missing/empty. This protects
// against two scenarios:
//   1. The Supabase `orders` table doesn't have a `payments` column yet, so
//      cloud reads always return `payments: []`. Without this merge a refresh
//      would silently wipe every partial payment.
//   2. Transient sync ordering where the cloud row pre-dates the latest local
//      payment update.
// We re-derive `paid` after merging so the boolean stays consistent.
function mergeCloudOrders(cloudOrders) {
  const localById = new Map((state.orders || []).map(o => [o.id, o]));
  return cloudOrders.map(o => {
    const local = localById.get(o.id);
    const cloudHasPayments = Array.isArray(o.payments) && o.payments.length > 0;
    if (!cloudHasPayments && local && Array.isArray(local.payments) && local.payments.length) {
      const merged = { ...o, payments: local.payments };
      syncOrderPaidFlag(merged);
      // Never DOWNGRADE a cloud-confirmed paid flag. The cloud `paid` column is
      // authoritative even when the payments column is missing/unsynced — so an
      // order marked Paid (e.g. on another device) that only has a partial
      // payment cached locally stays paid instead of flipping back to unpaid.
      if (o.paid) {
        merged.paid = true;
        // If the local payments don't cover the total, top them up with a
        // synthesized balance payment so the books reconcile with the paid flag.
        const bal = round2(orderTotal(merged) - orderPaymentsTotal(merged));
        if (bal > 0.005) {
          merged.payments = [...merged.payments, { id: uid('p'), amount: bal, date: o.date || todayISO(), method: '', note: '' }];
        }
      }
      return merged;
    }
    return o;
  });
}

async function initCloud() {
  if (!sb) { setCloudStatus('offline', 'No cloud configured'); return; }
  setCloudStatus('syncing', 'Loading from cloud…');
  try {
    const cloud = await cloudFetchAll();
    const cloudEmpty = !cloud.stock.length && !cloud.orders.length && !cloud.shipments.length && !cloud.expenses.length;
    const localHasData = state.orders.length > 0 || state.stock.length > 0;
    if (cloudEmpty && localHasData) {
      setCloudStatus('syncing', 'Uploading local data…');
      await cloudPushAll(state);
      toast('Local data uploaded to Supabase.');
    } else if (!cloudEmpty) {
      cloud.orders = mergeCloudOrders(cloud.orders);
      state = { ...state, ...cloud };
      saveState();
      // Cloud rows can carry spellings this device has never seen, so tidy
      // them before the first paint and push the corrections back up.
      normalizeVendorNames({ push: true, announce: true });
      renderAll();
      backfillStockCategories();
    }
    setCloudStatus('online', 'Synced');
  } catch (err) {
    console.error('initCloud failed', err);
    setCloudStatus('offline', 'Offline (using cache)');
    toast('Cloud unavailable — using local cache.');
  }
}

async function manualSync() {
  if (!sb) { toast('No cloud configured.'); return; }
  setCloudStatus('syncing', 'Syncing…');
  try {
    const cloud = await cloudFetchAll();
    cloud.orders = mergeCloudOrders(cloud.orders);
    state = { ...state, ...cloud };
    saveState();
    renderAll();
    backfillStockCategories();
    setCloudStatus('online', 'Synced');
    toast('Pulled latest from cloud.');
  } catch (err) {
    console.error(err);
    setCloudStatus('offline', 'Sync error');
    toast('Sync failed: ' + (err.message || 'unknown'));
  }
}

function resetState() {
  if (!confirm('Reset all data back to the seed (Excel) data? This will erase any changes.')) return;
  state = JSON.parse(JSON.stringify(window.SEED_DATA));
  saveState();
  renderAll();
  toast('Data reset to seed.');
}

// ---------- Helpers ----------
// Whole dollars everywhere — totals, KPIs, invoice lines, exports. The user
// works in whole dollars (no cents) so the display rounds at format time so a
// stray fractional cent from floating-point math never surfaces.
// "Hide numbers" mode — for showing the app to someone without revealing
// dollar figures. Every money value goes through fmt$, so masking there covers
// the whole UI; margins are masked via fmtPct. Remembered per device.
const HIDE_NUMBERS_KEY = 'lumen-hide-numbers';
let hideNumbers = false;
try { hideNumbers = localStorage.getItem(HIDE_NUMBERS_KEY) === '1'; } catch (e) {}
const MASK = '•••';
const fmt$ = (n) => {
  if (hideNumbers) return '$' + MASK;
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US');
};
const fmtN = (n) => Number(n || 0).toLocaleString('en-US');
const fmtPct = (n) => hideNumbers ? MASK + '%' : (Number(n) || 0).toFixed(1) + '%';
const uid = (p) => p + '-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
// Snap a value to whole cents — defends against floating-point noise like
// 0.1 + 0.2 = 0.30000000000000004 that would otherwise surface in pending
// totals as $225.02 when the user only typed whole-dollar amounts.
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
// Local-time YYYY-MM-DD. `Date.toISOString()` is UTC, so using it for "today"
// rolls the day forward in evening hours west of UTC and we'd show tomorrow's
// data. These getters read the device's local calendar date instead.
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthKey = (iso) => (iso || '').slice(0, 7); // YYYY-MM
// Compact "M/D" formatter (no zero-padding) for table date columns. Falls back
// to whatever was passed if the input isn't a YYYY-MM-DD ISO string.
const fmtDateShort = (iso) => {
  if (!iso || typeof iso !== 'string' || iso.length < 10) return iso || '';
  const [, m, d] = iso.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
};
// Long human-readable format for the invoice (e.g. "May 5, 2026"). Built from
// local components so we don't accidentally roll into UTC the way `new Date(iso)`
// would for naked ISO date strings.
const fmtDateLong = (iso) => {
  if (!iso || typeof iso !== 'string' || iso.length < 10) return iso || '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
};
const monthName = (iso) => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
};
// Calendar months + leftover days between two dates. Borrows days from the
// previous month when the end-of-month day-number is smaller than the start —
// matches how people intuitively count "X months and Y days".
function monthsAndDaysBetween(startIso, endIso) {
  if (!startIso || !endIso) return { months: 0, days: 0 };
  const s = new Date(startIso + 'T00:00:00');
  const e = new Date(endIso + 'T00:00:00');
  if (e < s) return { months: 0, days: 0 };
  let months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  let days = e.getDate() - s.getDate();
  if (days < 0) {
    months -= 1;
    days += new Date(e.getFullYear(), e.getMonth(), 0).getDate();
  }
  if (months < 0) months = 0;
  return { months, days };
}
function formatMonthsDays(months, days) {
  if (months <= 0 && days <= 0) return '0 days';
  const parts = [];
  if (months > 0) parts.push(`${months} month${months === 1 ? '' : 's'}`);
  if (days > 0 || months === 0) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  return parts.join(', ');
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2000);
}

// Per-order computed values (sums across all line items + shipping charge)
function orderItems(o) { return Array.isArray(o.items) ? o.items : []; }
function orderShipping(o) { return Number(o && o.shipping) || 0; }
// Items-only revenue (excluding shipping / discount). Invoice subtotal line.
function orderItemsTotal(o) {
  return orderItems(o).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
}
// Per-line gross (qty × price) before any line or order discount.
function itemLineSubtotal(it) {
  return (Number(it && it.qty) || 0) * (Number(it && it.price) || 0);
}
// Per-line discount — either a dollar amount PER UNIT or a percent of the
// line subtotal, depending on the user's pick. Schema is { type, value } | null.
// Dollar discounts multiply by quantity: "$5 off" on a qty-4 line = $20 off,
// so a per-unit deal reads the same no matter how many the customer buys.
// Legacy entries stored a bare number — treat those as per-unit dollars too.
// Always rounds UP to whole dollars (whole-dollar policy) and is capped at
// the line subtotal.
function itemDiscountAmount(it) {
  if (!it) return 0;
  const d = it.discount;
  let type = 'amount', value = 0;
  if (typeof d === 'number') {
    value = d;
  } else if (d && typeof d === 'object') {
    type = d.type === 'percent' ? 'percent' : 'amount';
    value = Number(d.value) || 0;
  }
  if (value <= 0) return 0;
  const base = itemLineSubtotal(it);
  const qty = Number(it.qty) || 0;
  const raw = type === 'percent' ? (base * value / 100) : value * qty;
  return Math.min(base, Math.max(0, Math.ceil(raw - 1e-9)));
}
// Per-line net (qty × price − line discount) — used everywhere the customer-
// facing line total appears, including the invoice and order summary.
function itemLineTotal(it) {
  return itemLineSubtotal(it) - itemDiscountAmount(it);
}
function orderItemDiscountsTotal(o) {
  return orderItems(o).reduce((s, it) => s + itemDiscountAmount(it), 0);
}
// Subtotal of the items eligible for the order-level discount. Items flagged
// `excludeDiscount` are left out of the base. Per-line discounts are subtracted
// FIRST so the order-level discount stacks on top of any line-level discount.
function orderDiscountableSubtotal(o) {
  return orderItems(o).reduce(
    (s, it) => (it && it.excludeDiscount ? s : s + itemLineTotal(it)),
    0
  );
}
// Discount applied to the eligible items subtotal (shipping and any excluded
// items are never discounted). `discount` is { type:'percent'|'amount', value }.
// The resolved discount ALWAYS rounds UP to a whole dollar — 8% of $80 = $6.40
// → $7, and even a flat $6.20 → $7 — so the books stay on round numbers. Never
// exceeds the eligible subtotal. The 1e-9 epsilon keeps an exact whole-dollar
// result (e.g. 6.00000001 from float math) from jumping to the next dollar.
function orderDiscountAmount(o) {
  const d = o && o.discount;
  const value = Number(d && d.value) || 0;
  if (!d || value <= 0) return 0;
  const base = orderDiscountableSubtotal(o);
  const raw = d.type === 'percent' ? (base * value / 100) : value;
  const amt = Math.ceil(raw - 1e-9);
  return Math.min(base, Math.max(0, amt));
}
// Total the customer pays = items gross − line discounts − order discount +
// shipping. Shipping is collected so it counts as revenue everywhere.
function orderTotal(o) {
  return orderItemsTotal(o) - orderItemDiscountsTotal(o) - orderDiscountAmount(o) + orderShipping(o);
}
// Profit = item profit − line discounts − order discount + shipping. Discounts
// come straight off the bottom line (COGS is fixed); shipping is pass-through.
function orderProfit(o) {
  const itemsProfit = orderItems(o).reduce((s, it) => s + ((Number(it.price) || 0) - (Number(it.cogs) || 0)) * (Number(it.qty) || 0), 0);
  return itemsProfit - orderItemDiscountsTotal(o) - orderDiscountAmount(o) + orderShipping(o);
}
function orderQty(o) {
  return orderItems(o).reduce((s, it) => s + (Number(it.qty) || 0), 0);
}
// Partial-payment accounting. `payments` is an array of { id, amount, date, method, note }.
// Sum represents how much the customer has actually paid. The boolean `o.paid`
// is kept in sync — true iff sum >= total (within a 0.5¢ epsilon for rounding).
function orderPayments(o) { return Array.isArray(o && o.payments) ? o.payments : []; }
function orderPaymentsTotal(o) {
  return orderPayments(o).reduce((s, p) => s + (Number(p && p.amount) || 0), 0);
}
function orderBalance(o) {
  return Math.max(0, orderTotal(o) - orderPaymentsTotal(o));
}
function orderIsFullyPaid(o) {
  const total = orderTotal(o);
  // Treat $0 orders with no items as not-paid (avoid revenue inflation).
  if (total <= 0) return false;
  return orderPaymentsTotal(o) >= total - 0.005;
}
function orderIsPartiallyPaid(o) {
  return orderPaymentsTotal(o) > 0.005 && !orderIsFullyPaid(o);
}
// Revenue recognized in cash terms — paid amount capped at the order total
// (defends against an over-payment data error inflating books).
function orderPaidRevenue(o) {
  return Math.min(orderPaymentsTotal(o), orderTotal(o));
}
// All-or-nothing profit recognition. The instant an order is marked Paid, its
// full profit lands in the dashboard's Gross Profit / True Net Profit; while
// it sits unpaid (or partially paid) the full profit waits in Pending Net.
// Rounded to whole dollars per order so legacy fractional-cent prices can't
// bleed into dashboard totals.
//
// We honor BOTH signals: the persisted `o.paid` flag (what every row toggle and
// the orders table show the user) AND the payments-derived orderIsFullyPaid().
// Trusting `o.paid` keeps the KPI consistent with the UI even if some path
// flipped the flag without keeping the payments array exactly in sync.
//
//   For David: $410 total, $207 profit, $200 paid (not fully paid).
//     paid profit   = $0      (profit hasn't landed yet)
//     unpaid profit = $207    (full profit still pending)
function orderHasLandedProfit(o) {
  return !!o && (o.paid === true || orderIsFullyPaid(o));
}
// The day an order became fully paid — the latest non-zero payment date once
// payments have caught up to the total. Used by the monthly calendar to attribute
// profit / item count to the day the order actually closed (so partial-payment
// orders only "land" their profit when the last dollar comes in). Returns null
// for orders that are still partially or fully unpaid.
// Short customer-facing invoice number for an order — same derivation the
// invoice itself uses (last 6 chars of the order id, uppercase). Searching
// for this in the orders page populates the exact order it came from.
function invoiceNumberForOrder(o) {
  if (!o || !o.id) return '';
  return String(o.id).replace(/^o-/i, '').slice(-6).toUpperCase();
}
function orderCompletionDate(o) {
  if (!orderHasLandedProfit(o)) return null;
  const dates = orderPayments(o)
    .filter(p => p && p.date && (Number(p.amount) || 0) > 0.005)
    .map(p => p.date)
    .sort();
  return dates.length ? dates[dates.length - 1] : (o.date || null);
}
function orderPaidProfit(o) {
  return orderHasLandedProfit(o) ? Math.round(orderProfit(o)) : 0;
}
function orderUnpaidProfit(o) {
  return orderHasLandedProfit(o) ? 0 : Math.round(orderProfit(o));
}
// Source-of-truth for the boolean `paid` flag. Called any time payments mutate
// so existing code (cloud sync, KPIs, inventory deduction) sees a coherent state.
function syncOrderPaidFlag(o) {
  o.paid = orderIsFullyPaid(o);
}
// Shortcut for the row-level / group-level Paid toggle. Checking the toggle
// tops payments up to the full balance (dated today); unchecking it clears
// every payment so the order reverts to "Unpaid". Granular control still lives
// in the order modal's Payments section.
function setOrderFullyPaid(o, fullyPaid) {
  if (!Array.isArray(o.payments)) o.payments = [];
  if (fullyPaid) {
    const balance = round2(Math.max(0, orderTotal(o) - orderPaymentsTotal(o)));
    if (balance > 0.005) {
      o.payments.push({
        id: uid('p'),
        amount: balance,
        date: todayISO(),
        method: '',
        note: '',
      });
    }
  } else {
    o.payments = [];
  }
  syncOrderPaidFlag(o);
}
// Inventory consumption rule: an order only counts against stock once it is
// BOTH fully paid AND marked delivered. Partial payments and pending deliveries
// leave stock untouched. The per-order `inventoryApplied` flag tracks whether
// the deduction is currently in place so toggles stay idempotent and consistent
// across devices (synced via the optional `inventory_applied` column).
function orderConsumesInventory(o) {
  return !!(o && o.paid && o.delivered);
}
// Apply / undo the inventory delta for an order so its actual deduction state
// matches the rule. No-op when already in sync. Returns the touched stock items
// (callers push them to the cloud).
function reconcileOrderInventory(o) {
  if (!o) return [];
  const want = orderConsumesInventory(o);
  if (want === !!o.inventoryApplied) return [];
  const touched = applyOrderInventoryDelta(o.items, want ? -1 : +1);
  o.inventoryApplied = want;
  return touched;
}
// Render a single line-item as a pill (for the 1-item case in any items column).
function itemPill(it) {
  if (!it) return '<span class="muted">No items</span>';
  return `<span class="item-pill"><span class="ip-name">${escapeHtml(it.product || '')}</span><span class="ip-qty">×${fmtN(it.qty || 0)}</span></span>`;
}
// Render an items column for a record: pill if 1 item, "N items" badge otherwise.
function itemsCellInline(items) {
  if (!items || !items.length) return '<span class="muted">No items</span>';
  if (items.length === 1) return itemPill(items[0]);
  return `<span class="grp-badge">${items.length} items</span>`;
}

// ---------- Navigation ----------
$$('.nav-item').forEach(b => {
  b.addEventListener('click', () => switchView(b.dataset.view));
});
$$('[data-view]').forEach(el => {
  if (el.classList.contains('nav-item')) return;
  el.addEventListener('click', () => switchView(el.dataset.view));
});

// Detect iOS standalone (home-screen PWA) mode. In standalone mode we
// AGGRESSIVELY avoid any custom touch/focus handling because iOS treats the
// standalone webview's input/keyboard activation very strictly — any
// document-level touch handler, hidden focusable element, or programmatic
// focus chain can silently prevent the on-screen keyboard from appearing.
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_STANDALONE =
  (typeof navigator.standalone === 'boolean' && navigator.standalone === true) ||
  (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
  (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches);
const IS_IOS_PWA = IS_IOS && IS_STANDALONE;

// iOS Safari (in a regular tab) sometimes loses the user-gesture association
// when we focus a freshly-appended input. The helper-focus trick fixes that —
// but ONLY in a regular Safari tab. In iOS standalone PWA mode it can backfire,
// so we fall back to plain native focus() there. Plain native focus from a
// click handler is the most reliable path in standalone mode.
let __kbdHelper = null;
function ensureKeyboardHelper() {
  if (__kbdHelper) return __kbdHelper;
  __kbdHelper = document.createElement('input');
  __kbdHelper.type = 'text';
  __kbdHelper.setAttribute('aria-hidden', 'true');
  __kbdHelper.tabIndex = -1;
  __kbdHelper.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;' +
    'border:0;padding:0;margin:0;font-size:16px;z-index:-1;' +
    'transform:translateZ(0);pointer-events:none;';
  document.body.appendChild(__kbdHelper);
  return __kbdHelper;
}
function focusForKeyboard(targetInput) {
  if (!targetInput) return;
  // Desktop / Android → plain focus, no helper games.
  if (!IS_IOS) {
    targetInput.focus();
    return;
  }
  // iOS (both Safari and standalone PWA) — use the helper-focus-transfer
  // dance so the on-screen keyboard reliably appears when focusing a row
  // that was just appended to the DOM.
  const helper = ensureKeyboardHelper();
  helper.focus();
  void targetInput.offsetHeight;
  setTimeout(() => {
    try { targetInput.focus(); } catch {}
  }, 0);
}

// Custom typeahead — replaces native <datalist> on text inputs where Chromium's
// "suggestions don't filter while typing until you click the field again" quirk
// was breaking the flow. Renders a fixed-position dropdown anchored under the
// input, filters on every keystroke, supports arrow-key navigation + Enter
// to pick. getOptions() is called fresh each time so the list stays current
// even if the underlying state changes mid-modal.
function attachTypeahead(input, getOptions) {
  if (!input) return;
  // Strip any native datalist binding so the two suggestion UIs don't both fire.
  input.removeAttribute('list');
  input.setAttribute('autocomplete', 'off');
  const dropdown = document.createElement('div');
  dropdown.className = 'typeahead-dropdown';
  dropdown.hidden = true;
  document.body.appendChild(dropdown);
  let activeIdx = -1;
  let currentOpts = [];
  const position = () => {
    const r = input.getBoundingClientRect();
    dropdown.style.left = r.left + 'px';
    dropdown.style.top = (r.bottom + 2) + 'px';
    dropdown.style.width = r.width + 'px';
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const all = (typeof getOptions === 'function' ? getOptions() : []) || [];
    const seen = new Set();
    const uniq = [];
    for (const n of all) {
      const key = String(n || '').trim();
      if (!key) continue;
      const lc = key.toLowerCase();
      if (seen.has(lc)) continue;
      seen.add(lc); uniq.push(key);
    }
    currentOpts = (q ? uniq.filter(n => n.toLowerCase().includes(q)) : uniq).slice(0, 8);
    if (!currentOpts.length) { dropdown.hidden = true; return; }
    dropdown.innerHTML = currentOpts.map((n, i) =>
      `<div class="typeahead-item${i === activeIdx ? ' active' : ''}" data-i="${i}">${escapeHtml(n)}</div>`
    ).join('');
    position();
    dropdown.hidden = false;
  };
  const pick = (i) => {
    if (i < 0 || i >= currentOpts.length) return;
    input.value = currentOpts[i];
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    dropdown.hidden = true;
    activeIdx = -1;
    input.blur();
  };
  // Suggestions must NOT appear on programmatic focus (the order modal
  // auto-focuses the customer field on open, which popped the list on
  // mobile before the user touched anything). Track real user intent:
  // a pointer press on the field or actual typing opens the list;
  // .focus() called from code does not.
  let userIntent = false;
  input.addEventListener('pointerdown', () => { userIntent = true; });
  input.addEventListener('input', () => { userIntent = true; activeIdx = -1; render(); });
  input.addEventListener('focus', () => {
    if (!userIntent) return;
    activeIdx = -1;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (dropdown.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      render();
      return;
    }
    if (dropdown.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(currentOpts.length - 1, activeIdx + 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(-1, activeIdx - 1);
      render();
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      pick(activeIdx);
    } else if (e.key === 'Escape') {
      dropdown.hidden = true;
    }
  });
  input.addEventListener('blur', () => {
    userIntent = false;
    // Defer so a click on a dropdown item can fire before we hide.
    setTimeout(() => { dropdown.hidden = true; }, 150);
  });
  // mousedown fires before blur, so preventDefault keeps focus on the input
  // long enough for us to commit the pick.
  dropdown.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const item = e.target.closest('[data-i]');
    if (item) pick(Number(item.dataset.i));
  });
  const onScroll = () => { if (!dropdown.hidden) position(); };
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  // Self-clean when the input leaves the DOM (modal closed).
  const observer = new MutationObserver(() => {
    if (!document.body.contains(input)) {
      dropdown.remove();
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

const VIEW_STORAGE_KEY = 'lumen-tracker-view';
const VALID_VIEWS = ['dashboard', 'orders', 'customers', 'inventory', 'shipments', 'expenses', 'income', 'monthly'];

function switchView(name) {
  if (!VALID_VIEWS.includes(name)) name = 'dashboard';
  $$('.view').forEach(v => v.classList.remove('active'));
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  $('#view-' + name).classList.add('active');
  $$('.nav-item').forEach(n => { if (n.dataset.view === name) n.classList.add('active'); });
  try { localStorage.setItem(VIEW_STORAGE_KEY, name); } catch (e) {}
  if (name === 'dashboard') renderDashboard();
  if (name === 'orders') renderOrders();
  if (name === 'customers') renderCustomers();
  if (name === 'inventory') renderInventory();
  if (name === 'shipments') renderShipments();
  if (name === 'expenses') renderExpenses();
  if (name === 'income') renderIncome();
  if (name === 'monthly') renderMonthly();
}

function restoreLastView() {
  let saved;
  try { saved = localStorage.getItem(VIEW_STORAGE_KEY); } catch (e) {}
  if (saved && VALID_VIEWS.includes(saved) && saved !== 'dashboard') switchView(saved);
}

// ---------- Modal ----------
const modal = $('#modal');
let modalOnSave = null;
function openModal(title, fields, onSave, initial = {}) {
  $('#modalTitle').textContent = title;
  const form = $('#modalForm');
  form.innerHTML = '';
  fields.forEach(f => {
    if (f.type === 'row') {
      const row = document.createElement('div');
      row.className = 'row-2';
      f.fields.forEach(sub => row.appendChild(buildField(sub, initial)));
      form.appendChild(row);
    } else {
      form.appendChild(buildField(f, initial));
    }
  });
  modalOnSave = () => {
    const data = {};
    fields.flatMap(f => f.type === 'row' ? f.fields : [f]).forEach(f => {
      const el = form.querySelector(`[name="${f.name}"]`);
      if (!el) return;
      if (f.type === 'checkbox') data[f.name] = el.checked;
      else if (f.type === 'number') data[f.name] = el.value === '' ? null : Number(el.value);
      else data[f.name] = el.value;
    });
    if (onSave(data) !== false) closeModal();
  };
  showModal();
  setTimeout(() => form.querySelector('input,select,textarea')?.focus(), 50);
}
function buildField(f, initial) {
  const lbl = document.createElement('label');
  if (f.type !== 'checkbox') {
    const span = document.createElement('span');
    span.textContent = f.label;
    if (f.required) span.classList.add('req');
    lbl.appendChild(span);
  }
  let el;
  if (f.type === 'select') {
    el = document.createElement('select');
    f.options.forEach(o => {
      const opt = document.createElement('option');
      opt.value = typeof o === 'object' ? o.value : o;
      opt.textContent = typeof o === 'object' ? o.label : o;
      el.appendChild(opt);
    });
    el.value = initial[f.name] ?? f.default ?? '';
  } else if (f.type === 'checkbox') {
    lbl.classList.add('check-row');
    el = document.createElement('input');
    el.type = 'checkbox';
    el.checked = !!initial[f.name];
    lbl.appendChild(el);
    const span = document.createElement('span');
    span.textContent = f.label;
    lbl.appendChild(span);
  } else if (f.type === 'textarea') {
    el = document.createElement('textarea');
    el.rows = 3;
    el.value = initial[f.name] ?? '';
  } else {
    el = document.createElement('input');
    el.type = f.type || 'text';
    if (f.type === 'number') { el.step = f.step ?? 'any'; if (f.min != null) el.min = f.min; }
    el.value = initial[f.name] ?? f.default ?? '';
    if (f.placeholder) el.placeholder = f.placeholder;
  }
  el.name = f.name;
  if (f.required) el.required = true;
  if (f.type !== 'checkbox') lbl.appendChild(el);
  return lbl;
}
// Lock body scroll while a modal is open. Uses position:fixed so iOS Safari
// doesn't fall back to letting touch-scroll the underlying content. Stores the
// scroll position so it can be restored when the modal closes.
let __savedScrollY = 0;
function lockBodyScroll() {
  if (document.body.classList.contains('modal-open')) return;
  __savedScrollY = window.scrollY;
  document.body.style.top = `-${__savedScrollY}px`;
  document.body.classList.add('modal-open');
}
function unlockBodyScroll() {
  if (!document.body.classList.contains('modal-open')) return;
  document.body.classList.remove('modal-open');
  document.body.style.top = '';
  window.scrollTo(0, __savedScrollY);
}
function showModal() { modal.classList.add('open'); lockBodyScroll(); }
function closeModal() {
  modal.classList.remove('open');
  // Reset any read-only popup styling so the next regular modal opens with the
  // standard Save/Cancel button setup.
  modal.classList.remove('modal-readonly');
  $('#modalCancel').textContent = 'Cancel';
  modalOnSave = null;
  unlockBodyScroll();
}
$('#modalClose').addEventListener('click', closeModal);
$('#modalCancel').addEventListener('click', closeModal);
$('#modalSave').addEventListener('click', () => modalOnSave && modalOnSave());
// Backdrop dismiss only fires when the user BOTH presses down and clicks on
// the backdrop. Without this guard, dragging out of an input (e.g. selecting
// text in a number field, or releasing a slider thumb) lands the click on
// the backdrop and closes the modal mid-edit.
let __modalMouseDownOnBackdrop = false;
modal.addEventListener('mousedown', (e) => {
  __modalMouseDownOnBackdrop = (e.target === modal);
});
modal.addEventListener('click', (e) => {
  if (e.target === modal && __modalMouseDownOnBackdrop) closeModal();
  __modalMouseDownOnBackdrop = false;
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.classList.contains('open')) closeModal(); });

// ---------- DASHBOARD ----------
// `readonly` skips paid/delivered toggles (used by the Recently Completed card,
// where everything is paid AND delivered — toggling there would un-complete it).
function renderRecentOrderGroup(g, readonly = false) {
  if (g.orders.length === 1) return renderRecentOrderRow(g.orders[0], readonly);

  const groupId = 'rg_' + (g.customer || '').replace(/\W+/g, '_') + '_' + (g.date || '').replace(/\W+/g, '');
  const totalQty = g.orders.reduce((s, o) => s + orderQty(o), 0);
  const totalAmt = g.orders.reduce((s, o) => s + orderTotal(o), 0);
  const totalLineItems = g.orders.reduce((s, o) => s + orderItems(o).length, 0);
  const allPaid = g.orders.every(o => o.paid);
  // Treat partial-payment orders as mixed so the user sees a "Mixed" pill (and
  // can drill in) instead of an unchecked toggle that misrepresents the state.
  const noPaid = g.orders.every(o => orderPaymentsTotal(o) <= 0.005);
  const allDelivered = g.orders.every(o => o.delivered);
  const noDelivered = g.orders.every(o => !o.delivered);
  const orderIds = g.orders.map(o => o.id).join(',');
  const childFlags = g.orders.map(o => orderStatusFlag(o));
  const aggCls = [
    'group-row',
    childFlags.includes('unpaid')  ? 'has-flag-unpaid'  : '',
    childFlags.includes('pending') ? 'has-flag-pending' : '',
  ].filter(Boolean).join(' ');

  // Toggleable switches when all children share the state, "Mixed" pill otherwise.
  // Empty cells in readonly mode (Recently Completed table — those columns are CSS-hidden anyway).
  const paidCell = readonly ? '' : (allPaid || noPaid)
    ? `<label class="switch"><input type="checkbox" data-group-paid="${orderIds}" ${allPaid ? 'checked' : ''} /><span class="slider"></span></label>`
    : `<span class="pill mixed" data-expand-group="${groupId}" title="Mixed — expand to see each">Mixed</span>`;
  const deliveredCell = readonly ? '' : (allDelivered || noDelivered)
    ? `<label class="switch"><input type="checkbox" data-group-delivered="${orderIds}" ${allDelivered ? 'checked' : ''} /><span class="slider"></span></label>`
    : `<span class="pill mixed" data-expand-group="${groupId}" title="Mixed — expand to see each">Mixed</span>`;

  const totalProfit = g.orders.reduce((s, o) => s + orderProfit(o), 0);
  // 9-col layout when interactive (last cell is the edit action); 8-col in
  // readonly mode (used by Recently Completed). Group rows have no single
  // editable order — users expand to edit a specific child.
  const groupEditCell = readonly ? '' : `<td></td>`;
  const childColspan = readonly ? 8 : 9;
  let html = `
    <tr class="${aggCls}">
      <td>${fmtDateShort(g.date)}</td>
      <td><b>${escapeHtml(g.customer || '')}</b><span class="customer-sub">${totalLineItems} item${totalLineItems === 1 ? '' : 's'}</span></td>
      <td class="items-cell"><span class="chevron" data-toggle-group="${groupId}">▶</span><span class="grp-badge">${totalLineItems} item${totalLineItems === 1 ? '' : 's'}</span></td>
      <td class="num">${fmtN(totalQty)}</td>
      <td class="num">${fmt$(totalAmt)}</td>
      <td class="num">${fmt$(totalProfit)}</td>
      <td>${paidCell}</td>
      <td>${deliveredCell}</td>
      ${groupEditCell}
    </tr>`;
  html += g.orders.map(o => {
    const flag = orderStatusFlag(o);
    const cls = ['child-row'];
    if (flag) cls.push(`row-flag-${flag}`);
    const childToggles = readonly ? '' : `
          <span class="cs-toggle"><span class="cs-tlabel">Paid</span><label class="switch"><input type="checkbox" data-toggle-paid="${o.id}" ${o.paid ? 'checked' : ''} /><span class="slider"></span></label>${partialPaidPill(o)}</span>
          <span class="cs-toggle"><span class="cs-tlabel">Delivered</span><label class="switch"><input type="checkbox" data-toggle-delivered="${o.id}" ${o.delivered ? 'checked' : ''} /><span class="slider"></span></label></span>
          <span class="cs-actions"><button class="icon-btn" data-edit-order="${o.id}" title="Edit">✎</button></span>`;
    return `
    <tr class="${cls.join(' ')}" data-parent="${groupId}" hidden>
      <td colspan="${childColspan}" class="child-cell">
        <div class="child-strip">
          <span class="cs-label">↳${statusFlagBadge(flag)}</span>
          <span class="cs-items">${itemsCellInline(orderItems(o))}</span>
          <span class="cs-stat"><span class="cs-tlabel">Total</span><b class="cs-stat-total">${fmt$(orderTotal(o))}</b></span>
          <span class="cs-stat"><span class="cs-tlabel">Profit</span><b>${fmt$(orderProfit(o))}</b></span>${childToggles}
        </div>
      </td>
    </tr>`;
  }).join('');
  return html;
}

function renderRecentOrderRow(o, readonly = false) {
  const items = orderItems(o);
  const flag = orderStatusFlag(o);
  const flagCls = flag ? ` row-flag-${flag}` : '';
  // Sub-line below customer name (visible on mobile): product name when single
  // item with qty, "N items" when multi.
  let sub = '';
  if (items.length === 1) {
    const it = items[0];
    sub = `<span class="customer-sub">${escapeHtml(it.product || '')}${(Number(it.qty) || 0) > 0 ? ` ×${fmtN(it.qty)}` : ''}</span>`;
  } else if (items.length > 1) {
    sub = `<span class="customer-sub">${items.length} items</span>`;
  }
  const paidCellTd = readonly ? '<td></td>' : `<td><div class="paid-cell"><label class="switch"><input type="checkbox" data-toggle-paid="${o.id}" ${o.paid ? 'checked' : ''} /><span class="slider"></span></label>${partialPaidPill(o)}</div></td>`;
  const deliveredCellTd = readonly ? '<td></td>' : `<td><label class="switch"><input type="checkbox" data-toggle-delivered="${o.id}" ${o.delivered ? 'checked' : ''} /><span class="slider"></span></label></td>`;
  const editCellTd = readonly ? '' : `<td style="white-space:nowrap;"><button class="icon-btn" data-edit-order="${o.id}" title="Edit">✎</button></td>`;
  const childColspan = readonly ? 8 : 9;
  if (items.length <= 1) {
    return `<tr class="${flagCls.trim()}">
      <td>${fmtDateShort(o.date)}</td>
      <td>${escapeHtml(o.customer || '')}${statusFlagBadge(flag)}${sub}</td>
      <td class="items-cell">${itemsCellInline(items)}</td>
      <td class="num">${fmtN(orderQty(o))}</td>
      <td class="num">${fmt$(orderTotal(o))}</td>
      <td class="num">${fmt$(orderProfit(o))}</td>
      ${paidCellTd}
      ${deliveredCellTd}
      ${editCellTd}
    </tr>`;
  }
  // Multi-item: parent row with chevron, plus child rows for each line item.
  const groupId = 'roi_' + String(o.id || '').replace(/\W+/g, '_');
  let html = `
    <tr class="group-row${flagCls}">
      <td>${fmtDateShort(o.date)}</td>
      <td>${escapeHtml(o.customer || '')}${statusFlagBadge(flag)}${sub}</td>
      <td class="items-cell"><span class="chevron" data-toggle-group="${groupId}">▶</span><span class="grp-badge">${items.length} items</span></td>
      <td class="num">${fmtN(orderQty(o))}</td>
      <td class="num">${fmt$(orderTotal(o))}</td>
      <td class="num">${fmt$(orderProfit(o))}</td>
      ${paidCellTd}
      ${deliveredCellTd}
      ${editCellTd}
    </tr>`;
  html += items.map(it => `
    <tr class="child-row" data-parent="${groupId}" hidden>
      <td colspan="${childColspan}" class="child-cell">
        <div class="child-strip">
          <span class="cs-label">↳</span>
          <span class="cs-items">${itemPill(it)}</span>
          <span class="cs-stat"><span class="cs-tlabel">Total</span><b class="cs-stat-total">${fmt$((Number(it.qty)||0)*(Number(it.price)||0))}</b></span>
          <span class="cs-stat"><span class="cs-tlabel">Profit</span><b>${fmt$(((Number(it.price)||0)-(Number(it.cogs)||0))*(Number(it.qty)||0))}</b></span>
        </div>
      </td>
    </tr>`).join('');
  return html;
}

function renderDashboard() {
  const orders = state.orders;
  // Cash-basis revenue/profit — count the paid portion of every order, including
  // partial payments. The unpaid balance shows up as Pending below. round2()
  // strips floating-point drift that accumulates when summing many orders.
  const grossRevenue = round2(orders.reduce((s, o) => s + orderPaidRevenue(o), 0));
  const grossProfit = round2(orders.reduce((s, o) => s + orderPaidProfit(o), 0));
  const pendingGross = round2(orders.reduce((s, o) => s + orderBalance(o), 0));
  const pendingNet = round2(orders.reduce((s, o) => s + orderUnpaidProfit(o), 0));
  // Operating spend only — capital / owner-funded purchases (the vehicle, and
  // anything else the owner covered personally) get their own KPI so they never
  // distort how the operation itself is performing.
  const opexSum = sumOperating(state.expenses);
  const capexSum = sumCapital(state.expenses);

  // True Net Profit = Gross Profit − Operating Expenses (what actually lands in the business account).
  const trueNetProfit = round2(grossProfit - opexSum);
  // All-In Position folds the owner-funded spend back in — the real cash story.
  const allInPosition = round2(trueNetProfit - capexSum);

  $('#kpiGross').textContent = fmt$(grossRevenue);
  $('#kpiExp').textContent = fmt$(opexSum);
  $('#kpiCapital').textContent = fmt$(capexSum);
  $('#kpiAllIn').textContent = fmt$(allInPosition);
  // Red when the all-in picture is underwater, so "operating at a loss" reads
  // at a glance instead of needing the minus sign to be spotted.
  $('#kpiAllIn').closest('.kpi')?.classList.toggle('is-negative', allInPosition < 0);
  $('#kpiNet').textContent = fmt$(grossProfit);
  $('#kpiNetTrue').textContent = fmt$(trueNetProfit);
  $('#kpiPending').textContent = fmt$(pendingGross);
  $('#kpiPendingNet').textContent = fmt$(pendingNet);

  // "Operating since" pill — anchored to the first fully-completed order
  // (paid + delivered) so it reflects when the business actually started
  // booking real revenue, not just when orders were entered.
  const opEl = $('#operatingSince');
  if (opEl) {
    let firstDate = null;
    for (const o of orders) {
      if (o.paid && o.delivered && o.date && (!firstDate || o.date < firstDate)) firstDate = o.date;
    }
    if (firstDate) {
      const { months, days } = monthsAndDaysBetween(firstDate, todayISO());
      $('#opDuration').textContent = formatMonthsDays(months, days);
      $('#opSince').textContent = `since ${fmtDateLong(firstDate)}`;
      opEl.hidden = false;
    } else {
      opEl.hidden = true;
    }
  }

  // "This Month" card — current calendar month only, with a See more link to the
  // Monthly page. Revenue / Net Profit tiles use cash-basis (paid portion of
  // each order, including partials). The card surfaces whenever there's any
  // activity for the month, even if no order is fully paid yet.
  const curMonthKey = monthKey(todayISO());
  const inMonth = (o) => monthKey(o.date) === curMonthKey;
  const monthOrders = orders.filter(inMonth);
  const monthPending = monthOrders.filter(o => orderBalance(o) > 0.005);
  const monthRev = round2(monthOrders.reduce((s, o) => s + orderPaidRevenue(o), 0));
  const monthNet = round2(monthOrders.reduce((s, o) => s + orderPaidProfit(o), 0));
  const monthLabel = monthName(curMonthKey + '-01');
  const tmCard = $('#thisMonthCard');
  // Keep monthPending in the hasAny check so a month with only pending orders
  // still renders the card (the empty state otherwise reads "no orders yet"
  // which would be misleading when there ARE orders, just none completed).
  const hasAny = monthOrders.length || monthPending.length;
  if (tmCard) {
    tmCard.innerHTML = hasAny
      ? `
        <div class="this-month-head">${monthLabel}</div>
        <div class="this-month-stats">
          <div class="tm-stat tm-stat-revenue"><span class="tm-label">Revenue</span><b>${fmt$(monthRev)}</b></div>
          <div class="tm-stat tm-stat-net"><span class="tm-label">Net Profit</span><b>${fmt$(monthNet)}</b></div>
        </div>
      `
      : `<div class="this-month-head">${monthLabel}</div><div class="muted" style="padding:6px 0;">No orders yet this month.</div>`;
  }

  // "Today" snapshot — orders dated today, regardless of paid/delivered status,
  // so the user sees real-time pulse of the day's activity. Split totals by paid
  // status so the user can see actual revenue vs money still owed.
  const todayKey = todayISO();
  const todayOrders = orders.filter(o => o.date === todayKey);
  const todayPendingOrders = todayOrders.filter(o => orderBalance(o) > 0.005);
  const todayOrderCount = new Set(
    todayOrders.map(o => (o.customer || '').toLowerCase().trim())
  ).size;
  // Today's tiles also follow cash basis: paid portion (incl. partials) on the
  // top row, outstanding balance on the bottom.
  // Cash basis — same model the Monthly calendar uses:
  //   Total Paid    = every payment whose date is today, across every order
  //                   (so a payment received today for an older order counts).
  //   Net Profit    = full profit of every order that became fully paid today
  //                   (all-or-nothing — profit lands on the day the last
  //                   payment lands, matching the monthly view).
  // The pending side stays scoped to orders DATED today since those are the
  // ones whose follow-up work is still on today's plate.
  const todayPaidRev = round2(orders.reduce((sum, o) =>
    sum + orderPayments(o).reduce((s, p) =>
      (p && p.date === todayKey) ? s + (Number(p.amount) || 0) : s, 0), 0));
  const todayPaidNet = round2(orders.reduce((sum, o) =>
    orderCompletionDate(o) === todayKey ? sum + orderProfit(o) : sum, 0));
  const todayPendingRev = round2(todayOrders.reduce((s, o) => s + orderBalance(o), 0));
  const todayPendingNet = round2(todayOrders.reduce((s, o) => s + orderUnpaidProfit(o), 0));
  const todayLabel = fmtDateShort(todayKey);

  // Group today's orders by customer so each customer is one row in To Do /
  // Completed. A customer goes to "Completed" only if ALL their orders today
  // are both paid AND delivered — otherwise they appear in "To Do" with pills
  // showing what's still outstanding.
  const todayCustomers = new Map();
  for (const o of todayOrders) {
    const key = (o.customer || '').toLowerCase().trim();
    if (!todayCustomers.has(key)) {
      todayCustomers.set(key, { name: o.customer || '', total: 0, paid: 0, allPaid: true, allDelivered: true });
    }
    const bucket = todayCustomers.get(key);
    bucket.total += orderTotal(o);
    bucket.paid += orderPaidRevenue(o);   // cap each at orderTotal in case of overpay
    if (!o.paid) bucket.allPaid = false;
    if (!o.delivered) bucket.allDelivered = false;
  }
  const todoList = [];
  const doneList = [];
  for (const c of todayCustomers.values()) {
    if (c.allPaid && c.allDelivered) doneList.push(c);
    else todoList.push(c);
  }

  // Overdue — incomplete orders with a date BEFORE today. Grouped by
  // customer+date so a customer with two outstanding past dates shows as two
  // rows. Sorted oldest first so the most-aged work surfaces at the top.
  const overdueGroupsMap = new Map();
  for (const o of orders) {
    if (o.paid && o.delivered) continue;
    if (!o.date || o.date >= todayKey) continue;
    const ck = (o.customer || '').toLowerCase().trim();
    const key = ck + '|' + o.date;
    if (!overdueGroupsMap.has(key)) {
      overdueGroupsMap.set(key, {
        name: o.customer || '', custKey: ck, date: o.date,
        total: 0, paid: 0, allPaid: true, allDelivered: true,
      });
    }
    const bucket = overdueGroupsMap.get(key);
    bucket.total += orderTotal(o);
    bucket.paid += orderPaidRevenue(o);
    if (!o.paid) bucket.allPaid = false;
    if (!o.delivered) bucket.allDelivered = false;
  }
  const overdueList = [...overdueGroupsMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const daysLate = (iso) => {
    const a = new Date(iso + 'T00:00:00');
    const b = new Date(todayKey + 'T00:00:00');
    return Math.max(0, Math.round((b - a) / 86400000));
  };

  const customerKey = (c) => (c.name || '').toLowerCase().trim();
  // Pills always show both Pay and Send status — green confirms a step is done,
  // amber flags it as still owed. "Send" covers both shipments and in-person
  // deliveries since either way it leaves the user's hands.
  const statusTags = (c) => {
    const paid = Math.max(0, Number(c.paid) || 0);
    const total = Math.max(0, Number(c.total) || 0);
    const balance = Math.max(0, total - paid);
    let pay;
    if (c.allPaid || balance <= 0.005) {
      pay = `<span class="pill green">Paid</span>`;
    } else if (paid > 0.005) {
      pay = `<span class="pill partial" title="${fmt$(round2(paid))} of ${fmt$(round2(total))} paid · ${fmt$(round2(balance))} due">Partial ${fmt$(round2(paid))}</span>`;
    } else {
      pay = `<span class="pill amber">Pay</span>`;
    }
    const send = c.allDelivered
      ? `<span class="pill green">Sent</span>`
      : `<span class="pill amber">Send</span>`;
    return `${pay}${send}`;
  };
  const todoRow = (c) => `<div class="today-row" data-today-customer="${escapeHtml(customerKey(c))}" role="button" tabindex="0">
    <span class="today-name">${escapeHtml(c.name)}</span>
    <span class="today-amount">${fmt$(c.total)}</span>
    <span class="today-tags">${statusTags(c)}</span>
  </div>`;
  const doneRow = (c) => `<div class="today-row today-row-done" data-today-customer="${escapeHtml(customerKey(c))}" role="button" tabindex="0">
    <span class="today-name">${escapeHtml(c.name)}</span>
    <span class="today-amount">${fmt$(c.total)}</span>
    <span class="today-tags">${statusTags(c)}</span>
  </div>`;
  const overdueRow = (c) => {
    const days = daysLate(c.date);
    return `<div class="today-row today-row-overdue" data-today-customer="${escapeHtml(c.custKey)}" data-today-date="${c.date}" role="button" tabindex="0">
      <span class="today-name">${escapeHtml(c.name)}<span class="today-row-date">${fmtDateShort(c.date)} · ${days}d late</span></span>
      <span class="today-amount">${fmt$(c.total)}</span>
      <span class="today-tags">${statusTags(c)}</span>
    </div>`;
  };

  const overdueSectionHtml = overdueList.length ? `
    <div class="today-section today-section-overdue">
      <div class="today-section-head today-section-head-overdue">Overdue <span class="muted">(${overdueList.length})</span></div>
      <div class="today-list">${overdueList.map(overdueRow).join('')}</div>
    </div>
  ` : '';

  const tdCard = $('#todayCard');
  if (tdCard) {
    // Show the stats block whenever there's any cash activity today OR any
    // orders dated today — so a payment collected today for a future-dated
    // order still surfaces under Total Paid / Net Profit Paid.
    const hasCashToday = todayPaidRev > 0.005 || todayPaidNet > 0.005;
    const headSuffix = todayOrders.length
      ? `· ${fmtN(todayOrderCount)} order${todayOrderCount === 1 ? '' : 's'}`
      : (hasCashToday ? `· Payments collected` : `· No orders today`);
    const statsBlock = (todayOrders.length || hasCashToday) ? `
      <div class="this-month-stats">
        <div class="tm-stat tm-stat-revenue"><span class="tm-label">Total Paid</span><b>${fmt$(todayPaidRev)}</b></div>
        <div class="tm-stat tm-stat-net"><span class="tm-label">Net Profit Paid</span><b>${fmt$(todayPaidNet)}</b></div>
        <div class="tm-stat tm-stat-pending"><span class="tm-label">Total Pending</span><b>${fmt$(todayPendingRev)}</b></div>
        <div class="tm-stat tm-stat-pending"><span class="tm-label">Profit Pending</span><b>${fmt$(todayPendingNet)}</b></div>
      </div>
    ` : '';
    if (todayOrders.length) {
      tdCard.innerHTML = `
        <div class="this-month-head">${todayLabel} <span class="muted">${headSuffix}</span></div>
        ${statsBlock}
        ${overdueSectionHtml}
        <div class="today-section">
          <div class="today-section-head">To Do <span class="muted">(${todoList.length})</span></div>
          <div class="today-list">${
            todoList.length
              ? todoList.map(todoRow).join('')
              : `<div class="today-empty">All caught up.</div>`
          }</div>
        </div>
        <div class="today-section">
          <div class="today-section-head">Completed <span class="muted">(${doneList.length})</span></div>
          <div class="today-list">${
            doneList.length
              ? doneList.map(doneRow).join('')
              : `<div class="today-empty">No completed orders yet.</div>`
          }</div>
        </div>
      `;
    } else if (hasCashToday || overdueList.length) {
      // No orders dated today, but either cash came in today or past orders
      // still need attention — surface both so the dashboard doesn't read as
      // "nothing happening" while real activity exists.
      tdCard.innerHTML = `
        <div class="this-month-head">${todayLabel} <span class="muted">${headSuffix}</span></div>
        ${statsBlock}
        ${overdueSectionHtml}
      `;
    } else {
      tdCard.innerHTML = `<div class="this-month-head">${todayLabel}</div><div class="muted" style="padding:6px 0;">No orders today yet.</div>`;
    }
    // Tap a customer row to see what they ordered. Overdue rows include a
    // data-today-date attribute so the popup loads that customer's past orders
    // for the right day instead of defaulting to today.
    tdCard.querySelectorAll('[data-today-customer]').forEach(el => {
      const open = () => openTodayOrderDetail(el.dataset.todayCustomer, el.dataset.todayDate || todayISO());
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }

  // Recently Completed Orders — last 5 customer-day groups across fully completed orders
  // (paid AND delivered). In-flight orders show up under Pending Orders below.
  const completedOrders = orders.filter(o => o.paid && o.delivered);
  const sortedOrders = [...completedOrders].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const recentGroupsMap = new Map();
  for (const o of sortedOrders) {
    const key = (o.customer || '').toLowerCase().trim() + '|' + (o.date || '');
    if (!recentGroupsMap.has(key)) recentGroupsMap.set(key, { customer: o.customer, date: o.date, orders: [] });
    recentGroupsMap.get(key).orders.push(o);
  }
  const recentGroups = [...recentGroupsMap.values()].slice(0, 5);
  const recentBody = $('#recentOrdersBody');
  const recentExpanded = getExpandedGroupIds(recentBody);
  recentBody.innerHTML = recentGroups.map(g => renderRecentOrderGroup(g, true)).join('') ||
    `<tr><td colspan="8" class="muted">No completed orders yet.</td></tr>`;
  restoreGroupExpansion(recentBody, recentExpanded);
  wireGroupExpand(recentBody);

  // Pending orders — anything not fully completed (unpaid OR undelivered).
  // Sorted oldest-first so the user can fulfill them in date order (5/2 before 5/5).
  const incompleteOrders = orders.filter(o => !o.paid || !o.delivered);
  const pendingOrdersList = [...incompleteOrders].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const pendingGroupsMap = new Map();
  for (const o of pendingOrdersList) {
    const key = (o.customer || '').toLowerCase().trim() + '|' + (o.date || '');
    if (!pendingGroupsMap.has(key)) pendingGroupsMap.set(key, { customer: o.customer, date: o.date, orders: [] });
    pendingGroupsMap.get(key).orders.push(o);
  }
  const pendingGroups = [...pendingGroupsMap.values()];
  const pendingBody = $('#pendingOrdersBody');
  const pendingExpanded = getExpandedGroupIds(pendingBody);
  pendingBody.innerHTML = pendingGroups.length
    ? pendingGroups.map(g => renderRecentOrderGroup(g)).join('')
    : `<tr><td colspan="8" class="muted">No pending orders.</td></tr>`;
  restoreGroupExpansion(pendingBody, pendingExpanded);
  wireGroupExpand(pendingBody);
  wireOrderInteractions(pendingBody);
  // Edit now requires explicitly tapping the pencil icon — the tap-anywhere
  // helper was too easy to trigger by accident while scrolling on mobile.
  // Pending header total/profit = outstanding balance only. Paid-but-undelivered
  // orders contribute $0 here (cash already collected); partial orders contribute
  // just the unpaid portion.
  const pendingUnpaidTotal = round2(incompleteOrders.reduce((s, o) => s + orderBalance(o), 0));
  const pendingUnpaidProfit = round2(incompleteOrders.reduce((s, o) => s + orderUnpaidProfit(o), 0));
  const pendingCountEl = $('#pendingOrdersCount');
  pendingCountEl.innerHTML = incompleteOrders.length
    ? `${incompleteOrders.length} pending · <span class="foot-label">Total</span>${fmt$(pendingUnpaidTotal)} · <span class="foot-label">Profit</span>${fmt$(pendingUnpaidProfit)}`
    : '';

  // Reorder alerts — active products at/below their reorder level (out of stock
  // sorts to the top). Each product's level is its own `reorder` value, or a
  // global default when unset. See stockNeedsReorder().
  const low = state.stock.filter(stockNeedsReorder)
    .sort((a, b) => (Number(a.qty) || 0) - (Number(b.qty) || 0));
  const reorderCountEl = $('#reorderCount');
  if (reorderCountEl) reorderCountEl.textContent = low.length ? `${low.length} to reorder` : '';
  $('#lowStock').innerHTML = low.length
    ? low.slice(0, 8).map(p => {
        const q = Number(p.qty) || 0;
        const right = q <= 0 ? `<b class="reorder-out">Out</b>` : `<b>${fmtN(q)} left</b>`;
        return `<li><span>${escapeHtml(p.name)}</span>${right}</li>`;
      }).join('')
    : '<li class="muted">All products well-stocked.</li>';

  // Pending shipments — consolidate by vendor+date OR shared tracking number.
  const pendingShipments = state.shipments
    .filter(s => !s.delivered)
    .sort((a, b) => (b.dateOrdered || '').localeCompare(a.dateOrdered || ''));
  const psGroups = consolidateShipments(pendingShipments).slice(0, 8);
  const pendingShipsEl = $('#pendingShips');
  if (!psGroups.length) {
    pendingShipsEl.innerHTML = '<li class="muted">No pending shipments.</li>';
  } else {
    pendingShipsEl.innerHTML = psGroups.map((g, i) => {
      if (g.shipments.length === 1) {
        const s = g.shipments[0];
        return `<li><span><b>${escapeHtml(s.vendor || '')}</b> <span class="muted">— ${escapeHtml(s.product || '')}</span></span><b>${escapeHtml(String(s.kits || ''))}</b></li>`;
      }
      const groupId = `pds_${i}`;
      const totalKits = g.shipments.reduce((sum, s) => {
        const n = parseInt(s.kits, 10);
        return sum + (Number.isFinite(n) ? n : 0);
      }, 0);
      const headRight = totalKits > 0 ? fmtN(totalKits) : `${g.shipments.length}`;
      const children = g.shipments.map(s =>
        `<li class="ps-child"><span>${escapeHtml(s.product || '')}</span><b>${escapeHtml(String(s.kits || ''))}</b></li>`
      ).join('');
      return `<li class="ps-group">
        <div class="ps-head" data-ps-toggle="${groupId}">
          <span><span class="chevron">▶</span><b>${escapeHtml(g.vendor || '')}</b> <span class="muted">— ${g.shipments.length} items</span></span>
          <b>${headRight}</b>
        </div>
        <ul class="ps-children" data-ps-children="${groupId}" hidden>${children}</ul>
      </li>`;
    }).join('');
    pendingShipsEl.querySelectorAll('[data-ps-toggle]').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.psToggle;
        const chev = el.querySelector('.chevron');
        const child = pendingShipsEl.querySelector(`[data-ps-children="${id}"]`);
        const expanded = chev.classList.toggle('expanded');
        if (child) child.hidden = !expanded;
      });
    });
  }
}

function pillBool(v, yes, no) {
  return v ? `<span class="pill green">${yes}</span>` : `<span class="pill amber">${no}</span>`;
}

// Flag mismatched payment/delivery states so the row stands out.
//   'unpaid'  = delivered but not paid (need to collect payment)
//   'pending' = paid but not delivered (need to ship)
//   'partial' = any payments made but balance still > 0
function orderStatusFlag(o) {
  if (o.delivered && !o.paid) return 'unpaid';
  if (o.paid && !o.delivered) return 'pending';
  if (orderIsPartiallyPaid(o)) return 'partial';
  return null;
}
function statusFlagBadge(flag) {
  if (flag === 'unpaid')  return ' <span class="status-flag danger" title="Delivered but not paid — collect payment">⚠</span>';
  if (flag === 'pending') return ' <span class="status-flag success" title="Paid but not yet delivered — needs to ship">⏳</span>';
  if (flag === 'partial') return ' <span class="status-flag warn" title="Partial payment received — balance still owed">◐</span>';
  return '';
}
// Compact "$40" chip rendered next to the Paid toggle on rows for partially-
// paid orders — shows how much has been collected so far. Tooltip carries the
// full breakdown so the row itself stays tidy.
function partialPaidPill(o) {
  if (!orderIsPartiallyPaid(o)) return '';
  const paid = orderPaymentsTotal(o);
  const total = orderTotal(o);
  const balance = Math.max(0, total - paid);
  return `<button type="button" class="partial-chip" data-open-payments="${o.id}" title="${fmt$(paid)} of ${fmt$(total)} paid · ${fmt$(balance)} due">${fmt$(paid)}</button>`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Inline SVG QR for any URI — used by the invoice for the Zelle and CashApp
// payment rows. Synchronous render so screenshots always capture the code.
// Returns '' if the qrcode-generator library failed to load (CDN blocked /
// offline) — the invoice still renders, just without QRs.
function qrSvg(data, opts) {
  if (typeof qrcode !== 'function') return '';
  try {
    const cellSize = (opts && opts.cellSize) || 4;
    const margin = (opts && opts.margin) || 2;
    const ec = (opts && opts.ec) || 'M';
    const qr = qrcode(0, ec);
    qr.addData(String(data || ''));
    qr.make();
    return qr.createSvgTag({ cellSize, margin, scalable: true });
  } catch (e) {
    console.warn('qrSvg failed for', data, e);
    return '';
  }
}

// Renders the invoice template into the modal form. Reusable from both the
// Today popup (multi-order group, editable notes) and the order edit/new form
// (single in-progress draft, notes are read-only here since they're edited in
// the order form itself).
//   formEl         the <form> element to render into (always #modalForm)
//   orders         array of order-like objects (each has items[], notes)
//   customerName   what shows under "Bill To"
//   dateKey        ISO date for the invoice "Date" line
//   onBack         called when the user taps ← Back
//   allowNotesEdit true → user can add/edit notes inside the invoice
//   onNotesSave    called with the new text when notes are saved (edit mode)
function renderInvoiceView({ formEl, orders, customerName, dateKey, onBack, allowNotesEdit, onNotesSave }) {
  // Build per-line items, allocating each order's discount proportionally across
  // its eligible lines so a discounted line can show its reduced price with the
  // original struck through. The remainder is applied to the last eligible line
  // so the per-line discounts sum exactly to the order's discount.
  // Per-line discount only ends up in `disc` so a line strikethrough means
  // "this specific line was marked down." The overall (order-level) discount is
  // shown as a single line at the BOTTOM of the invoice, not allocated into
  // each line. Customers see one familiar "You saved" total instead of a bunch
  // of tiny per-line markdowns that don't tie back to anything they did.
  const lineItems = orders.flatMap(o => orderItems(o).map(it => {
    const qty = Number(it.qty) || 0;
    const price = Number(it.price) || 0;
    const orig = Number(it.originalPrice) || 0;
    // wasUnit = the customer-visible "original" price per unit when the item
    // is on sale; 0 otherwise (no strikethrough). Per-line discounts are still
    // tracked separately in `disc`.
    const wasUnit = orig > price ? orig : 0;
    return {
      product: it.product || '',
      qty, price,
      wasUnit,
      lineTotal: qty * price,
      excluded: !!it.excludeDiscount,
      disc: itemDiscountAmount(it),
    };
  }));
  const itemsSubtotal = round2(orders.reduce((s, o) => s + orderItemsTotal(o), 0));
  const shipping = round2(orders.reduce((s, o) => s + orderShipping(o), 0));
  const lineDiscTotal = round2(orders.reduce((s, o) => s + orderItemDiscountsTotal(o), 0));
  const orderDiscTotal = round2(orders.reduce((s, o) => s + orderDiscountAmount(o), 0));
  // Original subtotal at MSRP (sum of qty × original-price-or-current). When
  // items are on sale, this is the "before" number; subtracting the combined
  // savings then matches the actual total the customer pays.
  const itemsOriginalSubtotal = round2(orders.reduce((s, o) => s + orderItems(o).reduce((ss, it) => {
    const qty = Number(it.qty) || 0;
    const price = Number(it.price) || 0;
    const orig = Number(it.originalPrice) || 0;
    const unit = orig > price ? orig : price;
    return ss + qty * unit;
  }, 0), 0));
  const saleSavings = Math.max(0, round2(itemsOriginalSubtotal - itemsSubtotal));
  // Total savings = sale markdowns + per-line discounts + overall discount.
  // Customer reads one neutral "You saved" line for the combined dollars off.
  const totalSavings = round2(saleSavings + lineDiscTotal + orderDiscTotal);
  // Discount line label — show "(X% off)" only when ALL the savings came from
  // a single overall percent discount with no sale items / per-line discounts
  // mixed in. Otherwise just plain "You saved".
  const discountPcts = new Set(
    orders.filter(o => orderDiscountAmount(o) > 0 && o.discount && o.discount.type === 'percent')
          .map(o => Number(o.discount.value))
  );
  const anyFlatDiscount = orders.some(o => orderDiscountAmount(o) > 0 && (!o.discount || o.discount.type !== 'percent'));
  const discountLabel = (discountPcts.size === 1 && !anyFlatDiscount && lineDiscTotal <= 0.005 && saleSavings <= 0.005)
    ? `You saved (${[...discountPcts][0]}% off)`
    : 'You saved';
  const total = round2(orders.reduce((s, o) => s + orderTotal(o), 0));
  const paidSoFar = round2(orders.reduce((s, o) => s + orderPaidRevenue(o), 0));
  const balanceDue = round2(Math.max(0, total - paidSoFar));
  const hasPartial = paidSoFar > 0.005 && balanceDue > 0.005;
  const isFullyPaid = total > 0 && paidSoFar > 0.005 && balanceDue <= 0.005;
  // Individual payment records across all orders in this invoice, sorted by date,
  // so the customer can see each payment they've made.
  const paymentList = orders
    .flatMap(o => orderPayments(o))
    .filter(p => (Number(p.amount) || 0) > 0.005)
    .map(p => ({ amount: round2(p.amount), date: p.date || '' }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const combinedNotes = () => {
    const all = orders.map(o => (o.notes || '').trim()).filter(Boolean);
    return [...new Set(all)].join('\n');
  };
  // Short, customer-friendly invoice number derived from the first order's
  // ID. Same number every time you reopen this invoice, and the orders page
  // search box matches against it too — so the customer can quote the number
  // back and it'll surface the exact order they're asking about.
  const invoiceNumber = invoiceNumberForOrder(orders[0]) || 'XXXXXX';

  formEl.innerHTML = `
    <div class="invoice-view">
      <div class="invoice-paper">
        <img class="invoice-watermark" src="public/lr-logo.png" alt="" crossorigin="anonymous" />
        <div class="invoice-header">
          <div class="invoice-title">Order Invoice</div>
          <div class="invoice-meta">
            <div class="invoice-meta-row"><span class="invoice-meta-label">Invoice</span><span class="invoice-ref">${escapeHtml(invoiceNumber)}</span></div>
            <div class="invoice-meta-row"><span class="invoice-meta-label">Date</span><span>${fmtDateLong(dateKey)}</span></div>
            ${isFullyPaid ? `<div class="invoice-meta-row"><span class="invoice-paid-stamp">PAID</span></div>` : ''}
          </div>
        </div>
        <div class="invoice-items">
          <div class="invoice-items-head">
            <span>Item</span><span>Qty</span><span>Price</span><span>Total</span>
          </div>
          ${lineItems.length ? lineItems.map(r => {
            const isDisc = r.disc > 0.005;
            const onSale = r.wasUnit > r.price + 0.005;
            // Whole dollars only on the invoice — no cents on price or total.
            const dTotal = Math.round(r.lineTotal - r.disc);
            const dUnit = r.qty > 0 ? Math.round((r.lineTotal - r.disc) / r.qty) : r.price;
            // "Was" reference price per unit = inventory original price when on
            // sale; otherwise just the current selling price (only used when a
            // per-line discount calls for a strikethrough).
            const wasUnit = onSale ? r.wasUnit : r.price;
            const wasLineTotal = r.qty * wasUnit;
            const showStrike = onSale || isDisc;
            const priceCell = showStrike
              ? `<span class="invoice-price-was">${fmt$(wasUnit)}</span><span class="invoice-price-now">${fmt$(dUnit)}</span>${onSale ? '<span class="invoice-sale-pill">Sale</span>' : ''}`
              : fmt$(r.price);
            const totalCell = showStrike
              ? `<span class="invoice-price-was">${fmt$(wasLineTotal)}</span><span class="invoice-price-now">${fmt$(dTotal)}</span>`
              : fmt$(r.lineTotal);
            return `
              <div class="invoice-item-row${onSale ? ' invoice-item-row-sale' : ''}">
                <span class="invoice-item-name">${escapeHtml(r.product)}</span>
                <span>${fmtN(r.qty)}</span>
                <span>${priceCell}</span>
                <span>${totalCell}</span>
              </div>
            `;
          }).join('') : `<div class="invoice-item-row" style="opacity:.5"><span>(no items)</span><span></span><span></span><span></span></div>`}
        </div>
        ${(shipping > 0 || totalSavings > 0) ? `
          <div class="invoice-subtotal-rows">
            <div class="invoice-subtotal-row"><span>Subtotal</span><span>${fmt$(itemsOriginalSubtotal)}</span></div>
            ${totalSavings > 0 ? `<div class="invoice-subtotal-row invoice-discount-row"><span>${discountLabel}</span><span>−${fmt$(totalSavings)}</span></div>` : ''}
            ${shipping > 0 ? `<div class="invoice-subtotal-row"><span>Shipping</span><span>${fmt$(shipping)}</span></div>` : ''}
          </div>
        ` : ''}
        <div class="invoice-total-row">
          <span class="invoice-total-label">${(hasPartial || isFullyPaid) ? 'Order Total' : 'Total Due'}</span>
          <span class="invoice-total-amount">${fmt$(total)}</span>
        </div>
        ${paymentList.length ? `
          <div class="invoice-subtotal-rows invoice-balance-rows">
            ${paymentList.map(p => `
              <div class="invoice-subtotal-row">
                <span>Payment${p.date ? ` · ${fmtDateShort(p.date)}` : ''}</span>
                <span>−${fmt$(p.amount)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
        ${hasPartial ? `
          <div class="invoice-total-row invoice-balance-row">
            <span class="invoice-total-label">Balance Due</span>
            <span class="invoice-total-amount">${fmt$(balanceDue)}</span>
          </div>
        ` : ''}
        ${isFullyPaid ? `
          <div class="invoice-total-row invoice-paid-row">
            <span class="invoice-total-label">Balance Due</span>
            <span class="invoice-total-amount">${fmt$(0)}</span>
          </div>
        ` : ''}
        ${isFullyPaid ? '' : (() => {
          // Build deep links for the QR codes. Zelle has no universal link
          // scheme — `mailto:` is what every phone recognizes when scanning
          // a QR. CashApp's URL accepts an optional /AMOUNT suffix, so we
          // pre-fill the customer's still-owed balance and they don't have
          // to type it. Both QRs render as inline SVG so screenshots always
          // capture them in full crispness.
          const zelleEmail = 'LumenResearchLLC@gmail.com';
          const cashappTag = 'LumenResearch';
          const zelleUri = `mailto:${zelleEmail}`;
          const cashappAmt = Math.max(0, Math.round(balanceDue));
          const cashappUri = `https://cash.app/$${cashappTag}` + (cashappAmt > 0 ? `/${cashappAmt}` : '');
          return `
        <div class="invoice-payment-block">
          <div class="invoice-payment-label">Payment Methods</div>
          <div class="invoice-payment-qr-tip">Tip: <b>Tap &amp; Hold</b> on a QR code to scan it directly.</div>
          <div class="invoice-payment-list">
            <div class="invoice-payment-row invoice-payment-row-qr">
              <span class="invoice-payment-method">Zelle</span>
              <span class="invoice-payment-value invoice-payment-value-email">${zelleEmail.replace('@', '@<wbr>')}</span>
              <span class="invoice-payment-qr invoice-payment-qr-static" title="Scan to pay via Zelle"><img src="public/zelle-qr.png" alt="Zelle QR" loading="eager" decoding="sync" crossorigin="anonymous" /></span>
            </div>
            <div class="invoice-payment-row invoice-payment-row-qr">
              <span class="invoice-payment-method">CashApp</span>
              <a class="invoice-payment-value" href="${cashappUri}">$${cashappTag}${cashappAmt > 0 ? ` <span class="invoice-payment-amount">· ${fmt$(cashappAmt)}</span>` : ''}</a>
              <a class="invoice-payment-qr" href="${cashappUri}" title="Scan to open CashApp">${qrSvg(cashappUri)}</a>
            </div>
            <div class="invoice-payment-row">
              <span class="invoice-payment-method">Apple Pay</span>
              <span class="invoice-payment-value">512-573-1342</span>
            </div>
            <div class="invoice-payment-row">
              <span class="invoice-payment-method">Cash</span>
              <span class="invoice-payment-value">In person</span>
            </div>
          </div>
          <div class="invoice-payment-note">
            <b>Heads up: Zelle and CashApp are strict about memos.</b>
            Please leave the note/memo blank, or just enter a <b>"."</b> or
            <b>"food"</b> if one is required.
          </div>
        </div>
        `;
        })()}
        <div class="invoice-notes-block" id="invoiceNotesBlock"></div>
      </div>
      ${invoiceSmsNumber(customerName) ? '' : `
      <label class="invoice-phone">
        <span>Customer's phone — saves to their profile</span>
        <input type="tel" id="invoicePhoneInput" inputmode="tel" autocomplete="off" placeholder="Optional — opens their text thread" />
      </label>`}
      <div class="invoice-actions">
        <button type="button" class="btn ghost" id="invoiceBackBtn">← Back</button>
        ${invoiceSmsNumber(customerName) ? '<button type="button" class="btn ghost" id="invoiceShareBtn">Share…</button>' : ''}
        <button type="button" class="btn primary" id="invoiceSendBtn">Send Invoice</button>
      </div>
    </div>
  `;

  function renderNotesView(editing) {
    const block = formEl.querySelector('#invoiceNotesBlock');
    const text = combinedNotes();
    if (!allowNotesEdit) {
      block.innerHTML = text
        ? `<div class="invoice-notes-label">Notes</div><div class="invoice-notes-text">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`
        : '';
      return;
    }
    if (editing) {
      block.innerHTML = `
        <div class="invoice-notes-label">Notes</div>
        <textarea class="invoice-notes-input" rows="3" placeholder="Add a note (e.g. payment instructions)…" data-no-export>${escapeHtml(text)}</textarea>
        <div class="invoice-notes-actions" data-no-export>
          <button type="button" class="btn ghost" id="invoiceNotesCancel">Cancel</button>
          <button type="button" class="btn primary" id="invoiceNotesSave">Save</button>
        </div>
      `;
      const ta = block.querySelector('textarea');
      setTimeout(() => ta.focus(), 30);
      block.querySelector('#invoiceNotesCancel').addEventListener('click', () => renderNotesView(false));
      block.querySelector('#invoiceNotesSave').addEventListener('click', () => {
        if (typeof onNotesSave === 'function') onNotesSave(ta.value.trim());
        renderNotesView(false);
      });
    } else if (text) {
      block.innerHTML = `
        <div class="invoice-notes-label">Notes</div>
        <div class="invoice-notes-text">${escapeHtml(text).replace(/\n/g, '<br>')}</div>
        <button type="button" class="link invoice-notes-edit" id="invoiceNotesEdit" data-no-export>Edit notes</button>
      `;
      block.querySelector('#invoiceNotesEdit').addEventListener('click', () => renderNotesView(true));
    } else {
      // Whole block (the "+ Add Notes" button) is author-only — hidden from
      // the rasterized PNG the customer receives.
      block.innerHTML = `<button type="button" class="btn ghost invoice-notes-add" id="invoiceNotesAdd" data-no-export>+ Add Notes</button>`;
      block.querySelector('#invoiceNotesAdd').addEventListener('click', () => renderNotesView(true));
    }
  }
  renderNotesView(false);
  formEl.querySelector('#invoiceBackBtn').addEventListener('click', onBack);

  // Dynamic loader fallback — if the html2canvas <script> tag in the HTML
  // didn't run (cached pre-script HTML, blocked CDN, slow network), try to
  // fetch it on demand when the user clicks Send Invoice.
  function loadHtml2Canvas() {
    if (typeof html2canvas !== 'undefined') return Promise.resolve(true);
    if (window.__html2canvasLoading) return window.__html2canvasLoading;
    window.__html2canvasLoading = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
      s.async = true;
      s.onload = () => resolve(typeof html2canvas !== 'undefined');
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
    return window.__html2canvasLoading;
  }
  // Send Invoice — rasterizes the invoice paper into a PNG and then:
  //   - If the customer has a phone number saved: copies the PNG to the
  //     clipboard and opens Messages straight to that customer's thread
  //     (sms: link), so it's one long-press → Paste. iOS doesn't let a web
  //     page attach an image to a specific chat, so this is the closest
  //     thing to "send to this person".
  //   - Otherwise (or via the "Share…" button): the device share sheet with
  //     the PNG attached; on desktop, a download.
  // Uses html2canvas (instead of html-to-image) because it's more reliable on
  // iOS Safari — html-to-image renders via SVG foreignObject which WebKit
  // handles inconsistently when there are any cross-origin or QR-style images.
  let smsNumber = invoiceSmsNumber(customerName);
  const phoneInput = formEl.querySelector('#invoicePhoneInput');
  const sendBtn = formEl.querySelector('#invoiceSendBtn');
  const shareBtn = formEl.querySelector('#invoiceShareBtn');

  async function renderInvoiceBlob(paper, btn) {
    try {
      // Lazy-load the rasterization library if it didn't come down with the
      // page (cached HTML, blocked CDN, etc.). One-shot, then cached.
      if (typeof html2canvas === 'undefined') {
        btn.textContent = 'Loading…';
        const ok = await loadHtml2Canvas();
        if (!ok || typeof html2canvas === 'undefined') {
          throw new Error('Image library failed to load — check your internet connection.');
        }
        btn.textContent = 'Preparing…';
      }
      // Make sure every <img> inside the paper has finished loading before
      // html2canvas walks the DOM — otherwise their natural size is 0 and
      // they render blank in the captured image.
      const imgs = paper.querySelectorAll('img');
      await Promise.all(Array.from(imgs).map(img =>
        (img.complete && img.naturalWidth > 0)
          ? Promise.resolve()
          : new Promise(res => { img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); })
      ));

      // Hide author-only controls (the Add Notes / Edit notes buttons, the
      // notes editor while open) for the duration of the capture so the
      // customer's PNG doesn't include any of our editing chrome. Restored
      // in the `finally` block below regardless of how we exit.
      paper.querySelectorAll('[data-no-export]').forEach(el => { el.style.display = 'none'; });

      // Adaptive scale — target an output that's at least ~1280 px wide so
      // the PNG is crisp regardless of viewport. Mobile invoices are
      // narrower (~340–400 px) so they need a higher scale than desktop
      // (~500–540 px) to hit the same final resolution. Capped at 5× as a
      // safety margin against canvas memory limits on older phones.
      const paperWidth = paper.getBoundingClientRect().width || 400;
      const TARGET_WIDTH = 1280;
      const scale = Math.max(2, Math.min(5, Math.ceil(TARGET_WIDTH / paperWidth)));
      const canvas = await html2canvas(paper, {
        scale,
        backgroundColor: '#ffffff',  // white background even outside the paper
        useCORS: true,               // allow cross-origin images taint-free
        allowTaint: false,
        logging: false,
        imageTimeout: 8000,
      });
      return await new Promise((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob returned null')), 'image/png');
      });
    } finally {
      // Restore any author-only controls we hid for the capture.
      try {
        paper.querySelectorAll('[data-no-export]').forEach(el => { el.style.display = ''; });
      } catch {}
    }
  }

  async function shareOrDownload(blob) {
    const safeDate = (dateKey || todayISO()).replace(/[^0-9-]/g, '');
    // Keep the shared title / filename anonymized — no customer name.
    // "Invoice · YYYY-MM-DD · XXXXXX" so recipients see a neutral header
    // in the share sheet and the saved filename is sortable by date.
    const shareTitle = `Invoice · ${safeDate} · ${invoiceNumber}`;
    const filename = `Invoice-${safeDate}-${invoiceNumber}.png`;
    const file = new File([blob], filename, { type: 'image/png' });


    // Try the native share sheet first (mobile). canShare confirms the
    // browser actually supports file sharing — desktop Chrome/Firefox
    // generally return false and we fall through to download.
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: shareTitle });
        return;            // user picked an app — done
      } catch (err) {
        if (err && err.name === 'AbortError') return;  // user cancelled
        // Any other share error → fall through to download
      }
    }

    // Download fallback (desktop, or browsers without file-share support).
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    toast('Invoice saved to your downloads.');
  }

  async function sendInvoice(btn, { toCustomer }) {
    const paper = formEl.querySelector('.invoice-paper');
    if (!paper) {
      toast('No invoice to send.');
      return;
    }
    // A number typed into the invoice's phone field gets saved to the
    // customer's profile, so next time it's already there.
    if (phoneInput && phoneInput.value.trim()) {
      if (!saveInvoiceCustomerPhone(customerName, phoneInput.value.trim())) {
        toast('That phone number looks incomplete.');
        return;
      }
      smsNumber = invoiceSmsNumber(customerName);
      const label = phoneInput.closest('.invoice-phone');
      if (label) label.remove();
    }
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    try {
      const blobPromise = renderInvoiceBlob(paper, btn);
      // Touch devices only — on a desktop the sms: link has nowhere useful to go.
      if (toCustomer && smsNumber && navigator.maxTouchPoints > 0) {
        // clipboard.write must be called synchronously inside the tap (Safari
        // drops the user gesture after the first await), so hand it the
        // still-rendering PNG as a promise rather than awaiting it first.
        let copied = false;
        if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
          try {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
            copied = true;
          } catch (err) {
            console.warn('Clipboard image write failed', err);
          }
        }
        if (copied) {
          toast('Invoice copied — long-press the message box and tap Paste.');
          window.location.href = 'sms:' + smsNumber;
          return;
        }
      }
      await shareOrDownload(await blobPromise);
    } catch (err) {
      console.error('Send Invoice failed', err);
      // Surface a hint of the underlying error so we can debug from a
      // screenshot if the rendering still fails on a particular device.
      const detail = (err && err.message) ? `: ${String(err.message).slice(0, 80)}` : '';
      toast(`Could not render the invoice${detail}`);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  if (sendBtn) sendBtn.addEventListener('click', () => sendInvoice(sendBtn, { toCustomer: true }));
  if (shareBtn) shareBtn.addEventListener('click', () => sendInvoice(shareBtn, { toCustomer: false }));
}

// Save a phone number typed on the invoice screen to the customer's profile
// (creating the profile if somehow missing). Returns false if it's not a
// usable number. Synchronous apart from the background cloud sync, so the
// send flow stays inside the user's tap.
function saveInvoiceCustomerPhone(customerName, phone) {
  if (phone.replace(/\D/g, '').length < 7) return false;
  let c = findCustomerByName(customerName);
  if (!c) {
    c = {
      id: 'c-' + Math.random().toString(36).slice(2, 10),
      name: customerName, phone: '', email: '', address: '', notes: '',
      createdAt: todayISO(),
    };
    state.customers.push(c);
  }
  c.phone = phone;
  saveState();
  cloudUpsert('customers', c);
  renderCustomers();
  return true;
}

// Phone number for the invoice's customer in a form the sms: scheme accepts,
// or '' if none is saved. Bare 10-digit US numbers get +1 so Messages matches
// the existing thread/contact instead of starting a new one.
function invoiceSmsNumber(customerName) {
  const c = findCustomerByName(customerName);
  const raw = ((c && c.phone) || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7) return '';
  if (raw.startsWith('+')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return digits;
}

// Read-only popup invoked from the dashboard's Today card. Shows a quick summary
// of everything a customer ordered on a given day — items, qty, price, totals,
// and paid/delivered state — without opening the full order edit modal. Has a
// "Show Invoice" button that swaps to a screenshot-friendly invoice view.
// dateKey defaults to today; the Today card also passes past dates for overdue
// rows so the popup shows that customer's old order day.
function openTodayOrderDetail(customerKey, dateKey) {
  const todayKey = dateKey || todayISO();
  const orders = state.orders.filter(o =>
    o.date === todayKey &&
    (o.customer || '').toLowerCase().trim() === customerKey
  );
  if (!orders.length) return;
  const customerName = orders[0].customer || '';

  $('#modalTitle').textContent = customerName;
  const form = $('#modalForm');

  function persistOrders(updated, stockTouched) {
    if (!updated.length) return;
    saveState();
    cloudUpsertMany('orders', updated);
    if (stockTouched && stockTouched.size) cloudUpsertMany('stock', [...stockTouched]);
    renderOrders(); renderInventory(); renderDashboard(); renderMonthly();
  }

  // Combined notes from all orders in the group. If they all share the same
  // text we just show it once; otherwise join distinct values with newlines.
  function combinedNotes() {
    const all = orders.map(o => (o.notes || '').trim()).filter(Boolean);
    return [...new Set(all)].join('\n');
  }
  function setNotesOnAll(text) {
    const updated = [];
    for (const o of orders) {
      if ((o.notes || '') !== text) {
        o.notes = text;
        updated.push(o);
      }
    }
    persistOrders(updated, null);
  }

  function renderDetail() {
    // Flatten items but retain the parent order so we can attribute the
    // order-level discount + shipping correctly per row.
    const rows = orders.flatMap(o => orderItems(o).map(it => ({ o, it })));
    const total = orders.reduce((s, o) => s + orderTotal(o), 0);
    const profit = orders.reduce((s, o) => s + orderProfit(o), 0);
    const paidSoFar = orders.reduce((s, o) => s + orderPaidRevenue(o), 0);
    const balance = Math.max(0, total - paidSoFar);
    const allPaid = orders.every(o => o.paid);
    const allDelivered = orders.every(o => o.delivered);
    const anyPartial = orders.some(o => orderIsPartiallyPaid(o));

    const itemsSubtotalGross = rows.reduce((s, { it }) => s + itemLineSubtotal(it), 0);
    const lineDiscountsTotal = rows.reduce((s, { it }) => s + itemDiscountAmount(it), 0);
    const orderDiscountsTotal = orders.reduce((s, o) => s + orderDiscountAmount(o), 0);
    const shippingTotal = orders.reduce((s, o) => s + orderShipping(o), 0);
    // Sale savings — the delta between an item's original price and its
    // current price, folded into "You saved" alongside actual discounts.
    const saleSavings = rows.reduce((s, { it }) => {
      const qty = Number(it.qty) || 0;
      const price = Number(it.price) || 0;
      const orig = Number(it.originalPrice) || 0;
      return s + (orig > price ? (orig - price) * qty : 0);
    }, 0);
    const totalSavings = lineDiscountsTotal + orderDiscountsTotal + saleSavings;

    form.innerHTML = `
      <div class="readonly-detail">
        <div class="rd-meta">
          <span class="rd-date">${fmtDateShort(todayKey)}</span>
        </div>
        <div class="rd-toggles">
          <label class="toggle-row">
            <span class="toggle-row-label">Paid</span>
            <span class="switch"><input type="checkbox" id="rdPaid" ${allPaid ? 'checked' : ''} /><span class="slider"></span></span>
          </label>
          <label class="toggle-row">
            <span class="toggle-row-label">Delivered</span>
            <span class="switch"><input type="checkbox" id="rdDelivered" ${allDelivered ? 'checked' : ''} /><span class="slider"></span></span>
          </label>
        </div>
        <div class="rd-items">
          ${rows.map(({ it }) => {
            const qty = Number(it.qty) || 0;
            const price = Number(it.price) || 0;
            const orig = Number(it.originalPrice) || 0;
            const lineDisc = itemDiscountAmount(it);
            const lineTotal = itemLineTotal(it);
            const effectivePer = qty > 0 ? lineTotal / qty : 0;
            const showStrike = (orig > price) || lineDisc > 0;
            const strikeSrc = orig > price ? orig : price;
            return `
              <div class="rd-item">
                <span class="rd-item-name">${escapeHtml(it.product || '')}</span>
                <span class="rd-item-qty">×${fmtN(qty)}</span>
                <span class="rd-item-price muted">${showStrike ? `<s>${fmt$(strikeSrc)}</s> ` : ''}${fmt$(effectivePer)} ea</span>
                <span class="rd-item-total">${fmt$(lineTotal)}</span>
              </div>
            `;
          }).join('')}
        </div>
        <div class="rd-totals">
          ${totalSavings > 0.005 ? `
            <div class="rd-total-row">
              <span class="rd-total-label muted">Subtotal</span>
              <b class="rd-total-value">${fmt$(itemsSubtotalGross)}</b>
            </div>
            <div class="rd-total-row">
              <span class="rd-total-label muted">You Saved</span>
              <b class="rd-total-value rd-savings">− ${fmt$(totalSavings)}</b>
            </div>
          ` : ''}
          ${shippingTotal > 0.005 ? `
            <div class="rd-total-row">
              <span class="rd-total-label muted">Shipping</span>
              <b class="rd-total-value">${fmt$(shippingTotal)}</b>
            </div>
          ` : ''}
          <div class="rd-total-row">
            <span class="rd-total-label">Total</span>
            <b class="rd-total-value">${fmt$(total)}</b>
          </div>
          ${(paidSoFar > 0.005 && balance > 0.005) ? `
            <div class="rd-total-row">
              <span class="rd-total-label muted">Paid So Far</span>
              <b class="rd-total-value">${fmt$(paidSoFar)}</b>
            </div>
            <div class="rd-total-row">
              <span class="rd-total-label muted">Balance Due</span>
              <b class="rd-total-value">${fmt$(balance)}</b>
            </div>
          ` : ''}
          <div class="rd-total-row">
            <span class="rd-total-label muted">Net Profit</span>
            <b class="rd-total-value">${fmt$(profit)}</b>
          </div>
        </div>
        ${anyPartial ? '<button type="button" class="btn ghost" id="editPaymentsBtn">Edit Payments</button>' : ''}
        <div class="rd-invoice-actions">
          <button type="button" class="btn ghost rd-invoice-btn" id="showInvoiceBtn">Show Invoice</button>
          <button type="button" class="btn primary rd-invoice-btn" id="sendInvoiceDirectBtn">Send Invoice</button>
        </div>
      </div>
    `;

    // Toggling Paid / Delivered updates every order in this customer-day group
    // at once. Either toggle can now flip an order's inventory state — stock is
    // only deducted once the order is BOTH paid AND delivered — so each handler
    // runs reconcileOrderInventory after the change.
    form.querySelector('#rdPaid').addEventListener('change', (e) => {
      const isPaid = e.target.checked;
      const stockTouched = new Set();
      const updated = [];
      for (const o of orders) {
        if (!!o.paid === isPaid) continue;
        setOrderFullyPaid(o, isPaid);
        reconcileOrderInventory(o).forEach(p => stockTouched.add(p));
        updated.push(o);
      }
      persistOrders(updated, stockTouched);
    });
    form.querySelector('#rdDelivered').addEventListener('change', (e) => {
      const isDelivered = e.target.checked;
      const stockTouched = new Set();
      const updated = [];
      for (const o of orders) {
        if (!!o.delivered === isDelivered) continue;
        o.delivered = isDelivered;
        reconcileOrderInventory(o).forEach(p => stockTouched.add(p));
        updated.push(o);
      }
      persistOrders(updated, stockTouched);
    });
    form.querySelector('#showInvoiceBtn').addEventListener('click', renderInvoice);
    // "Send Invoice" shortcut on the detail view — renders the invoice and
    // immediately triggers its share flow, so the user can go straight from
    // the customer detail to the share sheet without an extra tap.
    form.querySelector('#sendInvoiceDirectBtn').addEventListener('click', () => {
      renderInvoice();
      // Click synchronously (not in a rAF) — the clipboard copy in the send
      // flow only works while we're still inside the user's tap.
      const sendBtn = form.querySelector('#invoiceSendBtn');
      if (sendBtn) sendBtn.click();
    });
    const editPaymentsBtn = form.querySelector('#editPaymentsBtn');
    if (editPaymentsBtn) {
      editPaymentsBtn.addEventListener('click', () => {
        // The Today popup can span multiple same-day orders for a customer.
        // Open the first partially-paid one in the full editor so the user can
        // adjust its payments.
        const target = orders.find(o => orderIsPartiallyPaid(o)) || orders[0];
        if (target) orderModal(target);
      });
    }
  }

  function renderInvoice() {
    renderInvoiceView({
      formEl: form,
      orders,
      customerName,
      dateKey: todayKey,
      onBack: renderDetail,
      allowNotesEdit: true,
      onNotesSave: setNotesOnAll,
    });
  }

  renderDetail();

  modalOnSave = null;
  modal.classList.add('modal-readonly');
  $('#modalCancel').textContent = 'Close';
  showModal();
}

// ---------- ORDERS ----------
// Persist a filter input/select to localStorage so the user's selection sticks
// across navigation and reloads. For text inputs the saved value always
// applies; for <select> we only restore values that exist as options.
function persistFilter(el, key) {
  if (!el) return;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) {
      if (el.tagName === 'SELECT') {
        if ([...el.options].some(o => o.value === saved)) el.value = saved;
      } else {
        el.value = saved;
      }
    }
  } catch {}
  el.addEventListener('input', () => {
    try { localStorage.setItem(key, el.value); } catch {}
  });
}

// Reset a list of filter controls back to their defaults (first option for
// selects, empty for text inputs) and dispatch input events so persistFilter
// re-saves the defaults and any subscribed render functions re-run.
function resetFilters(elements) {
  elements.forEach(el => {
    if (!el) return;
    if (el.tagName === 'SELECT') {
      // Prefer the option marked `selected` in the HTML — it's the page's
      // intended default (e.g. Top Products defaults to "Top 10", not first).
      const def = el.querySelector('option[selected]');
      el.value = def?.value ?? el.options[0]?.value ?? '';
    } else {
      el.value = '';
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// Wire a custom × button inside a `.search-wrap` to clear its <input> and re-fire
// the input event so any subscribed render runs. Clears localStorage too.
function wireSearchClear(input) {
  const wrap = input.closest('.search-wrap');
  if (!wrap) return;
  const btn = wrap.querySelector('.search-clear');
  if (!btn) return;
  const update = () => wrap.classList.toggle('has-text', !!input.value);
  input.addEventListener('input', update);
  btn.addEventListener('click', () => {
    input.value = '';
    update();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });
  update();
}

const ordSearch = $('#ordSearch');
const ordFilter = $('#ordFilter');
const ordMonth = $('#ordMonth');
const ordDay = $('#ordDay');
const ordSort = $('#ordSort');
wireSearchClear(ordSearch);
const ORD_MONTH_KEY = 'lumen.orders.month';
const ORD_DAY_KEY = 'lumen.orders.day';
persistFilter(ordSearch, 'lumen.orders.search');
persistFilter(ordFilter, 'lumen.orders.filter');
persistFilter(ordMonth, ORD_MONTH_KEY);
persistFilter(ordDay, ORD_DAY_KEY);
persistFilter(ordSort, 'lumen.orders.sort');
[ordSearch, ordFilter, ordMonth, ordDay, ordSort].forEach(el => el.addEventListener('input', renderOrders));
$('#ordReset').addEventListener('click', () => resetFilters([ordSearch, ordFilter, ordMonth, ordDay, ordSort]));

$('#addOrderBtn').addEventListener('click', () => orderModal());

function refreshMonthDropdown() {
  const months = Array.from(new Set(state.orders.map(o => monthKey(o.date)).filter(Boolean))).sort();
  const stored = (() => { try { return localStorage.getItem(ORD_MONTH_KEY) || ''; } catch { return ''; } })();
  // Capture before innerHTML wipes the value, fall back to localStorage on first render.
  const cur = ordMonth.value || stored;
  ordMonth.innerHTML = `<option value="all">All Months</option>` +
    months.map(m => `<option value="${m}">${monthName(m + '-01')}</option>`).join('');
  if (cur === 'all' || months.includes(cur)) ordMonth.value = cur;
}

// Day dropdown lists every distinct date in the orders. When a specific month
// is chosen above, days are scoped to that month so the user only sees relevant
// dates. Selection persists via localStorage; falls back to "all" if the saved
// day is no longer valid (e.g., switched months).
function refreshDayDropdown() {
  const mo = ordMonth.value;
  const allDates = state.orders.map(o => o.date).filter(Boolean);
  const scoped = mo === 'all' ? allDates : allDates.filter(d => monthKey(d) === mo);
  const days = Array.from(new Set(scoped)).sort((a, b) => b.localeCompare(a));
  const stored = (() => { try { return localStorage.getItem(ORD_DAY_KEY) || ''; } catch { return ''; } })();
  const cur = ordDay.value || stored;
  ordDay.innerHTML = `<option value="all">All Days</option>` +
    days.map(d => `<option value="${d}">${fmtDateShort(d)}</option>`).join('');
  if (cur === 'all' || days.includes(cur)) ordDay.value = cur;
  else ordDay.value = 'all';
}

function renderOrders() {
  refreshMonthDropdown();
  refreshDayDropdown();
  const q = ordSearch.value.toLowerCase().trim();
  const f = ordFilter.value;
  const mo = ordMonth.value;
  const dy = ordDay.value;
  // 'asc' → oldest first; anything else → newest first (default).
  const ordDir = ordSort.value === 'asc' ? 1 : -1;
  let rows = [...state.orders].sort((a, b) =>
    ordDir * ((a.date || '').localeCompare(b.date || ''))
  );
  if (q) {
    // Strip any "#" / "INV-" / whitespace and uppercase so a search like
    // "#INV-A1B2C3", "inv-a1b2c3", or just "A1B2C3" all hit the same order's
    // invoice number. Require at least 3 chars before matching as a number
    // so a one-letter customer search isn't drowned by every "A…" order id.
    const qInv = q.replace(/[\s#]/g, '').replace(/^inv[-_]?/i, '').toUpperCase();
    const matchByInvoice = qInv.length >= 3;
    rows = rows.filter(o => {
      if ((o.customer || '').toLowerCase().includes(q)) return true;
      if (orderItems(o).some(it => (it.product || '').toLowerCase().includes(q))) return true;
      if (matchByInvoice && invoiceNumberForOrder(o).includes(qInv)) return true;
      return false;
    });
  }
  if (mo !== 'all') rows = rows.filter(o => monthKey(o.date) === mo);
  if (dy !== 'all') rows = rows.filter(o => o.date === dy);
  if (f === 'unpaid') rows = rows.filter(o => !o.paid);
  if (f === 'partial') rows = rows.filter(o => orderIsPartiallyPaid(o));
  if (f === 'paid') rows = rows.filter(o => o.paid);
  if (f === 'undelivered') rows = rows.filter(o => !o.delivered);
  if (f === 'delivered') rows = rows.filter(o => o.delivered);
  if (f === 'pending') rows = rows.filter(o => !o.paid && !o.delivered);

  // Group rows by customer + date so multiple same-day orders collapse into one row
  const groupsMap = new Map();
  for (const o of rows) {
    const key = (o.customer || '').toLowerCase().trim() + '|' + (o.date || '');
    if (!groupsMap.has(key)) groupsMap.set(key, { customer: o.customer, date: o.date, orders: [] });
    groupsMap.get(key).orders.push(o);
  }
  const groups = [...groupsMap.values()].sort((a, b) =>
    ordDir * ((a.date || '').localeCompare(b.date || ''))
  );

  const body = $('#ordersBody');
  const expandedBefore = getExpandedGroupIds(body);
  body.innerHTML = groups.map(g => renderOrderGroup(g)).join('') ||
    `<tr><td colspan="9" class="muted" style="padding:24px;text-align:center;">No orders match.</td></tr>`;
  restoreGroupExpansion(body, expandedBefore);

  const totalQty = rows.reduce((s, o) => s + orderQty(o), 0);
  const groupCount = groups.length;
  $('#ordCount').innerHTML =
    `<span class="foot-label">Total Orders</span> <span>${fmtN(groupCount)}</span>` +
    ` <span class="muted">· ${fmtN(totalQty)} item${totalQty === 1 ? '' : 's'}</span>`;
  $('#ordSumQty').textContent = fmtN(totalQty);
  // Footer Total = sum of full order totals (what was sold), Profit = full
  // potential profit. Cash-basis collection numbers live on the dashboard /
  // income statement; here the user is looking at the orders themselves.
  $('#ordSumTotal').textContent = fmt$(round2(rows.reduce((s, o) => s + orderTotal(o), 0)));
  $('#ordSumProfit').textContent = fmt$(round2(rows.reduce((s, o) => s + orderProfit(o), 0)));

  // Per-order toggles + edit/delete + group-level paid/delivered. Shared so the
  // dashboard's pending/recent cards get the same interactions as the Orders page.
  wireOrderInteractions(body);

  // Group expand/collapse + row-click + Mixed-pill behavior (shared helper)
  wireGroupExpand(body);
}

// Wire paid/delivered toggles, group toggles, edit, and delete buttons inside
// any tbody that renders order rows (orders page, dashboard recent, dashboard pending).
// Mobile-only convenience: tap anywhere on a pending row to edit it. The
// dashboard pending table is read in a hurry on phones, where the pencil icon
// is a tiny target. We skip when the tap is on an interactive control
// (switches, chevron, the edit button itself) so toggling Paid/Delivered or
// expanding a group still works as expected.
function wirePendingMobileRowEdit(body) {
  body.addEventListener('click', (e) => {
    if (window.innerWidth > 640) return;
    if (e.target.closest('label.switch, button, input, .pill, [data-toggle-group], .chevron')) return;
    const tr = e.target.closest('tr');
    if (!tr || tr.parentElement !== body) return;

    // Direct edit ID on this row (single-order or single-multi-item parent).
    let btn = tr.querySelector('[data-edit-order]');

    // Multi-item child rows of a single order have no edit button — defer to
    // the parent group-row's order id so tapping any item edits the parent.
    if (!btn && tr.classList.contains('child-row') && tr.dataset.parent) {
      const parentRow = body.querySelector(`[data-toggle-group="${tr.dataset.parent}"]`)?.closest('tr');
      if (parentRow) btn = parentRow.querySelector('[data-edit-order]');
    }
    if (!btn) return;
    const o = state.orders.find(x => x.id === btn.dataset.editOrder);
    if (o) orderModal(o);
  });
}

function wireOrderInteractions(body) {
  body.querySelectorAll('[data-toggle-paid]').forEach(el => el.addEventListener('change', e => {
    const o = state.orders.find(x => x.id === e.target.dataset.togglePaid);
    if (!o) return;
    setOrderFullyPaid(o, e.target.checked);
    const stockTouched = reconcileOrderInventory(o);
    saveState();
    cloudUpsert('orders', o);
    if (stockTouched.length) cloudUpsertMany('stock', stockTouched);
    renderOrders(); renderInventory(); renderDashboard(); renderMonthly();
  }));
  body.querySelectorAll('[data-toggle-delivered]').forEach(el => el.addEventListener('change', e => {
    const o = state.orders.find(x => x.id === e.target.dataset.toggleDelivered);
    if (!o) return;
    o.delivered = e.target.checked;
    const stockTouched = reconcileOrderInventory(o);
    saveState();
    cloudUpsert('orders', o);
    if (stockTouched.length) cloudUpsertMany('stock', stockTouched);
    renderOrders(); renderInventory(); renderDashboard(); renderMonthly();
  }));
  body.querySelectorAll('[data-edit-order]').forEach(el => el.addEventListener('click', () => {
    const o = state.orders.find(x => x.id === el.dataset.editOrder);
    if (o) orderModal(o);
  }));
  body.querySelectorAll('[data-del-order]').forEach(el => el.addEventListener('click', () => {
    if (!confirm('Delete this order?')) return;
    const id = el.dataset.delOrder;
    const o = state.orders.find(x => x.id === id);
    const restored = (o && o.inventoryApplied) ? applyOrderInventoryDelta(o.items, +1) : [];
    state.orders = state.orders.filter(x => x.id !== id);
    saveState();
    cloudDelete('orders', id);
    if (restored.length) cloudUpsertMany('stock', restored);
    renderOrders();
    renderInventory();
    renderDashboard();
    renderMonthly();
    toast('Order deleted.');
  }));
  // Open the partial-payment editor straight from a row pill, so the user
  // doesn't have to remember to use the pencil icon.
  body.querySelectorAll('[data-open-payments]').forEach(el => el.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const o = state.orders.find(x => x.id === el.dataset.openPayments);
    if (o) orderModal(o);
  }));
  body.querySelectorAll('[data-group-paid]').forEach(el => el.addEventListener('change', () => {
    const updated = [];
    const stockTouched = new Set();
    el.dataset.groupPaid.split(',').forEach(id => {
      const o = state.orders.find(x => x.id === id);
      if (!o) return;
      setOrderFullyPaid(o, el.checked);
      reconcileOrderInventory(o).forEach(p => stockTouched.add(p));
      updated.push(o);
    });
    saveState();
    cloudUpsertMany('orders', updated);
    if (stockTouched.size) cloudUpsertMany('stock', [...stockTouched]);
    renderOrders(); renderInventory(); renderDashboard(); renderMonthly();
  }));
  body.querySelectorAll('[data-group-delivered]').forEach(el => el.addEventListener('change', () => {
    const updated = [];
    const stockTouched = new Set();
    el.dataset.groupDelivered.split(',').forEach(id => {
      const o = state.orders.find(x => x.id === id);
      if (!o) return;
      o.delivered = el.checked;
      reconcileOrderInventory(o).forEach(p => stockTouched.add(p));
      updated.push(o);
    });
    saveState();
    cloudUpsertMany('orders', updated);
    if (stockTouched.size) cloudUpsertMany('stock', [...stockTouched]);
    renderOrders(); renderInventory(); renderDashboard(); renderMonthly();
  }));
}

function renderOrderGroup(g) {
  if (g.orders.length === 1) return renderSingleOrderRow(g.orders[0]);

  const groupId = 'g_' + (g.customer || '').replace(/\W+/g, '_') + '_' + (g.date || '').replace(/\W+/g, '');
  const totalQty = g.orders.reduce((s, o) => s + orderQty(o), 0);
  const totalAmt = g.orders.reduce((s, o) => s + orderTotal(o), 0);
  const totalProfit = g.orders.reduce((s, o) => s + orderProfit(o), 0);
  const totalLineItems = g.orders.reduce((s, o) => s + orderItems(o).length, 0);
  const allPaid = g.orders.every(o => o.paid);
  // Treat partial-payment orders as mixed so the user sees a "Mixed" pill (and
  // can drill in) instead of an unchecked toggle that misrepresents the state.
  const noPaid = g.orders.every(o => orderPaymentsTotal(o) <= 0.005);
  const allDelivered = g.orders.every(o => o.delivered);
  const noDelivered = g.orders.every(o => !o.delivered);

  const orderIds = g.orders.map(o => o.id).join(',');
  const childFlags = g.orders.map(o => orderStatusFlag(o));
  const aggCls = [
    'group-row',
    childFlags.includes('unpaid')  ? 'has-flag-unpaid'  : '',
    childFlags.includes('pending') ? 'has-flag-pending' : '',
  ].filter(Boolean).join(' ');

  const paidCell = (allPaid || noPaid)
    ? `<label class="switch"><input type="checkbox" data-group-paid="${orderIds}" ${allPaid ? 'checked' : ''} /><span class="slider"></span></label>`
    : `<span class="pill mixed" data-expand-group="${groupId}" title="Mixed — expand to see each">Mixed</span>`;
  const deliveredCell = (allDelivered || noDelivered)
    ? `<label class="switch"><input type="checkbox" data-group-delivered="${orderIds}" ${allDelivered ? 'checked' : ''} /><span class="slider"></span></label>`
    : `<span class="pill mixed" data-expand-group="${groupId}" title="Mixed — expand to see each">Mixed</span>`;

  let html = `
    <tr class="${aggCls}">
      <td>${fmtDateShort(g.date)}</td>
      <td><b>${escapeHtml(g.customer || '')}</b><span class="customer-sub">${totalLineItems} item${totalLineItems === 1 ? '' : 's'}</span></td>
      <td class="items-cell"><span class="chevron" data-toggle-group="${groupId}">▶</span><span class="grp-badge">${totalLineItems} item${totalLineItems === 1 ? '' : 's'}</span></td>
      <td class="num">${fmtN(totalQty)}</td>
      <td class="num">${fmt$(totalAmt)}</td>
      <td class="num">${fmt$(totalProfit)}</td>
      <td>${paidCell}</td>
      <td>${deliveredCell}</td>
      <td></td>
    </tr>`;
  html += g.orders.map(o => {
    const flag = orderStatusFlag(o);
    const cls = ['child-row'];
    if (flag) cls.push(`row-flag-${flag}`);
    return `
    <tr class="${cls.join(' ')}" data-parent="${groupId}" hidden>
      <td colspan="9" class="child-cell">
        <div class="child-strip">
          <span class="cs-label">↳${statusFlagBadge(flag)}</span>
          <span class="cs-items">${itemsCellInline(orderItems(o))}</span>
          <span class="cs-stat"><span class="cs-tlabel">Total</span><b class="cs-stat-total">${fmt$(orderTotal(o))}</b></span>
          <span class="cs-stat"><span class="cs-tlabel">Profit</span><b>${fmt$(orderProfit(o))}</b></span>
          <span class="cs-toggle"><span class="cs-tlabel">Paid</span><label class="switch"><input type="checkbox" data-toggle-paid="${o.id}" ${o.paid ? 'checked' : ''} /><span class="slider"></span></label>${partialPaidPill(o)}</span>
          <span class="cs-toggle"><span class="cs-tlabel">Delivered</span><label class="switch"><input type="checkbox" data-toggle-delivered="${o.id}" ${o.delivered ? 'checked' : ''} /><span class="slider"></span></label></span>
          <span class="cs-actions">
            <button class="icon-btn" data-edit-order="${o.id}" title="Edit">✎</button>
            <button class="icon-btn danger" data-del-order="${o.id}" title="Delete">🗑</button>
          </span>
        </div>
      </td>
    </tr>`;
  }).join('');
  return html;
}

function renderSingleOrderRow(o) {
  const items = orderItems(o);
  const flag = orderStatusFlag(o);
  const flagCls = flag ? ` row-flag-${flag}` : '';
  if (items.length <= 1) {
    const it = items[0];
    const sub = it ? `<span class="customer-sub">${escapeHtml(it.product || '')}${(Number(it.qty) || 0) > 0 ? ` ×${fmtN(it.qty)}` : ''}</span>` : '';
    return `<tr class="${flagCls.trim()}">
      <td>${fmtDateShort(o.date)}</td>
      <td>${escapeHtml(o.customer || '')}${statusFlagBadge(flag)}${sub}</td>
      <td class="items-cell">${itemsCellInline(items)}</td>
      <td class="num">${fmtN(orderQty(o))}</td>
      <td class="num">${fmt$(orderTotal(o))}</td>
      <td class="num">${fmt$(orderProfit(o))}</td>
      <td><div class="paid-cell"><label class="switch"><input type="checkbox" data-toggle-paid="${o.id}" ${o.paid ? 'checked' : ''} /><span class="slider"></span></label>${partialPaidPill(o)}</div></td>
      <td><label class="switch"><input type="checkbox" data-toggle-delivered="${o.id}" ${o.delivered ? 'checked' : ''} /><span class="slider"></span></label></td>
      <td style="white-space:nowrap;">
        <button class="icon-btn" data-edit-order="${o.id}" title="Edit">✎</button>
        <button class="icon-btn danger" data-del-order="${o.id}" title="Delete">🗑</button>
      </td>
    </tr>`;
  }
  // Multi-item: parent row with chevron, plus child rows for each line item.
  const groupId = 'oi_' + String(o.id || '').replace(/\W+/g, '_');
  let html = `
    <tr class="group-row${flagCls}">
      <td>${fmtDateShort(o.date)}</td>
      <td>${escapeHtml(o.customer || '')}${statusFlagBadge(flag)}<span class="customer-sub">${items.length} items</span></td>
      <td class="items-cell"><span class="chevron" data-toggle-group="${groupId}">▶</span><span class="grp-badge">${items.length} items</span></td>
      <td class="num">${fmtN(orderQty(o))}</td>
      <td class="num">${fmt$(orderTotal(o))}</td>
      <td class="num">${fmt$(orderProfit(o))}</td>
      <td><div class="paid-cell"><label class="switch"><input type="checkbox" data-toggle-paid="${o.id}" ${o.paid ? 'checked' : ''} /><span class="slider"></span></label>${partialPaidPill(o)}</div></td>
      <td><label class="switch"><input type="checkbox" data-toggle-delivered="${o.id}" ${o.delivered ? 'checked' : ''} /><span class="slider"></span></label></td>
      <td style="white-space:nowrap;">
        <button class="icon-btn" data-edit-order="${o.id}" title="Edit">✎</button>
        <button class="icon-btn danger" data-del-order="${o.id}" title="Delete">🗑</button>
      </td>
    </tr>`;
  html += items.map(it => `
    <tr class="child-row" data-parent="${groupId}" hidden>
      <td colspan="9" class="child-cell">
        <div class="child-strip">
          <span class="cs-label">↳</span>
          <span class="cs-items">${itemPill(it)}</span>
          <span class="cs-stat"><span class="cs-tlabel">Total</span><b class="cs-stat-total">${fmt$((Number(it.qty)||0)*(Number(it.price)||0))}</b></span>
          <span class="cs-stat"><span class="cs-tlabel">Profit</span><b>${fmt$(((Number(it.price)||0)-(Number(it.cogs)||0))*(Number(it.qty)||0))}</b></span>
        </div>
      </td>
    </tr>`).join('');
  return html;
}

function orderModal(existing, draft) {
  // `draft` is set when re-opening the form after the user previewed the
  // invoice — preserves their unsaved changes. Otherwise we hydrate from the
  // existing order (edit) or blank state (new).
  const data = draft
    ? JSON.parse(JSON.stringify(draft))
    : existing
      ? JSON.parse(JSON.stringify(existing))
      : { customer: '', date: todayISO(), paid: false, delivered: false, items: [], payments: [], notes: '', shipping: 0, discount: null };
  // Lock in the order's id at modal open. Existing orders keep their real id.
  // New orders get a fresh id NOW so the View Invoice preview shows the same
  // invoice number that the order will have once the user hits Save — no
  // more "XXXXXX" on the preview, and no number-change after save.
  if (!data.id) data.id = (existing && existing.id) || uid('o');
  if (!Array.isArray(data.items)) data.items = [];
  if (data.items.length === 0) data.items.push(blankItem());
  if (!Array.isArray(data.payments)) data.payments = [];
  data.shipping = Number(data.shipping) || 0;
  // Normalize discount to { type, value } or null.
  if (!(data.discount && (data.discount.type === 'percent' || data.discount.type === 'amount') && Number(data.discount.value) > 0)) {
    data.discount = null;
  }

  $('#modalTitle').textContent = existing ? 'Edit Order' : 'New Order';
  // Reset any read-only popup state left over from a prior modal (invoice view,
  // Today popup, etc.) so the Save/Cancel footer is back to normal.
  modal.classList.remove('modal-readonly');
  $('#modalCancel').textContent = 'Cancel';
  const form = $('#modalForm');
  // Datalist values feed the typeable product input — typing filters matches.
  const productOptions = state.stock
    .map(s => `<option value="${escapeHtml(s.name)}"></option>`)
    .join('');
  // Unique past customer names for autocomplete — typing filters, but any new name is accepted.
  const customerNames = [...new Set(
    state.orders.map(o => (o.customer || '').trim()).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));
  const customerOptions = customerNames
    .map(n => `<option value="${escapeHtml(n)}"></option>`)
    .join('');

  form.innerHTML = `
    <datalist id="orderProductList">${productOptions}</datalist>
    <datalist id="orderCustomerList">${customerOptions}</datalist>
    <div class="row-2">
      <label><span class="req">Customer</span><input type="text" name="customer" list="orderCustomerList" autocomplete="off" required value="${escapeHtml(data.customer || '')}" placeholder="Search or add customer…" /></label>
      <label><span class="req">Order Date</span><input type="date" name="date" required value="${data.date || todayISO()}" /></label>
    </div>
    <div class="items-section">
      <div class="items-head">
        <span class="label">Items</span>
        <button type="button" class="btn ghost add-item-btn" id="addItemBtn">+ Add Item</button>
      </div>
      <div class="items-col-head">
        <span>Product</span><span>Qty</span><span>Price</span><span></span>
      </div>
      <div id="itemsList"></div>
      <div class="items-summary">
        <span><span class="muted">Items</span> <b id="sumCount">0</b></span>
        <span><span class="muted">Qty</span> <b id="sumQty">0</b></span>
        <span><span class="muted">Total</span> <b id="sumTotal">$0</b></span>
        <span><span class="muted">Profit</span> <b id="sumProfit">$0</b></span>
      </div>
    </div>
    <div class="discount-section">
      <button type="button" class="btn ghost discount-toggle-btn" id="discountToggleBtn">+ Add Discount</button>
    </div>
    <div class="discount-popup" id="discountPopup" hidden>
      <div class="discount-popup-backdrop" id="discountPopupBackdrop"></div>
      <div class="discount-popup-card" role="dialog" aria-modal="true" aria-label="Discount">
        <div class="discount-popup-head">
          <h4>Discount</h4>
          <button type="button" class="icon-btn" id="discountPopupClose" title="Close">×</button>
        </div>
        <div class="discount-popup-body">
          <label class="discount-popup-overall">
            <span>Overall Discount</span>
            <div class="discount-input-wrap">
              <select id="discountType" name="discountType">
                <option value="amount">$ Off</option>
                <option value="percent">% Off</option>
              </select>
              <input type="number" inputmode="numeric" id="discountValue" min="0" step="1" placeholder="0" />
              <span class="discount-applied" id="discountApplied"></span>
              <button type="button" class="icon-btn danger discount-remove" id="discountRemoveBtn" title="Remove overall discount">×</button>
            </div>
          </label>
          <div class="discount-exclude" id="discountExclude">
            <div class="discount-exclude-head">
              <div class="discount-exclude-label">Line Items</div>
              <div class="discount-exclude-sub muted">Uncheck to skip the overall discount · $ line discounts are per item ($5 off × 4 = $20)</div>
            </div>
            <div class="discount-exclude-cols muted">
              <span>Include</span><span>Item</span><span>Line</span><span>Off</span>
            </div>
            <div id="discountExcludeList"></div>
          </div>
        </div>
        <div class="discount-popup-foot">
          <button type="button" class="btn primary" id="discountPopupDone">Done</button>
        </div>
      </div>
    </div>
    <div class="row-2">
      <label class="toggle-row">
        <span class="toggle-row-label">Paid in Full</span>
        <span class="switch"><input type="checkbox" name="paid" ${data.paid ? 'checked' : ''} /><span class="slider"></span></span>
      </label>
      <label class="toggle-row">
        <span class="toggle-row-label">Delivered</span>
        <span class="switch"><input type="checkbox" name="delivered" ${data.delivered ? 'checked' : ''} /><span class="slider"></span></span>
      </label>
    </div>
    <div class="payments-section">
      <div class="payments-head">
        <span class="label">Payments</span>
        <button type="button" class="btn ghost add-payment-btn" id="addPaymentBtn">+ Add Payment</button>
      </div>
      <div class="payments-col-head">
        <span>Amount</span><span>Date</span><span></span>
      </div>
      <div id="paymentsList"></div>
      <div class="payments-summary">
        <span><span class="muted">Paid</span> <b id="sumPaid">$0</b></span>
        <span><span class="muted">Balance</span> <b id="sumBalance">$0</b></span>
        <span class="payments-status" id="sumPayStatus"></span>
      </div>
    </div>
    <div class="shipping-section">
      <button type="button" class="btn ghost shipping-toggle-btn" id="shippingToggleBtn"${(Number(data.shipping) || 0) > 0 ? ' hidden' : ''}>+ Add Shipping Charge</button>
      <label class="shipping-field"${(Number(data.shipping) || 0) > 0 ? '' : ' hidden'}>
        <span>Shipping Charge</span>
        <div class="shipping-input-wrap">
          <span class="shipping-prefix">$</span>
          <input type="number" name="shipping" step="0.01" min="0" value="${Number(data.shipping) || 0}" />
          <button type="button" class="icon-btn danger shipping-remove" id="shippingRemoveBtn" title="Remove shipping">×</button>
        </div>
      </label>
    </div>
    <div class="notes-section">
      <button type="button" class="btn ghost notes-toggle-btn" id="notesToggleBtn"${data.notes ? ' hidden' : ''}>+ Add Notes</button>
      <label class="notes-field"${data.notes ? '' : ' hidden'}>
        <span>Notes</span>
        <textarea name="notes" rows="3" placeholder="Add a note for this order…">${escapeHtml(data.notes || '')}</textarea>
      </label>
    </div>
    <button type="button" class="btn ghost" id="viewInvoiceBtn">View Invoice</button>
    ${existing ? '<button type="button" class="btn danger-outline" id="orderDeleteBtn">Delete Order</button>' : ''}
  `;

  function blankItem() {
    return { product: '', qty: 1, price: 0, cogs: 0, discount: null };
  }

  // Build a single item row. Handlers close over the item reference (not an
  // index) so removing a row doesn't leave stale data-idx values behind, and
  // we never have to rebuild the entire list when one row changes — that's the
  // root cause of the keyboard-dismiss / input-jank that used to hit users on
  // mobile after typing in the second or third line.
  function buildItemRow(it) {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <input type="text" list="orderProductList" data-field="product" value="${escapeHtml(it.product || '')}" placeholder="Search product…" autocomplete="off" />
      <input type="number" inputmode="numeric" min="1" step="1" data-field="qty" value="${it.qty ?? ''}" placeholder="Qty" />
      <input type="number" inputmode="decimal" min="0" step="any" data-field="price" value="${it.price ?? ''}" placeholder="Price" />
      <button type="button" class="icon-btn danger" data-remove title="Remove">×</button>
    `;
    const priceInput = row.querySelector('[data-field="price"]');
    const productInput = row.querySelector('[data-field="product"]');
    // Custom typeahead — Chromium's native <datalist> stops filtering as you
    // keep typing unless you re-click the field, which broke desktop order entry.
    attachTypeahead(productInput, () => state.stock.map(s => s.name || ''));
    row.querySelectorAll('[data-field]').forEach(el => {
      el.addEventListener('input', () => {
        const field = el.dataset.field;
        let val = el.value;
        if (field !== 'product') val = val === '' ? null : Number(val);
        it[field] = val;
        if (field === 'product') {
          const p = state.stock.find(s => (s.name || '').toLowerCase() === String(val || '').toLowerCase());
          if (p) {
            it.price = Number(p.price) || 0;
            it.cogs = Number(p.cost) || 0;
            // Carry the "Original Price" onto the line so the invoice can
            // strike it through — but only when the product is actually on
            // sale (original > current). Otherwise leave it null so no
            // misleading "sale" indicator appears.
            const orig = Number(p.originalPrice) || 0;
            it.originalPrice = (orig > it.price) ? orig : null;
            if (priceInput) priceInput.value = it.price;
            // Dismiss the on-screen keyboard / dropdown after a pick
            // so the user can scroll on to the next field without an extra tap.
            el.blur();
          }
        }
        updateSummary();
        renderDiscountExclusions();
      });
    });
    row.querySelector('[data-remove]').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = data.items.indexOf(it);
      if (idx < 0) return;
      if (data.items.length === 1) {
        // Last row — clear in place instead of vanishing the editor.
        const blank = blankItem();
        Object.assign(it, blank);
        // Repopulate inputs from the cleared item without rebuilding the row,
        // so focus and scroll position are preserved.
        row.querySelector('[data-field="product"]').value = blank.product;
        row.querySelector('[data-field="qty"]').value = blank.qty;
        row.querySelector('[data-field="price"]').value = blank.price;
      } else {
        data.items.splice(idx, 1);
        row.remove();
      }
      updateSummary();
      renderDiscountExclusions();
    });
    return row;
  }

  function renderItems() {
    const list = form.querySelector('#itemsList');
    list.innerHTML = '';
    data.items.forEach(it => list.appendChild(buildItemRow(it)));
    updateSummary();
  }

  function updateSummary() {
    form.querySelector('#sumCount').textContent = data.items.length;
    form.querySelector('#sumQty').textContent = fmtN(orderQty(data));
    form.querySelector('#sumTotal').textContent = fmt$(orderTotal(data));
    form.querySelector('#sumProfit').textContent = fmt$(orderProfit(data));
    // Show the resolved discount amount (e.g. "−$23" for a rounded 10%).
    const applied = form.querySelector('#discountApplied');
    if (applied) {
      const amt = orderDiscountAmount(data);
      applied.textContent = amt > 0 ? `−${fmt$(amt)}` : '';
    }
    renderDiscountExclusions();
    updatePaymentsSummary();
  }

  // "Apply discount to" checklist — one toggle per item, shown only when a
  // discount is active and there are 2+ items. Unchecking an item sets its
  // excludeDiscount flag so the discount skips it. Rebuilt from data each time
  // so product names stay current; checkbox state is read back from the item.
  function renderDiscountExclusions() {
    const list = form.querySelector('#discountExcludeList');
    if (!list) return;
    // Don't rip the list out while the user is typing in one of its inputs —
    // that would steal focus mid-edit and drop the next keystroke. The line
    // input handlers update their own row's display in-place, so skipping the
    // rebuild here is safe.
    if (list.contains(document.activeElement)) return;
    list.innerHTML = '';
    data.items.forEach((it, idx) => {
      const row = document.createElement('div');
      row.className = 'discount-exclude-item';
      const name = (it.product || '').trim() || `Item ${idx + 1}`;
      const lineSub = itemLineSubtotal(it);
      const lineTotal = lineSub - itemDiscountAmount(it);
      // Discount schema is { type:'amount'|'percent', value:number } | null.
      // Legacy entries stored a bare number — treat those as a dollar amount.
      const d = it.discount;
      let curType = 'amount';
      let curValue = '';
      if (typeof d === 'number' && d > 0) { curType = 'amount'; curValue = String(d); }
      else if (d && typeof d === 'object' && Number(d.value) > 0) {
        curType = d.type === 'percent' ? 'percent' : 'amount';
        curValue = String(d.value);
      }
      row.innerHTML = `
        <label class="dx-include" title="Include in overall discount">
          <input type="checkbox" data-dx-include ${it.excludeDiscount ? '' : 'checked'} />
        </label>
        <span class="dx-name">${escapeHtml(name)}</span>
        <span class="dx-amt muted">${fmt$(round2(lineTotal))}</span>
        <span class="dx-line-disc">
          <select data-dx-type aria-label="Line discount type">
            <option value="amount"${curType === 'amount' ? ' selected' : ''}>$</option>
            <option value="percent"${curType === 'percent' ? ' selected' : ''}>%</option>
          </select>
          <input type="number" inputmode="numeric" min="0" step="1" data-dx-line value="${escapeHtml(curValue)}" placeholder="0" aria-label="Line discount value" />
        </span>
      `;
      const typeSel = row.querySelector('[data-dx-type]');
      const lineInput = row.querySelector('[data-dx-line]');
      // Pull a fresh {type, value} from the row and write it into it.discount,
      // then update just THIS row's displayed line total + the order summary.
      // No full list rebuild — keeps the input focused so typing flows.
      function syncLineDiscount() {
        const v = Number(lineInput.value) || 0;
        if (v > 0) {
          it.discount = {
            type: typeSel.value === 'percent' ? 'percent' : 'amount',
            value: v,
          };
        } else {
          it.discount = null;
        }
        const newLineTotal = itemLineSubtotal(it) - itemDiscountAmount(it);
        row.querySelector('.dx-amt').textContent = fmt$(round2(newLineTotal));
        // Update just the form summary numbers — do NOT call updateSummary()
        // here because that would invoke renderDiscountExclusions again and
        // (apart from the focus guard) ripple back into this row.
        refreshOrderSummaryNumbers();
      }
      row.querySelector('[data-dx-include]').addEventListener('change', (e) => {
        it.excludeDiscount = !e.target.checked;
        refreshOrderSummaryNumbers();
      });
      typeSel.addEventListener('change', syncLineDiscount);
      lineInput.addEventListener('input', syncLineDiscount);
      lineInput.addEventListener('change', syncLineDiscount);
      lineInput.addEventListener('blur', syncLineDiscount);
      list.appendChild(row);
    });
  }
  // Lightweight refresh: just updates the four summary numbers + applied
  // discount badge + payments summary. Used while typing in the discount panel
  // so we don't trigger a full discount-list rebuild on every keystroke.
  function refreshOrderSummaryNumbers() {
    form.querySelector('#sumCount').textContent = data.items.length;
    form.querySelector('#sumQty').textContent = fmtN(orderQty(data));
    form.querySelector('#sumTotal').textContent = fmt$(orderTotal(data));
    form.querySelector('#sumProfit').textContent = fmt$(orderProfit(data));
    const applied = form.querySelector('#discountApplied');
    if (applied) {
      const amt = orderDiscountAmount(data);
      applied.textContent = amt > 0 ? `−${fmt$(amt)}` : '';
    }
    updatePaymentsSummary();
  }

  form.querySelector('#addItemBtn').addEventListener('click', () => {
    const it = blankItem();
    data.items.push(it);
    const row = buildItemRow(it);
    form.querySelector('#itemsList').appendChild(row);
    updateSummary();
    // Drop focus onto the new product field so the user can immediately start
    // typing — uses focusForKeyboard to bring up the iOS keyboard reliably.
    focusForKeyboard(row.querySelector('[data-field="product"]'));
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  // ---- Payments section ----
  // Row-level closures (no data-idx) so rows can be added or removed without
  // rebuilding the list — keyboard / scroll position stay put.
  function buildPaymentRow(p) {
    const row = document.createElement('div');
    row.className = 'payment-row';
    // IMPORTANT: don't set `value="..."` in the HTML for the date input. On
    // iOS Safari (and some other WebKit builds) a date input rendered with a
    // pre-set `value` attribute can get "anchored" to that attribute — the
    // wheel picker visibly updates the input, but `el.value` keeps reporting
    // the original date. Setting the value via the JS property after creation
    // sidesteps the bug. Same treatment for the amount input for consistency.
    row.innerHTML = `
      <div class="payment-amount-wrap">
        <span class="payment-prefix">$</span>
        <input type="number" inputmode="numeric" min="0" step="1" data-pfield="amount" placeholder="0" />
      </div>
      <input type="date" data-pfield="date" />
      <button type="button" class="icon-btn danger" data-premove title="Remove payment">×</button>
    `;
    const amountInput = row.querySelector('[data-pfield="amount"]');
    const dateInput = row.querySelector('[data-pfield="date"]');
    if (amountInput) amountInput.value = (p.amount ?? '') === '' ? '' : String(p.amount);
    if (dateInput) dateInput.value = p.date || '';
    row.querySelectorAll('[data-pfield]').forEach(el => {
      // `<input type="date">` on iOS Safari (especially in standalone PWA mode)
      // is finicky about which event commits the value: sometimes only `change`
      // fires when the wheel picker closes, sometimes only `blur` fires when
      // focus moves. Listening to all three guarantees the in-memory p.date
      // tracks whatever the input is showing. The save handler also re-reads
      // the DOM directly as a final safety net.
      const sync = () => {
        const field = el.dataset.pfield;
        let val = el.value;
        if (field === 'amount') val = val === '' ? 0 : Number(val);
        p[field] = val;
        updatePaymentsSummary();
      };
      el.addEventListener('input', sync);
      el.addEventListener('change', sync);
      el.addEventListener('blur', sync);
    });
    row.querySelector('[data-premove]').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = data.payments.indexOf(p);
      if (idx >= 0) data.payments.splice(idx, 1);
      row.remove();
      // Show the empty-state hint again if we just removed the last payment.
      if (!data.payments.length) ensurePaymentsEmptyState();
      updatePaymentsSummary();
    });
    return row;
  }

  function ensurePaymentsEmptyState() {
    const list = form.querySelector('#paymentsList');
    if (list.querySelector('.payments-empty')) return;
    if (data.payments.length) return;
    const empty = document.createElement('div');
    empty.className = 'payments-empty muted';
    empty.textContent = 'No payments yet. Add one to track partial or full payments.';
    list.appendChild(empty);
  }

  function renderPayments() {
    const list = form.querySelector('#paymentsList');
    list.innerHTML = '';
    if (!data.payments.length) {
      ensurePaymentsEmptyState();
    } else {
      data.payments.forEach(p => list.appendChild(buildPaymentRow(p)));
    }
    updatePaymentsSummary();
  }

  function updatePaymentsSummary() {
    const paid = orderPaymentsTotal(data);
    const total = orderTotal(data);
    const balance = Math.max(0, total - paid);
    const sumPaidEl = form.querySelector('#sumPaid');
    const sumBalEl = form.querySelector('#sumBalance');
    const statusEl = form.querySelector('#sumPayStatus');
    if (sumPaidEl) sumPaidEl.textContent = fmt$(paid);
    if (sumBalEl) sumBalEl.textContent = fmt$(balance);
    if (statusEl) {
      statusEl.innerHTML = '';
      if (total <= 0) {
        // No items yet — nothing meaningful to badge.
      } else if (paid <= 0.005) {
        statusEl.innerHTML = `<span class="pill amber">Unpaid</span>`;
      } else if (paid >= total - 0.005) {
        statusEl.innerHTML = `<span class="pill green">Paid in Full</span>`;
      } else {
        // "Paid $X · Balance $Y" labels above already carry the numbers; the
        // pill just colors the state.
        statusEl.innerHTML = `<span class="pill partial">Partial</span>`;
      }
    }
    // Keep the "Paid in Full" toggle reflecting reality. Don't bother dispatching
    // an event — the toggle is only inspected at save time.
    const paidToggle = form.querySelector('[name="paid"]');
    if (paidToggle) paidToggle.checked = paid >= total - 0.005 && total > 0;
  }

  form.querySelector('#addPaymentBtn').addEventListener('click', () => {
    // amount: null so the row renders an empty input — no need for a
    // programmatic .value reset, which can break iOS focus chaining.
    const p = {
      id: uid('p'),
      amount: null,
      date: todayISO(),
      method: '',
      note: '',
    };
    data.payments.push(p);
    const list = form.querySelector('#paymentsList');
    list.querySelector('.payments-empty')?.remove();
    const row = buildPaymentRow(p);
    list.appendChild(row);
    updatePaymentsSummary();
    // focusForKeyboard() handles the iOS quirk where focusing a freshly-
    // appended input silently fails to open the keyboard.
    const amountInput = row.querySelector('[data-pfield="amount"]');
    focusForKeyboard(amountInput);
    // Bring the new row into view AFTER focus, in the next frame, so the
    // scroll animation doesn't interrupt the keyboard activation.
    requestAnimationFrame(() => {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  });

  // "Paid in Full" toggle is a shortcut: checking it tops up payments to the
  // full balance, unchecking it wipes payments. Granular control still lives
  // in the payments list below.
  const paidToggle = form.querySelector('[name="paid"]');
  paidToggle.addEventListener('change', () => {
    if (paidToggle.checked) {
      const balance = round2(Math.max(0, orderTotal(data) - orderPaymentsTotal(data)));
      if (balance > 0.005) {
        data.payments.push({
          id: uid('p'),
          amount: balance,
          date: todayISO(),
          method: '',
          note: '',
        });
      }
    } else {
      data.payments = [];
    }
    renderPayments();
  });

  // "+ Add Notes" reveals a textarea; once shown it stays visible (the button
  // hides). Existing orders with notes show the textarea expanded by default.
  const notesBtn = form.querySelector('#notesToggleBtn');
  const notesField = form.querySelector('.notes-field');
  notesBtn.addEventListener('click', () => {
    notesBtn.hidden = true;
    notesField.hidden = false;
    notesField.querySelector('textarea').focus();
  });

  // Shipping charge — same toggle pattern as Notes. The × button on the field
  // clears the amount and collapses back to the "+ Add Shipping Charge" button.
  const shipBtn = form.querySelector('#shippingToggleBtn');
  const shipField = form.querySelector('.shipping-field');
  const shipInput = shipField.querySelector('[name="shipping"]');
  const shipRemoveBtn = form.querySelector('#shippingRemoveBtn');
  shipBtn.addEventListener('click', () => {
    shipBtn.hidden = true;
    shipField.hidden = false;
    shipInput.focus();
    shipInput.select();
  });
  shipRemoveBtn.addEventListener('click', () => {
    shipInput.value = '0';
    data.shipping = 0;
    shipField.hidden = true;
    shipBtn.hidden = false;
    updateSummary();
  });
  // Live-update the items summary when shipping changes so Total reflects it.
  shipInput.addEventListener('input', () => {
    data.shipping = Number(shipInput.value) || 0;
    updateSummary();
  });

  // Discount — single button opens a popup overlay that lets the user set both
  // the overall discount AND any per-line discounts in one place. Changes are
  // applied live (no Save button on the popup); Done just dismisses it.
  const discountBtn = form.querySelector('#discountToggleBtn');
  const discountPopup = form.querySelector('#discountPopup');
  const discountPopupCloseBtn = form.querySelector('#discountPopupClose');
  const discountPopupBackdrop = form.querySelector('#discountPopupBackdrop');
  const discountPopupDoneBtn = form.querySelector('#discountPopupDone');
  const discountType = form.querySelector('#discountType');
  const discountValue = form.querySelector('#discountValue');
  const discountRemoveBtn = form.querySelector('#discountRemoveBtn');
  // Hydrate inputs from existing data.discount on first build.
  if (data.discount) {
    discountType.value = data.discount.type === 'percent' ? 'percent' : 'amount';
    discountValue.value = data.discount.value;
  }
  function syncDiscountFromInputs() {
    const v = Number(discountValue.value) || 0;
    data.discount = v > 0 ? { type: discountType.value === 'percent' ? 'percent' : 'amount', value: v } : null;
    updateSummary();
    updateDiscountBtnLabel();
  }
  function updateDiscountBtnLabel() {
    const total = orderItemDiscountsTotal(data) + orderDiscountAmount(data);
    discountBtn.textContent = total > 0
      ? `Edit Discount · −${fmt$(round2(total))}`
      : '+ Add Discount';
  }
  function openDiscountPopup() {
    discountPopup.hidden = false;
    document.body.classList.add('discount-popup-open');
    // Re-render the line items list so it reflects the latest items, then
    // focus the value input so the user can start typing right away.
    renderDiscountExclusions();
    setTimeout(() => focusForKeyboard(discountValue), 50);
  }
  function closeDiscountPopup() {
    discountPopup.hidden = true;
    document.body.classList.remove('discount-popup-open');
    updateDiscountBtnLabel();
    updateSummary();
  }
  discountBtn.addEventListener('click', openDiscountPopup);
  discountPopupCloseBtn.addEventListener('click', closeDiscountPopup);
  discountPopupBackdrop.addEventListener('click', closeDiscountPopup);
  discountPopupDoneBtn.addEventListener('click', closeDiscountPopup);
  discountRemoveBtn.addEventListener('click', () => {
    discountValue.value = '';
    data.discount = null;
    updateSummary();
    updateDiscountBtnLabel();
  });
  discountType.addEventListener('change', syncDiscountFromInputs);
  discountValue.addEventListener('input', syncDiscountFromInputs);
  // Reflect any existing discount in the button label on first paint.
  updateDiscountBtnLabel();

  renderItems();
  renderPayments();

  modalOnSave = () => {
    const customer = form.querySelector('[name="customer"]').value.trim();
    const date = form.querySelector('[name="date"]').value;
    const delivered = form.querySelector('[name="delivered"]').checked;
    const notes = form.querySelector('[name="notes"]').value.trim();
    // If the shipping section is hidden the user has no charge — save 0
    // regardless of whatever stale value is in the input.
    const shipping = shipField.hidden ? 0 : (Number(shipInput.value) || 0);
    if (!customer) { alert('Customer is required.'); return; }
    if (!date) { alert('Date is required.'); return; }
    if (!data.items.length) { alert('Add at least one item.'); return; }
    for (const it of data.items) {
      if (!it.product) { alert('Each item needs a product.'); return; }
      if (!it.qty || it.qty <= 0) { alert('Each item needs a quantity > 0.'); return; }
    }
    // Safety net: read the payment row inputs directly from the DOM right
    // before reading data.payments. `<input type="date">` on some platforms
    // (notably iOS standalone PWAs) doesn't always fire `input`/`change`
    // before the Save button's click handler runs, so the in-memory p.date
    // can be stale even though the input visibly shows the new date. Pulling
    // straight from the DOM here guarantees what the user sees is what saves.
    const paymentsList = form.querySelector('#paymentsList');
    if (paymentsList) {
      const rows = paymentsList.querySelectorAll('.payment-row');
      rows.forEach((row, i) => {
        const p = data.payments[i];
        if (!p) return;
        const dateInput = row.querySelector('[data-pfield="date"]');
        const amountInput = row.querySelector('[data-pfield="amount"]');
        const methodInput = row.querySelector('[data-pfield="method"]');
        if (dateInput && dateInput.value) p.date = dateInput.value;
        if (amountInput) p.amount = amountInput.value === '' ? 0 : Number(amountInput.value);
        if (methodInput) p.method = methodInput.value;
      });
    }
    // Sanitize payments — snap amounts to whole cents (no FP drift surviving
    // a round trip) and drop entries the user added but never filled in.
    const cleanPayments = data.payments
      .map(p => ({
        id: p.id || uid('p'),
        amount: round2(p.amount),
        date: p.date || date,
        method: (p.method || '').trim(),
        note: (p.note || '').trim(),
      }))
      .filter(p => p.amount > 0.005);
    // Discount: keep it whenever there's a positive value entered. Driven by
    // the value alone (not the field's hidden state) so it saves reliably.
    // Removing a discount clears the input, so value 0/empty → null.
    const discount = Number(discountValue.value) > 0
      ? { type: discountType.value === 'percent' ? 'percent' : 'amount', value: round2(Number(discountValue.value)) }
      : null;
    const payload = {
      customer, date, delivered,
      items: data.items, payments: cleanPayments,
      notes, shipping, discount,
    };
    // `paid` is derived from payments — compute it from the payload, don't
    // trust the toggle (the user may have left the payments section in a state
    // that disagrees with the toggle).
    payload.paid = orderIsFullyPaid(payload);
    let saved;
    const stockTouched = new Set();
    // Inventory is only adjusted once an order is BOTH paid AND delivered.
    // Strategy: undo the existing applied deduction (using its OLD items so
    // mid-edit item changes don't strand stock), then reapply the new state via
    // reconcileOrderInventory once the payload is in place.
    if (existing) {
      if (existing.inventoryApplied) {
        applyOrderInventoryDelta(existing.items, +1).forEach(p => stockTouched.add(p));
        existing.inventoryApplied = false;
      }
      Object.assign(existing, payload);
      saved = existing;
      toast('Order updated.');
    } else {
      // Use the id locked in at modal open so the preview invoice number and
      // the saved order's invoice number stay identical.
      saved = { id: data.id || uid('o'), inventoryApplied: false, ...payload };
      state.orders.push(saved);
      toast('Order added.');
    }
    reconcileOrderInventory(saved).forEach(p => stockTouched.add(p));
    saveState();
    cloudUpsert('orders', saved);
    if (stockTouched.size) cloudUpsertMany('stock', [...stockTouched]);
    renderOrders();
    renderInventory();
    renderDashboard();
    renderMonthly();
    closeModal();
  };

  // "View Invoice" — preview the invoice for this order without saving. Captures
  // the user's current form values into a draft so re-opening the form via the
  // Back button preserves their unsaved edits.
  form.querySelector('#viewInvoiceBtn').addEventListener('click', () => {
    const draft = {
      id: data.id,        // carry the order id so the preview invoice number matches
      customer: form.querySelector('[name="customer"]').value.trim(),
      date: form.querySelector('[name="date"]').value || todayISO(),
      paid: form.querySelector('[name="paid"]').checked,
      delivered: form.querySelector('[name="delivered"]').checked,
      notes: form.querySelector('[name="notes"]').value.trim(),
      shipping: shipField.hidden ? 0 : (Number(shipInput.value) || 0),
      items: data.items,
      payments: data.payments,
      discount: data.discount || null,
    };
    modal.classList.add('modal-readonly');
    $('#modalCancel').textContent = 'Close';
    renderInvoiceView({
      formEl: form,
      orders: [draft],
      customerName: draft.customer || 'Customer',
      dateKey: draft.date,
      onBack: () => orderModal(existing, draft),
      allowNotesEdit: false,
    });
  });

  if (existing) {
    form.querySelector('#orderDeleteBtn').addEventListener('click', () => {
      if (!confirm('Delete this order? This cannot be undone.')) return;
      // Restore inventory only if this order was currently deducting stock
      // (inventoryApplied flag). Avoids double-restoring orders that never
      // consumed inventory in the first place.
      const restored = existing.inventoryApplied ? applyOrderInventoryDelta(existing.items, +1) : [];
      const id = existing.id;
      state.orders = state.orders.filter(x => x.id !== id);
      saveState();
      cloudDelete('orders', id);
      if (restored.length) cloudUpsertMany('stock', restored);
      renderOrders();
      renderInventory();
      renderDashboard();
      renderMonthly();
      toast('Order deleted.');
      closeModal();
    });
  }

  showModal();
  // Custom typeahead on the customer field — native <datalist> stops filtering
  // after the first keystroke on Chromium unless the user re-clicks the field.
  attachTypeahead(form.querySelector('[name="customer"]'), () =>
    [...new Set(state.orders.map(o => (o.customer || '').trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b))
  );
  setTimeout(() => form.querySelector('[name="customer"]').focus(), 50);
}

// ---------- CUSTOMERS ----------
// Aggregate one customer's order activity into stats the list + profile show.
//   lifetime = total billed (sum of orderTotal across all of their orders).
//   paid     = cash received from them so far (paid portion of every order).
//   owed     = outstanding balance still owed.
//   pendingCount = orders that are NOT (paid AND delivered) — covers both
//     unpaid orders AND paid-but-undelivered orders so the Pending filter
//     surfaces every customer who has anything still in flight.
function customerStats(c) {
  const orders = state.orders.filter(o => customerKey(o.customer) === customerKey(c.name));
  const orderCount = orders.length;
  const lifetimeRev = orders.reduce((s, o) => s + orderTotal(o), 0);
  const paid = orders.reduce((s, o) => s + orderPaidRevenue(o), 0);
  const owed = orders.reduce((s, o) => s + orderBalance(o), 0);
  const lifetimeProfit = orders.reduce((s, o) => s + orderPaidProfit(o), 0);
  const pendingCount = orders.filter(o => !(o.paid && o.delivered)).length;
  const lastDate = orders.reduce((d, o) => (o.date && (!d || o.date > d)) ? o.date : d, '');
  return { orders, orderCount, lifetimeRev, paid, owed, lifetimeProfit, pendingCount, lastDate };
}

const custSearch = $('#custSearch');
const custFilter = $('#custFilter');
const custSort = $('#custSort');
persistFilter(custSearch, 'lumen.customers.search');
persistFilter(custFilter, 'lumen.customers.filter');
persistFilter(custSort, 'lumen.customers.sort');
wireSearchClear(custSearch);
[custSearch, custFilter, custSort].forEach(el => el.addEventListener('input', renderCustomers));
$('#custReset').addEventListener('click', () => resetFilters([custSearch, custFilter, custSort]));
$('#addCustomerBtn').addEventListener('click', () => customerModal());

function renderCustomers() {
  // Make sure every order has a matching profile so the user can always click
  // through from an order's customer name to their profile — even for new
  // names typed straight into an order without first creating a profile.
  const before = state.customers.length;
  state.customers = ensureCustomersFromOrders(state.customers, state.orders);
  if (state.customers.length !== before) {
    saveState();
    if (sb) cloudUpsertMany('customers', state.customers.slice(before));
  }

  const q = (custSearch.value || '').toLowerCase().trim();
  const filterKey = custFilter.value || 'all';
  const sortKey = custSort.value || 'recent';
  let rows = state.customers
    .map(c => ({ ...c, ...customerStats(c) }))
    .filter(c => {
      // Pending = anything not yet (paid AND delivered) — includes both
      // unpaid orders and paid-but-undelivered orders so the customer still
      // surfaces while there's work to do.
      if (filterKey === 'pending' && c.pendingCount === 0) return false;
      if (!q) return true;
      return [c.name, c.phone, c.email].some(v => (v || '').toLowerCase().includes(q));
    });

  if (sortKey === 'name') {
    rows.sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()));
  } else if (sortKey === 'lifetime') {
    rows.sort((a, b) => b.lifetimeRev - a.lifetimeRev);
  } else if (sortKey === 'owed') {
    // Pending Orders sort — customers with more incomplete orders bubble up;
    // tiebreaker is the unpaid balance so the biggest debts surface first.
    rows.sort((a, b) => (b.pendingCount - a.pendingCount) || (b.owed - a.owed));
  } else {
    // recent: most recent activity first; customers with no orders sink to the bottom.
    rows.sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''));
  }

  // KPI tiles — totals across every customer (not the filtered view) so they
  // stay stable while you scrub through filters / search.
  const totals = state.customers.reduce((acc, c) => {
    const s = customerStats(c);
    acc.rev += s.lifetimeRev; acc.profit += s.lifetimeProfit; acc.owed += s.owed;
    return acc;
  }, { rev: 0, profit: 0, owed: 0 });
  $('#custKpiCount').textContent = fmtN(state.customers.length);
  $('#custKpiRevenue').textContent = fmt$(round2(totals.rev));
  $('#custKpiProfit').textContent = fmt$(round2(totals.profit));
  $('#custKpiOwed').textContent = fmt$(round2(totals.owed));

  const body = $('#customersBody');
  body.innerHTML = rows.length
    ? rows.map(c => {
        const last = c.lastDate ? fmtDateShort(c.lastDate) : '<span class="muted">—</span>';
        const paidCell = c.paid > 0.005
          ? `<b class="cust-paid">${fmt$(round2(c.paid))}</b>`
          : `<span class="muted">—</span>`;
        // Pending column dollar value = outstanding balance owed. Customers
        // who only have paid-but-undelivered orders show "—" here (they owe
        // nothing) but still surface in the Pending filter via pendingCount.
        const pendingCell = c.owed > 0.005
          ? `<b class="cust-owed">${fmt$(round2(c.owed))}</b>`
          : `<span class="muted">—</span>`;
        return `<tr data-edit-customer="${c.id}">
          <td><b>${escapeHtml(c.name)}</b>${c.notes ? `<span class="customer-sub">${escapeHtml((c.notes || '').slice(0, 40))}${c.notes.length > 40 ? '…' : ''}</span>` : ''}</td>
          <td class="num">${fmtN(c.orderCount)}</td>
          <td class="num">${fmt$(round2(c.lifetimeRev))}</td>
          <td class="num">${paidCell}</td>
          <td class="num">${pendingCell}</td>
          <td>${last}</td>
          <td style="white-space:nowrap;text-align:right;"><button class="icon-btn" data-edit-customer-btn="${c.id}" title="Edit">✎</button></td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="7" class="muted" style="padding:24px;text-align:center;">No customers match.</td></tr>`;

  // Tap anywhere on the row OR the pencil to open the profile. Keep both
  // hooks since tapping the pencil should not bubble row-level click handlers.
  body.querySelectorAll('[data-edit-customer-btn]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = state.customers.find(x => x.id === el.dataset.editCustomerBtn);
      if (c) customerModal(c);
    });
  });
  body.querySelectorAll('[data-edit-customer]').forEach(el => {
    el.addEventListener('click', () => {
      const c = state.customers.find(x => x.id === el.dataset.editCustomer);
      if (c) customerModal(c);
    });
  });
}

function customerModal(existing) {
  const isNew = !existing;
  const initial = existing
    ? { ...existing }
    : { name: '', phone: '', email: '', address: '', notes: '' };

  $('#modalTitle').textContent = isNew ? 'New Customer' : 'Customer Profile';
  const form = $('#modalForm');
  const stats = existing ? customerStats(existing) : { orders: [], orderCount: 0, lifetimeRev: 0, lifetimeProfit: 0, owed: 0, lastDate: '' };

  form.innerHTML = `
    <label><span class="req">Name</span><input type="text" name="name" required value="${escapeHtml(initial.name)}" placeholder="Customer name" autocomplete="off" /></label>
    <div class="row-2">
      <label><span>Phone</span><input type="tel" name="phone" value="${escapeHtml(initial.phone)}" placeholder="Optional" inputmode="tel" /></label>
      <label><span>Email</span><input type="email" name="email" value="${escapeHtml(initial.email)}" placeholder="Optional" inputmode="email" /></label>
    </div>
    <label><span>Address</span><input type="text" name="address" value="${escapeHtml(initial.address)}" placeholder="Optional — pickup or delivery info" /></label>
    <label><span>Notes</span><textarea name="notes" rows="3" placeholder="Anything useful: preferences, allergies, recurring orders, payment quirks…">${escapeHtml(initial.notes || '')}</textarea></label>
    ${existing ? `
      <div class="customer-stats">
        <div class="cust-stat"><span class="cust-stat-label">Orders</span><b>${fmtN(stats.orderCount)}</b></div>
        <div class="cust-stat"><span class="cust-stat-label">Lifetime Rev</span><b>${fmt$(round2(stats.lifetimeRev))}</b></div>
        <div class="cust-stat"><span class="cust-stat-label">Lifetime Profit</span><b>${fmt$(round2(stats.lifetimeProfit))}</b></div>
        <div class="cust-stat${stats.owed > 0.005 ? ' cust-stat-owed' : ''}"><span class="cust-stat-label">Owed Now</span><b>${fmt$(round2(stats.owed))}</b></div>
      </div>
      <div class="customer-orders">
        <div class="customer-orders-head">Order History</div>
        ${stats.orderCount ? `
          <div class="customer-orders-list">
            ${stats.orders.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(o => {
              const status = orderIsFullyPaid(o)
                ? `<span class="pill green">Paid</span>`
                : orderIsPartiallyPaid(o)
                  ? `<span class="pill partial">Partial · ${fmt$(round2(orderBalance(o)))} due</span>`
                  : `<span class="pill amber">Unpaid</span>`;
              const inv = invoiceNumberForOrder(o);
              const items = orderItems(o).map(it => `${it.product || ''}${Number(it.qty)>0 ? ` ×${fmtN(it.qty)}` : ''}`).filter(Boolean).join(', ');
              return `<div class="customer-order-row" data-open-order="${o.id}">
                <div class="cor-head">
                  <span class="cor-date">${fmtDateShort(o.date)}</span>
                  <span class="cor-inv muted">${inv}</span>
                  <span class="cor-status">${status}</span>
                </div>
                <div class="cor-items muted">${escapeHtml(items) || '(no items)'}</div>
                <div class="cor-foot">
                  <span class="muted">Total</span><b>${fmt$(round2(orderTotal(o)))}</b>
                  <span class="muted">Profit</span><b>${fmt$(round2(orderProfit(o)))}</b>
                </div>
              </div>`;
            }).join('')}
          </div>
        ` : '<div class="muted" style="padding:6px 2px;">No orders yet.</div>'}
      </div>
      <button type="button" class="btn danger-outline" id="customerDeleteBtn">Delete Customer</button>
    ` : ''}
  `;

  // Open the order modal when the user taps an order in the history.
  form.querySelectorAll('[data-open-order]').forEach(el => el.addEventListener('click', () => {
    const o = state.orders.find(x => x.id === el.dataset.openOrder);
    if (o) orderModal(o);
  }));

  if (existing) {
    form.querySelector('#customerDeleteBtn').addEventListener('click', () => {
      const hasOrders = stats.orderCount > 0;
      const warn = hasOrders
        ? `Delete ${existing.name}? They have ${stats.orderCount} order${stats.orderCount === 1 ? '' : 's'} on record — those orders stay; only the profile (contact info + notes) is removed.`
        : `Delete ${existing.name}?`;
      if (!confirm(warn)) return;
      state.customers = state.customers.filter(x => x.id !== existing.id);
      saveState();
      cloudDelete('customers', existing.id);
      renderCustomers();
      toast('Customer deleted.');
      closeModal();
    });
  }

  modalOnSave = () => {
    const name = form.querySelector('[name="name"]').value.trim();
    const phone = form.querySelector('[name="phone"]').value.trim();
    const email = form.querySelector('[name="email"]').value.trim();
    const address = form.querySelector('[name="address"]').value.trim();
    const notes = form.querySelector('[name="notes"]').value.trim();
    if (!name) { alert('Name is required.'); return; }

    let saved;
    let renamedFrom = null;
    if (existing) {
      // Cascade rename — if the user changed the customer's name, propagate
      // it to every order they have so the link stays intact.
      const oldKey = customerKey(existing.name);
      const newKey = customerKey(name);
      if (oldKey && newKey && oldKey !== newKey) {
        const matching = state.orders.filter(o => customerKey(o.customer) === oldKey);
        if (matching.length) {
          const ok = confirm(`Rename "${existing.name}" → "${name}"?\n\n${matching.length} order${matching.length === 1 ? '' : 's'} reference this customer — they'll be updated to the new name.`);
          if (!ok) return;
          matching.forEach(o => { o.customer = name; });
          renamedFrom = { from: existing.name, to: name, orders: matching };
        }
      }
      Object.assign(existing, { name, phone, email, address, notes });
      saved = existing;
    } else {
      // A profile with this name may already exist (e.g. auto-created from
      // an order) — update it in place instead of creating a duplicate row.
      const dupe = findCustomerByName(name);
      if (dupe) {
        Object.assign(dupe, { name, phone, email, address, notes });
        saved = dupe;
      } else {
        saved = {
          id: 'c-' + Math.random().toString(36).slice(2, 10),
          name, phone, email, address, notes,
          createdAt: todayISO(),
        };
        state.customers.push(saved);
      }
    }
    saveState();
    cloudUpsert('customers', saved);
    if (renamedFrom && renamedFrom.orders.length) {
      cloudUpsertMany('orders', renamedFrom.orders);
      renderOrders(); renderDashboard(); renderMonthly();
    }
    renderCustomers();
    toast(existing ? 'Customer updated.' : 'Customer added.');
    closeModal();
  };

  showModal();
  setTimeout(() => form.querySelector('[name="name"]')?.focus(), 50);
}

// ---------- INVENTORY ----------
const stkSearch = $('#stkSearch');
const stkFilter = $('#stkFilter');
const stkCategory = $('#stkCategory');
persistFilter(stkSearch, 'lumen.stock.search');
persistFilter(stkFilter, 'lumen.stock.filter');
persistFilter(stkCategory, 'lumen.stock.category');
wireSearchClear(stkSearch);
[stkSearch, stkFilter, stkCategory].forEach(el => el.addEventListener('input', renderInventory));
$('#stkReset').addEventListener('click', () => resetFilters([stkSearch, stkFilter, stkCategory]));
$('#addStockBtn').addEventListener('click', () => stockModal());

// Apply a delta to stock for a list of order items.
// direction = -1 to deduct (a new sale), +1 to restore (deletion / undo).
// Returns the list of stock products that were modified, so callers can sync to cloud.
function applyOrderInventoryDelta(items, direction) {
  const updated = [];
  for (const it of items || []) {
    if (!it || !it.product) continue;
    const qty = Number(it.qty) || 0;
    if (qty <= 0) continue;
    const target = (it.product || '').toLowerCase().trim();
    const product = state.stock.find(p => (p.name || '').toLowerCase().trim() === target);
    if (!product) continue;
    product.qty = Math.max(0, (Number(product.qty) || 0) + direction * qty);
    if (product.qty > 0 && product.status !== 'ACTIVE') product.status = 'ACTIVE';
    if (!updated.includes(product)) updated.push(product);
  }
  return updated;
}

// Reorder thresholds. A product's reorder level is its own `reorder` value when
// set (> 0), otherwise a sensible global default. "Needs reorder" = an active
// product whose qty has fallen to or below that level (out-of-stock included).
const DEFAULT_REORDER_LEVEL = 5;
function stockReorderLevel(s) {
  const v = Number(s && s.reorder);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_REORDER_LEVEL;
}
function stockIsActive(s) { return ((s && s.status) || 'ACTIVE') === 'ACTIVE'; }
function stockIsOut(s) { return stockIsActive(s) && (Number(s && s.qty) || 0) <= 0; }
function stockNeedsReorder(s) {
  return stockIsActive(s) && (Number(s && s.qty) || 0) <= stockReorderLevel(s);
}

function renderInventory() {
  const q = stkSearch.value.toLowerCase().trim();
  const f = stkFilter.value;
  let rows = [...state.stock];
  if (q) rows = rows.filter(p => (p.name || '').toLowerCase().includes(q));
  if (f === 'active') rows = rows.filter(p => p.status === 'ACTIVE');
  if (f === 'oos') rows = rows.filter(p => p.status !== 'ACTIVE' || Number(p.qty) === 0);
  if (f === 'low') rows = rows.filter(p => stockNeedsReorder(p));
  const cat = stkCategory.value;
  if (cat !== 'all') rows = rows.filter(p => stockCategory(p) === cat);

  // sort: active first, then qty desc
  rows.sort((a, b) => (a.status === 'ACTIVE' ? 0 : 1) - (b.status === 'ACTIVE' ? 0 : 1) || (b.qty - a.qty));

  $('#stockBody').innerHTML = rows.map(p => {
    const margin = (Number(p.price) || 0) - (Number(p.cost) || 0);
    const valNet = margin * (Number(p.qty) || 0);
    const valGross = (Number(p.price) || 0) * (Number(p.qty) || 0);
    const isActive = p.status === 'ACTIVE';
    const out = stockIsOut(p);
    const needs = stockNeedsReorder(p);
    const lvl = stockReorderLevel(p);
    const customLvl = Number(p.reorder) > 0;
    const statusPill = !isActive
      ? `<span class="pill red">Out of Stock</span>`
      : out
        ? `<span class="pill red">Reorder · Out</span>`
        : needs
          ? `<span class="pill amber">Reorder</span>`
          : `<span class="pill green">Active</span>`;
    // On sale = original price set AND higher than the current selling price.
    // When true, show the original struck through next to the sale price.
    const origPrice = Number(p.originalPrice) || 0;
    const onSale = origPrice > (Number(p.price) || 0);
    const priceCell = onSale
      ? `<span class="inv-price-was">${fmt$(origPrice)}</span><span class="inv-price-now">${fmt$(p.price)}</span><span class="pill amber inv-sale-pill">Sale</span>`
      : fmt$(p.price);
    const cat = stockCategory(p);
    // Detail row carries the columns that get hidden on phones (cost, reorder
    // level, margin, and both stock values) so the same numbers are reachable
    // there by tapping the row. CSS keeps it out of the way on desktop, where
    // every column is already on screen.
    return `<tr class="inv-row${needs ? ' row-reorder' : ''}" data-stock-row="${p.id}">
      <td>
        <span class="inv-caret" aria-hidden="true">▶</span>
        <b>${escapeHtml(p.name)}</b>
        <span class="cat-tag cat-${cat}">${escapeHtml(categoryLabel(cat))}</span>
      </td>
      <td class="num">${fmt$(p.cost)}</td>
      <td class="num">${priceCell}</td>
      <td class="num"><b>${fmtN(p.qty)}</b></td>
      <td class="num muted${customLvl ? ' reorder-custom' : ''}" title="${customLvl ? 'Custom reorder level' : 'Default reorder level'}">${fmtN(lvl)}</td>
      <td class="num">${fmt$(margin)}</td>
      <td class="num">${fmt$(valNet)}</td>
      <td class="num">${fmt$(valGross)}</td>
      <td>${statusPill}</td>
      <td style="white-space:nowrap;">
        <button class="icon-btn" data-edit-stock="${p.id}" title="Edit">✎</button>
        <button class="icon-btn danger" data-del-stock="${p.id}" title="Delete">🗑</button>
      </td>
    </tr>
    <tr class="inv-detail" data-stock-detail="${p.id}" hidden>
      <td colspan="10">
        <div class="inv-strip">
          <div class="inv-cell"><span>Cost</span><b>${fmt$(p.cost)}</b></div>
          <div class="inv-cell"><span>Margin / Unit</span><b class="inv-pos">${fmt$(margin)}</b></div>
          <div class="inv-cell hl"><span>Stock Value (Gross)</span><b>${fmt$(valGross)}</b></div>
          <div class="inv-cell hl"><span>Stock Value (Net)</span><b class="inv-pos">${fmt$(valNet)}</b></div>
          <div class="inv-cell"><span>Reorder At</span><b>${fmtN(lvl)}</b></div>
          <div class="inv-cell"><span>Category</span><b>${escapeHtml(categoryLabel(cat))}</b></div>
        </div>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="10" class="muted" style="padding:24px;text-align:center;">No products match.</td></tr>`;

  // Summary tiles at the top of the page — respect the current search/filter so
  // they reflect exactly what's visible (e.g. filtering to Low Stock recalcs).
  const sumNet = rows.reduce((s, p) => s + ((Number(p.price) || 0) - (Number(p.cost) || 0)) * (Number(p.qty) || 0), 0);
  const sumGross = rows.reduce((s, p) => s + (Number(p.price) || 0) * (Number(p.qty) || 0), 0);
  const margin = sumGross > 0 ? (sumNet / sumGross) * 100 : 0;
  $('#invKpiCount').textContent = fmtN(rows.length);
  $('#invKpiGross').textContent = fmt$(sumGross);
  $('#invKpiNet').textContent = fmt$(sumNet);
  $('#invKpiMargin').textContent = fmtPct(margin);

  // Tap a product row to open its detail strip. Only meaningful on phones —
  // desktop shows every column already, so CSS keeps the strip collapsed there.
  $$('#stockBody [data-stock-row]').forEach(row => row.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;   // edit / delete handle themselves
    const detail = $(`#stockBody [data-stock-detail="${row.dataset.stockRow}"]`);
    if (!detail) return;
    const open = detail.hidden;
    detail.hidden = !open;
    row.classList.toggle('open', open);
  }));

  $$('#stockBody [data-edit-stock]').forEach(el => el.addEventListener('click', () => {
    const p = state.stock.find(x => x.id === el.dataset.editStock);
    if (p) stockModal(p);
  }));
  $$('#stockBody [data-del-stock]').forEach(el => el.addEventListener('click', () => {
    if (!confirm('Delete this product?')) return;
    const id = el.dataset.delStock;
    state.stock = state.stock.filter(x => x.id !== id);
    saveState(); cloudDelete('stock', id); renderInventory(); renderDashboard(); toast('Product deleted.');
  }));
}

function stockModal(existing) {
  const initial = existing
    ? { ...existing }
    : { name: '', cost: 0, price: 0, originalPrice: '', qty: 0, status: 'ACTIVE', reorder: '', category: DEFAULT_CATEGORY };
  // Normalize originalPrice for the form: '' shows blank when there's no sale,
  // and a number shows when one is set.
  if (existing && (initial.originalPrice == null || Number(initial.originalPrice) <= 0)) initial.originalPrice = '';
  initial.category = stockCategory(initial);
  openModal(existing ? 'Edit Product' : 'New Product', [
    { name: 'name', label: 'Product Name', required: true },
    { name: 'category', label: 'Category', type: 'select',
      options: CATEGORIES.map(c => ({ value: c.key, label: c.label })) },
    { type: 'row', fields: [
      { name: 'cost', label: 'Purchase Price (Cost)', type: 'number', min: 0 },
      { name: 'price', label: 'Selling Price', type: 'number', min: 0 },
    ]},
    { type: 'row', fields: [
      { name: 'originalPrice', label: 'Original Price (was)', type: 'number', min: 0, placeholder: 'Optional — leave blank if not on sale' },
      { name: 'qty', label: 'Quantity Available', type: 'number', min: 0 },
    ]},
    { type: 'row', fields: [
      { name: 'reorder', label: 'Reorder At', type: 'number', min: 0, placeholder: `Alert level (default ${DEFAULT_REORDER_LEVEL})` },
      { name: 'status', label: 'Status', type: 'select', options: [
        { value: 'ACTIVE', label: 'Active' },
        { value: 'OUT OF STOCK', label: 'Out of Stock' },
      ]},
    ]},
  ], (data) => {
    if (!data.name) { alert('Name is required.'); return false; }
    let saved;
    let renameSummary = null;
    if (existing) {
      const oldName = (existing.name || '').trim();
      const newName = (data.name || '').trim();
      // Cascade rename: if the product name changed, update every shipment
      // and order line item that referenced the old name (case-insensitive
      // match) so inventory linkage stays intact.
      if (oldName && newName && oldName.toLowerCase() !== newName.toLowerCase()) {
        const target = oldName.toLowerCase();
        const shipMatches = state.shipments.filter(s =>
          (s.product || '').toLowerCase().trim() === target
        );
        const orderMatches = state.orders.filter(o =>
          (o.items || []).some(it => (it.product || '').toLowerCase().trim() === target)
        );
        const refCount = shipMatches.length + orderMatches.length;
        if (refCount > 0) {
          const ok = confirm(
            `Rename "${oldName}" → "${newName}"?\n\n` +
            `${shipMatches.length} shipment${shipMatches.length === 1 ? '' : 's'} and ` +
            `${orderMatches.length} order${orderMatches.length === 1 ? '' : 's'} reference this product. ` +
            `They'll be updated to the new name so inventory tracking keeps working.`
          );
          if (!ok) return false;
          shipMatches.forEach(s => { s.product = newName; });
          orderMatches.forEach(o => {
            (o.items || []).forEach(it => {
              if ((it.product || '').toLowerCase().trim() === target) it.product = newName;
            });
          });
          renameSummary = { ships: shipMatches, orders: orderMatches };
        }
      }
      Object.assign(existing, data);
      saved = existing;
    } else {
      saved = { id: uid('s'), ...data };
      state.stock.push(saved);
    }
    saveState();
    cloudUpsert('stock', saved);
    if (renameSummary) {
      if (renameSummary.ships.length) cloudUpsertMany('shipments', renameSummary.ships);
      if (renameSummary.orders.length) cloudUpsertMany('orders', renameSummary.orders);
      renderShipments();
      renderOrders();
    }
    renderInventory();
    renderDashboard();
    if (renameSummary) {
      const total = renameSummary.ships.length + renameSummary.orders.length;
      toast(`Renamed. ${total} reference${total === 1 ? '' : 's'} updated.`);
    } else {
      toast(existing ? 'Product updated.' : 'Product added.');
    }
  }, initial);
}


// ---------- Tap surfaces: menus, sheets, filter panels ----------
// One primitive behind every tap-to-open surface in the app. On a phone it
// presents as a bottom sheet — thumb-reachable, safe-area aware, big rows. On
// anything wider it becomes a popover anchored to whatever was tapped. Both
// share the same dismiss rules so the behaviour is never surprising.
const PHONE_QUERY = '(max-width: 640px)';
function isPhoneWidth() {
  try { return window.matchMedia(PHONE_QUERY).matches; } catch { return window.innerWidth <= 640; }
}

let activeOverlay = null;

function closeOverlay() {
  if (!activeOverlay) return;
  const ov = activeOverlay;
  activeOverlay = null;
  ov.backdrop.classList.remove('show');
  ov.panel.classList.remove('show');
  document.removeEventListener('keydown', ov.onKey, true);
  window.removeEventListener('resize', ov.onReflow);
  window.removeEventListener('scroll', ov.onReflow, true);
  if (ov.locked) unlockBodyScroll();
  // Let the transition finish before the nodes go, so it doesn't snap shut.
  // onClose runs first so borrowed DOM (the live filter fields) is returned
  // before the wrapper is removed from the document.
  try { ov.onClose && ov.onClose(); } catch (e) { console.error('overlay onClose failed', e); }
  setTimeout(() => {
    ov.backdrop.remove();
    ov.panel.remove();
  }, 200);
}

// Keep a popover inside the viewport: prefer directly under the anchor and
// right-aligned to it, then clamp. On a phone this is skipped entirely.
function positionPopover(panel, anchor) {
  if (!anchor) {
    panel.style.top = '50%';
    panel.style.left = '50%';
    panel.style.transform = 'translate(-50%, -50%)';
    return;
  }
  const r = anchor.getBoundingClientRect();
  const pad = 8;
  const pw = panel.offsetWidth;
  const ph = panel.offsetHeight;
  let left = r.right - pw;
  let top = r.bottom + 6;
  // Flip above when there isn't room below.
  if (top + ph > window.innerHeight - pad) {
    const above = r.top - ph - 6;
    if (above > pad) top = above;
    else top = Math.max(pad, window.innerHeight - ph - pad);
  }
  left = Math.min(Math.max(pad, left), window.innerWidth - pw - pad);
  panel.style.top = top + 'px';
  panel.style.left = left + 'px';
}

// buildBody(bodyEl, close) fills the panel. onClose fires exactly once, before
// the nodes are detached.
function openOverlayPanel({ anchor, title, subtitle, buildBody, onClose, wide }) {
  closeOverlay();
  const phone = isPhoneWidth();

  const backdrop = document.createElement('div');
  backdrop.className = 'ov-backdrop';

  const panel = document.createElement('div');
  panel.className = 'ov-panel ' + (phone ? 'ov-sheet' : 'ov-popover') + (wide ? ' ov-wide' : '');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');

  if (phone) panel.innerHTML = '<div class="ov-grabber"></div>';
  if (title) {
    const head = document.createElement('div');
    head.className = 'ov-head';
    head.innerHTML = '<span class="ov-title">' + escapeHtml(title) + '</span>' +
      (subtitle ? '<span class="ov-sub">' + escapeHtml(subtitle) + '</span>' : '');
    panel.appendChild(head);
  }
  const body = document.createElement('div');
  body.className = 'ov-body';
  panel.appendChild(body);

  const ov = { backdrop, panel, onClose, locked: phone };
  ov.onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeOverlay(); } };
  // A popover is anchored to a moving element, so it follows layout changes.
  // The sheet is fixed to the bottom and doesn't care.
  ov.onReflow = () => { if (phone) return; positionPopover(panel, anchor); };

  buildBody(body, closeOverlay);

  document.body.appendChild(backdrop);
  document.body.appendChild(panel);
  activeOverlay = ov;

  if (phone) lockBodyScroll();
  else positionPopover(panel, anchor);

  backdrop.addEventListener('click', closeOverlay);
  document.addEventListener('keydown', ov.onKey, true);
  window.addEventListener('resize', ov.onReflow);
  window.addEventListener('scroll', ov.onReflow, true);

  // Force a reflow so the browser registers the closed state, then flip to
  // open in the same tick. requestAnimationFrame would be the usual trick, but
  // it can be throttled or skipped (background tab, nested frame) and the panel
  // would then sit off-screen with no way back.
  void panel.offsetHeight;
  backdrop.classList.add('show');
  panel.classList.add('show');
  return closeOverlay;
}

// Row action menu. Each action is { label, hint, icon, danger, confirm, onSelect }.
// A 'confirm' action doesn't fire on first tap — the menu swaps to an inline
// confirm step instead. That keeps destructive taps deliberate without a native
// confirm() dialog, which on iOS blocks the whole page.
function openActionMenu(anchor, title, actions, subtitle) {
  return openOverlayPanel({
    anchor, title, subtitle,
    buildBody: (body, close) => {
      const draw = (confirming) => {
        body.innerHTML = '';
        const list = confirming ? [confirming.confirmStep] : actions;
        for (const a of list) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ov-item' + (a.danger ? ' danger' : '');
          btn.innerHTML =
            '<span class="ov-item-icon">' + (a.icon || '') + '</span>' +
            '<span class="ov-item-text"><span class="ov-item-label">' + escapeHtml(a.label) + '</span>' +
            (a.hint ? '<span class="ov-item-hint">' + escapeHtml(a.hint) + '</span>' : '') + '</span>';
          btn.addEventListener('click', () => {
            if (a.confirm) {
              draw({
                confirmStep: {
                  label: a.confirm,
                  hint: 'Tap again to confirm — this cannot be undone.',
                  icon: a.icon,
                  danger: true,
                  onSelect: a.onSelect,
                },
              });
              return;
            }
            close();
            // Defer so the panel is visually gone before a modal opens over it.
            setTimeout(() => a.onSelect && a.onSelect(), 0);
          });
          body.appendChild(btn);
        }
        if (confirming) {
          const back = document.createElement('button');
          back.type = 'button';
          back.className = 'ov-item ov-item-quiet';
          back.innerHTML = '<span class="ov-item-icon">‹</span><span class="ov-item-text"><span class="ov-item-label">Cancel</span></span>';
          back.addEventListener('click', () => draw(null));
          body.appendChild(back);
        }
      };
      draw(null);
    },
  });
}

// ---------- Filter panels ----------
// The real <select> elements live in a hidden host in the page and are moved
// into the panel on open, then moved back on close. Nothing is cloned, so the
// existing persistFilter() wiring, saved values, and change listeners all keep
// working untouched.
function openFilterPanel(anchor, hostId, onCleared) {
  const fields = document.getElementById(hostId);
  if (!fields) return;
  const home = fields.parentNode;
  fields.hidden = false;
  openOverlayPanel({
    anchor,
    title: 'Filters',
    wide: true,
    buildBody: (body, close) => {
      body.appendChild(fields);
      const foot = document.createElement('div');
      foot.className = 'ov-foot';
      foot.innerHTML =
        '<button type="button" class="btn ghost" data-ov-clear>Clear all</button>' +
        '<button type="button" class="btn primary" data-ov-done>Done</button>';
      foot.querySelector('[data-ov-clear]').addEventListener('click', () => {
        onCleared && onCleared();
      });
      foot.querySelector('[data-ov-done]').addEventListener('click', close);
      body.appendChild(foot);
    },
    onClose: () => {
      fields.hidden = true;
      home.appendChild(fields);
    },
  });
}

// Active-filter chips. \'fields\' is [{ el, label, format }]; a filter counts as
// active when its value isn't the first option ("all"). Tapping a chip clears
// just that one. Returns the active count so the button can show a badge.
function renderFilterChips(container, fields, searchEl) {
  if (!container) return 0;
  const chips = [];
  if (searchEl && searchEl.value.trim()) {
    chips.push({
      label: 'Search',
      value: searchEl.value.trim(),
      clear: () => { searchEl.value = ''; searchEl.dispatchEvent(new Event('input', { bubbles: true })); },
    });
  }
  for (const f of fields) {
    const el = f.el;
    if (!el || !el.value || el.value === 'all' || el.value === '') continue;
    const opt = el.options[el.selectedIndex];
    chips.push({
      label: f.label,
      value: f.format ? f.format(el.value) : (opt ? opt.textContent : el.value),
      clear: () => { el.value = 'all'; el.dispatchEvent(new Event('input', { bubbles: true })); },
    });
  }
  container.innerHTML = chips.map((c, i) =>
    '<button type="button" class="filter-chip" data-chip="' + i + '">' +
      '<span class="fc-label">' + escapeHtml(c.label) + '</span>' +
      '<span class="fc-value">' + escapeHtml(String(c.value)) + '</span>' +
      '<span class="fc-x" aria-hidden="true">×</span>' +
    '</button>').join('');
  container.hidden = chips.length === 0;
  container.querySelectorAll('[data-chip]').forEach(btn => {
    btn.addEventListener('click', () => chips[Number(btn.dataset.chip)].clear());
  });
  return chips.length;
}

// Mirror the active count onto the Filters button so the state is visible
// without opening the panel.
function setFilterCount(btnId, n) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const badge = btn.querySelector('.filter-count');
  if (!badge) return;
  badge.textContent = n ? String(n) : '';
  btn.classList.toggle('has-filters', n > 0);
}

// ---------- Collapsible analysis cards ----------
// The breakdown / vendor cards are useful on a desktop and just a wall to
// scroll past on a phone. Collapsed by default under the phone breakpoint,
// always open above it.
function wireCollapsibleCard(cardId) {
  const card = document.getElementById(cardId);
  if (!card || card.dataset.collapseWired) return;
  card.dataset.collapseWired = '1';
  const head = card.querySelector('.card-head');
  const bodyEl = card.querySelector('[data-collapse-body]');
  if (!head || !bodyEl) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card-collapse-btn';
  btn.setAttribute('aria-label', 'Toggle section');
  btn.innerHTML = '<span class="cc-chevron">▾</span>';
  head.appendChild(btn);
  const apply = (open) => {
    card.classList.toggle('is-collapsed', !open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  // Phones start collapsed; wider screens are always open.
  apply(!isPhoneWidth());
  head.addEventListener('click', (e) => {
    if (!isPhoneWidth()) return;
    if (e.target.closest('a, select, input')) return;
    apply(card.classList.contains('is-collapsed'));
  });
  window.addEventListener('resize', () => { if (!isPhoneWidth()) apply(true); });
}



// Mark a shipment delivered or not from anywhere in the UI. Owns the whole
// side-effect chain so the row toggle, the timeline menu and the modals cannot
// drift apart: set the flag, stamp or clear the received date, move inventory,
// then sync. Pass an explicit date to record a delivery that happened on a day
// other than today.
function setShipmentsDelivered(list, delivered, dateISO) {
  const shipments = (Array.isArray(list) ? list : [list]).filter(Boolean);
  if (!shipments.length) return;
  const stockTouched = [];
  for (const sh of shipments) {
    const was = !!sh.delivered;
    sh.delivered = !!delivered;
    if (sh.delivered) {
      // An explicit date always wins; otherwise stamp today, but never
      // clobber a date already recorded.
      if (dateISO) sh.dateReceived = dateISO;
      else if (!sh.dateReceived) sh.dateReceived = todayISO();
    } else {
      sh.dateReceived = '';
    }
    if (was !== sh.delivered) {
      const p = applyShipmentInventoryDelta(sh, sh.delivered);
      if (p && !stockTouched.includes(p)) stockTouched.push(p);
    }
  }
  saveState();
  cloudUpsertMany('shipments', shipments);
  if (stockTouched.length) {
    cloudUpsertMany('stock', stockTouched);
    toast('Inventory updated: ' + stockTouched.map(p => p.name + ' now ' + fmtN(p.qty)).join(', ') + '.');
  } else if (delivered) {
    const when = shipments[0].dateReceived;
    toast('Marked delivered' + (when ? ' ' + fmtDateShort(when) : '') + '.');
  } else {
    toast('Moved back to in transit.');
  }
  renderShipments(); renderInventory(); renderDashboard();
}
// Single-shipment convenience, so call sites read naturally.
function setShipmentDelivered(sh, delivered, dateISO) {
  setShipmentsDelivered([sh], delivered, dateISO);
}

// Tap the timeline cell to say when something actually landed. The common
// cases are one tap; the date picker is there for anything older. On iOS the
// date input opens the native wheel.
function openDeliveryDateMenu(anchor, list) {
  const shipments = (Array.isArray(list) ? list : [list]).filter(Boolean);
  if (!shipments.length) return;
  const sh = shipments[0];
  const many = shipments.length > 1;
  // A group counts as delivered only when every line in it is.
  const allDelivered = shipments.every(x => x.delivered);
  const iso = (daysAgo) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  };
  const received = shipments.map(x => x.dateReceived || '').filter(Boolean).sort().pop() || '';
  const base = allDelivered
    ? (received ? 'Received ' + fmtDateShort(received) : 'Delivered, no date recorded')
    : shipmentStatus(sh).detail || 'In transit';
  const label = many ? base + ' · ' + shipments.length + ' products' : base;

  openOverlayPanel({
    anchor,
    title: (sh.vendor || '').trim() || 'Shipment',
    subtitle: label,
    buildBody: (body, close) => {
      const add = (text, hint, icon, onSelect, danger) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ov-item' + (danger ? ' danger' : '');
        b.innerHTML = '<span class="ov-item-icon">' + icon + '</span>' +
          '<span class="ov-item-text"><span class="ov-item-label">' + escapeHtml(text) + '</span>' +
          (hint ? '<span class="ov-item-hint">' + escapeHtml(hint) + '</span>' : '') + '</span>';
        b.addEventListener('click', () => { close(); setTimeout(onSelect, 0); });
        body.appendChild(b);
      };

      const applyTo = many ? shipments.length + ' products' : '';
      add('Delivered today', [fmtDateShort(iso(0)), applyTo].filter(Boolean).join(' · '), '✓',
        () => setShipmentsDelivered(shipments, true, iso(0)));
      add('Delivered yesterday', [fmtDateShort(iso(1)), applyTo].filter(Boolean).join(' · '), '✓',
        () => setShipmentsDelivered(shipments, true, iso(1)));

      // Inline date picker for anything further back.
      const wrap = document.createElement('label');
      wrap.className = 'ov-datefield';
      wrap.innerHTML = '<span>Another date</span>';
      const input = document.createElement('input');
      input.type = 'date';
      input.max = todayISO();
      if (sh.dateOrdered) input.min = sh.dateOrdered;
      input.value = received;
      input.addEventListener('change', () => {
        if (!input.value) return;
        const picked = input.value;
        closeOverlay();
        setTimeout(() => setShipmentsDelivered(shipments, true, picked), 0);
      });
      wrap.appendChild(input);
      body.appendChild(wrap);

      if (shipments.some(x => x.delivered)) {
        add('Not delivered yet', 'Clears the date and takes the stock back out',
          '↩', () => setShipmentsDelivered(shipments, false), true);
      }
    },
  });
}

// ---------- Vendor name normalization ----------
// The same supplier gets typed several ways over a year — "Tracy QST",
// "TRACY QST", "QST Tracy" — and every variant used to count as its own vendor
// in the filter and the performance card. Two tiers here, on purpose:
//
//   Automatic: variants that are unmistakably the same string — identical once
//   case, spacing and punctuation are ignored, or the same words in a different
//   order. Those are rewritten to one spelling without asking.
//
//   Suggested: abbreviations and one-name-inside-another ("SBL" vs "Silverback
//   Labs", "APS" vs "Andy Peps Studio (APS)"). Those are a guess about the
//   business rather than about the text, so they are offered for review and
//   merged only on an explicit tap.
const VENDOR_TABLES = ['shipments', 'expenses'];

// Case, spacing and punctuation all collapse away. "PCTZone" and "PCT Zone"
// share a key; "Tracy QST" and "Health Warehouse" do not.
function vendorKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
// Same words in any order: catches "QST Tracy" against "Tracy QST".
function vendorTokenKey(name) {
  const parts = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return parts.length > 1 ? parts.slice().sort().join(' ') : '';
}
function isAllCapsName(name) {
  const letters = String(name || '').replace(/[^A-Za-z]/g, '');
  return letters.length > 1 && letters === letters.toUpperCase();
}

// Choose which spelling survives a merge. Most-used wins, because that is the
// one already recognizable across the history. Ties fall to the more readable
// form: mixed case over shouting, spaced words over run-together, then longer,
// then alphabetical so the result never depends on iteration order.
function pickCanonicalVendor(counts) {
  const entries = [...counts.entries()];
  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const capsA = isAllCapsName(a[0]) ? 1 : 0, capsB = isAllCapsName(b[0]) ? 1 : 0;
    if (capsA !== capsB) return capsA - capsB;
    const wordsA = a[0].trim().split(/\s+/).length, wordsB = b[0].trim().split(/\s+/).length;
    if (wordsA !== wordsB) return wordsB - wordsA;
    if (b[0].length !== a[0].length) return b[0].length - a[0].length;
    return a[0].localeCompare(b[0]);
  });
  return entries[0][0];
}

// Every vendor spelling in use, counted across both tables so a name used
// mostly on expenses still wins on shipments.
function collectVendorCounts() {
  const counts = new Map();
  for (const table of VENDOR_TABLES) {
    for (const row of (state[table] || [])) {
      const raw = String(row.vendor || '').trim();
      if (!raw) continue;
      counts.set(raw, (counts.get(raw) || 0) + 1);
    }
  }
  return counts;
}

// Map each spelling to the one it should become. Only unmistakable variants
// are included; anything needing judgement is left out and surfaced instead.
function buildVendorRenameMap() {
  const counts = collectVendorCounts();
  const groups = new Map();
  for (const [name, n] of counts) {
    const k = vendorKey(name);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, new Map());
    groups.get(k).set(name, n);
  }
  // Second pass: fold together buckets whose names are the same words
  // reordered, so a swap lands in the same group as a casing variant.
  const byTokens = new Map();
  for (const [k, members] of groups) {
    for (const name of members.keys()) {
      const tk = vendorTokenKey(name);
      if (!tk) continue;
      if (!byTokens.has(tk)) byTokens.set(tk, new Set());
      byTokens.get(tk).add(k);
    }
  }
  for (const keys of byTokens.values()) {
    if (keys.size < 2) continue;
    const [first, ...rest] = [...keys];
    const target = groups.get(first);
    if (!target) continue;
    for (const k of rest) {
      const members = groups.get(k);
      if (!members) continue;
      for (const [n, c] of members) target.set(n, (target.get(n) || 0) + c);
      groups.delete(k);
    }
  }

  const renames = new Map();
  for (const members of groups.values()) {
    if (members.size < 2) continue;
    const canonical = pickCanonicalVendor(members);
    for (const name of members.keys()) {
      if (name !== canonical) renames.set(name, canonical);
    }
  }
  return renames;
}

// Apply the automatic renames. Idempotent — once the data is clean this finds
// nothing and does nothing. Returns a summary so the caller can report it.
function normalizeVendorNames(opts) {
  const push = !!(opts && opts.push);
  const announce = !!(opts && opts.announce);
  const renames = buildVendorRenameMap();
  if (!renames.size) return { changed: 0, merges: [] };
  const touched = { shipments: [], expenses: [] };
  for (const table of VENDOR_TABLES) {
    for (const row of (state[table] || [])) {
      const raw = String(row.vendor || '').trim();
      const target = renames.get(raw);
      if (target && target !== row.vendor) {
        row.vendor = target;
        touched[table].push(row);
      }
    }
  }
  const changed = touched.shipments.length + touched.expenses.length;
  if (!changed) return { changed: 0, merges: [] };

  saveState();
  if (push && sb) {
    if (touched.shipments.length) cloudUpsertMany('shipments', touched.shipments);
    if (touched.expenses.length) cloudUpsertMany('expenses', touched.expenses);
  }
  const merges = [...new Set(renames.values())].map(canonical => ({
    canonical,
    from: [...renames.entries()].filter(([, t]) => t === canonical).map(([f]) => f),
  }));
  if (announce) {
    const first = merges[0];
    const extra = merges.length > 1 ? ' and ' + (merges.length - 1) + ' more' : '';
    toast('Vendor names tidied: ' + first.from.map(f => '"' + f + '"').join(', ') +
      ' now "' + first.canonical + '"' + extra + '.');
  }
  console.log('vendor names normalized', { changed, merges });
  return { changed, merges };
}

// ---------- Suggested merges (need a human) ----------
// Abbreviations and containment. Deliberately not automatic: "SBL" is probably
// Silverback Labs, but that is a claim about the business, and an unwanted
// merge is tedious to unpick by hand.
// Words in a name, with CamelCase split apart so "SilverBack Labs" yields
// silver / back / labs — which is what makes its initials "SBL".
function vendorWords(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}
function vendorInitials(name) {
  const w = vendorWords(name);
  return w.length >= 2 ? w.map(x => x[0]).join('') : '';
}

// Score every plausible pair, strongest signal first, then take them greedily.
// Ranking matters: "SBL" is a candidate for both "SilverBack Labs" (its
// initials) and "SBL Group Order" (word containment). The initials pairing is
// the more meaningful one, so it gets to claim the name first.
const VENDOR_MATCH_INITIALS = 0;
const VENDOR_MATCH_WORDS = 1;
const VENDOR_MATCH_PREFIX = 2;

function vendorMatchRank(long, short) {
  const longKey = vendorKey(long), shortKey = vendorKey(short);
  if (!shortKey || shortKey.length < 2) return null;
  if (vendorInitials(long).length >= 2 && shortKey === vendorInitials(long)) {
    return VENDOR_MATCH_INITIALS;
  }
  const longWords = new Set(vendorWords(long));
  const shortWords = vendorWords(short);
  // Whole-word containment. A bare substring test was matching "SBL" inside
  // "Shoe(s Bl)ack Stone Cover".
  if (shortWords.length && shortWords.every(w => longWords.has(w))) return VENDOR_MATCH_WORDS;
  // The short name is how the long one starts — covers "Bac Water" against
  // "Bacwater.com".
  if (shortKey.length >= 4 && longKey.startsWith(shortKey)) return VENDOR_MATCH_PREFIX;
  return null;
}

function suggestedVendorMerges() {
  const counts = collectVendorCounts();
  const names = [...counts.keys()];
  const pairs = [];
  for (const long of names) {
    for (const short of names) {
      if (short === long) continue;
      // Only consider the shorter name as the abbreviation of the longer one,
      // so each pair is examined once in one direction.
      if (short.length > long.length) continue;
      const rank = vendorMatchRank(long, short);
      if (rank == null) continue;
      pairs.push({ long, short, rank, weight: (counts.get(long) || 0) + (counts.get(short) || 0) });
    }
  }
  pairs.sort((a, b) => a.rank - b.rank || b.weight - a.weight || a.long.localeCompare(b.long));

  const used = new Set();
  const groups = [];
  for (const p of pairs) {
    if (used.has(p.long) || used.has(p.short)) continue;
    used.add(p.long); used.add(p.short);
    const all = [p.long, p.short]
      // Most-used first: that is the name most likely worth keeping, and it
      // becomes the leading button in the review sheet.
      .sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.localeCompare(b));
    groups.push({
      keep: all[0],
      others: all.slice(1),
      counts: Object.fromEntries(all.map(n => [n, counts.get(n) || 0])),
    });
  }
  return groups;
}

// Rewrite every row using any name in from[] to use to, then sync.
function mergeVendorInto(from, to) {
  const set = new Set(from.map(f => String(f).trim()));
  const touched = { shipments: [], expenses: [] };
  for (const table of VENDOR_TABLES) {
    for (const row of (state[table] || [])) {
      if (set.has(String(row.vendor || '').trim()) && row.vendor !== to) {
        row.vendor = to;
        touched[table].push(row);
      }
    }
  }
  const changed = touched.shipments.length + touched.expenses.length;
  if (!changed) return 0;
  saveState();
  if (sb) {
    if (touched.shipments.length) cloudUpsertMany('shipments', touched.shipments);
    if (touched.expenses.length) cloudUpsertMany('expenses', touched.expenses);
  }
  return changed;
}

// Review sheet: one card per suspected duplicate, tap the name to keep.
function openVendorMergeSheet(anchor) {
  const groups = suggestedVendorMerges();
  openOverlayPanel({
    anchor,
    title: 'Tidy vendor names',
    subtitle: groups.length ? groups.length + ' to review' : 'Nothing to review',
    wide: true,
    buildBody: (body, close) => {
      if (!groups.length) {
        body.innerHTML = '<p class="ov-empty">Every vendor name is already distinct. ' +
          'Spelling and capitalisation variants are merged automatically.</p>';
        return;
      }
      const note = document.createElement('p');
      note.className = 'ov-empty';
      note.textContent = 'These may be the same supplier written two ways. ' +
        'Pick the name to keep — nothing changes until you tap.';
      body.appendChild(note);
      for (const g of groups) {
        const all = [g.keep, ...g.others];
        const row = document.createElement('div');
        row.className = 'vm-group';
        row.innerHTML = '<div class="vm-names">' + all.map(n =>
          '<span class="vm-name">' + escapeHtml(n) +
          '<span class="vm-count">' + (g.counts[n] || 0) + '</span></span>'
        ).join('<span class="vm-join">or</span>') + '</div>';
        const picks = document.createElement('div');
        picks.className = 'vm-picks';
        for (const keep of all) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn ghost vm-pick';
          b.textContent = 'Keep ' + keep;
          b.addEventListener('click', () => {
            const n = mergeVendorInto(all.filter(x => x !== keep), keep);
            renderShipments(); renderExpenses(); renderDashboard();
            toast(n ? 'Merged ' + n + ' record' + (n === 1 ? '' : 's') + ' into "' + keep + '".'
                    : 'Nothing to merge.');
            close();
          });
          picks.appendChild(b);
        }
        row.appendChild(picks);
        body.appendChild(row);
      }
    },
  });
}

// ---------- SHIPMENTS ----------
const shipSearch = $('#shipSearch');
const shipFilter = $('#shipFilter');
const shipSort = $('#shipSort');
const shipCategory = $('#shipCategory');
const shipVendor = $('#shipVendor');
const shipMonth = $('#shipMonth');
const SHIP_VENDOR_KEY = 'lumen.shipments.vendor';
const SHIP_MONTH_KEY = 'lumen.shipments.month';
// Product categories are a fixed list, so this dropdown can be built once.
// Vendor and month depend on the data and get rebuilt on every render.
shipCategory.innerHTML = '<option value="all">All Categories</option>' +
  CATEGORIES.map(c => `<option value="${c.key}">${c.label}</option>`).join('');
persistFilter(shipSearch, 'lumen.shipments.search');
persistFilter(shipFilter, 'lumen.shipments.filter');
persistFilter(shipSort, 'lumen.shipments.sort');
persistFilter(shipCategory, 'lumen.shipments.category');
persistFilter(shipVendor, SHIP_VENDOR_KEY);
persistFilter(shipMonth, SHIP_MONTH_KEY);
wireSearchClear(shipSearch);
const SHIP_FILTERS = [shipSearch, shipFilter, shipSort, shipCategory, shipVendor, shipMonth];
SHIP_FILTERS.forEach(el => el.addEventListener('input', renderShipments));
const SHIP_CHIP_FIELDS = [
  { el: shipFilter, label: 'Status' },
  { el: shipCategory, label: 'Category' },
  { el: shipVendor, label: 'Vendor' },
  { el: shipMonth, label: 'Month' },
];
$('#shipFilterBtn').addEventListener('click', (e) =>
  openFilterPanel(e.currentTarget, 'shipFilterFields', () => resetFilters(SHIP_FILTERS)));
$('#addShipBtn').addEventListener('click', () => shipModal());
$('#shipExportBtn')?.addEventListener('click', () => exportShipmentsCSV());

// ---------- Shipment status, aging, and tracking ----------
// A pending shipment gets louder the longer it sits. Thresholds are generous
// on purpose — international peptide vendors routinely run past a week and a
// page full of red flags stops meaning anything.
const SHIP_AGING_DAYS = 10;    // amber: worth a look
const SHIP_OVERDUE_DAYS = 21;  // red: chase it

// Whole days between two ISO dates, or null when either is missing. Parsed at
// local midnight so DST shifts can't round a result off by one.
function daysBetweenISO(fromISO, toISO) {
  if (!fromISO || !toISO) return null;
  const a = new Date(fromISO + 'T00:00:00');
  const b = new Date(toISO + 'T00:00:00');
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

// Actual door-to-door time, only knowable once a shipment has both dates.
function shipmentTransitDays(s) {
  if (!s || !s.delivered) return null;
  const d = daysBetweenISO(s.dateOrdered, s.dateReceived);
  return d != null && d >= 0 ? d : null;
}

// How long a still-pending shipment has been outstanding.
function shipmentPendingDays(s) {
  if (!s || s.delivered) return null;
  const d = daysBetweenISO(s.dateOrdered, todayISO());
  return d != null && d >= 0 ? d : null;
}

// One resolved status per shipment, driving the badge, the row tint, and the
// summary tiles so all three can never disagree.
function shipmentStatus(s) {
  if (s && s.delivered) {
    const days = shipmentTransitDays(s);
    return {
      key: 'delivered',
      label: 'Delivered',
      days,
      detail: days == null ? '' : `${days}d in transit`,
    };
  }
  const days = shipmentPendingDays(s);
  if (days == null) return { key: 'transit', label: 'Pending', days: null, detail: '' };
  if (days >= SHIP_OVERDUE_DAYS) return { key: 'overdue', label: 'Overdue', days, detail: `${days}d out` };
  if (days >= SHIP_AGING_DAYS) return { key: 'aging', label: 'Aging', days, detail: `${days}d out` };
  return { key: 'transit', label: 'In transit', days, detail: `${days}d out` };
}

// Keep dateReceived consistent with the delivered flag. Flipping Delivered on
// stamps today's date (only when it's blank — never overwrite a date the user
// typed); flipping it off clears the date, because an undelivered shipment
// hasn't been received. Returns true when the date actually changed.
function syncShipmentReceived(shipment, isDelivered) {
  if (!shipment) return false;
  if (isDelivered) {
    if (!shipment.dateReceived) { shipment.dateReceived = todayISO(); return true; }
    return false;
  }
  if (shipment.dateReceived) { shipment.dateReceived = ''; return true; }
  return false;
}

// Product category for a shipment, resolved through inventory so a shipment
// line reads the same as the product it restocks.
function shipmentCategory(s) { return itemCategory(s && s.product); }

// Carrier tracking link, guessed from the number's shape. Returns null when
// nothing matches, so the caller can fall back to plain text rather than
// sending the user to a lookup page that won't recognize the number.
function trackingUrl(tracking) {
  const t = String(tracking || '').replace(/[\s-]/g, '').toUpperCase();
  if (!t) return null;
  if (/^1Z[0-9A-Z]{16}$/.test(t)) {
    return { carrier: 'UPS', url: `https://www.ups.com/track?tracknum=${encodeURIComponent(t)}` };
  }
  // USPS: 20–22 digits, and the IMpb numbers this business actually gets all
  // start 92/93/94/95.
  if (/^(9[2-5])\d{18,20}$/.test(t)) {
    return { carrier: 'USPS', url: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(t)}` };
  }
  if (/^\d{12}$|^\d{15}$|^\d{20}$/.test(t)) {
    return { carrier: 'FedEx', url: `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(t)}` };
  }
  if (/^\d{10}$|^\d{11}$/.test(t)) {
    return { carrier: 'DHL', url: `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(t)}` };
  }
  return null;
}

// Total stock items across a set of shipments.
function shipmentsItemTotal(list) {
  return (list || []).reduce((sum, s) => sum + shipmentUnitCount(s), 0);
}

// Average door-to-door days across shipments that have both dates. Returns
// null when nothing in the set has been measured yet.
function averageTransitDays(list) {
  const measured = (list || []).map(shipmentTransitDays).filter(d => d != null);
  if (!measured.length) return null;
  return measured.reduce((a, b) => a + b, 0) / measured.length;
}

// Per-vendor rollup for the vendor performance card: how much is outstanding,
// how much has landed, and how fast that vendor actually delivers.
function shipmentVendorStats(list) {
  const by = new Map();
  for (const s of (list || [])) {
    const name = (s.vendor || '').trim() || 'No vendor';
    let row = by.get(name);
    if (!row) { row = { vendor: name, total: 0, pending: 0, overdue: 0, items: 0, shipments: [] }; by.set(name, row); }
    row.total++;
    row.items += shipmentUnitCount(s);
    if (!s.delivered) {
      row.pending++;
      if (shipmentStatus(s).key === 'overdue') row.overdue++;
    }
    row.shipments.push(s);
  }
  return [...by.values()]
    .map(r => ({ ...r, avgDays: averageTransitDays(r.shipments) }))
    .sort((a, b) => b.total - a.total);
}

// Adjust the matching stock product's qty when a shipment's delivered state flips.
// Returns the affected stock row (or null) so callers can sync it to the cloud.
// Cutoff date — only shipments ordered AFTER this date contribute to inventory.
// Prior shipments are treated as historical and don't affect stock counts.
const SHIPMENT_INVENTORY_CUTOFF = '2026-04-14';

// Stock units on one shipment line: a kit counts as 10, a qty line counts
// 1:1. Called "items" everywhere in the UI, since a mixed list of kit and
// qty lines is not a vial count.
const KIT_TO_VIAL_MULTIPLIER = 10;

function shipmentUnitCount(shipment) {
  const n = parseInt(shipment.kits, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = shipment.unit === 'qty' ? 'qty' : 'kits';
  return unit === 'kits' ? n * KIT_TO_VIAL_MULTIPLIER : n;
}

function applyShipmentInventoryDelta(shipment, isDelivered) {
  if (!shipment || !shipment.product) return null;
  // Skip shipments ordered on/before the cutoff.
  if ((shipment.dateOrdered || '') <= SHIPMENT_INVENTORY_CUTOFF) return null;
  const units = shipmentUnitCount(shipment);
  if (units <= 0) return null;
  const target = (shipment.product || '').toLowerCase().trim();
  const product = state.stock.find(p => (p.name || '').toLowerCase().trim() === target);
  if (!product) return null;
  const delta = isDelivered ? units : -units;
  product.qty = Math.max(0, (Number(product.qty) || 0) + delta);
  if (product.qty > 0 && product.status !== 'ACTIVE') product.status = 'ACTIVE';
  return product;
}

// Find an existing stock product by case-insensitive name; create one if none
// matches. Used by the shipment flow so a typed-but-new product gets added to
// inventory automatically (qty 0 until the shipment is delivered).
function ensureStockProduct(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { product: null, created: false };
  const target = trimmed.toLowerCase();
  let product = state.stock.find(p => (p.name || '').toLowerCase().trim() === target);
  if (product) return { product, created: false };
  product = { id: uid('p'), name: trimmed, cost: 0, price: 0, qty: 0, status: 'ACTIVE' };
  state.stock.push(product);
  return { product, created: true };
}

// Capture which groups are currently expanded inside a tbody so we can restore
// them after a re-render. Without this, toggling paid/delivered re-renders the
// whole table and the user's open dropdowns collapse.
function getExpandedGroupIds(body) {
  if (!body) return new Set();
  return new Set(
    Array.from(body.querySelectorAll('[data-toggle-group].expanded'))
      .map(el => el.dataset.toggleGroup)
  );
}
function restoreGroupExpansion(body, ids) {
  if (!body || !ids || !ids.size) return;
  ids.forEach(id => {
    const chev = body.querySelector(`[data-toggle-group="${id}"]`);
    if (!chev) return;
    chev.classList.add('expanded');
    chev.closest('tr')?.classList.add('expanded');
    body.querySelectorAll(`[data-parent="${id}"]`).forEach(c => c.hidden = false);
  });
}

// Shared helper: wire up the expand/collapse chevron + tap-to-expand cell + Mixed-pill
// behavior for any tbody that uses the .group-row / .child-row pattern.
function wireGroupExpand(body) {
  body.querySelectorAll('[data-toggle-group]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = el.dataset.toggleGroup;
    const expanded = el.classList.toggle('expanded');
    el.closest('tr')?.classList.toggle('expanded', expanded);
    body.querySelectorAll(`[data-parent="${id}"]`).forEach(c => c.hidden = !expanded);
  }));
  body.querySelectorAll('[data-expand-group]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const chev = body.querySelector(`[data-toggle-group="${el.dataset.expandGroup}"]`);
    if (chev && !chev.classList.contains('expanded')) chev.click();
  }));

  // Restrict tap-to-expand to identifier cells (items column + vendor/customer
  // column). Date / qty / total / switches / actions cells no longer trigger
  // expansion when tapped.
  function tapToExpand(cell, e) {
    if (e.target.closest('label.switch, button, input, select, .cat-chip, .pill, [data-toggle-group]')) return;
    const chev = cell.closest('tr')?.querySelector('[data-toggle-group]');
    if (chev) chev.click();
  }
  body.querySelectorAll('.group-row .items-cell').forEach(cell => {
    cell.addEventListener('click', (e) => tapToExpand(cell, e));
  });
  // Per-table: also enable tap-to-expand on the vendor/customer cell.
  let extraSelector = null;
  if (body.id === 'shipBody' || body.id === 'expBody') {
    extraSelector = '.group-row > td:first-child';                  // vendor
  } else if (body.id === 'ordersBody' || body.id === 'recentOrdersBody' || body.id === 'pendingOrdersBody') {
    extraSelector = '.group-row > td:nth-child(2)';                  // customer
  }
  if (extraSelector) {
    body.querySelectorAll(extraSelector).forEach(cell => {
      cell.addEventListener('click', (e) => tapToExpand(cell, e));
    });
  }
}

// Vendor dropdown, built from whatever vendors actually appear in the data.
function refreshShipVendorDropdown() {
  const vendors = Array.from(new Set(
    state.shipments.map(s => (s.vendor || '').trim()).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));
  const stored = (() => { try { return localStorage.getItem(SHIP_VENDOR_KEY) || ''; } catch { return ''; } })();
  const cur = shipVendor.value || stored;
  shipVendor.innerHTML = '<option value="all">All Vendors</option>' +
    vendors.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  if (cur === 'all' || vendors.includes(cur)) shipVendor.value = cur;
  else shipVendor.value = 'all';
}

function refreshShipMonthDropdown() {
  const months = Array.from(new Set(state.shipments.map(s => monthKey(s.dateOrdered)).filter(Boolean)))
    .sort((a, b) => b.localeCompare(a));
  const stored = (() => { try { return localStorage.getItem(SHIP_MONTH_KEY) || ''; } catch { return ''; } })();
  const cur = shipMonth.value || stored;
  shipMonth.innerHTML = '<option value="all">All Months</option>' +
    months.map(m => `<option value="${m}">${monthName(m + '-01')}</option>`).join('');
  if (cur === 'all' || months.includes(cur)) shipMonth.value = cur;
  else shipMonth.value = 'all';
}

function renderShipments() {
  refreshShipVendorDropdown();
  refreshShipMonthDropdown();
  const q = shipSearch.value.toLowerCase().trim();
  const f = shipFilter.value;
  const shipDir = shipSort.value === 'asc' ? 1 : -1;
  let rows = [...state.shipments].sort((a, b) =>
    shipDir * ((a.dateOrdered || '').localeCompare(b.dateOrdered || ''))
  );
  if (q) rows = rows.filter(s => [s.vendor, s.product, s.tracking].join(' ').toLowerCase().includes(q));
  if (f === 'pending') rows = rows.filter(s => !s.delivered);
  if (f === 'delivered') rows = rows.filter(s => s.delivered);
  if (f === 'overdue') rows = rows.filter(s => shipmentStatus(s).key === 'overdue');
  const cat = shipCategory.value || 'all';
  if (cat !== 'all') rows = rows.filter(s => shipmentCategory(s) === cat);
  const vend = shipVendor.value || 'all';
  if (vend !== 'all') rows = rows.filter(s => (s.vendor || '').trim() === vend);
  const mo = shipMonth.value || 'all';
  if (mo !== 'all') rows = rows.filter(s => monthKey(s.dateOrdered) === mo);

  // Group by vendor + date + tracking — same vendor/day OR same tracking number
  // collapses into one row with a dropdown. Re-sort the groups to honor the
  // user's chosen direction (consolidateShipments hard-codes desc internally).
  const groups = consolidateShipments(rows).sort((a, b) =>
    shipDir * ((a.dateOrdered || '').localeCompare(b.dateOrdered || ''))
  );

  const body = $('#shipBody');
  const expandedBefore = getExpandedGroupIds(body);
  body.innerHTML = groups.map(g => renderShipmentGroup(g)).join('') ||
    `<tr><td colspan="7" class="muted" style="padding:24px;text-align:center;">No shipments match.</td></tr>`;
  restoreGroupExpansion(body, expandedBefore);

  const itemTotal = shipmentsItemTotal(rows);
  $('#shipCount').textContent = `${rows.length} shipment${rows.length === 1 ? '' : 's'}`;
  $('#shipItems').textContent = itemTotal > 0 ? `${fmtN(itemTotal)} items` : '';
  renderShipSummary(rows);
  renderShipBreakdown(rows);
  renderShipVendors(rows);
  setFilterCount('shipFilterBtn', renderFilterChips($('#shipChips'), SHIP_CHIP_FIELDS, shipSearch));
  // Only offer the review when there is actually something ambiguous left —
  // the unmistakable variants have already been merged automatically.
  const tidyBtn = $('#shipVendorTidy');
  if (tidyBtn) {
    const pending = suggestedVendorMerges().length;
    tidyBtn.hidden = pending === 0;
    tidyBtn.textContent = pending ? `Tidy names (${pending})` : 'Tidy names';
    if (!tidyBtn.dataset.wired) {
      tidyBtn.dataset.wired = '1';
      tidyBtn.addEventListener('click', (e) => { e.stopPropagation(); openVendorMergeSheet(e.currentTarget); });
    }
  }
  wireCollapsibleCard('shipBreakdownCard');
  wireCollapsibleCard('shipVendorCard');

  body.querySelectorAll('[data-ship-delivered]').forEach(el => el.addEventListener('change', e => {
    const sh = state.shipments.find(x => x.id === el.dataset.shipDelivered);
    if (sh) setShipmentDelivered(sh, e.target.checked);
  }));
  // Tapping the dates opens the "when did it land" menu.
  body.querySelectorAll('[data-ship-when]').forEach(el => el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const sh = state.shipments.find(x => x.id === el.dataset.shipWhen);
    if (sh) openDeliveryDateMenu(el, [sh]);
  }));
  body.querySelectorAll('[data-ship-group-when]').forEach(el => el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const group = el.dataset.shipGroupWhen.split(',')
      .map(id => state.shipments.find(x => x.id === id)).filter(Boolean);
    if (group.length) openDeliveryDateMenu(el, group);
  }));
  body.querySelectorAll('[data-ship-menu]').forEach(el => el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const sh = state.shipments.find(x => x.id === el.dataset.shipMenu);
    if (!sh) return;
    const st = shipmentStatus(sh);
    const link = trackingUrl(sh.tracking);
    const actions = [{ label: 'Edit shipment', icon: '✎', onSelect: () => shipModal(sh) }];
    if (link) {
      actions.push({
        label: 'Track with ' + link.carrier, icon: '⤴', hint: sh.tracking,
        onSelect: () => window.open(link.url, '_blank', 'noopener'),
      });
    }
    if (sh.tracking) {
      actions.push({
        label: 'Copy tracking number', icon: '⧉',
        onSelect: async () => {
          try { await navigator.clipboard.writeText(sh.tracking); toast('Tracking number copied.'); }
          catch { toast('Could not copy — long-press the number instead.'); }
        },
      });
    }
    actions.push({
      label: 'Delete shipment', icon: '🗑', danger: true, confirm: 'Delete permanently',
      onSelect: () => {
        // Reverse the stock it contributed before removing it, same as the
        // edit modal's delete path.
        const touched = [];
        if (sh.delivered) {
          const reverted = applyShipmentInventoryDelta(sh, false);
          if (reverted) touched.push(reverted);
        }
        state.shipments = state.shipments.filter(x => x.id !== sh.id);
        saveState(); cloudDelete('shipments', sh.id);
        if (touched.length) cloudUpsertMany('stock', touched);
        renderShipments(); renderInventory(); renderDashboard();
        toast('Shipment deleted.');
      },
    });
    openActionMenu(el, (sh.vendor || '').trim() || 'Shipment', actions,
      `${st.label}${st.detail ? ' · ' + st.detail : ''}`);
  }));
  body.querySelectorAll('[data-ship-group-menu]').forEach(el => el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const ids = el.dataset.shipGroupMenu.split(',');
    const group = ids.map(id => state.shipments.find(x => x.id === id)).filter(Boolean);
    if (!group.length) return;
    const first = group[0];
    const link = trackingUrl(first.tracking);
    const actions = [{
      label: 'Edit all ' + group.length + ' lines', icon: '✎',
      onSelect: () => shipGroupModal(group),
    }];
    if (link) {
      actions.push({
        label: 'Track with ' + link.carrier, icon: '⤴', hint: first.tracking,
        onSelect: () => window.open(link.url, '_blank', 'noopener'),
      });
    }
    openActionMenu(el, (first.vendor || '').trim() || 'Shipment group', actions,
      `${group.length} products · ${fmtN(shipmentsItemTotal(group))} items`);
  }));
  body.querySelectorAll('[data-group-ship-delivered]').forEach(el => el.addEventListener('change', () => {
    const group = el.dataset.groupShipDelivered.split(',')
      .map(id => state.shipments.find(x => x.id === id)).filter(Boolean);
    if (group.length) setShipmentsDelivered(group, el.checked);
  }));
  wireGroupExpand(body);
}

// Four tiles: what's still out, what's late, how much stock is riding on the
// pending boxes, and how fast things have actually been arriving.
function renderShipSummary(rows) {
  const el = $('#shipSummary');
  if (!el) return;
  const pending = rows.filter(s => !s.delivered);
  const overdue = pending.filter(s => shipmentStatus(s).key === 'overdue');
  const aging = pending.filter(s => shipmentStatus(s).key === 'aging');
  const delivered = rows.filter(s => s.delivered);
  const pendingItems = shipmentsItemTotal(pending);
  const avg = averageTransitDays(delivered);
  const oldest = pending
    .map(s => shipmentPendingDays(s))
    .filter(d => d != null)
    .sort((a, b) => b - a)[0];

  el.innerHTML = `
    <div class="exp-stat ship-stat-transit">
      <div class="exp-stat-label">In Transit</div>
      <div class="exp-stat-value">${fmtN(pending.length)}</div>
      <div class="exp-stat-note">${oldest != null ? `Oldest ${oldest}d out` : 'Nothing outstanding'}</div>
    </div>
    <div class="exp-stat ship-stat-late${overdue.length ? '' : ' is-empty'}">
      <div class="exp-stat-label">Needs Chasing</div>
      <div class="exp-stat-value">${fmtN(overdue.length)}</div>
      <div class="exp-stat-note">${aging.length
        ? `${aging.length} more aging past ${SHIP_AGING_DAYS}d`
        : `Overdue past ${SHIP_OVERDUE_DAYS}d`}</div>
    </div>
    <div class="exp-stat ship-stat-items">
      <div class="exp-stat-label">Items Incoming</div>
      <div class="exp-stat-value">${fmtN(pendingItems)}</div>
      <div class="exp-stat-note">Not yet counted in inventory</div>
    </div>
    <div class="exp-stat ship-stat-avg">
      <div class="exp-stat-label">Avg Transit</div>
      <div class="exp-stat-value">${avg == null ? '—' : `${avg.toFixed(1)}d`}</div>
      <div class="exp-stat-note">${avg == null
        ? 'No received dates recorded yet'
        : `Across ${delivered.filter(s => shipmentTransitDays(s) != null).length} delivered`}</div>
    </div>`;
}

// Same share-bar component the Expenses page uses, counting stock items
// rather than dollars — items are what matters for incoming stock.
function renderShipBreakdown(rows) {
  const el = $('#shipBreakdown');
  if (!el) return;
  const by = new Map();
  for (const s of rows) {
    const key = shipmentCategory(s);
    let row = by.get(key);
    if (!row) { row = { key, items: 0, count: 0, pending: 0 }; by.set(key, row); }
    row.items += shipmentUnitCount(s);
    row.count++;
    if (!s.delivered) row.pending += shipmentUnitCount(s);
  }
  const totals = CATEGORIES.map(c => by.get(c.key)).filter(Boolean);
  const grand = totals.reduce((sum, r) => sum + r.items, 0);
  const note = $('#shipBreakdownNote');
  if (note) note.textContent = grand > 0 ? `${fmtN(grand)} items` : '';
  if (!totals.length || grand <= 0) {
    el.innerHTML = '<p class="muted" style="margin:0;">No shipments in this range.</p>';
    return;
  }
  const active = shipCategory.value || 'all';
  const bar = totals.map(r =>
    `<span class="exp-bar-seg" data-cat="${r.key}" style="flex:${r.items}" title="${escapeHtml(categoryLabel(r.key))} — ${fmtN(r.items)} items"></span>`
  ).join('');
  const legend = totals.map(r => {
    const raw = (r.items / grand) * 100;
    const pct = raw > 0 && raw < 0.5 ? '<1' : Math.round(raw);
    return `<button type="button" class="exp-legend${active === r.key ? ' active' : ''}" data-filter-shipcat="${r.key}">
        <span class="exp-legend-dot" data-cat="${r.key}"></span>
        <span class="exp-legend-name">${escapeHtml(categoryLabel(r.key))}</span>
        <span class="exp-legend-amt">${fmtN(r.items)}</span>
        <span class="exp-legend-pct">${pct}%</span>
        ${r.pending > 0 ? `<span class="exp-legend-cap" title="Still in transit">${fmtN(r.pending)} out</span>` : ''}
      </button>`;
  }).join('');
  el.innerHTML = `<div class="exp-bar">${bar}</div><div class="exp-legend-grid">${legend}</div>`;
  el.querySelectorAll('[data-filter-shipcat]').forEach(btn => btn.addEventListener('click', () => {
    const key = btn.dataset.filterShipcat;
    shipCategory.value = shipCategory.value === key ? 'all' : key;
    shipCategory.dispatchEvent(new Event('input', { bubbles: true }));
  }));
}

// Who you buy from, how much is outstanding with them, and how long they
// actually take. Clicking a row filters the table to that vendor.
function renderShipVendors(rows) {
  const el = $('#shipVendors');
  if (!el) return;
  const stats = shipmentVendorStats(rows);
  if (!stats.length) {
    el.innerHTML = '<p class="muted" style="margin:0;">No shipments in this range.</p>';
    return;
  }
  const active = shipVendor.value || 'all';
  el.innerHTML = stats.map(v => `
    <button type="button" class="ship-vendor${active === v.vendor ? ' active' : ''}" data-filter-vendor="${escapeHtml(v.vendor)}">
      <span class="sv-name">${escapeHtml(v.vendor)}</span>
      <span class="sv-stat"><b>${fmtN(v.total)}</b> shipment${v.total === 1 ? '' : 's'}</span>
      <span class="sv-stat sv-avg">${v.avgDays == null ? '<span class="muted">— days</span>' : `<b>${v.avgDays.toFixed(1)}</b> days avg`}</span>
      ${v.overdue > 0
        ? `<span class="sv-flag overdue">${v.overdue} overdue</span>`
        : v.pending > 0 ? `<span class="sv-flag">${v.pending} out</span>` : ''}
    </button>`).join('');
  el.querySelectorAll('[data-filter-vendor]').forEach(btn => btn.addEventListener('click', () => {
    const name = btn.dataset.filterVendor;
    shipVendor.value = shipVendor.value === name ? 'all' : name;
    shipVendor.dispatchEvent(new Event('input', { bubbles: true }));
  }));
}

// ---------- Shipment cell renderers ----------
// Ordered → received on one line, with the aging/transit badge beside it. Two
// separate date columns would have pushed the table past what fits.
function shipTimelineCell(s, tappable, groupIds) {
  const st = shipmentStatus(s);
  const ordered = s.dateOrdered ? fmtDateShort(s.dateOrdered) : '—';
  const received = s.dateReceived ? fmtDateShort(s.dateReceived) : '';
  const arrow = received
    ? `<span class="tl-arrow">→</span><span class="tl-date">${received}</span>`
    : '';
  const badge = st.detail
    ? `<span class="ship-badge" data-status="${st.key}">${escapeHtml(st.detail)}</span>`
    : '';
  const inner = `<span class="tl-date">${ordered}</span>${arrow}${badge}`;
  // The dates are a button — tap to record when it actually arrived. A group
  // header carries every id in the box, so one tap dates the whole delivery.
  if (groupIds) {
    return `<button type="button" class="ship-timeline is-tappable" data-ship-group-when="${groupIds}" title="Set delivery date for this whole shipment">${inner}</button>`;
  }
  return tappable && s && s.id
    ? `<button type="button" class="ship-timeline is-tappable" data-ship-when="${s.id}" title="Set delivery date">${inner}</button>`
    : `<span class="ship-timeline">${inner}</span>`;
}

// Product category chip, read-only here — the category comes from the product
// record, so it's changed on the Inventory page, not per shipment.
function shipCategoryChip(s) {
  const key = shipmentCategory(s);
  return `<span class="cat-chip static" data-cat="${key}"><span class="cat-chip-label">${escapeHtml(categoryLabel(key))}</span></span>`;
}

// Tracking number, linked to the carrier when the number's shape identifies
// one. Unrecognized numbers stay as plain copyable text.
function shipTrackingCell(tracking) {
  const t = String(tracking || '').trim();
  if (!t) return '<span class="muted">—</span>';
  const hit = trackingUrl(t);
  if (!hit) return `<span class="tracking-no" title="${escapeHtml(t)}">${escapeHtml(t)}</span>`;
  return `<a class="tracking-no tracking-link" href="${hit.url}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(t)} — track with ${hit.carrier}"><span class="tracking-digits">${escapeHtml(t)}</span><span class="tracking-carrier">${hit.carrier}</span></a>`;
}

// Group shipments into one row when they share vendor+date OR a tracking number.
// We walk shipments in order and union-find them by either matching key.
function consolidateShipments(shipments) {
  const groups = [];
  const byVendorDate = new Map();
  const byTracking = new Map();
  for (const s of shipments) {
    const vd = (s.vendor || '').toLowerCase().trim() + '|' + (s.dateOrdered || '');
    const tk = (s.tracking || '').trim().toLowerCase();
    let group = byVendorDate.get(vd) || (tk && byTracking.get(tk));
    if (!group) {
      group = { vendor: s.vendor, dateOrdered: s.dateOrdered, shipments: [] };
      groups.push(group);
    }
    group.shipments.push(s);
    byVendorDate.set(vd, group);
    if (tk) byTracking.set(tk, group);
  }
  return groups.sort((a, b) => (b.dateOrdered || '').localeCompare(a.dateOrdered || ''));
}

function renderShipmentGroup(g) {
  if (g.shipments.length === 1) return renderSingleShipmentRow(g.shipments[0]);

  const groupId = 'sg_' + (g.vendor || '').replace(/\W+/g, '_') + '_' + (g.dateOrdered || '').replace(/\W+/g, '');
  const allDelivered = g.shipments.every(s => s.delivered);
  const noDelivered = g.shipments.every(s => !s.delivered);
  const shipIds = g.shipments.map(s => s.id).join(',');

  const deliveredCell = (allDelivered || noDelivered)
    ? `<label class="switch"><input type="checkbox" data-group-ship-delivered="${shipIds}" ${allDelivered ? 'checked' : ''} /><span class="slider"></span></label>`
    : `<span class="pill mixed" data-expand-group="${groupId}" title="Mixed — expand to see each">Mixed</span>`;

  // Show shared tracking number (if all the same) on the parent row.
  const trackings = g.shipments.map(s => (s.tracking || '').trim()).filter(Boolean);
  const distinctTrackings = [...new Set(trackings)];
  const groupTracking = distinctTrackings[0] || '';
  const groupTrackingCell = groupTracking
    ? shipTrackingCell(groupTracking) + (distinctTrackings.length > 1 ? ' <span class="muted" title="Children have different tracking numbers — expand to see each">+' + (distinctTrackings.length - 1) + '</span>' : '')
    : '<span class="muted">—</span>';

  // Every line in a group shares a vendor, a date and usually a box, so the
  // group's status is the worst status among its children — one overdue line
  // makes the whole group worth chasing.
  const groupStatus = g.shipments
    .map(shipmentStatus)
    .reduce((worst, st) => {
      const rank = { delivered: 0, transit: 1, aging: 2, overdue: 3 };
      return rank[st.key] > rank[worst.key] ? st : worst;
    }, { key: 'delivered', label: 'Delivered', days: null, detail: '' });
  // Stock items, not line count — the useful number when a box is still out.
  const groupItems = shipmentsItemTotal(g.shipments);
  const groupCats = Array.from(new Set(g.shipments.map(shipmentCategory)));
  const groupCatCell = groupCats.length === 1
    ? `<span class="cat-chip static" data-cat="${groupCats[0]}"><span class="cat-chip-label">${escapeHtml(categoryLabel(groupCats[0]))}</span></span>`
    : `<span class="grp-badge">${groupCats.length} categories</span>`;

  let html = `
    <tr class="group-row ship-row" data-status="${groupStatus.key}">
      <td><b>${escapeHtml(g.vendor || '')}</b></td>
      <td>${shipTimelineCell({
        ...g.shipments[0],
        dateOrdered: g.dateOrdered,
        delivered: allDelivered,
        // The box is only fully received once its last line arrives, so the
        // group shows the latest child date rather than whichever happened to
        // sort first.
        dateReceived: allDelivered
          ? g.shipments.map(s => s.dateReceived || '').filter(Boolean).sort().pop() || ''
          : '',
      }, false, shipIds)}</td>
      <td class="cat-cell">${groupCatCell}</td>
      <td class="items-cell"><span class="chevron" data-toggle-group="${groupId}">▶</span><span class="grp-badge">${g.shipments.length} product${g.shipments.length === 1 ? '' : 's'}</span>${groupItems > 0 ? `<span class="grp-badge">${fmtN(groupItems)} items</span>` : ''}</td>
      <td>${groupTrackingCell}</td>
      <td>${deliveredCell}</td>
      <td class="row-actions"><button class="row-menu-btn" data-ship-group-menu="${shipIds}" aria-label="Actions" title="Actions">⋯</button></td>
    </tr>`;
  html += g.shipments.map(s => {
    const n = Number(s.kits) || 0;
    const amtInner = s.unit === 'qty'
      ? `×${fmtN(n)}`
      : `×${fmtN(n)} Kit${n === 1 ? '' : 's'}`;
    // Pill matches the order modal's item-pill: product name + qty in muted color.
    const pill = `<span class="item-pill"><span class="ip-name">${escapeHtml(s.product || '')}</span><span class="ip-qty">${amtInner}</span></span>`;
    return `
    <tr class="child-row child-row-cells" data-parent="${groupId}" hidden>
      <td colspan="2" class="cs-product-cell"><span class="cs-label">↳</span> ${pill}</td>
      <td class="cat-cell">${shipCategoryChip(s)}</td>
      <td class="num muted">${shipmentUnitCount(s) > 0 ? `${fmtN(shipmentUnitCount(s))} items` : ''}</td>
      <td></td>
      <td><label class="switch"><input type="checkbox" data-ship-delivered="${s.id}" ${s.delivered ? 'checked' : ''}/><span class="slider"></span></label></td>
      <td class="row-actions">
        <button class="row-menu-btn" data-ship-menu="${s.id}" aria-label="Actions" title="Actions">⋯</button>
      </td>
    </tr>`;
  }).join('');
  return html;
}

function renderSingleShipmentRow(s) {
  const n = Number(s.kits) || 0;
  const amtInner = n > 0
    ? (s.unit === 'qty' ? `×${fmtN(n)}` : `×${fmtN(n)} Kit${n === 1 ? '' : 's'}`)
    : '';
  // Match the dropdown child rows: product + amount as a single pill.
  const pill = `<span class="item-pill"><span class="ip-name">${escapeHtml(s.product || '')}</span>${amtInner ? `<span class="ip-qty">${amtInner}</span>` : ''}</span>`;
  const st = shipmentStatus(s);
  return `<tr class="ship-row" data-status="${st.key}">
    <td>${(s.vendor || '').trim() ? `<b>${escapeHtml(s.vendor)}</b>` : '<span class="muted">No vendor</span>'}</td>
    <td>${shipTimelineCell(s, true)}</td>
    <td class="cat-cell">${shipCategoryChip(s)}</td>
    <td>${pill}</td>
    <td>${shipTrackingCell(s.tracking)}</td>
    <td><label class="switch"><input type="checkbox" data-ship-delivered="${s.id}" ${s.delivered ? 'checked' : ''}/><span class="slider"></span></label></td>
    <td class="row-actions">
      <button class="row-menu-btn" data-ship-menu="${s.id}" aria-label="Actions" title="Actions">⋯</button>
    </td>
  </tr>`;
}

function shipModal(existing) {
  // Edit path: single shipment record. Custom form so we get the same
  // typeable product field (with datalist autocomplete from inventory) and
  // labeled Unit dropdown that the New Shipment modal uses.
  if (existing) {
    const ed = {
      vendor: existing.vendor || '',
      dateOrdered: existing.dateOrdered || '',
      dateReceived: existing.dateReceived || '',
      tracking: existing.tracking || '',
      delivered: !!existing.delivered,
      product: existing.product || '',
      kits: existing.kits == null ? '' : String(existing.kits),
      unit: existing.unit === 'qty' ? 'qty' : 'kits',
    };

    $('#modalTitle').textContent = 'Edit Shipment';
    const form = $('#modalForm');

    const productOptions = state.stock
      .map(s => `<option value="${escapeHtml(s.name)}"></option>`)
      .join('');

    form.innerHTML = `
      <datalist id="shipEditProductList">${productOptions}</datalist>
      <div class="row-2">
        <label><span class="req">Vendor</span><input type="text" name="vendor" required value="${escapeHtml(ed.vendor)}" placeholder="e.g. Lumen Research" /></label>
        <label><span>Date Ordered</span><input type="date" name="dateOrdered" value="${ed.dateOrdered}" /></label>
      </div>
      <label id="shipEditReceivedWrap"><span>Date Received</span><input type="date" name="dateReceived" value="${ed.dateReceived}" /><span class="field-hint">Stamped automatically when you mark it delivered.</span></label>
      <label><span class="req">Product</span><input type="text" name="product" list="shipEditProductList" autocomplete="off" required value="${escapeHtml(ed.product)}" placeholder="Search or add product…" /></label>
      <div class="row-2">
        <label><span>Amount</span><input type="number" name="kits" min="0" step="1" value="${escapeHtml(ed.kits)}" placeholder="e.g. 5" /></label>
        <label><span>Unit</span>
          <select name="unit">
            <option value="kits" ${ed.unit === 'kits' ? 'selected' : ''}>Kits (×10)</option>
            <option value="qty" ${ed.unit === 'qty' ? 'selected' : ''}>Qty</option>
          </select>
        </label>
      </div>
      <div class="row-2">
        <label><span>Tracking Number</span><input type="text" name="tracking" value="${escapeHtml(ed.tracking)}" placeholder="optional" /></label>
        <label class="toggle-row">
          <span class="toggle-row-label">Delivered</span>
          <span class="switch"><input type="checkbox" name="delivered" ${ed.delivered ? 'checked' : ''} /><span class="slider"></span></span>
        </label>
      </div>
      <button type="button" class="btn danger-outline" id="shipDeleteBtn">Delete Shipment</button>
    `;

    modalOnSave = () => {
      const vendor = form.querySelector('[name="vendor"]').value.trim();
      const dateOrdered = form.querySelector('[name="dateOrdered"]').value;
      const product = form.querySelector('[name="product"]').value.trim();
      const kits = form.querySelector('[name="kits"]').value;
      const unit = form.querySelector('[name="unit"]').value === 'qty' ? 'qty' : 'kits';
      const tracking = form.querySelector('[name="tracking"]').value.trim();
      const delivered = form.querySelector('[name="delivered"]').checked;
      // Typed date wins; otherwise stamp today when it's newly delivered and
      // clear it when it isn't delivered at all.
      let dateReceived = form.querySelector('[name="dateReceived"]').value || '';
      if (delivered && !dateReceived) dateReceived = todayISO();
      if (!delivered) dateReceived = '';
      if (!vendor) { alert('Vendor is required.'); return; }
      if (!product) { alert('Product is required.'); return; }
      if (dateReceived && dateOrdered && dateReceived < dateOrdered) {
        alert('Date Received is before Date Ordered.');
        return;
      }

      const wasDelivered = !!existing.delivered;
      // Reverse the OLD inventory contribution (using the old product/kits/unit)
      // before applying the new one — handles product or amount or unit changes
      // while delivered=true.
      const stockTouched = [];
      if (wasDelivered) {
        const reverted = applyShipmentInventoryDelta(existing, false);
        if (reverted && !stockTouched.includes(reverted)) stockTouched.push(reverted);
      }
      Object.assign(existing, { vendor, dateOrdered, dateReceived, product, kits, unit, tracking, delivered });
      const saved = existing;

      const { product: ensuredProduct, created: createdNew } = ensureStockProduct(saved.product);
      if (createdNew && ensuredProduct && !stockTouched.includes(ensuredProduct)) {
        stockTouched.push(ensuredProduct);
      }
      let stockChanged = null;
      if (delivered) {
        stockChanged = applyShipmentInventoryDelta(saved, true);
        if (stockChanged && !stockTouched.includes(stockChanged)) stockTouched.push(stockChanged);
      }

      saveState();
      cloudUpsert('shipments', saved);
      if (stockTouched.length) cloudUpsertMany('stock', stockTouched);

      if (stockChanged) {
        toast(`Inventory updated: ${stockChanged.name} now ${fmtN(stockChanged.qty)}.`);
      } else if (createdNew) {
        toast(`Shipment updated. "${ensuredProduct.name}" added to inventory.`);
      } else {
        toast('Shipment updated.');
      }
      renderShipments(); renderInventory(); renderDashboard();
      closeModal();
    };

    // Delivered drives the received field: stamp today when it's switched on
// and the box is empty, blank it when switched off.
    const editDeliveredBox = form.querySelector('[name="delivered"]');
    const editReceivedInput = form.querySelector('[name="dateReceived"]');
    const syncEditReceived = () => {
      const on = editDeliveredBox.checked;
      form.querySelector('#shipEditReceivedWrap').hidden = !on;
      if (on && !editReceivedInput.value) editReceivedInput.value = todayISO();
      if (!on) editReceivedInput.value = '';
    };
    editDeliveredBox.addEventListener('change', syncEditReceived);
    syncEditReceived();

    form.querySelector('#shipDeleteBtn').addEventListener('click', () => {
      if (!confirm('Delete this shipment? This cannot be undone.')) return;
      // If the shipment was contributing to inventory, reverse it first.
      const stockTouched = [];
      if (existing.delivered) {
        const reverted = applyShipmentInventoryDelta(existing, false);
        if (reverted) stockTouched.push(reverted);
      }
      const id = existing.id;
      state.shipments = state.shipments.filter(x => x.id !== id);
      saveState();
      cloudDelete('shipments', id);
      if (stockTouched.length) cloudUpsertMany('stock', stockTouched);
      renderShipments(); renderInventory(); renderDashboard();
      toast('Shipment deleted.');
      closeModal();
    });

    showModal();
    setTimeout(() => form.querySelector('[name="vendor"]')?.focus(), 50);
    return;
  }

  // New shipment: multi-line entry. One record is created per product line,
  // all sharing the same vendor / date / tracking / delivered.
  const data = {
    vendor: '',
    dateOrdered: todayISO(),
    dateReceived: '',
    tracking: '',
    delivered: false,
    items: [{ product: '', kits: '', unit: 'kits' }],
  };

  $('#modalTitle').textContent = 'New Shipment';
  const form = $('#modalForm');

  // Datalist with current inventory so the user can pick an existing product
  // OR type a brand-new one (which gets auto-added to stock on save).
  const productOptions = state.stock
    .map(s => `<option value="${escapeHtml(s.name)}"></option>`)
    .join('');

  form.innerHTML = `
    <datalist id="shipProductList">${productOptions}</datalist>
    <div class="row-2">
      <label><span class="req">Vendor</span><input type="text" name="vendor" required placeholder="e.g. Lumen Research" /></label>
      <label><span>Date Ordered</span><input type="date" name="dateOrdered" value="${data.dateOrdered}" /></label>
    </div>
    <div class="row-2">
      <label><span>Tracking Number</span><input type="text" name="tracking" placeholder="optional" /></label>
      <label class="toggle-row">
        <span class="toggle-row-label">Delivered</span>
        <span class="switch"><input type="checkbox" name="delivered" /><span class="slider"></span></span>
      </label>
    </div>
    <div class="items-section">
      <div class="items-head">
        <span class="label">Products</span>
        <button type="button" class="btn ghost add-item-btn" id="addItemBtn">+ Add Product</button>
      </div>
      <div class="items-col-head ship-col-head">
        <span>Product</span><span>Amount</span><span>Unit</span><span></span>
      </div>
      <div id="itemsList"></div>
    </div>
  `;

  // Per-row closures so add / remove don't have to rebuild the whole list —
  // keeps the keyboard up on mobile and avoids the brief freeze users hit when
  // tapping "+ Add Product" mid-entry.
  function refreshRemoveButtons() {
    const list = form.querySelector('#itemsList');
    const onlyOne = data.items.length === 1;
    list.querySelectorAll('[data-remove]').forEach(btn => { btn.disabled = onlyOne; });
  }
  function buildShipItemRow(it) {
    const row = document.createElement('div');
    row.className = 'item-row ship-item-row';
    const unit = it.unit === 'qty' ? 'qty' : 'kits';
    row.innerHTML = `
      <input type="text" list="shipProductList" autocomplete="off" data-field="product" value="${escapeHtml(it.product || '')}" placeholder="Search or add product…" />
      <input type="number" inputmode="numeric" min="0" step="1" data-field="kits" value="${escapeHtml(it.kits || '')}" placeholder="e.g. 5" />
      <select data-field="unit">
        <option value="kits" ${unit === 'kits' ? 'selected' : ''}>Kits</option>
        <option value="qty" ${unit === 'qty' ? 'selected' : ''}>Qty</option>
      </select>
      <button type="button" class="icon-btn danger" data-remove title="Remove">×</button>
    `;
    row.querySelectorAll('[data-field]').forEach(el => {
      const eventName = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(eventName, () => { it[el.dataset.field] = el.value; });
    });
    row.querySelector('[data-remove]').addEventListener('click', () => {
      if (data.items.length === 1) return;
      const idx = data.items.indexOf(it);
      if (idx >= 0) data.items.splice(idx, 1);
      row.remove();
      refreshRemoveButtons();
    });
    return row;
  }

  function renderItems() {
    const list = form.querySelector('#itemsList');
    list.innerHTML = '';
    data.items.forEach(it => list.appendChild(buildShipItemRow(it)));
    refreshRemoveButtons();
  }

  form.querySelector('#addItemBtn').addEventListener('click', () => {
    const it = { product: '', kits: '', unit: 'kits' };
    data.items.push(it);
    const row = buildShipItemRow(it);
    form.querySelector('#itemsList').appendChild(row);
    refreshRemoveButtons();
    // Focus stays synchronous so iOS brings the keyboard up inside the tap
    // gesture; the scroll is deferred to the next frame so it doesn't stutter
    // fighting the keyboard animation + layout reflow that focus kicks off.
    focusForKeyboard(row.querySelector('[data-field="product"]'));
    requestAnimationFrame(() => {
      try { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {}
    });
  });

  renderItems();

  modalOnSave = () => {
    const vendor = form.querySelector('[name="vendor"]').value.trim();
    const dateOrdered = form.querySelector('[name="dateOrdered"]').value;
    const tracking = form.querySelector('[name="tracking"]').value.trim();
    const delivered = form.querySelector('[name="delivered"]').checked;
    if (!vendor) { alert('Vendor is required.'); return; }
    if (!data.items.length) { alert('Add at least one product.'); return; }
    for (const it of data.items) {
      if (!it.product || !it.product.trim()) { alert('Each line needs a product.'); return; }
    }

    // Entering something already delivered means it landed today unless the
    // user says otherwise — the common case for logging a box after it arrives.
    const dateReceived = delivered ? (todayISO()) : '';
    const created = data.items.map(it => ({
      id: uid('sh'),
      vendor, dateOrdered, dateReceived, tracking, delivered,
      product: it.product.trim(),
      kits: it.kits || '',
      unit: it.unit === 'qty' ? 'qty' : 'kits',
    }));
    state.shipments.push(...created);

    // Ensure every product on the shipment exists in inventory. Brand-new
    // names get added as a stock row (qty 0) so they're tracked from now on.
    const stockUpdated = [];
    let createdStockCount = 0;
    for (const s of created) {
      const { product, created: wasCreated } = ensureStockProduct(s.product);
      if (product && !stockUpdated.includes(product)) stockUpdated.push(product);
      if (wasCreated) createdStockCount++;
    }
    // Then, if the shipment is already delivered AND past the cutoff, add kits.
    if (delivered) {
      for (const s of created) {
        const p = applyShipmentInventoryDelta(s, true);
        if (p && !stockUpdated.includes(p)) stockUpdated.push(p);
      }
    }

    saveState();
    cloudUpsertMany('shipments', created);
    if (stockUpdated.length) cloudUpsertMany('stock', stockUpdated);

    const label = created.length === 1 ? 'Shipment added.' : `${created.length} shipments added.`;
    const newProductLabel = createdStockCount
      ? ` (${createdStockCount} new product${createdStockCount === 1 ? '' : 's'} added to inventory)`
      : '';
    if (delivered && stockUpdated.some(p => Number(p.qty) > 0)) {
      const summary = stockUpdated.map(p => `${p.name} → ${fmtN(p.qty)}`).join(', ');
      toast(`${label}${newProductLabel} Inventory: ${summary}.`);
    } else {
      toast(`${label}${newProductLabel}`);
    }

    renderShipments(); renderInventory(); renderDashboard();
    closeModal();
  };

  showModal();
  setTimeout(() => form.querySelector('[name="vendor"]')?.focus(), 50);
}

// Edit-the-whole-group modal: lets the user update shared fields (vendor,
// date, tracking, delivered) once and have them propagate to every child
// shipment, plus edit each line's product / amount / unit, plus add or
// remove lines. Existing children are matched by id; new lines get fresh ids;
// removed lines get deleted from state and Supabase.
function shipGroupModal(groupShipments) {
  if (!groupShipments || !groupShipments.length) return;
  // Pick the first record's shared fields as the starting point. Tracking
  // numbers may differ between children — show the first one and let the
  // user overwrite (which then applies to all on save).
  const first = groupShipments[0];
  const ed = {
    vendor: first.vendor || '',
    dateOrdered: first.dateOrdered || '',
    tracking: first.tracking || '',
    delivered: !!first.delivered,
    items: groupShipments.map(s => ({
      id: s.id,                    // keep existing id so we update in place
      product: s.product || '',
      kits: s.kits == null ? '' : String(s.kits),
      unit: s.unit === 'qty' ? 'qty' : 'kits',
    })),
  };
  // Mark all children as having the same delivered state by default.
  // If they differ, pick the most common.
  const allDelivered = groupShipments.every(s => s.delivered);
  const noDelivered = groupShipments.every(s => !s.delivered);
  ed.delivered = allDelivered;
  const mixedDelivery = !allDelivered && !noDelivered;

  $('#modalTitle').textContent = 'Edit Shipment Group';
  const form = $('#modalForm');

  const productOptions = state.stock
    .map(s => `<option value="${escapeHtml(s.name)}"></option>`)
    .join('');

  form.innerHTML = `
    <datalist id="shipGroupProductList">${productOptions}</datalist>
    <div class="row-2">
      <label><span class="req">Vendor</span><input type="text" name="vendor" required value="${escapeHtml(ed.vendor)}" placeholder="e.g. Lumen Research" /></label>
      <label><span>Date Ordered</span><input type="date" name="dateOrdered" value="${ed.dateOrdered}" /></label>
    </div>
    <div class="row-2">
      <label><span>Tracking Number</span><input type="text" name="tracking" value="${escapeHtml(ed.tracking)}" placeholder="optional — applied to all lines" /></label>
      <label class="toggle-row">
        <span class="toggle-row-label">Delivered${mixedDelivery ? ' <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500;">(was mixed)</span>' : ''}</span>
        <span class="switch"><input type="checkbox" name="delivered" ${ed.delivered ? 'checked' : ''} /><span class="slider"></span></span>
      </label>
    </div>
    <div class="items-section">
      <div class="items-head">
        <span class="label">Products</span>
        <button type="button" class="btn ghost add-item-btn" id="addItemBtn">+ Add Product</button>
      </div>
      <div class="items-col-head ship-col-head">
        <span>Product</span><span>Amount</span><span>Unit</span><span></span>
      </div>
      <div id="itemsList"></div>
    </div>
    <button type="button" class="btn danger-outline" id="shipGroupDeleteBtn">Delete Entire Group</button>
  `;

  function refreshRemoveButtons() {
    const list = form.querySelector('#itemsList');
    const onlyOne = ed.items.length === 1;
    list.querySelectorAll('[data-remove]').forEach(btn => { btn.disabled = onlyOne; });
  }
  function buildShipGroupRow(it) {
    const row = document.createElement('div');
    row.className = 'item-row ship-item-row';
    const unit = it.unit === 'qty' ? 'qty' : 'kits';
    row.innerHTML = `
      <input type="text" list="shipGroupProductList" autocomplete="off" data-field="product" value="${escapeHtml(it.product || '')}" placeholder="Search or add product…" />
      <input type="number" inputmode="numeric" min="0" step="1" data-field="kits" value="${escapeHtml(it.kits || '')}" placeholder="e.g. 5" />
      <select data-field="unit">
        <option value="kits" ${unit === 'kits' ? 'selected' : ''}>Kits</option>
        <option value="qty" ${unit === 'qty' ? 'selected' : ''}>Qty</option>
      </select>
      <button type="button" class="icon-btn danger" data-remove title="Remove">×</button>
    `;
    row.querySelectorAll('[data-field]').forEach(el => {
      const eventName = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(eventName, () => { it[el.dataset.field] = el.value; });
    });
    row.querySelector('[data-remove]').addEventListener('click', () => {
      if (ed.items.length === 1) return;
      const idx = ed.items.indexOf(it);
      if (idx >= 0) ed.items.splice(idx, 1);
      row.remove();
      refreshRemoveButtons();
    });
    return row;
  }

  function renderItems() {
    const list = form.querySelector('#itemsList');
    list.innerHTML = '';
    ed.items.forEach(it => list.appendChild(buildShipGroupRow(it)));
    refreshRemoveButtons();
  }

  form.querySelector('#addItemBtn').addEventListener('click', () => {
    const it = { id: null, product: '', kits: '', unit: 'kits' };
    ed.items.push(it);
    const row = buildShipGroupRow(it);
    form.querySelector('#itemsList').appendChild(row);
    refreshRemoveButtons();
    // Keyboard focus synchronous (iOS gesture); scroll deferred a frame so the
    // two don't collide and stutter — keeps adding a line feeling instant.
    focusForKeyboard(row.querySelector('[data-field="product"]'));
    requestAnimationFrame(() => {
      try { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {}
    });
  });

  renderItems();

  form.querySelector('#shipGroupDeleteBtn').addEventListener('click', () => {
    if (!confirm(`Delete all ${groupShipments.length} shipment${groupShipments.length === 1 ? '' : 's'} in this group? This cannot be undone.`)) return;
    const stockTouched = [];
    for (const s of groupShipments) {
      if (s.delivered) {
        const reverted = applyShipmentInventoryDelta(s, false);
        if (reverted && !stockTouched.includes(reverted)) stockTouched.push(reverted);
      }
    }
    const ids = new Set(groupShipments.map(s => s.id));
    state.shipments = state.shipments.filter(s => !ids.has(s.id));
    saveState();
    for (const id of ids) cloudDelete('shipments', id);
    if (stockTouched.length) cloudUpsertMany('stock', stockTouched);
    renderShipments(); renderInventory(); renderDashboard();
    toast(`${groupShipments.length} shipment${groupShipments.length === 1 ? '' : 's'} deleted.`);
    closeModal();
  });

  modalOnSave = () => {
    const vendor = form.querySelector('[name="vendor"]').value.trim();
    const dateOrdered = form.querySelector('[name="dateOrdered"]').value;
    const tracking = form.querySelector('[name="tracking"]').value.trim();
    const delivered = form.querySelector('[name="delivered"]').checked;
    if (!vendor) { alert('Vendor is required.'); return; }
    if (!ed.items.length) { alert('Add at least one product.'); return; }
    for (const it of ed.items) {
      if (!it.product || !String(it.product).trim()) { alert('Each line needs a product.'); return; }
    }

    const stockTouched = [];
    // Step 1: reverse OLD inventory contributions for any child that was
    // previously delivered, using its old product/kits/unit.
    for (const s of groupShipments) {
      if (s.delivered) {
        const reverted = applyShipmentInventoryDelta(s, false);
        if (reverted && !stockTouched.includes(reverted)) stockTouched.push(reverted);
      }
    }

    // Step 2: figure out which existing rows survived, which got removed.
    const keptIds = new Set(ed.items.filter(it => it.id).map(it => it.id));
    const removedShipments = groupShipments.filter(s => !keptIds.has(s.id));
    state.shipments = state.shipments.filter(s => !removedShipments.some(r => r.id === s.id));

    // Step 3: update kept shipments and create new ones; collect them all.
    const updated = [];
    const created = [];
    for (const it of ed.items) {
      const product = String(it.product || '').trim();
      const kits = it.kits || '';
      const unit = it.unit === 'qty' ? 'qty' : 'kits';
      if (it.id) {
        const live = state.shipments.find(s => s.id === it.id);
        if (live) {
          Object.assign(live, { vendor, dateOrdered, tracking, delivered, product, kits, unit });
          // Preserves a per-line received date that was already recorded; only
          // fills or clears it to match the group's delivered state.
          syncShipmentReceived(live, delivered);
          updated.push(live);
        }
      } else {
        const fresh = {
          id: uid('sh'),
          vendor, dateOrdered, tracking, delivered,
          dateReceived: delivered ? todayISO() : '',
          product, kits, unit,
        };
        state.shipments.push(fresh);
        created.push(fresh);
      }
    }

    // Step 4: ensure each (potentially new) product exists in stock.
    let createdStockCount = 0;
    for (const s of [...updated, ...created]) {
      const { product: ensured, created: wasCreated } = ensureStockProduct(s.product);
      if (ensured && !stockTouched.includes(ensured)) stockTouched.push(ensured);
      if (wasCreated) createdStockCount++;
    }

    // Step 5: re-apply inventory contributions for the new state.
    if (delivered) {
      for (const s of [...updated, ...created]) {
        const p = applyShipmentInventoryDelta(s, true);
        if (p && !stockTouched.includes(p)) stockTouched.push(p);
      }
    }

    saveState();
    if (updated.length) cloudUpsertMany('shipments', updated);
    if (created.length) cloudUpsertMany('shipments', created);
    for (const r of removedShipments) cloudDelete('shipments', r.id);
    if (stockTouched.length) cloudUpsertMany('stock', stockTouched);

    const newProductLabel = createdStockCount
      ? ` (${createdStockCount} new product${createdStockCount === 1 ? '' : 's'} added to inventory)`
      : '';
    toast(`Group updated.${newProductLabel}`);
    renderShipments(); renderInventory(); renderDashboard();
    closeModal();
  };

  showModal();
  setTimeout(() => form.querySelector('[name="vendor"]')?.focus(), 50);
}

// ---------- EXPENSES ----------
const expSearch = $('#expSearch');
const expMonth = $('#expMonth');
const expDay = $('#expDay');
const expSort = $('#expSort');
const expCategory = $('#expCategory');
const expFunding = $('#expFunding');
const EXP_MONTH_KEY = 'lumen.expenses.month';
const EXP_DAY_KEY = 'lumen.expenses.day';
// The category dropdown is built once from the canonical list — unlike month /
// day it doesn't depend on the data, so it can be populated before the first
// render and persistFilter() can restore a saved choice immediately.
expCategory.innerHTML = '<option value="all">All Categories</option>' +
  EXPENSE_CATEGORIES.map(c => `<option value="${c.key}">${c.label}</option>`).join('');
persistFilter(expSearch, 'lumen.expenses.search');
persistFilter(expMonth, EXP_MONTH_KEY);
persistFilter(expDay, EXP_DAY_KEY);
persistFilter(expSort, 'lumen.expenses.sort');
persistFilter(expCategory, 'lumen.expenses.category');
persistFilter(expFunding, 'lumen.expenses.funding');
wireSearchClear(expSearch);
const EXP_FILTERS = [expSearch, expMonth, expDay, expSort, expCategory, expFunding];
EXP_FILTERS.forEach(el => el.addEventListener('input', renderExpenses));
// Which filters get a chip, and what to call them. Sort is deliberately left
// out — it's an ordering preference, not a filter that hides rows.
const EXP_CHIP_FIELDS = [
  { el: expCategory, label: 'Category' },
  { el: expMonth, label: 'Month' },
  { el: expDay, label: 'Day' },
  { el: expFunding, label: 'Funding' },
];
$('#expFilterBtn').addEventListener('click', (e) =>
  openFilterPanel(e.currentTarget, 'expFilterFields', () => resetFilters(EXP_FILTERS)));
$('#addExpBtn').addEventListener('click', () => expModal());
$('#expExportBtn')?.addEventListener('click', () => exportExpensesCSV());

function expenseItems(e) { return Array.isArray(e.items) ? e.items : []; }
function expenseCost(e) {
  if (e && e.costMode === 'total') return Number(e.totalCost) || 0;
  return expenseItems(e).reduce((s, it) => s + (Number(it.cost) || 0), 0);
}
// Format an expense line item label with qty + unit info, e.g. "Retatrutide ×3 kits"
// or "Tape ×2". Skips the suffix when no qty is recorded so legacy items still
// look clean.
function expenseItemLabel(it) {
  const product = (it && it.product) || '';
  const qty = Number(it && it.qty) || 0;
  const unit = (it && it.unit === 'kits') ? 'kits' : '';
  // Pill matches the order modal / shipment row style: product on the left,
  // amount in muted color on the right, kits get pluralized.
  const amtInner = qty > 0
    ? (unit
      ? `×${fmtN(qty)} Kit${qty === 1 ? '' : 's'}`
      : `×${fmtN(qty)}`)
    : '';
  const amtSpan = amtInner ? `<span class="ip-qty">${amtInner}</span>` : '';
  return `<span class="item-pill"><span class="ip-name">${escapeHtml(product)}</span>${amtSpan}</span>`;
}

// Category chip. Rendered as a native select so reassigning is one tap on
// desktop and a native picker on mobile — no custom menu to get stuck open
// inside a scrolling table.
function expenseCategoryChip(e) {
  const cur = expenseCategory(e);
  const opts = EXPENSE_CATEGORIES
    .map(c => `<option value="${c.key}" ${c.key === cur ? 'selected' : ''}>${escapeHtml(c.label)}</option>`)
    .join('');
  return `<span class="cat-chip" data-cat="${cur}">
      <span class="cat-chip-label">${escapeHtml(expenseCategoryShort(cur))}</span>
      <select class="cat-chip-select" data-set-cat="${e.id}" aria-label="Category">${opts}</select>
    </span>`;
}

// Vendor is optional — a lot of older records only have a description. Render
// a muted placeholder rather than an empty cell so the column still reads as a
// column.
function vendorCell(vendor) {
  const v = (vendor || '').trim();
  return v ? `<b>${escapeHtml(v)}</b>` : '<span class="muted">No vendor</span>';
}

// Small badge marking an expense as capital / owner-funded, so a row that is
// missing from the operating total explains itself at a glance.
function capitalBadge(e) {
  return expenseExcluded(e)
    ? '<span class="cap-badge" title="Capital / owner-funded — excluded from Net Profit">Capital</span>'
    : '';
}

// Reassigning a category writes through immediately: local state, disk, cloud,
// then a re-render so the summary and breakdown move with it.
function wireCategorySelects(body) {
  body.querySelectorAll('[data-set-cat]').forEach(sel => {
    sel.addEventListener('change', () => {
      const e = state.expenses.find(x => x.id === sel.dataset.setCat);
      if (!e) return;
      e.category = sel.value;
      saveState();
      cloudUpsert('expenses', e);
      renderExpenses();
      renderDashboard();
      toast(`Filed under ${expenseCategoryLabel(e.category)}.`);
    });
    // Keep a tap on the chip from bubbling into the row's expand handler.
    sel.addEventListener('click', ev => ev.stopPropagation());
  });
}

function refreshExpMonthDropdown() {
  const months = Array.from(new Set(state.expenses.map(e => monthKey(e.dateOrdered)).filter(Boolean)))
    .sort((a, b) => b.localeCompare(a));
  const stored = (() => { try { return localStorage.getItem(EXP_MONTH_KEY) || ''; } catch { return ''; } })();
  const cur = expMonth.value || stored;
  expMonth.innerHTML = `<option value="all">All Months</option>` +
    months.map(m => `<option value="${m}">${monthName(m + '-01')}</option>`).join('');
  if (cur === 'all' || months.includes(cur)) expMonth.value = cur;
}

function refreshExpDayDropdown() {
  const mo = expMonth.value;
  const allDates = state.expenses.map(e => e.dateOrdered).filter(Boolean);
  const scoped = mo === 'all' ? allDates : allDates.filter(d => monthKey(d) === mo);
  const days = Array.from(new Set(scoped)).sort((a, b) => b.localeCompare(a));
  const stored = (() => { try { return localStorage.getItem(EXP_DAY_KEY) || ''; } catch { return ''; } })();
  const cur = expDay.value || stored;
  expDay.innerHTML = `<option value="all">All Days</option>` +
    days.map(d => `<option value="${d}">${fmtDateShort(d)}</option>`).join('');
  if (cur === 'all' || days.includes(cur)) expDay.value = cur;
  else expDay.value = 'all';
}

function renderExpenses() {
  refreshExpMonthDropdown();
  refreshExpDayDropdown();
  const q = expSearch.value.toLowerCase().trim();
  const mo = expMonth.value;
  const dy = expDay.value;
  const expDir = expSort.value === 'asc' ? 1 : -1;
  let rows = [...state.expenses].sort((a, b) =>
    expDir * ((a.dateOrdered || '').localeCompare(b.dateOrdered || ''))
  );
  if (mo !== 'all') rows = rows.filter(e => monthKey(e.dateOrdered) === mo);
  if (dy !== 'all') rows = rows.filter(e => e.dateOrdered === dy);
  if (q) rows = rows.filter(e =>
    (e.vendor || '').toLowerCase().includes(q) ||
    expenseCategoryLabel(expenseCategory(e)).toLowerCase().includes(q) ||
    expenseItems(e).some(it => (it.product || '').toLowerCase().includes(q))
  );
  const cat = expCategory.value || 'all';
  if (cat !== 'all') rows = rows.filter(e => expenseCategory(e) === cat);
  const funding = expFunding.value || 'all';
  if (funding === 'operating') rows = rows.filter(e => !expenseExcluded(e));
  else if (funding === 'capital') rows = rows.filter(e => expenseExcluded(e));

  // consolidateExpenses sorts internally desc — re-sort here so the user's
  // chosen direction wins.
  const groups = consolidateExpenses(rows).sort((a, b) =>
    expDir * ((a.dateOrdered || '').localeCompare(b.dateOrdered || ''))
  );

  const body = $('#expBody');
  const expandedBefore = getExpandedGroupIds(body);
  body.innerHTML = groups.map(g => renderExpenseGroup(g)).join('') ||
    `<tr><td colspan="6" class="muted" style="padding:24px;text-align:center;">No expenses match.</td></tr>`;
  restoreGroupExpansion(body, expandedBefore);

  const expCount = rows.length;
  const itemCount = rows.reduce((s, e) => s + expenseItems(e).length, 0);
  $('#expCount').textContent = itemCount === expCount
    ? `${expCount} expense${expCount === 1 ? '' : 's'}`
    : `${expCount} expense${expCount === 1 ? '' : 's'} · ${itemCount} item${itemCount === 1 ? '' : 's'}`;

  const opex = sumOperating(rows);
  const capex = sumCapital(rows);
  $('#expSum').textContent = fmt$(round2(opex + capex));
  // Only spell out the split when there's actually a capital line to explain.
  $('#expFootSplit').textContent = capex > 0
    ? `${fmt$(opex)} operating + ${fmt$(capex)} capital`
    : '';

  renderExpenseSummary(rows, opex, capex);
  renderExpenseBreakdown(rows);
  setFilterCount('expFilterBtn', renderFilterChips($('#expChips'), EXP_CHIP_FIELDS, expSearch));
  wireCollapsibleCard('expBreakdownCard');

  body.querySelectorAll('[data-exp-menu]').forEach(el => el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const e = state.expenses.find(x => x.id === el.dataset.expMenu);
    if (!e) return;
    const items = expenseItems(e);
    const what = items.length === 1 ? (items[0].product || '') : `${items.length} items`;
    openActionMenu(el, (e.vendor || '').trim() || 'Expense', [
      { label: 'Edit expense', icon: '✎', onSelect: () => expModal(e) },
      {
        label: expenseExcluded(e) ? 'Move back to operating' : 'Mark capital / owner-funded',
        hint: expenseExcluded(e)
          ? 'Counts against Net Profit again'
          : 'Excluded from Net Profit, tracked separately',
        icon: expenseExcluded(e) ? '↩' : '⚑',
        onSelect: () => {
          e.excludeFromNet = !expenseExcluded(e);
          saveState(); cloudUpsert('expenses', e);
          renderExpenses(); renderDashboard();
          toast(expenseExcluded(e) ? 'Moved to capital / owner-funded.' : 'Moved back to operating.');
        },
      },
      {
        label: 'Delete expense', icon: '🗑', danger: true, confirm: 'Delete permanently',
        onSelect: () => {
          state.expenses = state.expenses.filter(x => x.id !== e.id);
          saveState(); cloudDelete('expenses', e.id);
          renderExpenses(); renderDashboard(); toast('Expense deleted.');
        },
      },
    ], `${fmt$(expenseCost(e))}${what ? ' · ' + what : ''}`);
  }));
  wireCategorySelects(body);
  wireGroupExpand(body);
}

// Three tiles above the table: what the business itself paid, what the owner
// covered, and the two together. The capital tile stays visible even at zero so
// the page doesn't reflow the moment something gets flagged.
function renderExpenseSummary(rows, opex, capex) {
  const el = $('#expSummary');
  if (!el) return;
  const total = round2(opex + capex);
  const capCount = rows.filter(expenseExcluded).length;
  const share = total > 0 ? Math.round((capex / total) * 100) : 0;
  el.innerHTML = `
    <div class="exp-stat exp-stat-op">
      <div class="exp-stat-label">Operating Expenses</div>
      <div class="exp-stat-value">${fmt$(opex)}</div>
      <div class="exp-stat-note">Deducted from Net Profit</div>
    </div>
    <div class="exp-stat exp-stat-cap${capex > 0 ? '' : ' is-empty'}">
      <div class="exp-stat-label">Capital &amp; Owner-Funded</div>
      <div class="exp-stat-value">${fmt$(capex)}</div>
      <div class="exp-stat-note">${capCount
        ? `${capCount} purchase${capCount === 1 ? '' : 's'} · ${share}% of outlay`
        : 'Nothing flagged yet'}</div>
    </div>
    <div class="exp-stat exp-stat-total">
      <div class="exp-stat-label">Total Outlay</div>
      <div class="exp-stat-value">${fmt$(total)}</div>
      <div class="exp-stat-note">Every dollar spent, however funded</div>
    </div>`;
}

// Horizontal share bar plus a clickable legend. Clicking a category drives the
// toolbar filter, so the breakdown doubles as navigation.
function renderExpenseBreakdown(rows) {
  const el = $('#expBreakdown');
  if (!el) return;
  const totals = expenseCategoryTotals(rows);
  const grand = totals.reduce((s, r) => s + r.total, 0);
  const note = $('#expBreakdownNote');
  if (note) {
    note.textContent = totals.length
      ? `${totals.length} categor${totals.length === 1 ? 'y' : 'ies'} · ${fmt$(round2(grand))}`
      : '';
  }
  if (!totals.length || grand <= 0) {
    el.innerHTML = '<p class="muted" style="margin:0;">No expenses in this range.</p>';
    return;
  }
  const active = expCategory.value || 'all';
  const bar = totals.map(r =>
    `<span class="exp-bar-seg" data-cat="${r.key}" style="flex:${r.total}" title="${escapeHtml(expenseCategoryLabel(r.key))} — ${fmt$(r.total)}"></span>`
  ).join('');
  const legend = totals.map(r => {
    const raw = (r.total / grand) * 100;
    // Anything non-zero but under half a percent would round to 0% and read as
    // "nothing spent here" — show it as <1% instead.
    const pct = raw > 0 && raw < 0.5 ? '<1' : Math.round(raw);
    return `<button type="button" class="exp-legend${active === r.key ? ' active' : ''}" data-filter-cat="${r.key}">
        <span class="exp-legend-dot" data-cat="${r.key}"></span>
        <span class="exp-legend-name">${escapeHtml(expenseCategoryLabel(r.key))}</span>
        <span class="exp-legend-amt">${fmt$(r.total)}</span>
        <span class="exp-legend-pct">${pct}%</span>
        ${r.capital > 0 ? `<span class="exp-legend-cap" title="Capital / owner-funded portion">${fmt$(r.capital)} cap</span>` : ''}
      </button>`;
  }).join('');
  el.innerHTML = `<div class="exp-bar">${bar}</div><div class="exp-legend-grid">${legend}</div>`;
  el.querySelectorAll('[data-filter-cat]').forEach(btn => btn.addEventListener('click', () => {
    const key = btn.dataset.filterCat;
    // Second click on the active category clears the filter.
    expCategory.value = expCategory.value === key ? 'all' : key;
    expCategory.dispatchEvent(new Event('input', { bubbles: true }));
  }));
}

// Consolidate expenses by shared vendor + date — multiple receipts on the same
// day from the same vendor collapse into one drop-down row.
function consolidateExpenses(expenses) {
  const groups = [];
  const byKey = new Map();
  for (const e of expenses) {
    const key = (e.vendor || '').toLowerCase().trim() + '|' + (e.dateOrdered || '');
    let g = byKey.get(key);
    if (!g) {
      g = { vendor: e.vendor, dateOrdered: e.dateOrdered, expenses: [] };
      groups.push(g);
      byKey.set(key, g);
    }
    g.expenses.push(e);
  }
  return groups.sort((a, b) => (b.dateOrdered || '').localeCompare(a.dateOrdered || ''));
}

function renderExpenseGroup(g) {
  if (g.expenses.length === 1) return renderExpenseRow(g.expenses[0]);

  const groupId = 'xg_' + (g.vendor || '').replace(/\W+/g, '_') + '_' + (g.dateOrdered || '').replace(/\W+/g, '');
  const totalCost = g.expenses.reduce((s, e) => s + expenseCost(e), 0);
  const totalItems = g.expenses.reduce((s, e) => s + expenseItems(e).length, 0);

  // A consolidated group can span several categories — show the single shared
  // category when they agree, and a count when they don't.
  const cats = Array.from(new Set(g.expenses.map(expenseCategory)));
  const catCell = cats.length === 1
    ? `<span class="cat-chip static" data-cat="${cats[0]}"><span class="cat-chip-label">${escapeHtml(expenseCategoryShort(cats[0]))}</span></span>`
    : `<span class="grp-badge">${cats.length} categories</span>`;
  const anyCapital = g.expenses.some(expenseExcluded);

  let html = `
    <tr class="group-row">
      <td>${vendorCell(g.vendor)}<span class="grp-badge">${g.expenses.length} expense${g.expenses.length === 1 ? '' : 's'}</span></td>
      <td>${g.dateOrdered ? fmtDateShort(g.dateOrdered) : '<span class="muted">—</span>'}</td>
      <td class="cat-cell">${catCell}${anyCapital ? '<span class="cap-badge">Capital</span>' : ''}</td>
      <td class="items-cell"><span class="chevron" data-toggle-group="${groupId}">▶</span><span class="grp-badge">${totalItems} item${totalItems === 1 ? '' : 's'}</span></td>
      <td class="num"><b>${fmt$(totalCost)}</b></td>
      <td></td>
    </tr>`;
  html += g.expenses.map(e => {
    const items = expenseItems(e);
    const productsCell = items.length === 1
      ? expenseItemLabel(items[0])
      : `<span class="grp-badge">${items.length} items</span>`;
    return `
      <tr class="child-row" data-parent="${groupId}" hidden>
        <td colspan="6" class="child-cell">
          <div class="child-strip">
            <span class="cs-label">↳</span>
            <span class="cs-items">${productsCell}</span>
            ${expenseCategoryChip(e)}${capitalBadge(e)}
            <span class="cs-total">${fmt$(expenseCost(e))}</span>
            <span class="cs-actions">
              <button class="row-menu-btn" data-exp-menu="${e.id}" aria-label="Actions" title="Actions">⋯</button>
            </span>
          </div>
        </td>
      </tr>`;
  }).join('');
  return html;
}

function renderExpenseRow(e) {
  const items = expenseItems(e);
  if (items.length <= 1) return renderSingleExpenseRow(e);

  const groupId = 'eg_' + String(e.id || '').replace(/\W+/g, '_');
  const totalCost = expenseCost(e);

  let html = `
    <tr class="group-row${expenseExcluded(e) ? ' is-capital' : ''}">
      <td>${vendorCell(e.vendor)}</td>
      <td>${e.dateOrdered ? fmtDateShort(e.dateOrdered) : '<span class="muted">—</span>'}</td>
      <td class="cat-cell">${expenseCategoryChip(e)}${capitalBadge(e)}</td>
      <td class="items-cell">
        <span class="chevron" data-toggle-group="${groupId}">▶</span><span class="grp-badge">${items.length} items</span>
      </td>
      <td class="num"><b>${fmt$(totalCost)}</b></td>
      <td class="row-actions">
        <button class="row-menu-btn" data-exp-menu="${e.id}" aria-label="Actions" title="Actions">⋯</button>
      </td>
    </tr>`;
  // Show per-item cost only when the expense is tracked per-item — in total
  // mode every line's cost is 0, so showing it just clutters the dropdown.
  const showPerItemCost = e.costMode === 'perItem';
  html += items.map(it => `
    <tr class="child-row" data-parent="${groupId}" hidden>
      <td colspan="6" class="child-cell">
        <div class="child-strip">
          <span class="cs-label">↳</span>
          <span class="cs-items">${expenseItemLabel(it)}</span>
          ${showPerItemCost ? `<span class="cs-total">${fmt$(it.cost)}</span>` : ''}
        </div>
      </td>
    </tr>`).join('');
  return html;
}

function renderSingleExpenseRow(e) {
  const items = expenseItems(e);
  const it = items[0] || { product: e.product || '', cost: e.cost || 0 };
  // Use expenseCost(e) instead of it.cost so total-cost-mode expenses (where
  // each line item's cost is 0 and the real amount lives on e.totalCost)
  // display correctly. Also covers per-item-mode multi-item rows.
  return `<tr${expenseExcluded(e) ? ' class="is-capital"' : ''}>
    <td>${vendorCell(e.vendor)}</td>
    <td>${e.dateOrdered ? fmtDateShort(e.dateOrdered) : '<span class="muted">—</span>'}</td>
    <td class="cat-cell">${expenseCategoryChip(e)}${capitalBadge(e)}</td>
    <td>${expenseItemLabel(it)}</td>
    <td class="num">${fmt$(expenseCost(e))}</td>
    <td class="row-actions">
      <button class="row-menu-btn" data-exp-menu="${e.id}" aria-label="Actions" title="Actions">⋯</button>
    </td>
  </tr>`;
}

function expModal(existing) {
  const data = existing
    ? JSON.parse(JSON.stringify(existing))
    : { vendor: '', dateOrdered: todayISO(), dateReceived: '', costMode: 'total', totalCost: 0, category: '', excludeFromNet: false, items: [{ product: '', qty: 1, unit: 'qty', cost: 0 }] };
  if (!Array.isArray(data.items)) data.items = [];
  if (data.items.length === 0) data.items.push({ product: '', qty: 1, unit: 'qty', cost: 0 });
  // Backfill new fields on legacy items so the form renders cleanly.
  data.items = data.items.map(it => ({
    product: it.product || '',
    qty: it.qty != null ? it.qty : 1,
    unit: (it.unit === 'kits' || it.unit === 'qty') ? it.unit : 'qty',
    cost: it.cost != null ? it.cost : 0,
  }));
  if (typeof data.vendor !== 'string') data.vendor = '';
  if (data.costMode !== 'total' && data.costMode !== 'perItem') data.costMode = 'total';
  if (typeof data.totalCost !== 'number') data.totalCost = 0;
  data.excludeFromNet = !!data.excludeFromNet;
  // A new expense has no category until the description is typed — leave it
  // empty so autoCategory() can keep guessing as the user fills the form, and
  // stop guessing the moment they pick one themselves.
  let categoryTouched = EXPENSE_CATEGORY_KEYS.includes(data.category);
  if (!categoryTouched) data.category = classifyExpense(expenseText(data));

  $('#modalTitle').textContent = existing ? 'Edit Expense' : 'New Expense';
  const form = $('#modalForm');

  // Datalist with current inventory so item descriptions can autocomplete.
  const productOptions = state.stock
    .map(s => `<option value="${escapeHtml(s.name)}"></option>`)
    .join('');

  form.innerHTML = `
    <datalist id="expProductList">${productOptions}</datalist>
    <div class="row-2">
      <label><span class="req">Vendor / Site</span><input type="text" name="vendor" required value="${escapeHtml(data.vendor || '')}" placeholder="e.g. Amazon, Lumen Research" /></label>
      <label><span>Date Ordered</span><input type="date" name="dateOrdered" value="${data.dateOrdered || ''}" /></label>
    </div>
    <label><span>Date Received</span><input type="date" name="dateReceived" value="${data.dateReceived || ''}" /></label>
    <label class="toggle-row">
      <span class="toggle-row-label">
        Track cost per item
        <span class="toggle-row-hint">On = enter a cost on each line · Off = enter a single total</span>
      </span>
      <span class="switch"><input type="checkbox" id="expCostPerItem" ${data.costMode === 'perItem' ? 'checked' : ''} /><span class="slider"></span></span>
    </label>
    <label id="expTotalCostWrap"><span class="req">Total Cost</span><input type="number" min="0" step="any" name="totalCost" value="${data.totalCost || ''}" placeholder="0.00" /></label>
    <label>
      <span class="req">Category</span>
      <select name="category" id="expCategorySelect">
        ${EXPENSE_CATEGORIES.map(c => `<option value="${c.key}" ${c.key === data.category ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
      </select>
      <span class="field-hint" id="expCatHint"></span>
    </label>
    <label class="toggle-row">
      <span class="toggle-row-label">
        Capital / owner-funded
        <span class="toggle-row-hint">On = didn't come out of the business account. Tracked separately, not deducted from Net Profit.</span>
      </span>
      <span class="switch"><input type="checkbox" id="expExcludeNet" ${data.excludeFromNet ? 'checked' : ''} /><span class="slider"></span></span>
    </label>
    <div class="items-section">
      <div class="items-head">
        <span class="label">Products</span>
        <button type="button" class="btn ghost add-item-btn" id="addItemBtn">+ Add Item</button>
      </div>
      <div class="items-col-head exp-col-head" id="expColHead"></div>
      <div id="itemsList"></div>
      <div class="items-summary">
        <span><span class="muted">Items</span> <b id="sumCount">0</b></span>
        <span><span class="muted">Items</span> <b id="sumItems">0</b></span>
        <span><span class="muted">Total</span> <b id="sumTotal">$0</b></span>
      </div>
    </div>
  `;

  const totalCostInput = form.querySelector('[name="totalCost"]');
  const categorySelect = form.querySelector('#expCategorySelect');
  const categoryHint = form.querySelector('#expCatHint');

  // Keep re-guessing the category from vendor + line items while the user
  // types, right up until they choose one by hand. After that the form stops
  // second-guessing them.
  function autoCategory() {
    if (categoryTouched) return;
    const text = expenseText(data);
    const guess = classifyExpense(text);
    data.category = guess;
    categorySelect.value = guess;
    // Nothing typed yet means nothing was actually classified — claiming
    // "filed automatically" over an empty form would be a lie.
    categoryHint.textContent = text
      ? 'Filed automatically — change it if this is wrong.'
      : '';
  }
  categorySelect.addEventListener('change', () => {
    categoryTouched = true;
    data.category = categorySelect.value;
    categoryHint.textContent = '';
  });
  form.querySelector('#expExcludeNet').addEventListener('change', (ev) => {
    data.excludeFromNet = ev.target.checked;
  });

  function applyMode() {
    const perItem = data.costMode === 'perItem';
    form.querySelector('#expTotalCostWrap').hidden = perItem;
    totalCostInput.required = !perItem;
    const head = form.querySelector('#expColHead');
    head.innerHTML = perItem
      ? '<span>Description</span><span>Qty</span><span>Unit</span><span>Cost</span><span></span>'
      : '<span>Description</span><span>Qty</span><span>Unit</span><span></span>';
    head.classList.toggle('exp-col-head-no-cost', !perItem);
    renderItems();
  }

  function refreshRemoveButtons() {
    const list = form.querySelector('#itemsList');
    const onlyOne = data.items.length === 1;
    list.querySelectorAll('[data-remove]').forEach(btn => { btn.disabled = onlyOne; });
  }
  // Per-row closures — adding/removing a line stays surgical, the keyboard
  // never closes and the user can keep typing. Full rebuild only when the
  // user toggles per-item ↔ total-cost mode (the row layout actually changes).
  function buildExpenseRow(it) {
    const perItem = data.costMode === 'perItem';
    const row = document.createElement('div');
    row.className = perItem ? 'item-row exp-item-row' : 'item-row exp-item-row no-cost';
    const unit = it.unit === 'kits' ? 'kits' : 'qty';
    const baseFields = `
      <input type="text" list="expProductList" autocomplete="off" data-field="product" value="${escapeHtml(it.product || '')}" placeholder="Search or add product…" />
      <input type="number" inputmode="numeric" min="0" step="1" data-field="qty" value="${it.qty ?? ''}" placeholder="Qty" />
      <select data-field="unit">
        <option value="qty" ${unit === 'qty' ? 'selected' : ''}>Qty</option>
        <option value="kits" ${unit === 'kits' ? 'selected' : ''}>Kits</option>
      </select>
    `;
    row.innerHTML = perItem
      ? baseFields + `
        <input type="number" inputmode="decimal" min="0" step="any" data-field="cost" value="${it.cost ?? ''}" placeholder="0.00" />
        <button type="button" class="icon-btn danger" data-remove title="Remove">×</button>
      `
      : baseFields + `
        <button type="button" class="icon-btn danger" data-remove title="Remove">×</button>
      `;
    row.querySelectorAll('[data-field]').forEach(el => {
      const eventName = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(eventName, () => {
        const field = el.dataset.field;
        let val = el.value;
        if (field === 'cost' || field === 'qty') val = val === '' ? null : Number(val);
        it[field] = val;
        if (field === 'product') autoCategory();
        updateSummary();
      });
    });
    row.querySelector('[data-remove]').addEventListener('click', () => {
      if (data.items.length === 1) return;
      const idx = data.items.indexOf(it);
      if (idx >= 0) data.items.splice(idx, 1);
      row.remove();
      refreshRemoveButtons();
      updateSummary();
    });
    return row;
  }

  function renderItems() {
    const list = form.querySelector('#itemsList');
    list.innerHTML = '';
    data.items.forEach(it => list.appendChild(buildExpenseRow(it)));
    refreshRemoveButtons();
    updateSummary();
  }

  function updateSummary() {
    form.querySelector('#sumCount').textContent = data.items.length;
    // Stock items — a kit counts as 10, a qty line 1:1. Mirrors the shipment
    // rule, and is not a vial count once qty lines are in the mix.
    const unitTotal = data.items.reduce((s, it) => {
      const q = Number(it.qty) || 0;
      const mult = it.unit === 'kits' ? KIT_TO_VIAL_MULTIPLIER : 1;
      return s + q * mult;
    }, 0);
    form.querySelector('#sumItems').textContent = fmtN(unitTotal);
    const total = data.costMode === 'perItem'
      ? data.items.reduce((s, it) => s + (Number(it.cost) || 0), 0)
      // Read from the in-memory value (kept in sync by the input listener)
      // rather than the DOM, so the summary is correct even if the input
      // element was just (re-)rendered.
      : Number(data.totalCost) || 0;
    form.querySelector('#sumTotal').textContent = fmt$(total);
  }

  form.querySelector('#expCostPerItem').addEventListener('change', (e) => {
    if (e.target.checked) {
      data.costMode = 'perItem';
    } else {
      data.costMode = 'total';
      // Pre-fill the total with the current sum so the user doesn't lose it.
      const sum = data.items.reduce((s, it) => s + (Number(it.cost) || 0), 0);
      if (sum > 0) {
        data.totalCost = sum;
        totalCostInput.value = sum;
      }
    }
    applyMode();
  });
  totalCostInput.addEventListener('input', () => {
    data.totalCost = Number(totalCostInput.value) || 0;
    updateSummary();
  });
  form.querySelector('[name="vendor"]').addEventListener('input', (ev) => {
    data.vendor = ev.target.value;
    autoCategory();
  });

  form.querySelector('#addItemBtn').addEventListener('click', () => {
    const it = { product: '', qty: 1, unit: 'qty', cost: 0 };
    data.items.push(it);
    const row = buildExpenseRow(it);
    form.querySelector('#itemsList').appendChild(row);
    refreshRemoveButtons();
    updateSummary();
    focusForKeyboard(row.querySelector('[data-field="product"]'));
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  applyMode();
  autoCategory();

  modalOnSave = async () => {
    const vendorInput = form.querySelector('[name="vendor"]');
    const dateOrderedInput = form.querySelector('[name="dateOrdered"]');
    const dateReceivedInput = form.querySelector('[name="dateReceived"]');
    if (!vendorInput || !dateOrderedInput) {
      alert('Form fields missing — please close and re-open the modal.');
      return;
    }
    const vendor = vendorInput.value.trim();
    const dateOrdered = dateOrderedInput.value || '';
    const dateReceived = (dateReceivedInput && dateReceivedInput.value) || '';
    const costMode = data.costMode;
    // Read from the in-memory value (kept in sync by the input listener) so we
    // don't depend on a possibly-hidden DOM input being readable. This was the
    // root cause of "$100 entered, total saved as $0" reports.
    const totalCost = costMode === 'total' ? (Number(data.totalCost) || 0) : 0;

    if (!vendor) { alert('Vendor is required.'); return; }
    if (!data.items.length) { alert('Add at least one product.'); return; }
    for (const it of data.items) {
      if (!it.product || !String(it.product).trim()) { alert('Each product needs a description.'); return; }
    }
    if (costMode === 'total' && totalCost <= 0) { alert('Enter a total cost greater than 0.'); return; }

    const items = data.items.map(it => ({
      product: String(it.product || '').trim(),
      qty: Number(it.qty) || 0,
      unit: it.unit === 'kits' ? 'kits' : 'qty',
      cost: costMode === 'perItem' ? (Number(it.cost) || 0) : 0,
    }));
    const category = EXPENSE_CATEGORY_KEYS.includes(categorySelect.value)
      ? categorySelect.value
      : classifyExpense([vendor, ...items.map(it => it.product)].join(' '));
    const excludeFromNet = !!form.querySelector('#expExcludeNet').checked;
    const payload = { vendor, dateOrdered, dateReceived, costMode, totalCost, category, excludeFromNet, items };

    let saved;
    if (existing && existing.id) {
      // Look up by id rather than mutating the captured reference, so we
      // always update the live record even if the array got replaced (e.g.
      // by a cloud sync) between opening the modal and saving.
      const live = state.expenses.find(x => x.id === existing.id);
      if (live) {
        Object.assign(live, payload);
        saved = live;
      } else {
        // Record was removed remotely — re-insert with the same id.
        saved = { id: existing.id, ...payload };
        state.expenses.push(saved);
      }
    } else {
      saved = { id: uid('e'), ...payload };
      state.expenses.push(saved);
    }
    saveState();
    renderExpenses();
    renderDashboard();
    closeModal();

    // Cloud sync: await so failures surface to the user immediately rather
    // than silently leaving local + cloud out of sync.
    if (sb) {
      try {
        // Goes through upsertWithColumnRetry so a Supabase table that doesn't
        // have exp_category / exclude_from_net yet still syncs everything else
        // — the new fields stay in the local cache and populate cloud the
        // moment the columns are added.
        const error = await new Promise(resolve => {
          upsertWithColumnRetry('expenses', [saved], ALL_OPTIONAL_COLUMNS.length, resolve);
        });
        if (error) {
          console.error('expense upsert failed', { id: saved.id, error });
          alert(`Saved locally, but cloud sync failed: ${error.message}\n\nReload may revert this edit. Check your Supabase schema (vendor / cost_mode / items columns).`);
          setCloudStatus('offline', 'Sync error');
          return;
        }
        setCloudStatus('online', 'Synced');
        toast(existing ? 'Expense updated.' : 'Expense added.');
      } catch (err) {
        console.error('expense upsert threw', err);
        alert(`Saved locally, but cloud sync failed: ${err.message || err}`);
      }
    } else {
      toast(existing ? 'Expense updated.' : 'Expense added.');
    }
  };

  showModal();
  setTimeout(() => form.querySelector('input[type="text"]')?.focus(), 50);
}

// ---------- INCOME STATEMENT ----------
const isFrom = $('#isFrom');
const isTo = $('#isTo');
[isFrom, isTo].forEach(el => el.addEventListener('change', renderIncome));
$('#isReset').addEventListener('click', () => { isFrom.value = ''; isTo.value = ''; renderIncome(); });

function renderIncome() {
  const from = isFrom.value || '';
  const to = isTo.value || '';
  const inRange = (d) => {
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  };
  const orders = state.orders.filter(o => o.date && (!from && !to ? true : inRange(o.date)));
  const expenses = state.expenses.filter(e => {
    const d = e.dateOrdered || e.dateReceived;
    return !from && !to ? true : inRange(d);
  });

  // Cash basis — paid portion of each order (including partials) flows into
  // revenue / gross. The unpaid balance lands in the Pending block. round2()
  // strips floating-point drift that compounds when summing across many orders.
  const rev = round2(orders.reduce((s, o) => s + orderPaidRevenue(o), 0));
  const gross = round2(orders.reduce((s, o) => s + orderPaidProfit(o), 0));
  const cogs = round2(rev - gross);
  // Operating expenses only — capital / owner-funded purchases are held out so
  // Net Profit reflects how the operation itself performed. They come back in
  // below as All-In Position.
  const opex = sumOperating(expenses);
  const capex = sumCapital(expenses);
  const net = round2(gross - opex);
  const allIn = round2(net - capex);
  const margin = rev > 0 ? (net / rev * 100) : 0;
  const pendG = round2(orders.reduce((s, o) => s + orderBalance(o), 0));
  const pendN = round2(orders.reduce((s, o) => s + orderUnpaidProfit(o), 0));

  $('#isRev').textContent = fmt$(rev);
  $('#isCogs').textContent = fmt$(cogs);
  $('#isGross').textContent = fmt$(gross);
  $('#isOpex').textContent = fmt$(opex);
  $('#isNet').textContent = fmt$(net);
  $('#isMargin').textContent = fmtPct(margin);
  $('#isCapital').textContent = fmt$(capex);
  const allInEl = $('#isAllIn');
  allInEl.textContent = fmt$(allIn);
  allInEl.classList.toggle('is-negative', allIn < 0);
  $('#isPendGross').textContent = fmt$(pendG);
  $('#isPendNet').textContent = fmt$(pendN);

  const capCount = expenses.filter(expenseExcluded).length;
  const capNote = $('#isCapitalNote');
  if (capNote) {
    capNote.textContent = capCount
      ? `${capCount} purchase${capCount === 1 ? '' : 's'} flagged as capital or owner-funded. Held out of Net Profit; All-In Position puts ${capCount === 1 ? 'it' : 'them'} back.`
      : 'Nothing flagged as capital or owner-funded in this period.';
  }
  renderIncomeCategories(expenses);
}

// The accountant-facing table: every category with its operating and capital
// halves broken out, plus a total row that ties back to the summary cards.
function renderIncomeCategories(expenses) {
  const el = $('#isCatTable');
  if (!el) return;
  const totals = expenseCategoryTotals(expenses);
  if (!totals.length) {
    el.innerHTML = '<p class="muted" style="margin:0;">No expenses in this period.</p>';
    return;
  }
  const anyCapital = totals.some(r => r.capital > 0);
  const grand = { total: 0, operating: 0, capital: 0, count: 0 };
  totals.forEach(r => {
    grand.total += r.total; grand.operating += r.operating;
    grand.capital += r.capital; grand.count += r.count;
  });
  const row = (r, cls) => `
    <tr${cls ? ` class="${cls}"` : ''}>
      <td>${escapeHtml(r.label)}</td>
      <td class="num muted">${r.count}</td>
      <td class="num">${fmt$(round2(r.operating))}</td>
      ${anyCapital ? `<td class="num">${r.capital > 0 ? fmt$(round2(r.capital)) : '<span class="muted">—</span>'}</td>` : ''}
      <td class="num"><b>${fmt$(round2(r.total))}</b></td>
    </tr>`;
  el.innerHTML = `
    <table class="table compact">
      <thead>
        <tr>
          <th>Category</th>
          <th class="num">#</th>
          <th class="num">Operating</th>
          ${anyCapital ? '<th class="num">Capital</th>' : ''}
          <th class="num">Total</th>
        </tr>
      </thead>
      <tbody>
        ${totals.map(r => row({ ...r, label: expenseCategoryLabel(r.key) })).join('')}
      </tbody>
      <tfoot>
        ${row({ ...grand, label: 'Total' }, 'is-cat-total')}
      </tfoot>
    </table>`;
}

// ---------- MONTHLY (calendar view) ----------
const monthlySearch = $('#monthlySearch');
persistFilter($('#monthlyFilter'), 'lumen.monthly.filter');
persistFilter(monthlySearch, 'lumen.monthly.search');
wireSearchClear(monthlySearch);
[$('#monthlyFilter'), monthlySearch].forEach(el =>
  el.addEventListener('input', renderMonthly)
);
$('#monthlyReset').addEventListener('click', () => {
  // Reset returns the calendar to the year overview and forgets the saved spot.
  monthlyView = 'year';
  calYear = null;
  calMonth = null;
  try { localStorage.removeItem(CAL_STATE_KEY); } catch {}
  resetFilters([monthlySearch, $('#monthlyFilter')]);
  renderMonthly();
});

// The Monthly tab drills down: year overview → month calendar → day detail.
//   monthlyView: 'year' | 'month'
//   calYear:  number, the year shown in the year overview
//   calMonth: 'YYYY-MM', the month shown in the calendar
let monthlyView = 'year';
let calYear = null;
let calMonth = null;
// Buckets from the most recent renderMonthly run so the drill-down views and
// the day-detail modal can look up totals without recomputing.
let __monthlyDayBuckets = {};
// True when the Monthly view is showing the Pending (Potential) filter — used
// by the calendar / summary / day-detail to relabel "Gross" → "Pending" so the
// user always knows whether they're looking at cash received or potential.
let __monthlyPending = false;
let __monthlyMonthBuckets = {};

// Persist the drill-down state so closing/reopening the app lands you back on
// the exact view you left (e.g. May's calendar), not the year overview. Reset
// clears it.
const CAL_STATE_KEY = 'lumen.monthly.calState';
function saveCalState() {
  try {
    localStorage.setItem(CAL_STATE_KEY, JSON.stringify({ view: monthlyView, year: calYear, month: calMonth }));
  } catch {}
}
(function loadCalState() {
  try {
    const s = JSON.parse(localStorage.getItem(CAL_STATE_KEY) || 'null');
    if (!s) return;
    if (s.view === 'year' || s.view === 'month') monthlyView = s.view;
    if (typeof s.year === 'number') calYear = s.year;
    if (typeof s.month === 'string' && /^\d{4}-\d{2}$/.test(s.month)) calMonth = s.month;
  } catch {}
})();

function addMonthsToKey(mk, delta) {
  const [y, m] = (mk || monthKey(todayISO())).split('-').map(Number);
  const d = new Date(y, (m - 1) + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// One delegated listener for the whole calendar card. Head / summary / content
// are re-rendered on each navigation, so delegating off the stable card avoids
// re-binding buttons every render.
$('#calCard').addEventListener('click', (e) => {
  if (e.target.closest('[data-cal-back]')) {
    calYear = Number((calMonth || '').slice(0, 4)) || calYear;
    monthlyView = 'year';
    renderMonthly();
    return;
  }
  if (e.target.closest('[data-cal-prev]')) {
    if (monthlyView === 'year') calYear -= 1;
    else calMonth = addMonthsToKey(calMonth, -1);
    renderMonthly();
    return;
  }
  if (e.target.closest('[data-cal-next]')) {
    if (monthlyView === 'year') calYear += 1;
    else calMonth = addMonthsToKey(calMonth, 1);
    renderMonthly();
    return;
  }
  const monthCell = e.target.closest('[data-cal-month]');
  if (monthCell) {
    calMonth = monthCell.dataset.calMonth;
    calYear = Number(calMonth.slice(0, 4));
    monthlyView = 'month';
    renderMonthly();
    return;
  }
  const dayCell = e.target.closest('[data-cal-day]');
  if (dayCell) { openDayDetail(dayCell.dataset.calDay); return; }
  const weekCell = e.target.closest('[data-cal-week]');
  if (weekCell) {
    const [wmk, wn, sd, ed] = weekCell.dataset.calWeek.split(':');
    openWeekDetail(wmk, Number(wn), Number(sd), Number(ed));
  }
});

// Top Products card has its OWN filters — it shouldn't be tied to the months
// table's filter state. Independent month/day/status/sort/limit + collapse toggle.
const tpMonth = $('#tpMonth');
const tpDay = $('#tpDay');
const TP_MONTH_KEY = 'lumen.topProducts.month';
const TP_DAY_KEY = 'lumen.topProducts.day';
const TP_OPEN_KEY = 'lumen.topProducts.open';
persistFilter($('#tpStatus'), 'lumen.topProducts.status');
persistFilter(tpMonth, TP_MONTH_KEY);
persistFilter(tpDay, TP_DAY_KEY);
persistFilter($('#tpCategory'), 'lumen.topProducts.category');
persistFilter($('#tpSort'), 'lumen.topProducts.sort');
persistFilter($('#tpLimit'), 'lumen.topProducts.limit');
[$('#tpStatus'), tpMonth, tpDay, $('#tpCategory'), $('#tpSort'), $('#tpLimit')].forEach(el =>
  el.addEventListener('input', renderTopProducts)
);
$('#tpReset').addEventListener('click', () => resetFilters(
  [$('#tpStatus'), tpMonth, tpDay, $('#tpCategory'), $('#tpSort'), $('#tpLimit')]
));
const tpToggleBtn = $('#topProductsToggle');
const tpBody = $('#topProductsBody');
function setTopProductsOpen(open) {
  tpBody.hidden = !open;
  tpToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  tpToggleBtn.textContent = open ? 'Hide Top Products ▴' : 'View Top Products ▾';
  try { localStorage.setItem(TP_OPEN_KEY, open ? '1' : '0'); } catch {}
}
tpToggleBtn.addEventListener('click', () => {
  setTopProductsOpen(tpBody.hidden);
});
// Restore prior open/closed state — collapsed by default for first-time visits.
try { setTopProductsOpen(localStorage.getItem(TP_OPEN_KEY) === '1'); } catch { setTopProductsOpen(false); }

function refreshTopProductsMonthDropdown() {
  const months = Array.from(new Set(state.orders.map(o => monthKey(o.date)).filter(Boolean)))
    .sort((a, b) => b.localeCompare(a));
  const stored = (() => { try { return localStorage.getItem(TP_MONTH_KEY) || ''; } catch { return ''; } })();
  const cur = tpMonth.value || stored;
  tpMonth.innerHTML = `<option value="all">All Months</option>` +
    months.map(m => `<option value="${m}">${monthName(m + '-01')}</option>`).join('');
  if (cur === 'all' || months.includes(cur)) tpMonth.value = cur;
}

function refreshTopProductsDayDropdown() {
  const mo = tpMonth.value;
  const allDates = state.orders.map(o => o.date).filter(Boolean);
  const scoped = mo === 'all' ? allDates : allDates.filter(d => monthKey(d) === mo);
  const days = Array.from(new Set(scoped)).sort((a, b) => b.localeCompare(a));
  const stored = (() => { try { return localStorage.getItem(TP_DAY_KEY) || ''; } catch { return ''; } })();
  const cur = tpDay.value || stored;
  tpDay.innerHTML = `<option value="all">All Days</option>` +
    days.map(d => `<option value="${d}">${fmtDateShort(d)}</option>`).join('');
  if (cur === 'all' || days.includes(cur)) tpDay.value = cur;
  else tpDay.value = 'all';
}

function renderTopProducts() {
  refreshTopProductsMonthDropdown();
  refreshTopProductsDayDropdown();
  const status = $('#tpStatus').value;
  const mo = tpMonth.value;
  const dy = tpDay.value;
  const cat = $('#tpCategory').value;
  const sort = $('#tpSort').value;
  const limit = $('#tpLimit').value;

  let orders = state.orders;
  if (status === 'paid') orders = orders.filter(o => o.paid);
  if (status === 'unpaid') orders = orders.filter(o => !o.paid);
  if (mo !== 'all') orders = orders.filter(o => monthKey(o.date) === mo);
  if (dy !== 'all') orders = orders.filter(o => o.date === dy);

  // Aggregate gross / net / qty per product across the filtered orders.
  const byProduct = {};
  orders.forEach(o => {
    orderItems(o).forEach(it => {
      const name = it.product;
      if (!name) return;
      const qty = Number(it.qty) || 0;
      const price = Number(it.price) || 0;
      const cogs = Number(it.cogs) || 0;
      if (!byProduct[name]) byProduct[name] = { gross: 0, net: 0, qty: 0, cat: itemCategory(name) };
      byProduct[name].gross += qty * price;
      byProduct[name].net += qty * (price - cogs);
      byProduct[name].qty += qty;
    });
  });
  const all = Object.entries(byProduct).map(([name, v]) => ({ name, ...v }));

  // Group into category sections. The limit applies PER category, so "Top 10"
  // means the top 10 peptides and the top 10 gear — not 10 rows total.
  const sections = CATEGORIES
    .filter(c => cat === 'all' || cat === c.key)
    .map(c => {
      let rows = all.filter(r => r.cat === c.key).sort((a, b) => b[sort] - a[sort]);
      if (limit !== 'all') rows = rows.slice(0, Number(limit) || rows.length);
      // Subtotals cover the rows actually displayed, so a limited view still
      // adds up to what's on screen.
      const sub = rows.reduce(
        (acc, r) => { acc.gross += r.gross; acc.net += r.net; acc.qty += r.qty; return acc; },
        { gross: 0, net: 0, qty: 0 }
      );
      return { ...c, rows, sub };
    })
    .filter(s => s.rows.length);

  const body = $('#monthlyTopProducts');
  body.innerHTML = sections.length
    ? sections.map(s => `
        <tr class="tp-cat-row tp-cat-${s.key}">
          <td colspan="4">
            <div class="tp-cat-bar">
              <span class="tp-cat-name">${escapeHtml(s.label)}</span>
              <span class="tp-cat-count">${fmtN(s.rows.length)} ${s.rows.length === 1 ? 'item' : 'items'}</span>
              <div class="tp-cat-stats">
                <div class="tp-cat-stat"><span>Units</span><b>${fmtN(s.sub.qty)}</b></div>
                <div class="tp-cat-stat"><span>Gross</span><b>${fmt$(s.sub.gross)}</b></div>
                <div class="tp-cat-stat"><span>Net Profit</span><b class="tp-net">${fmt$(s.sub.net)}</b></div>
              </div>
            </div>
          </td>
        </tr>
        ${s.rows.map((r, i) => `<tr class="tp-item-row tp-cat-${s.key}">
          <td><span class="tp-rank">${i + 1}</span><b>${escapeHtml(r.name)}</b></td>
          <td class="num">${fmtN(r.qty)}</td>
          <td class="num">${fmt$(r.gross)}</td>
          <td class="num tp-net">${fmt$(r.net)}</td>
        </tr>`).join('')}
      `).join('')
    : `<tr><td colspan="4" class="muted" style="padding:18px;text-align:center;">No data.</td></tr>`;

  // Footer = the combined total across every section shown.
  const totals = sections.reduce(
    (acc, s) => { acc.gross += s.sub.gross; acc.net += s.sub.net; acc.qty += s.sub.qty; return acc; },
    { gross: 0, net: 0, qty: 0 }
  );
  $('#tpQty').textContent = fmtN(totals.qty);
  $('#tpGross').textContent = fmt$(totals.gross);
  $('#tpNet').textContent = fmt$(totals.net);
  $('#tpGrandLabel').textContent = cat === 'all'
    ? 'Grand Total — All Categories'
    : `Grand Total — ${categoryLabel(cat)}`;
}

function renderMonthly() {
  // Normalize legacy 'unpaid' filter value (now superseded by 'pending').
  const rawFilter = $('#monthlyFilter').value;
  const filter = rawFilter === 'unpaid' ? 'pending' : rawFilter;
  const q = monthlySearch.value.toLowerCase().trim();
  let orders = state.orders;
  // "Paid Only" includes partially-paid orders too — their partial payments
  // are real cash received and should still land on the calendar. Anything
  // with at least one payment qualifies; completely unpaid orders drop out.
  if (filter === 'paid') orders = orders.filter(o => orderPaymentsTotal(o) > 0.005);
  if (q) orders = orders.filter(o => {
    if ((o.customer || '').toLowerCase().includes(q)) return true;
    return orderItems(o).some(it => (it.product || '').toLowerCase().includes(q));
  });

  // Two bucketing modes:
  //   Cash mode (default / Paid Only): payments land on their own date as gross,
  //     profit + items land on the day the order closed (last payment).
  //   Pending mode (Pending filter): unpaid BALANCES are bucketed on the order's
  //     date so the user can see potential income laid out by when each order
  //     was placed. Net = unpaid profit (all-or-nothing). Qty = order qty.
  const dayBuckets = {};
  const monthBuckets = {};
  const ensureDay = (dk) => {
    if (!dayBuckets[dk]) dayBuckets[dk] = {
      gross: 0, net: 0, qty: 0, orders: [], payments: [],
      pendingGross: 0, pendingNet: 0, pendingQty: 0, pendingOrders: [],
    };
    return dayBuckets[dk];
  };
  const ensureMonth = (mk) => {
    if (!monthBuckets[mk]) monthBuckets[mk] = {
      gross: 0, net: 0, qty: 0,
      pendingGross: 0, pendingNet: 0, pendingQty: 0,
    };
    return monthBuckets[mk];
  };
  if (filter === 'pending') {
    orders.forEach(o => {
      const balance = orderBalance(o);
      if (balance <= 0.005) return;          // nothing pending — skip
      const dk = o.date;
      if (!dk) return;
      const day = ensureDay(dk);
      day.gross += balance;
      day.net += orderUnpaidProfit(o);
      day.qty += orderQty(o);
      day.orders.push(o);
      const mb = ensureMonth(monthKey(dk));
      mb.gross += balance;
      mb.net += orderUnpaidProfit(o);
      mb.qty += orderQty(o);
    });
  } else {
    orders.forEach(o => {
      // 1) Every payment counts as gross on its own date — but cap the total
      // attributed to any single order at orderTotal so an over-payment can't
      // inflate the books. This matches the Dashboard's orderPaidRevenue()
      // which caps at orderTotal for the same reason.
      const cap = orderTotal(o);
      let attributed = 0;
      for (const p of orderPayments(o)) {
        const pd = p && p.date;
        const raw = Number(p && p.amount) || 0;
        if (!pd || raw <= 0) continue;
        const room = Math.max(0, cap - attributed);
        if (room <= 0) break;
        const amt = Math.min(raw, room);
        attributed += amt;
        const day = ensureDay(pd);
        day.gross += amt;
        day.payments.push({ order: o, payment: p });
        ensureMonth(monthKey(pd)).gross += amt;
      }
      // 2) Profit + qty land on the day the order closed (last payment date).
      // Round profit per-order (matches Dashboard's orderPaidProfit) so summed
      // buckets equal the Dashboard's rounded Gross Profit figure.
      const completed = orderCompletionDate(o);
      if (completed) {
        const profit = orderPaidProfit(o);
        const qty = orderQty(o);
        const day = ensureDay(completed);
        day.net += profit;
        day.qty += qty;
        day.orders.push(o);
        const mb = ensureMonth(monthKey(completed));
        mb.net += profit;
        mb.qty += qty;
      }
    });
    // "All Orders" also layers the still-unpaid balance of each order onto its
    // order date so the user sees realized cash AND potential income side by
    // side. "Paid Only" stays cash-only.
    if (filter === 'all') {
      orders.forEach(o => {
        const balance = orderBalance(o);
        if (balance <= 0.005) return;
        const dk = o.date;
        if (!dk) return;
        const day = ensureDay(dk);
        day.pendingGross += balance;
        day.pendingNet += orderUnpaidProfit(o);
        day.pendingQty += orderQty(o);
        day.pendingOrders.push(o);
        const mb = ensureMonth(monthKey(dk));
        mb.pendingGross += balance;
        mb.pendingNet += orderUnpaidProfit(o);
        mb.pendingQty += orderQty(o);
      });
    }
  }
  __monthlyPending = filter === 'pending';
  __monthlyDayBuckets = dayBuckets;
  __monthlyMonthBuckets = monthBuckets;
  // Tint the calendar so the Pending filter looks visibly different from the
  // cash-flow view — prevents mistaking potential income for realized cash.
  const calCard = $('#calCard');
  if (calCard) calCard.classList.toggle('cal-pending-mode', __monthlyPending);

  // Defaults: land on the most recent year / month that has cash activity.
  if (calYear == null) {
    const years = Array.from(new Set(Object.keys(monthBuckets).map(mk => mk.slice(0, 4)))).sort();
    calYear = Number(years[years.length - 1]) || new Date().getFullYear();
  }
  if (!calMonth) {
    const months = Object.keys(monthBuckets).sort();
    calMonth = months[months.length - 1] || monthKey(todayISO());
  }

  if (monthlyView === 'month') renderCalendar(calMonth, dayBuckets);
  else renderYearView(calYear, monthBuckets);

  saveCalState();
  renderTopProducts();
}

// Reusable summary strip — relabels itself under the Pending filter, and in
// "All Orders" combines paid + pending into a single number per stat (like the
// weekly total cells). Tooltip breaks down the paid/pending split on hover.
function calSummaryHtml(gross, net, qty, pendingGross, pendingNet, pendingQty) {
  const labels = __monthlyPending
    ? { gross: 'Pending', net: 'Potential Profit', qty: 'Items Pending' }
    : { gross: 'Total Gross', net: 'Net Profit', qty: 'Total Items' };
  const g = Number(gross) || 0;
  const n = Number(net) || 0;
  const q = Number(qty) || 0;
  const pg = Number(pendingGross) || 0;
  const pn = Number(pendingNet) || 0;
  const pq = Number(pendingQty) || 0;
  const hasPending = !__monthlyPending && (pg > 0.005 || pq > 0);
  // Cash-basis totals — match the Dashboard's Gross Revenue / Gross Profit
  // cards. Pending amounts are shown as a subtle "+ $X pending" line beneath
  // instead of being folded into the headline number.
  const grossTip = hasPending ? ` title="${fmt$(round2(g))} paid · ${fmt$(round2(pg))} pending"` : '';
  const netTip = hasPending ? ` title="${fmt$(round2(n))} paid · ${fmt$(round2(pn))} pending"` : '';
  const qtyTip = hasPending ? ` title="${fmtN(q)} delivered · ${fmtN(pq)} pending"` : '';
  const pendGrossLine = hasPending ? `<span class="cal-sum-pending-line">+${fmt$(round2(pg))} pending</span>` : '';
  const pendNetLine = hasPending ? `<span class="cal-sum-pending-line">+${fmt$(round2(pn))} pending</span>` : '';
  const pendQtyLine = hasPending ? `<span class="cal-sum-pending-line">+${fmtN(pq)} pending</span>` : '';
  return `
    <div class="cal-sum-stat cal-sum-gross${__monthlyPending ? ' cal-sum-pending' : ''}"${grossTip}><span class="cal-sum-label">${labels.gross}</span><b>${fmt$(round2(g))}</b>${pendGrossLine}</div>
    <div class="cal-sum-stat cal-sum-net${__monthlyPending ? ' cal-sum-pending' : ''}"${netTip}><span class="cal-sum-label">${labels.net}</span><b>${fmt$(round2(n))}</b>${pendNetLine}</div>
    <div class="cal-sum-stat cal-sum-qty"${qtyTip}><span class="cal-sum-label">${labels.qty}</span><b>${fmtN(q)}</b>${pendQtyLine}</div>
  `;
}

// Average of the most recent months that actually had sales — used to paint a
// faint "projected" figure on upcoming, still-empty months in the year view.
// Weighted toward the last few months so the estimate tracks recent performance.
function computeMonthlyProjection(monthBuckets) {
  const keys = Object.keys(monthBuckets)
    .filter(mk => { const b = monthBuckets[mk]; return b && (b.gross || b.net || b.qty); })
    .sort();
  if (!keys.length) return null;
  const recent = keys.slice(-3);   // last up-to-3 months with data
  let g = 0, n = 0, q = 0;
  recent.forEach(mk => { g += monthBuckets[mk].gross; n += monthBuckets[mk].net; q += monthBuckets[mk].qty; });
  const c = recent.length;
  return { gross: g / c, net: n / c, qty: q / c, basis: c };
}

// YEAR overview — 12 month tiles, each showing that month's totals. Tapping a
// month drills into its calendar. Prev/next nav moves between years. Upcoming
// months with no orders yet show a faint projection based on recent months.
function renderYearView(year, monthBuckets) {
  const head = $('#calHead'), summary = $('#calSummary'), content = $('#calContent');
  if (!content) return;

  head.innerHTML = `
    <button type="button" class="cal-nav" data-cal-prev aria-label="Previous year">‹</button>
    <div class="cal-title">${year}</div>
    <button type="button" class="cal-nav" data-cal-next aria-label="Next year">›</button>
  `;

  let yg = 0, yn = 0, yq = 0, ypg = 0, ypn = 0, ypq = 0;
  for (const mk of Object.keys(monthBuckets)) {
    if (mk.slice(0, 4) === String(year)) {
      const b = monthBuckets[mk];
      yg += b.gross; yn += b.net; yq += b.qty;
      ypg += b.pendingGross || 0; ypn += b.pendingNet || 0; ypq += b.pendingQty || 0;
    }
  }
  summary.innerHTML = calSummaryHtml(yg, yn, yq, ypg, ypn, ypq);

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const proj = computeMonthlyProjection(monthBuckets);
  const nextMonthKey = addMonthsToKey(monthKey(todayISO()), 1);
  let cells = '';
  for (let m = 1; m <= 12; m++) {
    const mk = `${year}-${String(m).padStart(2, '0')}`;
    const b = monthBuckets[mk];
    const hasRealized = b && (b.gross || b.net || b.qty);
    const hasPending = b && b.pendingGross > 0.005;
    const has = hasRealized || hasPending;
    // Only the single upcoming month gets a faint projection from recent months.
    // The moment a real order lands there, `has` flips true and the actual
    // numbers replace it. Every other empty month reads "No sales".
    const projectable = !has && proj && mk === nextMonthKey;
    const cls = ['cal-month-cell'];
    if (has) cls.push('cal-month-active');
    else if (projectable) cls.push('cal-month-projected');

    let inner;
    if (has) {
      const pendingGrossSpan = hasPending
        ? ` <span class="cal-month-pending-inline" title="${fmt$(round2(b.pendingGross))} potential">+${fmt$(round2(b.pendingGross))}</span>`
        : '';
      const pendingNetSpan = hasPending
        ? ` <span class="cal-month-pending-net-inline" title="${fmt$(round2(b.pendingNet))} potential profit">+${fmt$(round2(b.pendingNet))}</span>`
        : '';
      const totalQty = (b.qty || 0) + (b.pendingQty || 0);
      // Month-over-month delta on gross — cash modes only, completed months
      // only (the in-progress month would always read as a misleading drop).
      // Compares across year boundaries: Jan reads against prior-year Dec.
      let deltaSpan = '';
      if (!__monthlyPending && hasRealized && mk !== monthKey(todayISO())) {
        const prevMk = addMonthsToKey(mk, -1);
        const prevG = Number(monthBuckets[prevMk] && monthBuckets[prevMk].gross) || 0;
        const curG = Number(b.gross) || 0;
        if (prevG > 0.005 && curG > 0.005) {
          const pct = Math.round(((curG - prevG) / prevG) * 100);
          const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
          const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '—';
          deltaSpan = `<span class="cal-month-delta ${dir}" title="vs ${monthName(prevMk + '-01')}: ${fmt$(round2(prevG))}">${arrow} ${Math.abs(pct)}% MoM</span>`;
        }
      }
      inner = `
        <span class="cal-month-gross">${fmt$(round2(b.gross))}${pendingGrossSpan}</span>
        <span class="cal-month-net">${fmt$(round2(b.net))}${pendingNetSpan}</span>
        ${deltaSpan}
        <span class="cal-month-qty">${fmtN(totalQty)} item${totalQty === 1 ? '' : 's'}</span>`;
    } else if (projectable) {
      const pq = Math.round(proj.qty);
      inner = `
        <span class="cal-month-proj-tag">Projected</span>
        <span class="cal-month-gross">~${fmt$(Math.round(proj.gross))}</span>
        <span class="cal-month-net">~${fmt$(Math.round(proj.net))}</span>
        <span class="cal-month-qty">~${fmtN(pq)} item${pq === 1 ? '' : 's'}</span>`;
    } else {
      inner = `<span class="cal-month-empty">No sales</span>`;
    }

    cells += `
      <button type="button" class="${cls.join(' ')}" data-cal-month="${mk}">
        <span class="cal-month-name">${MONTHS[m - 1]}</span>
        ${inner}
      </button>`;
  }
  content.innerHTML = `<div class="cal-months-grid">${cells}</div>`;
}

// MONTH calendar — the day grid. A back button returns to the year overview;
// prev/next nav moves between months. Each day with orders is tappable.
function renderCalendar(mk, dayBuckets) {
  const head = $('#calHead'), summary = $('#calSummary'), content = $('#calContent');
  if (!content) return;
  const [yr, mo] = mk.split('-').map(Number);

  head.innerHTML = `
    <button type="button" class="cal-back" data-cal-back>‹ ${yr}</button>
    <div class="cal-nav-group">
      <button type="button" class="cal-nav" data-cal-prev aria-label="Previous month">‹</button>
      <div class="cal-title">${monthName(mk + '-01')}</div>
      <button type="button" class="cal-nav" data-cal-next aria-label="Next month">›</button>
    </div>
  `;

  let mg = 0, mn = 0, mq = 0, mpg = 0, mpn = 0, mpq = 0;
  for (const dk of Object.keys(dayBuckets)) {
    if (monthKey(dk) === mk) {
      const b = dayBuckets[dk];
      mg += b.gross; mn += b.net; mq += b.qty;
      mpg += b.pendingGross || 0; mpn += b.pendingNet || 0; mpq += b.pendingQty || 0;
    }
  }
  summary.innerHTML = calSummaryHtml(mg, mn, mq, mpg, mpn, mpq);

  const firstDow = new Date(yr, mo - 1, 1).getDay();   // 0=Sun … 6=Sat
  const daysInMonth = new Date(yr, mo, 0).getDate();
  const totalRows = Math.ceil((firstDow + daysInMonth) / 7);
  // Months that span 6 Sun-Sat rows (31-day months starting Fri/Sat, 30-day
  // months starting Sat) fold row 6 into Week 5 so every month renders as
  // exactly 4 or 5 weekly totals — without breaking the calendar weekday
  // alignment.
  const foldRow6 = totalRows === 6;
  const todayKey = todayISO();

  // Build a flat 7×totalRows sequence (leading pad + days + trailing pad), then
  // walk row-by-row to interleave each row's Week-total cell.
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length < totalRows * 7) cells.push(null);

  const renderDayCell = (d) => {
    if (d == null) return `<div class="cal-cell cal-cell-empty"></div>`;
    const dk = `${mk}-${String(d).padStart(2, '0')}`;
    const b = dayBuckets[dk];
    // A day is "active" if cash came in OR an order completed OR there's a
    // pending balance on an order placed that day (All Orders view) — any of
    // those should make the cell tappable.
    const has = b && (
      b.gross > 0 || b.net !== 0 || b.qty > 0 ||
      (b.orders && b.orders.length) || (b.payments && b.payments.length) ||
      b.pendingGross > 0
    );
    const cls = ['cal-cell'];
    if (has) cls.push('cal-cell-active');
    if (dk === todayKey) cls.push('cal-cell-today');
    if (has) {
      // Pending in "All Orders" sits inline next to the realized totals — no
      // extra rows, distinguished by color only (amber gross / teal profit).
      const showPending = b.pendingGross > 0.005;
      const pendingGrossSpan = showPending
        ? ` <span class="cal-cell-pending-inline" title="${fmt$(round2(b.pendingGross))} potential">+${fmt$(round2(b.pendingGross))}</span>`
        : '';
      const pendingNetSpan = showPending
        ? ` <span class="cal-cell-pending-net-inline" title="${fmt$(round2(b.pendingNet))} potential profit">+${fmt$(round2(b.pendingNet))}</span>`
        : '';
      // Items count includes pending qty so the day reflects ALL items in play
      // (realized + still-owed), not just orders that have closed.
      const totalQty = (b.qty || 0) + (b.pendingQty || 0);
      return `
        <button type="button" class="${cls.join(' ')}" data-cal-day="${dk}">
          <span class="cal-cell-day">${d}</span>
          <span class="cal-cell-gross">${fmt$(round2(b.gross))}${pendingGrossSpan}</span>
          <span class="cal-cell-net">${fmt$(round2(b.net))}${pendingNetSpan}</span>
          <span class="cal-cell-qty">${fmtN(totalQty)} item${totalQty === 1 ? '' : 's'}</span>
        </button>`;
    }
    return `<div class="${cls.join(' ')}"><span class="cal-cell-day">${d}</span></div>`;
  };

  const rowTotal = (r) => {
    let g = 0, n = 0, q = 0, pg = 0, pn = 0, pq = 0;
    for (let c = 0; c < 7; c++) {
      const d = cells[r * 7 + c];
      if (d == null) continue;
      const b = dayBuckets[`${mk}-${String(d).padStart(2, '0')}`];
      if (b) {
        g += b.gross; n += b.net; q += b.qty;
        pg += b.pendingGross || 0; pn += b.pendingNet || 0; pq += b.pendingQty || 0;
      }
    }
    return { g, n, q, pg, pn, pq };
  };

  // First/last day-of-month in a given visual row (skips leading/trailing pad).
  const rowDayRange = (r) => {
    let start = null, end = null;
    for (let c = 0; c < 7; c++) {
      const d = cells[r * 7 + c];
      if (d != null) { if (start == null) start = d; end = d; }
    }
    return { start, end };
  };

  const renderWeekCell = (weekNum, startDay, endDay, g, n, q, pg, pn, pq, spanRows) => {
    const spanClass = spanRows ? ' cal-week-total-span2' : '';
    const label = `Week ${weekNum}`;
    const had = g || n || q || pg > 0.005 || pn > 0.005 || pq > 0;
    if (had) {
      const ds = `${mk}:${weekNum}:${startDay}:${endDay}`;
      // Week total = realized + pending in a single combined number per stat.
      // Tooltip breaks down the two parts in case the user wants to see them.
      const totalG = (Number(g) || 0) + (Number(pg) || 0);
      const totalN = (Number(n) || 0) + (Number(pn) || 0);
      const totalQ = (Number(q) || 0) + (Number(pq) || 0);
      const hasPending = pg > 0.005 || pq > 0;
      const grossTip = hasPending ? ` title="${fmt$(round2(g))} paid + ${fmt$(round2(pg))} pending"` : '';
      const netTip = hasPending ? ` title="${fmt$(round2(n))} paid + ${fmt$(round2(pn))} pending"` : '';
      const qtyTip = hasPending ? ` title="${fmtN(q)} delivered + ${fmtN(pq)} pending"` : '';
      return `
        <button type="button" class="cal-week-total cal-week-total-active${spanClass}" data-cal-week="${ds}">
          <span class="cal-week-label">${label}</span>
          <span class="cal-week-gross"${grossTip}>${fmt$(round2(totalG))}</span>
          <span class="cal-week-net"${netTip}>${fmt$(round2(totalN))}</span>
          <span class="cal-week-qty"${qtyTip}>${fmtN(totalQ)} item${totalQ === 1 ? '' : 's'}</span>
        </button>`;
    }
    return `<div class="cal-week-total${spanClass}"><span class="cal-week-label">${label}</span><span class="cal-week-empty">—</span></div>`;
  };

  let grid = '';
  let weekNum = 1;
  for (let r = 0; r < totalRows; r++) {
    for (let c = 0; c < 7; c++) grid += renderDayCell(cells[r * 7 + c]);
    if (foldRow6 && r === 5) continue;                 // row 6's totals already counted in Week 5
    let { g, n, q, pg, pn, pq } = rowTotal(r);
    let { start, end } = rowDayRange(r);
    if (foldRow6 && r === 4) {                         // Week 5 absorbs row 6
      const t6 = rowTotal(5);
      g += t6.g; n += t6.n; q += t6.q;
      pg += t6.pg; pn += t6.pn; pq += t6.pq;
      const r6 = rowDayRange(5);
      if (r6.end != null) end = r6.end;
    }
    grid += renderWeekCell(weekNum, start, end, g, n, q, pg, pn, pq, foldRow6 && r === 4);
    weekNum++;
  }

  content.innerHTML = `
    <div class="cal-weekdays" aria-hidden="true">
      <span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Week</span>
    </div>
    <div class="cal-grid">${grid}</div>
  `;
}

// Read-only modal showing every sale on a given day, grouped by customer.
// Shared line-item row for the day/week drill-down popups. Uses the
// post-discount line total (itemLineTotal) — NOT raw qty × price — so the
// popup agrees with the order totals when line discounts or sale prices
// apply. Discounted/sale lines show the original line amount struck through.
function ddItemRowHtml(it) {
  const qty = Number(it.qty) || 0;
  const price = Number(it.price) || 0;
  const orig = Number(it.originalPrice) || 0;
  const lineDisc = itemDiscountAmount(it);
  const lineTotal = itemLineTotal(it);
  const strikeSrc = orig > price ? orig : price;
  const wasAmount = round2(qty * strikeSrc);
  const showStrike = (orig > price || lineDisc > 0) && wasAmount > round2(lineTotal);
  return `<div class="dd-item">
    <span class="dd-item-name">${escapeHtml(it.product || '')}</span>
    <span class="dd-item-qty muted">×${fmtN(qty)}</span>
    <span class="dd-item-total">${showStrike ? `<s class="dd-item-was">${fmt$(wasAmount)}</s> ` : ''}${fmt$(round2(lineTotal))}</span>
  </div>`;
}

function openDayDetail(dateKey) {
  const b = __monthlyDayBuckets[dateKey];
  const pendingOrdersList = Array.isArray(b && b.pendingOrders) ? b.pendingOrders : [];
  if (!b || (!b.orders.length && !b.payments.length && !pendingOrdersList.length)) return;

  // Distinct customers across payments received, orders closed, AND unpaid
  // orders placed that day (All Orders view).
  const customerSet = new Set();
  for (const pe of b.payments) customerSet.add((pe.order.customer || '').toLowerCase().trim());
  for (const o of b.orders) customerSet.add((o.customer || '').toLowerCase().trim());
  for (const o of pendingOrdersList) customerSet.add((o.customer || '').toLowerCase().trim());

  // Each completed order contributes its full subtotal/profit/items to the
  // "Orders completed today" section.
  const completed = b.orders.map(o => ({
    name: o.customer || 'Customer',
    total: orderTotal(o),
    profit: orderProfit(o),
    items: orderItems(o),
  }));
  // Pending orders for "All Orders" view — show remaining balance + potential
  // profit, since those are the actionable numbers.
  const pendingList = pendingOrdersList.map(o => ({
    name: o.customer || 'Customer',
    balance: orderBalance(o),
    profit: orderUnpaidProfit(o),
    items: orderItems(o),
  }));

  $('#modalTitle').textContent = fmtDateLong(dateKey) + (__monthlyPending ? ' · Pending' : '');
  const form = $('#modalForm');
  const labels = __monthlyPending
    ? { gross: 'Pending', net: 'Potential Profit', qty: 'Items Pending', sectionOrders: 'Pending Orders' }
    : { gross: 'Total Gross', net: 'Net Profit', qty: 'Total Items', sectionOrders: 'Orders Completed' };
  const ddTotalQty = (b.qty || 0) + (b.pendingQty || 0);
  const ddQtyTip = (!__monthlyPending && (b.pendingQty || 0) > 0)
    ? ` title="${fmtN(b.qty)} delivered + ${fmtN(b.pendingQty)} pending"`
    : '';
  form.innerHTML = `
    <div class="day-detail${__monthlyPending ? ' day-detail-pending' : ''}">
      <div class="day-detail-summary">
        <div class="dd-stat dd-stat-gross"><span>${labels.gross}</span><b>${fmt$(round2(b.gross))}</b></div>
        <div class="dd-stat dd-stat-net"><span>${labels.net}</span><b>${fmt$(round2(b.net))}</b></div>
        <div class="dd-stat dd-stat-qty"${ddQtyTip}><span>${labels.qty}</span><b>${fmtN(ddTotalQty)}</b></div>
        <div class="dd-stat"><span>Customers</span><b>${fmtN(customerSet.size)}</b></div>
      </div>
      ${b.payments.length ? `
        <div class="dd-section">
          <div class="dd-section-head">Payments Received</div>
          <div class="dd-payments">
            ${b.payments.map(pe => {
              const amt = Number(pe.payment && pe.payment.amount) || 0;
              const method = (pe.payment && pe.payment.method) || '';
              const bal = orderBalance(pe.order);
              const fullPaid = orderHasLandedProfit(pe.order);
              const tag = fullPaid
                ? `<span class="dd-pay-tag dd-pay-tag-final">Paid in full</span>`
                : `<span class="dd-pay-tag dd-pay-tag-partial">Partial · ${fmt$(round2(bal))} still owed</span>`;
              return `<div class="dd-payment">
                <span class="dd-pay-name"><b>${escapeHtml(pe.order.customer || 'Customer')}</b>${method ? ` <span class="muted">· ${escapeHtml(method)}</span>` : ''}</span>
                <span class="dd-pay-amount">${fmt$(round2(amt))}</span>
                ${tag}
              </div>`;
            }).join('')}
          </div>
        </div>
      ` : ''}
      ${completed.length ? `
        <div class="dd-section">
          <div class="dd-section-head">${labels.sectionOrders}</div>
          <div class="day-detail-list">
            ${completed.map(c => `
              <div class="dd-customer">
                <div class="dd-customer-head">
                  <b class="dd-customer-name">${escapeHtml(c.name)}</b>
                  <span class="dd-customer-totals">${fmt$(round2(c.total))} <span class="muted">· ${fmt$(round2(c.profit))} profit</span></span>
                </div>
                <div class="dd-items">
                  ${c.items.map(it => ddItemRowHtml(it)).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      ${pendingList.length ? `
        <div class="dd-section dd-section-pending">
          <div class="dd-section-head dd-section-head-pending">Pending Orders</div>
          <div class="day-detail-list">
            ${pendingList.map(c => `
              <div class="dd-customer dd-customer-pending">
                <div class="dd-customer-head">
                  <b class="dd-customer-name">${escapeHtml(c.name)}</b>
                  <span class="dd-customer-totals"><span class="dd-pending-amt">${fmt$(round2(c.balance))} due</span> <span class="muted">· ${fmt$(round2(c.profit))} potential</span></span>
                </div>
                <div class="dd-items">
                  ${c.items.map(it => ddItemRowHtml(it)).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;

  modalOnSave = null;
  modal.classList.add('modal-readonly');
  $('#modalCancel').textContent = 'Close';
  showModal();
}

// Same shape as openDayDetail but aggregates every day in the week's range —
// for 6-row months, Week 5's range extends through the folded row-6 days.
function openWeekDetail(mk, weekNum, startDay, endDay) {
  const allOrders = [];
  const allPayments = [];
  const allPendingOrders = [];
  let gross = 0, net = 0, qty = 0, pendingGross = 0, pendingNet = 0, pendingQty = 0;
  for (let d = startDay; d <= endDay; d++) {
    const dk = `${mk}-${String(d).padStart(2, '0')}`;
    const b = __monthlyDayBuckets[dk];
    if (!b) continue;
    allOrders.push(...(b.orders || []));
    allPayments.push(...(b.payments || []));
    allPendingOrders.push(...(b.pendingOrders || []));
    gross += b.gross; net += b.net; qty += b.qty;
    pendingGross += b.pendingGross || 0; pendingNet += b.pendingNet || 0; pendingQty += b.pendingQty || 0;
  }
  // Open even if no order completed in the week — partial-payment activity
  // OR a pending balance alone is still worth showing.
  if (!allOrders.length && !allPayments.length && !allPendingOrders.length) return;

  const byCustomer = new Map();
  for (const o of allOrders) {
    const key = (o.customer || '').toLowerCase().trim();
    if (!byCustomer.has(key)) byCustomer.set(key, { name: o.customer || '', total: 0, profit: 0, items: [] });
    const c = byCustomer.get(key);
    c.total += orderTotal(o);
    c.profit += orderProfit(o);
    c.items.push(...orderItems(o));
  }

  const startDk = `${mk}-${String(startDay).padStart(2, '0')}`;
  const endDk = `${mk}-${String(endDay).padStart(2, '0')}`;
  const rangeLabel = startDay === endDay ? fmtDateLong(startDk) : `${fmtDateLong(startDk)} – ${fmtDateLong(endDk)}`;
  $('#modalTitle').textContent = `Week ${weekNum} · ${rangeLabel}`;

  const hasPending = pendingGross > 0.005 || pendingQty > 0;
  // Week detail mirrors the calendar's week-total cells: one combined number
  // for gross and profit (paid + pending), with the breakdown surfacing as a
  // tooltip. Items count rolls realized + pending together too.
  const totalG = gross + pendingGross;
  const totalN = net + pendingNet;
  const totalQ = qty + pendingQty;
  const grossTip = hasPending ? ` title="${fmt$(round2(gross))} paid + ${fmt$(round2(pendingGross))} pending"` : '';
  const netTip = hasPending ? ` title="${fmt$(round2(net))} paid + ${fmt$(round2(pendingNet))} pending"` : '';
  const qtyTip = hasPending ? ` title="${fmtN(qty)} delivered + ${fmtN(pendingQty)} pending"` : '';

  const form = $('#modalForm');
  form.innerHTML = `
    <div class="day-detail">
      <div class="day-detail-summary">
        <div class="dd-stat dd-stat-gross"${grossTip}><span>Total Gross</span><b>${fmt$(round2(totalG))}</b></div>
        <div class="dd-stat dd-stat-net"${netTip}><span>Net Profit</span><b>${fmt$(round2(totalN))}</b></div>
        <div class="dd-stat dd-stat-qty"${qtyTip}><span>Total Items</span><b>${fmtN(totalQ)}</b></div>
        <div class="dd-stat"><span>Customers</span><b>${fmtN(byCustomer.size)}</b></div>
      </div>
      ${byCustomer.size ? `
        <div class="dd-section">
          <div class="dd-section-head">Orders Completed</div>
          <div class="day-detail-list">
            ${[...byCustomer.values()].map(c => `
              <div class="dd-customer">
                <div class="dd-customer-head">
                  <b class="dd-customer-name">${escapeHtml(c.name || 'Customer')}</b>
                  <span class="dd-customer-totals">${fmt$(round2(c.total))} <span class="muted">· ${fmt$(round2(c.profit))} profit</span></span>
                </div>
                <div class="dd-items">
                  ${c.items.map(it => ddItemRowHtml(it)).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      ${allPendingOrders.length ? `
        <div class="dd-section dd-section-pending">
          <div class="dd-section-head dd-section-head-pending">Pending Orders</div>
          <div class="day-detail-list">
            ${allPendingOrders.map(o => {
              const bal = orderBalance(o);
              const prof = orderUnpaidProfit(o);
              const its = orderItems(o);
              return `<div class="dd-customer dd-customer-pending">
                <div class="dd-customer-head">
                  <b class="dd-customer-name">${escapeHtml(o.customer || 'Customer')}</b>
                  <span class="dd-customer-totals"><span class="dd-pending-amt">${fmt$(round2(bal))} due</span> <span class="muted">· ${fmt$(round2(prof))} potential</span></span>
                </div>
                <div class="dd-items">
                  ${its.map(it => ddItemRowHtml(it)).join('')}
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;

  modalOnSave = null;
  modal.classList.add('modal-readonly');
  $('#modalCancel').textContent = 'Close';
  showModal();
}

// ---------- Export & Backup ----------
function downloadBlob(filename, text, mime) {
  try {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  } catch (e) {
    console.error('download failed', e);
    toast('Download failed.');
  }
}

// Quote a CSV cell only when it contains a delimiter, quote, or newline.
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// Lead with a UTF-8 BOM so Excel reads accented characters correctly.
function toCSV(headers, rows) {
  return '﻿' + [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}
// "Retatrutide x2; BPC-157 x1" — a compact item summary for one spreadsheet cell.
function itemsSummary(items) {
  return (items || []).map(it => {
    const q = Number(it && it.qty) || 0;
    return `${(it && it.product) || ''}${q ? ` x${q}` : ''}`;
  }).filter(s => s.trim()).join('; ');
}

function exportOrdersCSV() {
  const headers = ['Date', 'Customer', 'Items', 'Total Qty', 'Subtotal', 'Discount', 'Shipping', 'Order Total', 'Amount Paid', 'Balance Due', 'Status', 'Delivered', 'Profit'];
  const rows = state.orders.slice()
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .map(o => {
      const status = orderIsFullyPaid(o) ? 'Paid' : (orderPaymentsTotal(o) > 0.005 ? 'Partial' : 'Unpaid');
      return [
        o.date || '', o.customer || '', itemsSummary(orderItems(o)), orderQty(o),
        round2(orderItemsTotal(o)), round2(orderDiscountAmount(o)), round2(orderShipping(o)),
        round2(orderTotal(o)), round2(orderPaidRevenue(o)), round2(orderBalance(o)),
        status, o.delivered ? 'Yes' : 'No', round2(orderProfit(o)),
      ];
    });
  downloadBlob(`lumen-orders-${todayISO()}.csv`, toCSV(headers, rows), 'text/csv;charset=utf-8');
  toast(`Exported ${rows.length} order${rows.length === 1 ? '' : 's'}.`);
}

function exportExpensesCSV() {
  // Operating and capital get their own columns rather than a single amount
  // plus a flag — a bookkeeper can sum either column straight out of the sheet.
  const headers = [
    'Date Ordered', 'Date Received', 'Vendor', 'Category', 'Description',
    'Operating Cost', 'Capital / Owner-Funded', 'Total Cost',
  ];
  const rows = state.expenses.slice()
    .sort((a, b) => (a.dateOrdered || '').localeCompare(b.dateOrdered || ''))
    .map(e => [
      e.dateOrdered || '', e.dateReceived || '', e.vendor || '',
      expenseCategoryLabel(expenseCategory(e)),
      itemsSummary(expenseItems(e)) || (e.product || ''),
      round2(expenseOperatingCost(e)), round2(expenseCapitalCost(e)), round2(expenseCost(e)),
    ]);
  downloadBlob(`lumen-expenses-${todayISO()}.csv`, toCSV(headers, rows), 'text/csv;charset=utf-8');
  toast(`Exported ${rows.length} expense${rows.length === 1 ? '' : 's'}.`);
}

function exportShipmentsCSV() {
  const headers = [
    'Date Ordered', 'Date Received', 'Transit Days', 'Vendor', 'Category',
    'Product', 'Amount', 'Unit', 'Stock Items', 'Tracking', 'Status',
  ];
  const rows = state.shipments.slice()
    .sort((a, b) => (a.dateOrdered || '').localeCompare(b.dateOrdered || ''))
    .map(s => {
      const st = shipmentStatus(s);
      const transit = shipmentTransitDays(s);
      return [
        s.dateOrdered || '', s.dateReceived || '', transit == null ? '' : transit,
        s.vendor || '', categoryLabel(shipmentCategory(s)),
        s.product || '', s.kits || '', s.unit === 'qty' ? 'Qty' : 'Kits',
        shipmentUnitCount(s), s.tracking || '', st.label,
      ];
    });
  downloadBlob(`lumen-shipments-${todayISO()}.csv`, toCSV(headers, rows), 'text/csv;charset=utf-8');
  toast(`Exported ${rows.length} shipment${rows.length === 1 ? '' : 's'}.`);
}

function exportInventoryCSV() {
  const headers = ['Product', 'Cost', 'Price', 'Qty', 'Reorder At', 'Margin', 'Stock Value (Net)', 'Stock Value (Gross)', 'Status'];
  const rows = state.stock.slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(p => {
      const cost = Number(p.cost) || 0, price = Number(p.price) || 0, qty = Number(p.qty) || 0;
      const margin = price - cost;
      return [p.name || '', cost, price, qty, stockReorderLevel(p), margin, round2(margin * qty), round2(price * qty), p.status || 'ACTIVE'];
    });
  downloadBlob(`lumen-inventory-${todayISO()}.csv`, toCSV(headers, rows), 'text/csv;charset=utf-8');
  toast(`Exported ${rows.length} product${rows.length === 1 ? '' : 's'}.`);
}

function backupAllJSON() {
  const payload = {
    app: 'lumen-peptides-tracker',
    type: 'backup',
    version: 1,
    build: BUILD_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      stock: state.stock,
      orders: state.orders,
      shipments: state.shipments,
      expenses: state.expenses,
    },
  };
  downloadBlob(`lumen-backup-${todayISO()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  toast('Backup downloaded.');
}

function restoreFromBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try { parsed = JSON.parse(String(reader.result || '')); }
    catch { toast('That file isn’t valid JSON.'); return; }
    const d = (parsed && parsed.data) ? parsed.data : parsed;
    const keys = ['stock', 'orders', 'shipments', 'expenses'];
    if (!d || typeof d !== 'object' || !keys.some(k => Array.isArray(d[k]))) {
      toast('That doesn’t look like a Lumen backup.');
      return;
    }
    const counts = keys.map(k => `${(d[k] || []).length} ${k}`).join(', ');
    if (!confirm(
      `Restore this backup?\n\n${counts}\n\n` +
      `This REPLACES all current data on this device and in the cloud. ` +
      `If you're not sure, download a backup of your current data first.`
    )) return;

    state.stock = migrateStock(Array.isArray(d.stock) ? d.stock : []);
    state.orders = migrateOrders(Array.isArray(d.orders) ? d.orders : []);
    state.shipments = migrateShipments(Array.isArray(d.shipments) ? d.shipments : []);
    state.expenses = migrateExpenses(Array.isArray(d.expenses) ? d.expenses : []);
    saveState();
    setCloudStatus('syncing', 'Syncing…');
    Promise.resolve(cloudPushAll(state))
      .then(() => setCloudStatus('online', 'Synced'))
      .catch(err => { console.error('restore cloud push failed', err); setCloudStatus('offline', 'Sync error'); });
    renderDashboard(); renderOrders(); renderInventory();
    renderShipments(); renderExpenses(); renderIncome(); renderMonthly();
    toast('Backup restored.');
  };
  reader.onerror = () => toast('Could not read that file.');
  reader.readAsText(file);
}

$('#exportOrdersBtn')?.addEventListener('click', exportOrdersCSV);
$('#exportExpensesBtn')?.addEventListener('click', exportExpensesCSV);
$('#exportShipmentsBtn')?.addEventListener('click', exportShipmentsCSV);
$('#exportInventoryBtn')?.addEventListener('click', exportInventoryCSV);
$('#backupBtn')?.addEventListener('click', backupAllJSON);
(function wireRestore() {
  const input = $('#restoreInput');
  $('#restoreBtn')?.addEventListener('click', () => input && input.click());
  input?.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) restoreFromBackup(file);
    e.target.value = '';   // let the same file be picked again later
  });
})();

$('#resetBtn').addEventListener('click', resetState);
$('#syncNowBtn').addEventListener('click', manualSync);

function syncHideNumbersBtn() {
  const btn = $('#hideNumbersBtn');
  if (btn) btn.textContent = hideNumbers ? 'Show numbers' : 'Hide numbers';
  document.body.classList.toggle('numbers-hidden', hideNumbers);
}
$('#hideNumbersBtn').addEventListener('click', () => {
  hideNumbers = !hideNumbers;
  try { localStorage.setItem(HIDE_NUMBERS_KEY, hideNumbers ? '1' : '0'); } catch (e) {}
  syncHideNumbersBtn();
  renderAll();
  toast(hideNumbers ? 'Numbers hidden.' : 'Numbers visible.');
});
syncHideNumbersBtn();

// ---------- Mobile drawer ----------
const sidebarEl = $('#sidebar');
const backdropEl = $('#drawerBackdrop');
const menuBtnEl = $('#menuBtn');
function openMenu() {
  sidebarEl.classList.add('open');
  backdropEl.classList.add('show');
  document.body.classList.add('menu-open');
  menuBtnEl?.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  sidebarEl.classList.remove('open');
  backdropEl.classList.remove('show');
  document.body.classList.remove('menu-open');
  menuBtnEl?.setAttribute('aria-expanded', 'false');
}
menuBtnEl?.addEventListener('click', () => {
  sidebarEl.classList.contains('open') ? closeMenu() : openMenu();
});
backdropEl?.addEventListener('click', closeMenu);
$$('.nav-item').forEach(b => b.addEventListener('click', closeMenu));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sidebarEl.classList.contains('open')) closeMenu();
});

// Touch swipe gestures — right-from-left-edge opens the drawer, left-anywhere closes it.
// Only active on the mobile breakpoint and never while a modal is open.
//
// The touchmove listener (passive: false) is attached PER GESTURE — only when
// a touch starts in a region where a swipe is plausible (the left edge, or
// anywhere while the menu is open) — and removed on touchend. This minimizes
// the time a non-passive touch handler is alive at the document level, which
// is important for iOS standalone PWA mode where always-on document touch
// handlers can interfere with input focus / keyboard activation.
(function setupSwipeGestures() {
  const EDGE_TRIGGER_PX = 48;        // open swipes must start within this many px of the left edge
  const OPEN_THRESHOLD_PX = 30;      // horizontal travel required to open
  const CLOSE_THRESHOLD_PX = 40;     // horizontal travel required to close
  const VERTICAL_TOLERANCE_PX = 60;  // ignore if motion is mostly vertical (treated as scroll)
  const mq = window.matchMedia('(max-width: 900px)');
  let startX = null, startY = null, claimed = null; // claimed: null | 'horizontal' | 'vertical'
  let moveListenerAttached = false;

  // Decide the gesture axis on the FIRST touchmove with any movement. iOS
  // commits to scroll-vs-gesture on that first move: if we preventDefault it,
  // the page won't scroll at all for the rest of the touch (so no up/down jump
  // while opening the menu); if we DON'T, the page scrolls normally. Waiting
  // longer (e.g. until 10px of travel) is what caused the page to nudge before
  // we claimed the swipe. We bias ties toward horizontal so a natural arcing
  // edge-swipe still opens the drawer, but a clearly-vertical drag scrolls.
  function onTouchMove(e) {
    if (startX === null) return;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    const adx = Math.abs(dx), ady = Math.abs(dy);

    if (claimed === null) {
      if (adx === 0 && ady === 0) return; // no direction yet — wait for the next move
      const isOpen = sidebarEl.classList.contains('open');
      const fromEdge = startX <= EDGE_TRIGGER_PX;
      const couldOpen = !isOpen && fromEdge && dx > 0;
      const couldClose = isOpen && dx < 0;
      // Plausible drawer swipe + not vertical-dominant → lock horizontal.
      claimed = ((couldOpen || couldClose) && adx >= ady) ? 'horizontal' : 'vertical';
    }
    if (claimed === 'horizontal' && e.cancelable) {
      e.preventDefault();
    }
  }

  function attachMoveListener() {
    if (moveListenerAttached) return;
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    moveListenerAttached = true;
  }
  function detachMoveListener() {
    if (!moveListenerAttached) return;
    document.removeEventListener('touchmove', onTouchMove, { passive: false });
    moveListenerAttached = false;
  }

  document.addEventListener('touchstart', (e) => {
    claimed = null;
    if (!mq.matches) { startX = null; return; }
    if (document.body.classList.contains('modal-open')) { startX = null; return; }
    if (e.touches.length !== 1) { startX = null; return; }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    // Only listen for touchmove (with preventDefault capability) if this touch
    // could plausibly be a drawer swipe. Tapping inputs / scrolling tables /
    // any other touch leaves the global touch path clean — critical for iOS
    // PWA keyboard activation.
    const fromEdge = startX <= EDGE_TRIGGER_PX;
    const drawerOpen = sidebarEl.classList.contains('open');
    if (fromEdge || drawerOpen) {
      attachMoveListener();
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    detachMoveListener();
    if (startX === null) { claimed = null; return; }
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = Math.abs(t.clientY - startY);
    const x0 = startX;
    const wasHorizontal = claimed === 'horizontal';
    startX = null; claimed = null;
    if (!wasHorizontal && dy > VERTICAL_TOLERANCE_PX) return;
    const isOpen = sidebarEl.classList.contains('open');
    if (!isOpen && x0 <= EDGE_TRIGGER_PX && dx > OPEN_THRESHOLD_PX) {
      openMenu();
    } else if (isOpen && dx < -CLOSE_THRESHOLD_PX) {
      closeMenu();
    }
  }, { passive: true });

  document.addEventListener('touchcancel', () => {
    detachMoveListener();
    startX = null;
    claimed = null;
  }, { passive: true });
})();

// ---------- INIT ----------
function renderAll() {
  renderDashboard();
  renderOrders();
  renderCustomers();
  renderInventory();
  renderShipments();
  renderExpenses();
  renderIncome();
  renderMonthly();
}
saveState(); // persist initial seed if first run
renderAll();
restoreLastView(); // honor the last view the user was on across refreshes

// ---------- AUTH ----------
const loginOverlay = $('#loginOverlay');
const loginForm = $('#loginForm');
const loginBtn = $('#loginBtn');
const loginError = $('#loginError');

function showLogin() {
  loginOverlay.classList.add('show');
  document.body.classList.add('locked');
}
function hideLogin() {
  loginOverlay.classList.remove('show');
  document.body.classList.remove('locked');
  loginError.textContent = '';
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!sb) { loginError.textContent = 'Cloud not configured.'; return; }
  const email = loginForm.email.value.trim();
  const password = loginForm.password.value;
  loginBtn.disabled = true;
  loginError.textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email, password });
  loginBtn.disabled = false;
  if (error) {
    loginError.textContent = error.message || 'Sign-in failed.';
    return;
  }
  loginForm.password.value = '';
  hideLogin();
  initCloud();
});

$('#logoutBtn').addEventListener('click', async () => {
  if (!sb) return;
  if (!confirm('Sign out?')) return;
  await sb.auth.signOut();
  showLogin();
  setCloudStatus('offline', 'Signed out');
});

if (sb) {
  // Body keeps the `app-booting` class (set in HTML) so neither the app
  // nor the login overlay flashes before we know whether a session exists.
  sb.auth.getSession().then(({ data }) => {
    document.body.classList.remove('app-booting');
    if (data && data.session) {
      hideLogin();
      initCloud();
    } else {
      showLogin();
    }
  });
  // Reflect external sign-outs (token expired, signed out from another tab) in the UI.
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') showLogin();
  });
} else {
  document.body.classList.remove('app-booting');
  hideLogin();
  setCloudStatus('offline', 'No cloud configured');
}
// ── Terminal clock (preview-only) ─────────────────────────────
// Live HH:MM:SS readout in the sidebar footer. Pure flavor — no
// app logic depends on it.
(function () {
  const el = document.getElementById('termClock');
  if (!el) return;
  const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const p = (n) => String(n).padStart(2, '0');
  const tick = () => {
    const d = new Date();
    const h24 = d.getHours();
    const h12 = h24 % 12 || 12;
    const ampm = h24 < 12 ? 'AM' : 'PM';
    el.textContent = `${DAYS[d.getDay()]} ${h12}:${p(d.getMinutes())}:${p(d.getSeconds())} ${ampm} · ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  };
  tick();
  setInterval(tick, 1000);
})();
