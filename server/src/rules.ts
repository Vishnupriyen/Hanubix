// The server's own word on what a phone may save. Phones are not trusted with money, approvals, numbers or other
// people's records: these rules hold whatever a phone (or someone with its token) sends.
import type pg from 'pg';

type Doc = Record<string, unknown>;

/** PINs anyone would try first (4 or 6 digits): one digit repeated, pairs repeated (1212, 121212), straight or
 *  step-2 runs up or down (1234, 1357, 2468, 9753, 135791…), keypad lines (2580, 0852, 1470…), years 1950–2030, and for
 *  6 digits a date (DDMMYY or YYMMDD — a birthday). Phone and server use the same list (app/src/core/sync.ts). */
export function weakPin(pin: string): boolean {
  if (!/^(\d{4}|\d{6})$/.test(pin)) return false;
  const d = [...pin].map(Number);
  if (new Set(d).size === 1) return true;
  if (/^(\d\d)\1+$/.test(pin) || /^(\d\d\d)\1$/.test(pin)) return true;
  for (const step of [1, 2, -1, -2]) if (d.every((x, i) => i === 0 || (x - d[i - 1] + 10) % 10 === (step + 10) % 10)) return true;
  if (['2580', '0852', '1470', '0741', '3690', '0963', '7410', '9630', '1590', '9510', '3570', '0753', '147258', '258369', '852741', '123123', '112233', '102030', '010203'].some(k => pin.includes(k) && (k.length === pin.length || pin.length === 4))) return true;
  if (pin.length === 4) { const y = Number(pin); return y >= 1950 && y <= 2030; }
  const date = (dd: number, mm: number) => mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
  return date(d[0] * 10 + d[1], d[2] * 10 + d[3]) || date(d[4] * 10 + d[5], d[2] * 10 + d[3]);
}

// ---------------------------------------------------------------- bad text
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** strings Postgres can't store (a lone half of an emoji, \u0000) are cleaned, so one bad character never blocks a sync */
export function cleanText(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(LONE, '�').replace(/\u0000/g, '');
  if (Array.isArray(v)) return v.map(cleanText);
  if (v && typeof v === 'object') {
    const out: Doc = {};
    for (const [k, x] of Object.entries(v as Doc)) out[cleanText(k) as string] = cleanText(x);
    return out;
  }
  return v;
}

// ---------------------------------------------------------------- money and approvals (distributor side)
const META = new Set(['id', 'tenantId', 'updatedAt', 'createdAt', 'dirty']);
/** what a delivery phone writes on a bill: the delivery result (and the stock lots on its lines) */
const DELIVERY_FIELDS = new Set(['deliveryStatus', 'delivery', 'tripId', 'stopNo', 'vanId', 'printedAt']);
// key order never matters (Postgres stores a record's keys in its own order; a phone sends them in the order it built them)
const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v as Doc).sort().filter(k => (v as Doc)[k] !== undefined).map(k => [k, canon((v as Doc)[k])])) : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));
const linesNoLots = (l: unknown) => (Array.isArray(l) ? l : []).map(x => { const { batches: _b, ...rest } = (x ?? {}) as Doc; void _b; return rest; });
const ORDER_RANK: Record<string, number> = { new: 0, needs_ok: 0, approved: 1, picked: 2, billed: 3, cancelled: 3 };
const decided = (s: unknown) => s === 'approved' || s === 'rejected';

/** distributor records written by a role other than owner/office: a reason to refuse, or null */
export function distributorRule(role: string, userId: string, table: string, data: Doc, existing: Doc | undefined): string | null {
  if (role === 'owner' || role === 'office') return null;
  if (table === 'invoices') {
    if (!existing) return 'only the owner or office makes bills';
    for (const k of new Set([...Object.keys(data), ...Object.keys(existing)])) {
      if (META.has(k) || DELIVERY_FIELDS.has(k)) continue;
      if (k === 'lines') { if (!same(linesNoLots(data.lines), linesNoLots(existing.lines))) return 'bill lines are the owner\'s'; continue; }
      if (!same(data[k], existing[k])) return `bill field ${k} is the owner's`;
    }
    return null;
  }
  if (table === 'orders') return orderRule(role, userId, data, existing);
  if (table === 'payments') {
    if (!existing) return data.settled ? 'only the owner or office settles a payment' : !['ok', 'waiting_shop', undefined].includes(data.status as string) ? 'only the owner or office sets a payment status' : null;
    if (String(existing.collectedBy) !== userId) return 'a payment is changed only by the person who took it';
    if (!!data.settled !== !!existing.settled) return 'only the owner or office settles a payment';
    // the one status change a collector makes: cancelling their own collection before it reaches the office
    // (the app's "cancel / correct my payment"; the correction is a new payment)
    if (data.status !== existing.status && !(existing.status === 'ok' && data.status === 'cancelled' && !existing.settled)) return 'only the owner or office sets a payment status';
    return null;
  }
  // a staff return or write-off is a request: saved waiting, by its own person; only the owner or office decides it
  if (table === 'requests') {
    if (!existing) return data.by !== userId ? 'a request is made in your own name' : data.status !== 'waiting' ? 'nobody approves their own' : null;
    if (String(existing.by) !== userId) return 'a request is changed only by the person who made it';
    if (!same(data.status, existing.status) || !same(data.by, existing.by) || !same(data.result, existing.result)) return 'only the owner or office decides';
    return null;
  }
  if (table === 'advances' || table === 'leaves' || table === 'expenses') {
    const keys = table === 'expenses' ? ['status', 'approved'] : ['status'];
    for (const k of keys) {
      if (!existing) { if (k === 'approved' ? !!data.approved : (data[k] !== undefined && data[k] !== 'waiting')) return 'nobody approves their own'; }
      else if (!same(data[k], existing[k])) return 'only the owner or office decides';
    }
    return null;
  }
  return null;
}

/** what a staff phone (not owner/office) may do to an order (security round, Part 2 batch 1):
 *  - a salesman books orders in his own name only (status new, nothing approved, no owner edits on it), and changes or
 *    cancels only his own order while it is still new;
 *  - the godown packs an approved order (status → picked, picked rows, pickedBy = itself);
 *  - nobody else approves, bills or cancels; lines, the salesman's original, approvals, who edited and the source are the
 *    owner's; picked / issues / invoiceIds are the only other fields that move; the activity log only grows.
 *  Rates and Disc % on new or changed lines are checked separately (orderRates, needs the product list). */
const ORDER_OPEN = new Set(['picked', 'issues', 'invoiceIds', 'pickedBy', 'pickedAt']);
export function orderRule(role: string, userId: string, data: Doc, existing: Doc | undefined): string | null {
  if (role === 'owner' || role === 'office') return null;
  if (data.source === 'company' && !existing) return 'a company order comes only through the company link';
  if (!existing) {
    if (role !== 'salesman') return 'only a salesman books an order from his phone';
    if (data.salesmanId !== userId) return 'an order is booked in your own name';
    if (data.status !== 'new' && data.status !== 'needs_ok') return 'a new order waits for the owner';
    for (const k of ['approvedBy', 'approvedAt', 'original', 'editedBy', 'editedAt', 'picked', 'pickedBy', 'pickedAt']) if (data[k] != null) return `order field ${k} is the owner's`;
    if (Array.isArray(data.invoiceIds) && data.invoiceIds.length) return 'order field invoiceIds is the owner\'s';
    const act = Array.isArray(data.activity) ? data.activity as Doc[] : [];
    if (act.some(a => !a || a.by !== userId)) return 'order history is written in your own name';
    return null;
  }
  const a = ORDER_RANK[String(existing.status)] ?? 0, b = ORDER_RANK[String(data.status)] ?? 0;
  if (b < a) return 'an order never goes back';
  if (a === 3 && data.status !== existing.status) return 'a billed or cancelled order is final';
  const mine = role === 'salesman' && existing.salesmanId === userId;
  if (role === 'salesman' && !mine) return 'a salesman changes only his own orders';
  if (data.status !== existing.status) {
    const pack = role === 'godown' && existing.status === 'approved' && data.status === 'picked';
    const cancelOwn = mine && existing.status === 'new' && data.status === 'cancelled';
    if (!pack && !cancelOwn) return 'only the owner or office approves, bills or cancels an order';
  }
  const own = mine && existing.status === 'new'; // his own order, not approved yet: he may still change its lines
  if (!activityGrows(data.activity, existing.activity)) return 'order history only grows';
  for (const k of new Set([...Object.keys(data), ...Object.keys(existing)])) {
    if (META.has(k) || k === 'status' || k === 'activity' || ORDER_OPEN.has(k)) continue;
    if (k === 'lines') { if (!own && !same(linesNoLots(data.lines), linesNoLots(existing.lines))) return 'order lines are the owner\'s'; continue; }
    if (own && (k === 'rateRemark')) continue;
    if (!same(data[k], existing[k])) return `order field ${k} is the owner's`;
  }
  if ((!same(data.picked, existing.picked) || !same(data.pickedBy, existing.pickedBy) || !same(data.pickedAt, existing.pickedAt))
    && !(role === 'godown' && existing.status === 'approved' && data.status === 'picked' && data.pickedBy === userId)) return 'only the godown packs an order';
  return null;
}
/** a log that only grows: the stored entries are the first entries of the new copy, unchanged */
export function activityGrows(mine: unknown, had: unknown): boolean {
  const n = Array.isArray(mine) ? mine : [], o = Array.isArray(had) ? had : [];
  return n.length >= o.length && o.every((x, i) => same(x, n[i]));
}
/** new history entries carry the signed-in person (the token), whatever the phone wrote in them */
export function stampActivity(userId: string, data: Doc, existing: Doc | undefined): Doc {
  const n = Array.isArray(data.activity) ? data.activity as Doc[] : null, o = Array.isArray(existing?.activity) ? existing!.activity as unknown[] : [];
  if (!n || n.length <= o.length || !activityGrows(n, o)) return data;
  return { ...data, activity: n.map((x, i) => i < o.length || !x || typeof x !== 'object' ? x : { ...x, by: userId }) };
}
/** rates on a staff phone's new or changed order lines: the product's own rate (a lower rate only with the salesman's
 *  written reason — the owner decides it at approval, rateRemark), never above it; no Disc % (the owner's). A line the
 *  stored copy already had (same product, rate and Disc %) is not checked again. */
export function orderRates(role: string, data: Doc, existing: Doc | undefined, rateOf: (productId: string) => number | undefined): string | null {
  if (role === 'owner' || role === 'office') return null;
  const had = (Array.isArray(existing?.lines) ? existing!.lines as Doc[] : []).map(l => `${l?.productId}|${l?.rate}|${l?.discountPct ?? 0}`);
  for (const l of Array.isArray(data.lines) ? data.lines as Doc[] : []) {
    if (!l || typeof l !== 'object') continue;
    if (had.includes(`${l.productId}|${l.rate}|${l.discountPct ?? 0}`)) continue;
    if (l.discountPct != null && l.discountPct !== 0) return 'Disc % is the owner\'s';
    const std = rateOf(String(l.productId));
    if (std === undefined) return 'an order line needs a product of this firm';
    const r = Number(l.rate);
    if (Math.abs(r - std) <= 0.001) continue;
    if (r < std && String(data.rateRemark ?? '').trim()) continue;
    return 'order rate must be the product\'s rate';
  }
  return null;
}

/** A bill saved by the owner or office from a copy made BEFORE the driver's delivery result reached it (no result, or an
 *  older one) keeps that result: the delivery status, the result itself and the lots on its lines (the pieces the driver
 *  sent back to stock are never put on the bill again). Everything else in their copy is theirs. A copy that already
 *  carries the result (they saw it) wins as it is. Field-level merge for the delivery phone's fields only. */
export function keepDeliveryResult(role: string, data: Doc, existing: Doc | undefined): Doc {
  if (role !== 'owner' && role !== 'office') return data;
  const had = existing?.delivery as Doc | undefined;
  if (!existing || !had || typeof had !== 'object') return data;
  const mine = data.delivery as Doc | undefined;
  if (mine && typeof mine === 'object' && String(mine.at ?? '') >= String(had.at ?? '')) return data;
  const out: Doc = { ...data, deliveryStatus: existing.deliveryStatus, delivery: had };
  // the lots follow the driver's result while the bill charges the same; a bill whose charge changed keeps its own lines
  if (same(linesNoLots(data.lines), linesNoLots(existing.lines))) out.lines = existing.lines;
  return out;
}

/** Order line numbers are stable ids (Part 2, 2a0). An older phone sends an order without them: when the stored order has
 *  numbers and the same products in the same order, the stored numbers stay on its lines (and on picked rows of the same
 *  products). Any other change is the phone's copy as it is. */
export function keepLineNumbers(data: Doc, existing: Doc | undefined): Doc {
  const mine = Array.isArray(data.lines) ? data.lines as Doc[] : null, had = Array.isArray(existing?.lines) ? existing!.lines as Doc[] : null;
  if (!mine || !had || mine.some(l => l && l.line != null) || !had.some(l => l && l.line != null)) return data;
  if (mine.length !== had.length || mine.some((l, i) => String(l?.productId) !== String(had[i]?.productId))) return data;
  const out: Doc = { ...data, lines: mine.map((l, i) => had[i].line != null ? { ...l, line: had[i].line } : l) };
  if (Array.isArray(data.picked)) out.picked = (data.picked as Doc[]).map(r => {
    if (!r || r.line != null) return r;
    const at = had.find(l => String(l.productId) === String(r.productId));
    return at && at.line != null ? { ...r, line: at.line } : r;
  });
  return out;
}

// ---------------------------------------------------------------- money fields (every role, owner too)
const fin = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
/** the app's own list (app/src/core/db.ts guard): every money field, when present, is a real number */
const MONEY_KEYS = ['amount', 'total', 'taxable', 'tax', 'cgst', 'sgst', 'igst', 'roundOff', 'rate', 'mrp', 'purchaseRate', 'discount', 'gross',
  'advance', 'paid', 'credited', 'received', 'recovered', 'credit', 'debit', 'schemeSaving', 'budget', 'salary', 'batta', 'kmAmount', 'daAmount', 'expenses'];
const MONEY_REQUIRED: Record<string, string[]> = {
  claimEntries: ['amount'], claims: ['amount'], purchases: ['total'], advances: ['amount'], creditNotes: ['total'], payments: ['amount'], openingDues: ['amount'], invoices: ['total', 'taxable', 'cgst', 'sgst', 'igst'],
};
/** the first money field that is not a real number (text, or a required one missing / NaN — NaN arrives as null), or null.
 *  An optional field left empty (null) is allowed, as on the phone. */
export function badMoney(table: string, d: Doc): string | null {
  if (table === 'audit' || table === 'settings' || table === 'staff') return null;
  for (const k of MONEY_REQUIRED[table] ?? []) if (!fin(d[k])) return k;
  const check = (o: Doc) => { for (const k of MONEY_KEYS) if (k in o && o[k] !== undefined && o[k] !== null && !fin(o[k])) return k; return null; };
  const top = check(d); if (top) return top;
  for (const list of ['lines', 'allocations', 'settlements']) {
    const arr = d[list]; if (!Array.isArray(arr)) continue;
    for (const x of arr) if (x && typeof x === 'object') { const k = check(x as Doc); if (k) return `${list}.${k}`; }
  }
  return null;
}

/** order and bill lines the books never take, from any phone (the app's own order and bill-editor checks, held here too):
 *  a quantity is a whole number of pieces (more than 0 on an order) and a rate is more than ₹0 — an order of 2.5 pieces or at rate 0
 *  would be approved and then stick, or make a ₹0 bill. A cheque's date, when sent, is a real day. Returns the reason, or null. */
export function badLines(table: string, d: Doc): string | null {
  if (table === 'orders' || table === 'invoices') {
    const lines = Array.isArray(d.lines) ? d.lines as Doc[] : [];
    // the same product on two lines: sales bills and our own orders only, never a company's order (Part 2)
    if (table === 'orders' && d.source === 'company' && new Set(lines.map(l => String(l?.productId))).size !== lines.length) return 'a company order has each product once';
    const nums = lines.map(l => l?.line).filter(n => n != null);
    if (table === 'orders' && new Set(nums.map(String)).size !== nums.length) return 'two order lines have the same line number';
    for (const l of lines) {
      if (!l || typeof l !== 'object') return 'a line is not valid';
      if (l.discountPct != null && !(typeof l.discountPct === 'number' && Number.isFinite(l.discountPct) && l.discountPct >= 0 && l.discountPct <= 100)) return 'Disc % must be 0 to 100';
      if (table === 'invoices' && l.qty === undefined) continue; // a bill line without pieces (old or partial record) is the bill's own checks
      if (!Number.isInteger(l.qty) || (l.qty as number) < 0 || (table === 'orders' && (l.qty as number) <= 0)) return 'quantity must be whole pieces';
      if (((l.qty as number) > 0 || table === 'orders') && !(typeof l.rate === 'number' && Number.isFinite(l.rate) && l.rate > 0)) return 'rate must be more than 0';
    }
  }
  if (table === 'payments' && d.chequeDate != null && !(typeof d.chequeDate === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(d.chequeDate))) return 'cheque date is not a date';
  return null;
}

/** a credit note never takes a bill below zero: with the bill's other notes it comes to at most what the bill charged */
export function creditNoteRoom(cn: Doc, bill: Doc | undefined, otherNotesTotal: number): string | null {
  if (!bill) return 'a credit note needs its bill';
  if (bill.shopId !== cn.shopId) return 'a credit note is for its own bill\'s shop';
  const total = Number(cn.total), charged = Number(bill.total);
  if (!fin(total) || total < 0) return 'credit note amount is not valid';
  if (Math.round((otherNotesTotal + total) * 100) > Math.round(charged * 100) + 1) return 'credit notes would come to more than the bill charged';
  return null;
}

/** a bill line's pieces come from stock lots: every line carries its lots (batch id, whole pieces 0 or more) — the
 *  same rule the app's guard holds (one rule for every path that makes or changes a bill line) */
export function billLotsOk(d: Doc): boolean {
  const lines = Array.isArray(d.lines) ? d.lines as Doc[] : [];
  for (const l of lines) {
    if (!Array.isArray(l.batches)) return false;
    for (const b of l.batches as Doc[]) if (!b || typeof b.batchId !== 'string' || !b.batchId || !Number.isInteger(b.qty) || (b.qty as number) < 0) return false;
  }
  return true;
}

/** a stock movement as a phone sends it: a lot, and a whole number of pieces in (+) or out (−), never 0 */
export const MOVE_MAX = 1_000_000; // pieces in one movement: more is a typo or an attack, never a real day's stock
export function badMove(d: Doc): boolean {
  return typeof d.batchId !== 'string' || !d.batchId || !Number.isInteger(d.delta) || d.delta === 0 || Math.abs(d.delta as number) > MOVE_MAX;
}
/** a van number compared without spaces, dashes or case (the app's vanKey) */
export const vanKey = (n: unknown) => String(n ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------------------------------------------------------------- staff privacy (what a person downloads)
/** records only their own person may download: role → table → the field naming that person */
export const OWN_ROWS: Record<string, Record<string, string>> = {
  salesman: { advances: 'staffId', leaves: 'staffId' },
  godown: { advances: 'staffId', leaves: 'staffId' },
  delivery: { advances: 'staffId', leaves: 'staffId', expenses: 'by' },
  rep: { orders: 'repId', expenses: 'by', travelClaims: 'staffId', advances: 'staffId', leaves: 'staffId' },
};
/** may this person download this record? (another salesman's advance, another rep's orders: no) */
export function mayDownload(role: string, userId: string, tbl: string, data: Doc): boolean {
  const f = OWN_ROWS[role]?.[tbl];
  return !f || String(data[f] ?? '') === userId;
}

/** shops.creditLimit is the owner's: a staff save keeps the stored limit (a new shop starts cash-only, limit 0) */
export function keepCreditLimit(role: string, data: Doc, existing: Doc | undefined): Doc {
  if (role === 'owner' || role === 'office') return data;
  return { ...data, creditLimit: existing ? existing.creditLimit ?? 0 : 0 };
}

/** owner-only fields (purchase rate): anyone else's save keeps the stored value and can never set it */
export function keepOwnerOnly(role: string, fields: string[] | undefined, data: Doc, existing: Doc | undefined): Doc {
  if (role === 'owner' || role === 'cadmin' || !fields?.length) return data; // cadmin: the company's own price to distributors
  const out = { ...data };
  for (const f of fields) { if (existing && existing[f] !== undefined) out[f] = existing[f]; else delete out[f]; }
  return out;
}

/** a bill adds up: tax parts + round-off = total, and its lines' taxable = the bill's taxable */
export function billAddsUp(d: Doc): boolean {
  const n = (k: unknown) => Number(k ?? 0);
  if (![d.total, d.taxable, d.cgst, d.sgst, d.igst].every(x => typeof x === 'number' && Number.isFinite(x))) return false;
  const lines = Array.isArray(d.lines) ? d.lines as Doc[] : [];
  if (!lines.length && n(d.total) !== 0) return false;
  if (Math.abs(n(d.taxable) + n(d.cgst) + n(d.sgst) + n(d.igst) + n(d.roundOff) - n(d.total)) > 0.011) return false;
  if (Math.abs(lines.reduce((a, l) => a + n(l.taxable), 0) - n(d.taxable)) > 0.011 * Math.max(1, lines.length)) return false;
  if (Math.abs(lines.reduce((a, l) => a + n(l.total), 0) + n(d.roundOff) - n(d.total)) > 0.011 * Math.max(1, lines.length)) return false;
  return true;
}

/** was this bill / credit-note / receipt number issued by this server? (bills: PREFIX/FY/n, credit notes: CN/FY/n,
 *  collection receipts: R/FY/n; n below the counter) */
export async function numberIssued(q: pg.PoolClient, tenant: string, table: 'invoices' | 'creditNotes' | 'receipts', number: string): Promise<boolean> {
  const m = number.match(/^(.+)\/(\d{2}-\d{2})\/(\d{1,9})$/);
  if (!m) return false;
  const t = (await q.query('SELECT prefix, next_bill_no, next_cn_no, next_receipt_no FROM tenants WHERE id=$1', [tenant])).rows[0];
  if (!t) return false;
  const k = Number(m[3]);
  if (table === 'invoices') return m[1] === (t.prefix ?? 'DBX') && k >= 1 && k < Number(t.next_bill_no);
  if (table === 'receipts') return m[1] === 'R' && k >= 1 && k < Number(t.next_receipt_no);
  return m[1] === 'CN' && k >= 1 && k < Number(t.next_cn_no);
}
