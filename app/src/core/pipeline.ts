// The order chain, one step hands to the next:
// salesman order → godown picks → owner approves → invoice from picked qty → delivery plan (trip per van)
// → load → trip out (live track) → delivered/photo → collect → day close (reconciliation)
import { ChangeSet, db, getSettings, nowIso, session, today, daysFrom, ymd } from './db';
import { billTotals, checkOrder, makeInvoices, pickBatches, priceLines, refreshSchemeClaims, type BillCut } from './billing';
import { invoiceBalances, OWED, paymentCounts, r2 } from './ledger';
import { nextNumbers } from './sync';
import { locationAllowed } from './privacy';
import { billChangeBlock, isInterState } from './gst';
import { buildCreditNote, costValue, extraBill, lineRoom, makeCreditNote, otherQty, splitShort } from './credit';
import { lineOf, orderLineFor, pickedLines, shortageLines } from './lines';
import type { ClaimEntry, Invoice, InvoiceLine, Order, OrderLine, Role, Shop, Trip, Van } from './types';

// ---- 1. salesman books: always enters the chain as 'new' (checks recorded for the owner)
export async function bookOrder(cs: ChangeSet, shop: Shop, lines: OrderLine[], by: string, extra: Partial<Order> = {}) {
  const check = await checkOrder(shop, lines);
  return cs.put<Order>('orders', { shopId: shop.id, salesmanId: by, source: 'salesman', lines, date: today(), status: 'new', issues: check.issues, invoiceIds: [], ...extra }, 'order booked');
}

/** a company rep's order that just arrived through the link: the same checks as a salesman's order (stock short, low rate,
 *  new shop, cash-only dues, credit limit, overdue), on the owner's or office phone. Safe to run again (each order once). */
export async function flagArrivedOrders() {
  const me = await db.staff.get(session().userId);
  if (me && me.role !== 'owner' && me.role !== 'office') return 0;
  const due = (await db.orders.where('status').equals('new').toArray()).filter(o => o.flagsPending);
  if (!due.length) return 0;
  const cs = new ChangeSet({ noAudit: true });
  for (const o of due) {
    const shop = await db.shops.get(o.shopId); if (!shop) continue;
    const check = await checkOrder(shop, o.lines);
    cs.put<Order>('orders', { ...o, issues: [...new Set([...o.issues, ...check.issues])], flagsPending: false });
  }
  if (cs.size) await cs.commit('Rep orders checked');
  return cs.size;
}

export async function cancelMyOrder(orderId: string) {
  const o = (await db.orders.get(orderId))!;
  if (o.status !== 'new') throw new Error('Already approved — ask the owner');
  const cs = new ChangeSet(); cs.put('orders', { ...o, status: 'cancelled', issues: [...o.issues, 'Cancelled by salesman'] }, 'salesman cancelled'); await cs.commit('Order cancelled');
}
/** why this person can't change this order now, or null if they can. Packed, billed and cancelled orders are never changed here. */
export function orderBlock(o: Order, role: Role, me: string): string | null {
  if (o.status === 'cancelled') return 'it is already cancelled.';
  if (o.status === 'billed') return 'it is already billed. Cancel the bill (Bill → Billed) or make a return instead.';
  if (o.status === 'picked') return 'the godown has already packed it. Change the quantities while verifying it (Bill → Picked).';
  if (role === 'owner' || role === 'office') return null;
  if (o.salesmanId !== me) return 'only the person who booked it or the owner can change it.';
  if (o.status !== 'new') return 'the owner has already approved it. Ask the owner to change it.';
  return null;
}
/** change the lines of an order, or cancel it (lines = null). Checked again at save time: the order may have moved on. */
export async function changeOrder(cs: ChangeSet, orderId: string, lines: OrderLine[] | null, reason = '') {
  const o = await db.orders.get(orderId);
  if (!o) throw new Error('Order not found.');
  const me = session().userId;
  const role = (await db.staff.get(me))?.role ?? 'owner';
  const block = orderBlock(o, role, me);
  if (block) throw new Error(`Can't change this order: ${block}`);
  if (!lines) return cs.put<Order>('orders', { ...o, status: 'cancelled', issues: [...o.issues, `Cancelled${reason ? `: ${reason}` : ''}`] }, 'order cancelled');
  const keep = lines.filter(l => l.qty > 0);
  if (!keep.length) throw new Error('Every line is 0. Cancel the order instead.');
  const shop = (await db.shops.get(o.shopId))!;
  const check = await checkOrder(shop, keep);
  return cs.put<Order>('orders', { ...o, lines: keep, issues: check.issues }, 'order changed');
}
export async function updateMyOrder(orderId: string, lines: OrderLine[]) {
  const o = (await db.orders.get(orderId))!;
  if (o.status !== 'new') throw new Error('Already approved — ask the owner');
  const cs = new ChangeSet(); cs.put('orders', { ...o, lines }, 'salesman edited'); await cs.commit('Order edited');
}

// ---- 1b. owner approves the order (credit/history seen) → goes to the godown
// The order is read again at save time: another phone may have approved or cancelled it meanwhile. A salesman's lower
// rate is NOT a company claim (the company never agreed to it): the owner adds a rate-difference line by hand if it is.
const approving = new Set<string>();
export async function approveOrder(orderId: string) {
  if (approving.has(orderId)) throw new Error('This order is already being approved.');
  approving.add(orderId);
  try {
    const o = await db.orders.get(orderId);
    if (!o) throw new Error('Order not found.');
    if (o.status !== 'new' && o.status !== 'needs_ok') {
      if (o.status === 'cancelled') throw new Error('This order was already cancelled.');
      const who = o.approvedBy ? (await db.staff.get(o.approvedBy))?.name : undefined;
      throw new Error(`Order already approved${who ? ` by ${who}` : ''}. Pull down to refresh.`);
    }
    const cs = new ChangeSet();
    cs.put('orders', { ...o, status: 'approved', approvedBy: session().userId, approvedAt: nowIso(), activity: [...(o.activity ?? []), { at: nowIso(), by: session().userId, what: 'approved, sent to godown' }] }, 'owner approved');
    await cs.commit('Order approved');
  } finally { approving.delete(orderId); }
}

// Shop history strip for the approval screen: bills pending, oldest days, rupees, limit.
export async function shopHistory(shopId: string) {
  const { invoiceBalances } = await import('./ledger');
  const bal = (await invoiceBalances(shopId)).filter(b => b.balance > OWED);
  const shop = (await db.shops.get(shopId))!;
  return { bills: bal.length, amount: r2(bal.reduce((a, b) => a + b.balance, 0)), oldestDays: Math.max(0, ...bal.map(b => Math.floor((Date.now() - new Date(b.invoice.date).getTime()) / 86400000))), limit: shop.creditLimit, days: shop.creditDays };
}

// ---- 2. godown picks what is actually available (qty, batch, MRP may change; never adds a product)
export async function pickOrder(orderId: string, picked: { productId: string; qty: number; batchId?: string; mrp?: number; line?: number }[]) {
  const o = await db.orders.get(orderId);
  if (!o) throw new Error('Order not found.');
  // read again: the owner may have cancelled it (or another godown phone packed it) while this phone was offline
  if (o.status !== 'approved') throw new Error(o.status === 'cancelled' ? 'This order was already cancelled — do not pack it.' : 'This order is already packed or billed.');
  const cs = new ChangeSet();
  cs.put('orders', { ...o, status: 'picked', picked, pickedBy: session().userId, pickedAt: nowIso() }, 'picked');
  await cs.commit('Order picked');
}

export async function suggestPick(o: Order) {
  const batches = await db.batches.toArray();
  // stock already packed for another order (picked, not billed yet) is not on the shelf any more
  for (const other of await db.orders.where('status').equals('picked').toArray()) {
    if (other.id === o.id) continue;
    for (const pk of other.picked ?? []) { if (!pk.batchId || !pk.qty) continue; const b = batches.find(x => x.id === pk.batchId); if (b) b.qty -= pk.qty; }
  }
  return o.lines.map((l, i) => {
    const { picks, short } = pickBatches(batches, l.productId, l.qty);
    for (const p of picks) { const b = batches.find(x => x.id === p.batchId)!; b.qty -= p.qty; } // reserve within this order
    return { productId: l.productId, line: lineOf(l, i), ordered: l.qty, available: l.qty - short, picks };
  });
}

// ---- 3. owner approves → invoice from picked quantities (short lines cut, pending saved)
const billing = new Set<string>(); // orders being billed right now (a double tap must not make two bills)
export async function approvePicked(orderId: string) {
  if (billing.has(orderId)) throw new Error('This order is already being billed.');
  billing.add(orderId);
  try { return await approvePickedOnce(orderId); } finally { billing.delete(orderId); }
}
async function approvePickedOnce(orderId: string) {
  const o = (await db.orders.get(orderId))!;
  if (o.status !== 'picked') throw new Error(o.status === 'billed' ? 'This order is already billed.' : 'This order is not picked yet.');
  const shop = (await db.shops.get(o.shopId))!;
  const cs = new ChangeSet();
  // picker's quantities, batch and MRP go into the bill exactly as packed
  // each packed row is billed at the rate of the order line it packs (by line number; an old row: its product's first line)
  const lines = pickedLines(o).filter(p => p.qty > 0)
    .map(p => ({ productId: p.productId, qty: p.qty, rate: orderLineFor(o, p)?.rate ?? 0, discountPct: orderLineFor(o, p)?.discountPct, batchId: p.batchId, mrp: p.mrp, line: p.line }));
  // numbers from the server when there is one (never a duplicate across phones); needs internet
  const products = new Map((await db.products.toArray()).map(p => [p.id, p.companyId]));
  const companies = new Set(lines.map(l => products.get(l.productId)));
  const numbers = (await nextNumbers('bill', companies.size)) ?? undefined;
  const billed = cs.put<Order>('orders', { ...o, status: 'billed', lines: o.lines, invoiceIds: [] }, 'owner approved');
  const cuts: BillCut[] = [];
  const invs = lines.length ? await makeInvoices(cs, { ...billed, lines }, shop, numbers, undefined, cuts) : [];
  billed.invoiceIds = invs.map(i => i.id);
  if (cuts.length) billed.issues = [...billed.issues, ...cuts.map(c => `Billed ${c.billed} of ${c.wanted} ${c.name}: stock had no more`)];
  const batchId = await cs.commit('Approved & billed');
  return { invoices: invs, batchId };
}

// Day-close gate: billing stops until every earlier day with activity is closed (locked spec 15.2).
export async function billingLockedBy(): Promise<string | null> {
  const t = today();
  const days = new Set<string>();
  for (const i of await db.invoices.toArray()) if (i.date < t) days.add(i.date);
  for (const x of await db.trips.toArray()) if (x.date < t) days.add(x.date);
  for (const p of await db.payments.toArray()) if (p.date < t) days.add(p.date);
  const closed = new Set((await db.dayCloses.toArray()).map(d => d.date));
  // nothing before the app started counts — the local day it started (a UTC timestamp is the previous day before 5:30 AM in India)
  const firstAt = (await db.audit.orderBy('at').first())?.at;
  const first = firstAt ? ymd(new Date(firstAt)) : t;
  const open = [...days].filter(d => !closed.has(d) && d >= first).sort();
  return open[0] ?? null;
}

export async function rejectOrder(orderId: string, reason: string) {
  const o = (await db.orders.get(orderId))!;
  const cs = new ChangeSet();
  cs.put('orders', { ...o, status: 'cancelled', issues: [...o.issues, `Cancelled: ${reason}`] }, 'cancelled');
  await cs.commit('Order cancelled');
}

// ---- 4. delivery plan: the system suggests van + stop order; owner confirms → trips
export interface PlanSuggestion { van: Van; shops: { shop: Shop; invoices: Invoice[]; value: number }[] }

function near(a: Shop, b: Shop) {
  if (a.lat && a.lng && b.lat && b.lng) return Math.hypot(a.lat - b.lat, a.lng - b.lng);
  return a.area === b.area ? 0 : 1;
}
// nearest-neighbour ordering: by GPS when known, else keep areas together
export function orderStops<T extends { shop: Shop }>(stops: T[]): T[] {
  if (stops.length < 3) return stops;
  const left = [...stops]; const out: T[] = [left.shift()!];
  while (left.length) {
    const last = out[out.length - 1];
    let bi = 0, bd = Infinity;
    left.forEach((s, i) => { const d = near(last.shop, s.shop); if (d < bd) { bd = d; bi = i; } });
    out.push(left.splice(bi, 1)[0]);
  }
  return out;
}

/** bills waiting to be planned: the number on the Delivery tile and on the Plan page — cancelled bills never count */
export async function billsToPlan(): Promise<number> {
  return (await db.invoices.where('deliveryStatus').equals('pending').toArray()).filter(i => !i.cancelled).length;
}
export async function suggestPlan(): Promise<PlanSuggestion[]> {
  const vans = (await db.vans.toArray()).filter(v => v.active !== false).sort((a, b) => a.name.localeCompare(b.name)); // hidden vans never get a plan
  const pending = (await db.invoices.where('deliveryStatus').equals('pending').toArray()).filter(i => !i.cancelled);
  const shops = new Map((await db.shops.toArray()).map(s => [s.id, s]));
  const byShop = new Map<string, Invoice[]>();
  for (const i of pending) byShop.set(i.shopId, [...(byShop.get(i.shopId) ?? []), i]);
  const stops = [...byShop.entries()].map(([sid, invoices]) => ({ shop: shops.get(sid)!, invoices, value: r2(invoices.reduce((a, i) => a + i.total, 0)) }));
  if (!vans.length || !stops.length) return [];
  // group by area, then deal areas to vans so each van stays in one part of town, balanced by value
  const areas = new Map<string, typeof stops>();
  for (const s of stops) areas.set(s.shop.area, [...(areas.get(s.shop.area) ?? []), s]);
  const plan: PlanSuggestion[] = vans.map(van => ({ van, shops: [] }));
  const load = (p: PlanSuggestion) => p.shops.reduce((a, s) => a + s.value, 0);
  for (const group of [...areas.values()].sort((a, b) => b.length - a.length)) {
    const target = plan.reduce((best, p) => load(p) < load(best) ? p : best, plan[0]);
    target.shops.push(...group);
  }
  for (const p of plan) p.shops = orderStops(p.shops);
  return plan.filter(p => p.shops.length);
}

export async function confirmPlan(plan: PlanSuggestion[]) {
  const cs = new ChangeSet();
  for (const p of plan) {
    if (!p.shops.length) continue;
    const trip = cs.put<Trip>('trips', { vanId: p.van.id, driverId: p.van.driverId, date: today(), status: 'planned', stops: p.shops.map(s => s.shop.id), track: [] }, 'trip planned');
    p.shops.forEach((s, k) => { for (const inv of s.invoices) cs.put('invoices', { ...inv, vanId: p.van.id, tripId: trip.id, stopNo: k + 1, deliveryStatus: 'planned' }, 'planned'); });
  }
  await cs.commit('Delivery plan confirmed');
}

export async function tripLoaded(tripId: string) {
  const t = (await db.trips.get(tripId))!;
  const cs = new ChangeSet(); cs.put('trips', { ...t, status: 'loaded' }, 'loaded'); await cs.commit('Van loaded');
}

export async function startTrip(tripId: string) {
  const t = (await db.trips.get(tripId))!;
  const cs = new ChangeSet();
  cs.put('trips', { ...t, status: 'out', startedAt: nowIso(), driverId: t.driverId ?? session().userId }, 'trip started');
  for (const inv of await db.invoices.where('tripId').equals(tripId).toArray()) if (inv.deliveryStatus === 'planned') cs.put('invoices', { ...inv, deliveryStatus: 'out' }, 'out for delivery');
  await cs.commit('Trip started');
}

export async function trackPoint(tripId: string, lat: number, lng: number) {
  if (!(await locationAllowed())) return; // DPDP: live tracking only after the driver allowed it (Menu → Privacy & security)
  const t = await db.trips.get(tripId); if (!t || t.status !== 'out') return;
  const track = [...t.track, { at: nowIso(), lat, lng }].slice(-500);
  await db.trips.put({ ...t, track, updatedAt: nowIso(), dirty: 1 });
}

// Owner can end a trip the driver forgot to end, or cancel one that never left (bills back to the pool).
export async function ownerEndTrip(tripId: string) {
  const t = (await db.trips.get(tripId))!;
  if (t.status === 'out') return endTrip(tripId, {});
  const cs = new ChangeSet();
  for (const inv of await db.invoices.where('tripId').equals(tripId).toArray()) cs.put('invoices', { ...inv, deliveryStatus: 'pending', tripId: undefined, stopNo: undefined }, 'trip cancelled');
  cs.put('trips', { ...t, status: 'done', endedAt: nowIso() }, 'trip cancelled by owner');
  await cs.commit('Trip cancelled');
}

export async function endTrip(tripId: string, undelivered: Record<string, 'godown' | 'van' | 'next'>) {
  const t = (await db.trips.get(tripId))!;
  const cs = new ChangeSet();
  for (const inv of await db.invoices.where('tripId').equals(tripId).toArray()) {
    if (inv.deliveryStatus !== 'out') continue;
    const what = undelivered[inv.id] ?? 'next';
    // stock is NOT added back: the goods are still reserved for this live bill. Stock returns only when the bill is
    // cancelled or a credit note is made, so the same pieces can never be sold twice.
    // every undelivered bill goes back to the pool and is planned again tomorrow; where the goods are is in the audit line
    cs.put('invoices', { ...inv, deliveryStatus: 'pending', tripId: undefined, stopNo: undefined, vanId: what === 'van' ? inv.vanId : undefined }, `undelivered: goods ${what === 'godown' ? 'back in godown' : what === 'van' ? 'kept in van' : 'for next visit'}`);
  }
  cs.put('trips', { ...t, status: 'done', endedAt: nowIso() }, 'trip ended');
  await cs.commit('Trip ended');
}

// ---- 5. day close: what went out, what came back, cash per person
/**
 * The day's two headline figures, one definition for Day close, Home and TESRAX:
 *  - billed = the day's bills less their credit notes; a bill that was refused or fully credited counts as ₹0, a cancelled one is not a bill;
 *  - collected = money that clears dues today; a post-dated cheque is not collected until its date (shown apart as "cheques to clear").
 */
export async function dayFigures(date = today()) {
  const bills = (await db.invoices.where('date').equals(date).toArray()).filter(i => !i.cancelled);
  const cns = await db.creditNotes.toArray();
  const credited = new Map<string, number>(); for (const c of cns) credited.set(c.invoiceId, r2((credited.get(c.invoiceId) ?? 0) + c.total));
  const sales = r2(bills.reduce((a, i) => a + (i.deliveryStatus === 'returned' ? 0 : Math.max(0, i.total - (credited.get(i.id) ?? 0))), 0));
  const pays = (await db.payments.where('date').equals(date).toArray()).filter(p => p.status === 'ok');
  const collected = r2(pays.filter(p => paymentCounts(p, date)).reduce((a, p) => a + p.amount, 0));
  const chequesToClear = r2((await db.payments.toArray()).filter(p => p.status === 'ok' && !paymentCounts(p, date)).reduce((a, p) => a + p.amount, 0));
  return { sales, collected, chequesToClear, billsToday: bills.length };
}

export async function daySummary(date = today()) {
  const invs = (await db.invoices.toArray()).filter(i => !i.cancelled);
  const trips = (await db.trips.where('date').equals(date).toArray());
  const pays = (await db.payments.toArray()).filter(p => p.status !== 'cancelled');
  const staff = new Map((await db.staff.toArray()).map(s => [s.id, s.name]));
  const vans = new Map((await db.vans.toArray()).map(v => [v.id, v.name]));
  const cns = (await db.creditNotes.toArray()).filter(c => c.date === date);
  const byTrip = trips.map(t => {
    const ti = invs.filter(i => i.tripId === t.id);
    const n = (s: Invoice['deliveryStatus'][]) => ti.filter(i => s.includes(i.deliveryStatus));
    return { trip: t, van: vans.get(t.vanId) ?? '', bills: ti.length, value: r2(ti.reduce((a, i) => a + i.total, 0)), delivered: n(['delivered']).length, partial: n(['partial']).length, returned: n(['returned']).length, undelivered: n(['undelivered', 'pending', 'out', 'planned']).length };
  });
  const cashBy = new Map<string, { collected: number; handed: number; n: number }>();
  for (const p of pays.filter(x => x.date === date && x.mode === 'cash')) { const v = cashBy.get(p.collectedBy) ?? { collected: 0, handed: 0, n: 0 }; v.collected = r2(v.collected + p.amount); if (p.settled) v.handed = r2(v.handed + p.amount); v.n++; cashBy.set(p.collectedBy, v); }
  const heldOlder = pays.filter(p => p.mode === 'cash' && !p.settled && p.status === 'ok' && p.date < date);
  const nonCash = pays.filter(p => p.date === date && p.mode !== 'cash');
  const waiting = pays.filter(p => p.status === 'waiting_shop');
  return {
    date, trips: byTrip,
    cash: [...cashBy.entries()].map(([id, v]) => ({ staffId: id, name: staff.get(id) ?? id, ...v, pending: r2(v.collected - v.handed) })),
    olderCash: r2(heldOlder.reduce((a, p) => a + p.amount, 0)),
    nonCash: nonCash.map(p => ({ id: p.id, mode: p.mode, amount: p.amount, ref: p.ref ?? '', by: staff.get(p.collectedBy) ?? p.collectedBy })),
    waiting: waiting.length,
    creditNotes: r2(cns.reduce((a, c) => a + c.total, 0)),
    ...(await dayFigures(date)),
    closed: !!(await db.dayCloses.where('date').equals(date).first()),
  };
}

// ---- 5b. the checklist: everything the owner must decide before the day can close
export async function dayChecklist(date = today()) {
  const invs = (await db.invoices.toArray()).filter(i => !i.cancelled);
  const trips = (await db.trips.where('date').equals(date).toArray());
  const pays = (await db.payments.toArray());
  const orders = await db.orders.toArray();
  const shops = await db.shops.toArray();
  const expenses = (await db.expenses.where('date').equals(date).toArray());
  const tripsOpen = trips.filter(t => t.status === 'out' || t.status === 'loaded');
  const noResult = invs.filter(i => i.tripId && trips.some(t => t.id === i.tripId) && ['planned', 'out'].includes(i.deliveryStatus));
  const diffs = invs.filter(i => i.delivery && !i.diffAction && ((i.delivery.shortages?.length ?? 0) > 0 || (i.delivery.excess?.length ?? 0) > 0));
  const refs = pays.filter(p => p.date === date && p.mode !== 'cash' && !(p.ref && p.ref.length >= 4) && !p.confirmPhoto);
  const waitingOrders = orders.filter(o => o.date <= date && (o.status === 'new' || o.status === 'needs_ok' || o.status === 'picked'));
  const newShops = shops.filter(s => !s.approved);
  const dupes = pays.filter(p => p.status === 'ok' && p.date === date && !p.dupOk).filter((p, _, all) => all.some(q => q.id !== p.id && q.shopId === p.shopId && q.amount === p.amount));
  const cashOpen = pays.filter(p => p.mode === 'cash' && !p.settled && p.status === 'ok' && p.date <= date);
  const unapprovedExpenses = expenses.filter(e => !(e as { approved?: boolean }).approved && e.category !== 'advance');
  const shortfallsOpen = (await db.advances.toArray()).filter(a => a.kind === 'shortfall' && a.status === 'approved' && (a.recovered ?? 0) < a.amount);
  // staff returns and write-offs waiting for a decision (they change nothing until approved)
  const requests = await db.requests.where('status').equals('waiting').toArray();
  return { tripsOpen, noResult, diffs, refs, waitingOrders, newShops, dupes, cashOpen, unapprovedExpenses, shortfallsOpen, requests };
}

// Owner's choice for a bill with delivery differences: re-issue the same number with delivered quantities, or a credit note.
// Re-issue a bill with new quantities under the SAME number (allowed until it is printed, and at day close for
// delivery differences). The original lines are kept inside the bill; stock is corrected for the change.
/** day close: the owner checked the same amount twice from one shop — both are real collections */
/** collections that look entered twice (same shop, same amount), grouped: one pair = one thing to check, not two */
export function dupeGroups<T extends { id: string; shopId: string; amount: number }>(payments: T[]): T[][] {
  return [...payments.reduce((m, p) => m.set(`${p.shopId}|${p.amount}`, [...(m.get(`${p.shopId}|${p.amount}`) ?? []), p]), new Map<string, T[]>()).values()];
}
export async function confirmNotDuplicate(paymentIds: string[]) {
  const cs = new ChangeSet();
  for (const id of paymentIds) { const p = await db.payments.get(id); if (p && p.status === 'ok') cs.put('payments', { ...p, dupOk: true }, 'checked: not a duplicate'); }
  await cs.commit('Not a duplicate');
}

/** day close: one of two equal collections was entered twice — cancel it (kept for the audit, bills open again) */
export async function cancelPayment(paymentId: string, reason: string) {
  const p = await db.payments.get(paymentId);
  if (!p || p.status !== 'ok') throw new Error('That payment was already changed or cancelled.');
  // only the owner or office cancel a payment; a collector may cancel only their own, before it reaches the office (the server rule)
  const role = (await db.staff.get(session().userId))?.role;
  if (role !== 'owner' && role !== 'office' && !(p.collectedBy === session().userId && !p.settled)) throw new Error('Only the owner or office cancels a payment.');
  if (p.bankLineId) throw new Error('This payment is matched to the bank statement. Unmatch it in Accounts → Bank first.');
  const cs = new ChangeSet();
  cs.put('payments', { ...p, status: 'cancelled', note: reason }, 'payment cancelled');
  await cs.commit('Payment cancelled');
}

/** a cheque bounced: asked to confirm, with the reason; it stops counting and the bills it paid are open again */
export async function bounceCheque(paymentId: string, reason: string) {
  const role = (await db.staff.get(session().userId))?.role;
  if (role !== 'owner' && role !== 'office') throw new Error('Only the owner or office marks a cheque as bounced.');
  const p = await db.payments.get(paymentId);
  if (!p || p.mode !== 'cheque') throw new Error('That is not a cheque payment.');
  if (p.status === 'bounced') throw new Error('This cheque is already marked bounced.');
  if (p.status === 'cancelled') throw new Error('This payment was cancelled.');
  if (!reason.trim()) throw new Error('Say why the cheque bounced (e.g. "funds insufficient").');
  const cs = new ChangeSet();
  cs.put('payments', { ...p, status: 'bounced', bounce: { at: nowIso(), by: session().userId, reason: reason.trim() } }, `cheque bounced: ${reason.trim()}`);
  return cs.commit('Cheque bounced');
}

/**
 * Saves a changed bill under the SAME number (bill editor). Allowed only before printing, before delivery and before the
 * month's GSTR-1 is due. Every line is priced again (schemes, free pieces, tax by the shop's state) and its pieces are
 * taken from stock: a bill never charges a piece that is not in stock.
 */
export async function saveBillEdit(invoiceId: string, shopId: string, edits: { productId: string; qty: number; rate: number; mrp?: number; discount?: number; discountPct?: number }[]) {
  const inv = await db.invoices.get(invoiceId);
  if (!inv) throw new Error('Bill not found.');
  const block = billChangeBlock(inv, 'edit', today()); if (block) throw new Error(block);
  if ((await db.creditNotes.where('invoiceId').equals(inv.id).count()) > 0) throw new Error(`Bill ${inv.number} already has a credit note. Make another credit note instead.`);
  const shop = await db.shops.get(shopId); if (!shop) throw new Error('Shop not found.');
  const live = edits.filter(l => l.qty > 0);
  if (!live.length) throw new Error('A bill needs at least one line. Cancel the bill instead.');
  if (live.some(l => !Number.isInteger(l.qty) || !(l.rate > 0))) throw new Error('Quantities are whole pieces and rates are more than ₹0.');
  if (live.some(l => (l.discount ?? 0) < 0 || (l.discount ?? 0) > r2(l.qty * l.rate))) throw new Error('A discount cannot be more than the value of the line.');
  if (live.some(l => l.discountPct != null && (!(l.discountPct >= 0) || l.discountPct > 100))) throw new Error("Discount can't be more than 100%");
  const settings = await getSettings();
  const inter = isInterState(shop, settings);
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const schemes = await db.schemes.toArray();
  const cs = new ChangeSet();
  // stock: put the old pieces back, then take the new quantities out (the old lots first where they still fit, then oldest expiry)
  const batches = await db.batches.toArray();
  for (const l of inv.lines) for (const b of l.batches) { const x = batches.find(y => y.id === b.batchId); if (x) x.qty += b.qty; }
  // priced as a new bill is (Disc % or the typed ₹; a product on two lines: free pieces once, on line 1)
  if (live.some(e => !products.has(e.productId))) throw new Error('Unknown product on the bill.');
  const priced = priceLines(live, products, schemes, inter, inv.date);
  const lines: InvoiceLine[] = live.map((e, k) => {
    const p = products.get(e.productId)!;
    const line = priced[k]!;
    const need = line.qty + line.freeQty;
    const old = new Set(inv.lines.filter(l => l.productId === p.id).flatMap(l => l.batches.map(b => b.batchId)));
    const ordered = [...batches.filter(b => old.has(b.id)), ...batches.filter(b => !old.has(b.id))];
    const { picks, short } = pickBatches(ordered.filter(b => b.productId === p.id).sort((a, b) => Number(!old.has(a.id)) - Number(!old.has(b.id))), p.id, need, '0000-00-00');
    if (short > 0) throw new Error(`Not enough stock for ${p.name}: ${need - short} pcs in stock, the bill needs ${need}${line.freeQty ? ` (${line.qty} + ${line.freeQty} free)` : ''}.`);
    for (const pk of picks) { const x = batches.find(y => y.id === pk.batchId)!; x.qty -= pk.qty; }
    return { ...line, batches: picks };
  });
  const touched = new Set([...inv.lines.flatMap(l => l.batches.map(b => b.batchId)), ...lines.flatMap(l => l.batches.map(b => b.batchId))]);
  for (const id of touched) { const x = batches.find(y => y.id === id); if (x) cs.put('batches', { ...x }, 'bill edited'); }
  const { isB2B } = await import('./ledger');
  const upd = cs.put<Invoice>('invoices', { ...inv, shopId: shop.id, kind: isB2B(shop) ? 'B2B' : 'B2C', lines, ...billTotals(lines), original: inv.original ?? { lines: inv.lines, total: inv.total, at: nowIso() } }, 'bill edited before print');
  if (!(upd.total > 0) || lines.some(l => !(l.total > 0))) throw new Error('A bill line cannot come to ₹0. Cancel the bill instead, or give the line a real rate.');
  await refreshSchemeClaims(cs, upd, []);
  return cs.commit('Bill edited');
}

/**
 * Day close: a bill delivered with differences. A delivered bill is a supplied tax document and is never re-written:
 * pieces short get a credit note (paid pieces only, at the bill line's own value; free pieces ₹0), pieces given extra
 * go on a new bill. ("Modified bill, same number" is possible only while a bill is not printed or delivered.)
 */
export async function settleDifference(invoiceId: string, action: 'modified' | 'credit_note') {
  const inv = await db.invoices.get(invoiceId);
  if (!inv) throw new Error('Bill not found.');
  if (inv.diffAction) throw new Error('This difference is already settled.');
  if (action === 'modified') throw new Error(billChangeBlock(inv, 'edit', today()) ?? 'A delivery difference is settled with a credit note.');
  if (inv.cancelled) throw new Error('This bill is already cancelled.');
  const cs = new ChangeSet();
  const sh = inv.delivery?.shortages ?? []; const ex = inv.delivery?.excess ?? [];
  const lines = inv.lines.map(l => ({ ...l, batches: l.batches.map(b => ({ ...b })) }));
  const work: Invoice = { ...inv, lines };
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const schemes = await db.schemes.toArray();
  if (ex.length) await extraBill(cs, work, ex);
  const at = shortageLines(inv);
  const items = sh.map((x, k) => {
    const l = inv.lines[at[k]];
    const split = x.paid != null ? { paid: x.paid, free: x.free ?? 0 } : l ? splitShort(l, x.qty, products.get(x.productId), schemes, inv.date, otherQty(inv.lines, at[k])) : { paid: 0, free: 0 };
    return { productId: x.productId, line: at[k] >= 0 ? at[k] : undefined, ...split, restock: !!DELIVERY_REASONS.find(r => r.label === x.reason)?.restock };
  }).filter(x => x.paid || x.free);
  if (items.length) await makeCreditNote(cs, work, items, { reason: 'Short at delivery', source: 'delivery', takeOffBill: false });
  cs.put('invoices', { ...work, diffAction: 'credit_note' }, ex.length ? 'credit note + extra billed on a new bill' : 'credit note chosen');
  await cs.commit('Delivery difference settled');
}

/** what each day-close choice does to the money: the credit note gives back ₹back (the bill stays); extra pieces go on a new bill of about ₹extra */
export async function differenceMoney(inv: Invoice) {
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const schemes = await db.schemes.toArray();
  const cns = await db.creditNotes.where('invoiceId').equals(inv.id).toArray();
  const at = shortageLines(inv);
  const items = (inv.delivery?.shortages ?? []).map((x, k) => {
    const l = inv.lines[at[k]];
    const split = x.paid != null ? { paid: x.paid, free: x.free ?? 0 } : l ? splitShort(l, x.qty, products.get(x.productId), schemes, inv.date, otherQty(inv.lines, at[k])) : { paid: 0, free: 0 };
    return { productId: x.productId, line: at[k] >= 0 ? at[k] : undefined, ...split, restock: true };
  }).filter(x => x.paid || x.free);
  const back = items.length ? r2(buildCreditNote(inv, cns, items).total) : 0;
  const extra = r2((inv.delivery?.excess ?? []).reduce((a, x) => { const l = inv.lines.find(y => y.productId === x.productId); return a + (l ? x.qty * l.total / (l.qty || 1) : 0); }, 0));
  return { back, extra, becomes: r2(inv.total - back + extra) };
}

/** what a delivered bill's shortages (short, damaged, refused) will be credited — not yet a credit note, so the bill still shows its full total */
export async function pendingShortCredit(inv: Invoice) {
  if (inv.cancelled || inv.diffAction || !(inv.delivery?.shortages?.length)) return 0;
  return (await differenceMoney(inv)).back;
}
/** the bills a shop can pay now, for the driver's and salesman's collection: each bill's balance less what the delivery already
 *  knows will be credited (so the driver asks for the delivered value, not the full bill), with the shop's old dues as they are */
export async function collectableBills(shopId: string) {
  const out: { invoice: Invoice; balance: number; short: number; due: number }[] = [];
  for (const b of (await invoiceBalances(shopId)).filter(x => x.balance > OWED)) {
    const short = await pendingShortCredit(b.invoice);
    const due = r2(Math.max(0, b.balance - short));
    if (due > OWED) out.push({ invoice: b.invoice, balance: b.balance, short: r2(b.balance - due), due });
  }
  return out;
}

/** "Settle all as credit notes": every bill with a delivery difference gets its credit note (and a new bill for extras), one after the other;
 *  a bill that cannot be settled is reported and the rest still are. Safe to tap twice (a settled bill is skipped). */
export async function settleAllAsCreditNotes(invoiceIds: string[]) {
  const done: string[] = []; const failed: { id: string; message: string }[] = [];
  for (const id of invoiceIds) {
    try { await settleDifference(id, 'credit_note'); done.push(id); } catch (e) { failed.push({ id, message: (e as Error).message }); }
  }
  return { done, failed };
}

export async function closeDay(date = today(), received: Record<string, number> = {}) {
  const s = await daySummary(date);
  const cs = new ChangeSet();
  // cash: only what the owner counted and received is settled; the rest stays pending against that person
  const pays = (await db.payments.toArray()).filter(p => p.date <= date && p.mode === 'cash' && !p.settled && p.status === 'ok');
  const shortfalls: Record<string, number> = {};
  const byStaff = new Map<string, typeof pays>(); for (const p of pays) byStaff.set(p.collectedBy, [...(byStaff.get(p.collectedBy) ?? []), p]);
  for (const [staffId, list] of byStaff) {
    const have = r2(list.reduce((a, p) => a + p.amount, 0)); const got = received[staffId] ?? 0;
    // every payment is settled (the money is accounted for); the difference is recorded ONCE against the person
    for (const p of list) cs.put('payments', { ...p, settled: true }, got >= have ? 'cash received' : 'settled with shortfall');
    if (got < have - 0.5) { shortfalls[staffId] = r2(have - got); cs.put('advances', { staffId, amount: r2(have - got), reason: `Cash short at day close ${date}`, status: 'approved', kind: 'shortfall', date, instalments: 1, recovered: 0 }, 'cash shortfall'); }
  }
  cs.put('dayCloses', { date, closedBy: session().userId, summary: { ...(s as unknown as Record<string, unknown>), received, shortfalls } }, 'day closed');
  await cs.commit('Day closed');
}

// counts for the icon home screens
export async function counts() {
  const orders = await db.orders.toArray();
  const invs = (await db.invoices.toArray()).filter(i => !i.cancelled);
  const trips = await db.trips.where('date').equals(today()).toArray();
  const pays = await db.payments.toArray();
  const batches = await db.batches.toArray();
  const soon = daysFrom(45);
  const products = await db.products.toArray();
  const outOfStock = products.filter(p => p.active && !batches.some(b => b.productId === p.id && b.qty > 0 && b.expiry >= today())).length;
  const claims = await db.claims.toArray();
  const me = await db.staff.get(session().userId);
  const myTrip = me?.role === 'delivery' ? trips.find(t => t.status !== 'done' && (t.driverId === me.id || (me.vanId && t.vanId === me.vanId))) : undefined;
  const myStops = myTrip ? new Set(invs.filter(i => i.tripId === myTrip.id && ['planned', 'out'].includes(i.deliveryStatus)).map(i => i.shopId)).size : 0;
  return {
    toApproveOrders: orders.filter(o => o.status === 'new' || o.status === 'needs_ok').length,
    toPick: orders.filter(o => o.status === 'approved').length,
    toApprove: orders.filter(o => o.status === 'picked').length,
    toPlan: invs.filter(i => i.deliveryStatus === 'pending' && !i.cancelled).length,
    toLoad: trips.filter(t => t.status === 'planned').length,
    out: trips.filter(t => t.status === 'out').length,
    tripsToday: trips.length,
    stopsLeft: myStops,
    cashStaff: new Set(pays.filter(p => p.mode === 'cash' && !p.settled && p.status === 'ok').map(p => p.collectedBy)).size,
    cashWithStaff: r2(pays.filter(p => p.mode === 'cash' && !p.settled && p.status === 'ok').reduce((a, p) => a + p.amount, 0)),
    waitingShop: pays.filter(p => p.status === 'waiting_shop').length,
    stockAlerts: batches.filter(b => b.qty > 0 && b.expiry <= soon).length + outOfStock,
    claimsOpen: claims.filter(c => c.status === 'submitted' || c.status === 'draft').length,
    dayClosed: !!(await db.dayCloses.where('date').equals(today()).first()),
  };
}

// ---- Delivery and cancel live here (not in screens) so the money & stock laws can be tested ----
export const DELIVERY_REASONS = [
  { value: 'short', label: 'Not loaded / short', restock: true },
  { value: 'damaged', label: 'Damaged in van', restock: false },
  { value: 'refused', label: 'Shop refused', restock: true },
] as const;
export type DeliveryInput = {
  returnAll?: boolean;
  short?: Record<string, { qty: number; reason: string }>; // key `${invoiceId}|${productId}|${lineIndex}` (or `${invoiceId}|${productId}` = each line of that product)
  extra?: Record<string, number>;
  shopPhoto?: string; billPhoto?: string; pos?: { lat: number; lng: number } | null; distanceM?: number;
};
/** Records what the shop accepted for a stop. A bill that already has a delivery result is skipped (double tap safe). */
export async function recordDelivery(invoiceIds: string[], input: DeliveryInput) {
  const cs = new ChangeSet();
  const batches = await db.batches.toArray();
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const schemes = await db.schemes.toArray();
  let done = 0;
  for (const id of invoiceIds) {
    const inv = await db.invoices.get(id);
    if (!inv || inv.cancelled || ['delivered', 'partial', 'returned'].includes(inv.deliveryStatus)) continue;
    const lines = inv.lines.map(l => ({ ...l, batches: l.batches.map(b => ({ ...b })) }));
    // pieces a shop already returned (credit note) are off the bill: the short is split against what is still open on each line
    const room = lineRoom(inv, await db.creditNotes.where('invoiceId').equals(inv.id).toArray());
    const shortages: { productId: string; qty: number; reason: string; line: number }[] = [];
    const excess: { productId: string; qty: number; line: number }[] = [];
    for (const [li, l] of lines.entries()) {
      // per bill line `id|product|line`; the older key `id|product` (no line) applies to each line of that product, as before
      const k = `${inv.id}|${l.productId}|${li}`, k0 = `${inv.id}|${l.productId}`;
      const s = input.returnAll ? { qty: l.qty + l.freeQty, reason: 'refused' } : input.short?.[k] ?? input.short?.[k0];
      const e = input.extra?.[k] ?? input.extra?.[k0];
      if (e && e > 0) {
        // extra pieces given from the van: taken from stock and recorded on the bill line, so a cancel puts them back
        const b = batches.filter(x => x.productId === l.productId && x.qty >= e).sort((a, c) => a.expiry.localeCompare(c.expiry))[0];
        if (b) { b.qty -= e; cs.put('batches', { ...b }, 'extra given from van'); l.batches.push({ batchId: b.id, batch: b.batch, qty: e, expiry: b.expiry }); excess.push({ productId: l.productId, qty: e, line: li }); }
      }
      if (!s?.qty) continue;
      const qty = Math.min(s.qty, l.batches.reduce((a, b) => a + b.qty, 0));
      if (qty <= 0) continue;
      const reason = DELIVERY_REASONS.find(r => r.value === s.reason) ?? DELIVERY_REASONS[0];
      // paid and scheme-free pieces are kept apart: the shop keeps the most paid pieces whose free pieces still fit
      const full = splitShort(l, qty, products.get(l.productId), schemes, inv.date, otherQty(inv.lines, li)), open = room[li];
      const paid = Math.min(open.paid, Math.max(full.paid, qty - open.free));
      const split = { paid, free: Math.min(open.free, qty - paid) };
      shortages.push({ productId: l.productId, qty, reason: reason.label, ...split, line: li });
      // these pieces are no longer out on the bill: take them off its batches so a later cancel/edit can't put them back twice
      let left = qty;
      for (const lb of l.batches) { if (left <= 0) break; const take = Math.min(left, lb.qty); lb.qty -= take; left -= take; if (reason.restock) { const b = batches.find(x => x.id === lb.batchId); if (b) { b.qty += take; cs.put('batches', { ...b }, 'back to stock'); } } }
      if (!reason.restock) { const v = costValue(products.get(l.productId), qty); cs.put<ClaimEntry>('claimEntries', { companyId: inv.companyId, month: today().slice(0, 7), kind: 'transit', productId: l.productId, qty, amount: v.amount, valuePending: v.pending || undefined, invoiceId: inv.id, note: 'Damaged in van', photo: input.shopPhoto } as ClaimEntry, 'transit damage'); }
    }
    const diff = shortages.length || excess.length;
    const pos = input.pos ?? undefined;
    cs.put('invoices', { ...inv, lines, deliveryStatus: input.returnAll ? 'returned' : diff ? 'partial' : 'delivered', delivery: { at: nowIso(), by: session().userId, shopPhoto: input.shopPhoto, billPhoto: input.billPhoto, lat: pos?.lat, lng: pos?.lng, distanceM: input.distanceM, shortages, excess } }, 'delivery');
    done++;
  }
  if (!done) return null;
  return cs.commit(input.returnAll ? 'Refused at door' : 'Delivered');
}

/** Cancels a bill with a reason. Pieces still out on the bill go back to stock; money paid becomes shop advance. */
export async function cancelInvoice(invoiceId: string, reason: string) {
  const inv = await db.invoices.get(invoiceId);
  if (!inv) throw new Error('Bill not found.');
  if (inv.cancelled) throw new Error('This bill is already cancelled.');
  if (!reason.trim()) throw new Error('A reason is needed to cancel a bill.');
  // after supply (delivered) or once the month's GSTR-1 is due, a bill is never cancelled: credit note for less, new bill for extra
  const block = billChangeBlock(inv, 'cancel', today()); if (block) throw new Error(block);
  if ((await db.creditNotes.where('invoiceId').equals(inv.id).count()) > 0) throw new Error(`Bill ${inv.number} already has a credit note — it can't be cancelled now.`);
  const cs = new ChangeSet();
  const batches = await db.batches.toArray();
  for (const l of inv.lines) for (const b of l.batches) { if (b.qty <= 0) continue; const x = batches.find(y => y.id === b.batchId); if (x) { x.qty += b.qty; cs.put('batches', { ...x }, 'stock back (cancel)'); } }
  const lines = inv.lines.map(l => ({ ...l, batches: l.batches.map(b => ({ ...b, qty: 0 })) }));
  const done = cs.put<Invoice>('invoices', { ...inv, lines, cancelled: { at: nowIso(), by: session().userId, reason: reason.trim() } }, 'cancel bill');
  await refreshSchemeClaims(cs, done, []); // its company-scheme claim lines go with it, in the same save
  return cs.commit('Bill cancelled');
}
