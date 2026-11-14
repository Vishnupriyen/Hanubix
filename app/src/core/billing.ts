import { inr } from './i18n';
import { nextNumbers, PENDING_MARK, server } from './sync';
import { ChangeSet, db, getSettings, newId, today } from './db';
import { isB2B, OWED, r2, shopOutstanding } from './ledger';
import { isInterState, lineCredits, taxOn } from './gst';
import type { Batch, ClaimEntry, CreditNote, Invoice, InvoiceLine, Order, OrderLine, Product, Scheme, Settings, Shop } from './types';

// ---------- schemes ----------
export function activeSchemes(all: Scheme[], p: Product, date: string) {
  return all.filter(s => s.companyId === p.companyId && (!s.productId || s.productId === p.id) && s.from <= date && s.to >= date);
}

export function applySchemes(_p: Product, qty: number, rate: number, schemes: Scheme[]) {
  const gross = r2(qty * rate);
  let discount = 0;
  let freeQty = 0;
  const names: string[] = [];
  // company schemes first, then own schemes; "replace" own schemes cancel company % discounts
  const ordered = [...schemes].sort((a, b) => (a.source === 'company' ? -1 : 1) - (b.source === 'company' ? -1 : 1));
  let pctTotal = 0, coPct = 0, coFree = 0, replaced = false;
  for (const s of ordered) {
    if (s.type === 'pct') {
      if (s.source === 'own' && s.combine === 'replace') { pctTotal = s.value; replaced = true; } else pctTotal += s.value;
      if (s.source === 'company') coPct += s.value;
      names.push(s.name);
    } else if (s.type === 'free' && s.buyQty && s.freeQty && qty >= s.buyQty) {
      const f = Math.floor(qty / s.buyQty) * s.freeQty;
      freeQty += f; if (s.source === 'company') coFree += f;
      names.push(s.name);
    }
  }
  discount = r2(gross * pctTotal / 100);
  // the part the company pays back (claimable): its own % schemes (unless an own scheme replaced them) and its free pieces
  const coDiscount = replaced ? 0 : r2(gross * coPct / 100);
  return { gross, discount, freeQty, names, coDiscount, coFree };
}

/** one bill line, priced the same way everywhere (new bill, bill editor, extra bill): schemes, then tax on the taxable value */
export function billLine(p: Product, qty: number, rate: number, schemes: Scheme[], inter: boolean, opts: { mrp?: number; discount?: number; discountPct?: number; noFree?: boolean } = {}): InvoiceLine {
  const sch = applySchemes(p, qty, rate, schemes);
  // Disc % on the line: the ₹ figure is worked out here once (gross × % to the paisa) and is the legal figure on the bill
  if (opts.discount == null && opts.discountPct != null && Number.isFinite(opts.discountPct)) opts = { ...opts, discount: r2(sch.gross * Math.min(100, Math.max(0, opts.discountPct)) / 100) };
  const discount = opts.discount != null && Number.isFinite(opts.discount) ? r2(Math.min(sch.gross, Math.max(0, opts.discount))) : sch.discount;
  const taxable = r2(sch.gross - discount);
  const tax = taxOn(taxable, p.gst, inter);
  return {
    productId: p.id, name: p.name, hsn: p.hsn, qty, freeQty: opts.noFree ? 0 : sch.freeQty, rate, mrp: opts.mrp ?? p.mrp,
    gross: sch.gross, discount, taxable, gst: p.gst, ...tax, total: r2(taxable + tax.cgst + tax.sgst + tax.igst), batches: [], schemeNames: sch.names,
    // the buying rate at billing time (absent on a phone without buying rates: P&L then falls back)
    ...(typeof p.purchaseRate === 'number' && Number.isFinite(p.purchaseRate) ? { costRate: p.purchaseRate } : {}),
  };
}
/** lines priced as a bill prices them (new bill, bill editor, order screens): each line its own rate and Disc % (or a typed ₹),
 *  and a product on two lines gets its scheme-free pieces once, on the combined paid qty, on its first line (GST rule 3) */
export function priceLines(edits: { productId: string; qty: number; rate: number; mrp?: number; discount?: number; discountPct?: number }[], products: Map<string, Product>, schemes: Scheme[], inter: boolean, date: string): (InvoiceLine | null)[] {
  const together = new Map<string, number>(); for (const e of edits) if (e.qty > 0) together.set(e.productId, (together.get(e.productId) ?? 0) + e.qty);
  const seen = new Set<string>();
  return edits.map(e => {
    const p = products.get(e.productId); if (!p || !(e.qty > 0)) return null;
    const isFirst = !seen.has(p.id); seen.add(p.id);
    const sch = activeSchemes(schemes, p, date);
    const line = billLine(p, e.qty, e.rate, sch, inter, { mrp: e.mrp, ...(e.discountPct != null ? { discountPct: e.discountPct } : { discount: e.discount }), noFree: !isFirst });
    if (isFirst && together.get(p.id)! !== e.qty) line.freeQty = applySchemes(p, together.get(p.id)!, e.rate, sch).freeQty;
    if (e.discountPct != null) line.discountPct = e.discountPct;
    return line;
  });
}
/** a bill's totals from its lines: tax parts + round-off = total (rounded to the rupee) */
export function billTotals(lines: InvoiceLine[]) {
  const taxable = r2(lines.reduce((s, x) => s + x.taxable, 0));
  const cgst = r2(lines.reduce((s, x) => s + x.cgst, 0));
  const sgst = r2(lines.reduce((s, x) => s + x.sgst, 0));
  const igst = r2(lines.reduce((s, x) => s + x.igst, 0));
  const exact = r2(taxable + cgst + sgst + igst);
  const total = Math.round(exact);
  return { taxable, cgst, sgst, igst, roundOff: r2(total - exact), total, schemeSaving: r2(lines.reduce((s, x) => s + x.discount + x.freeQty * x.rate, 0)) };
}
/**
 * What these lines would be billed at, to the rupee: the same schemes, tax and per-bill round-off as makeInvoices (one bill per company).
 * The order, approval and picking screens show this, so the order total is the bill total when it is packed as ordered.
 */
export function billValueOf(lines: { productId: string; qty: number; rate: number; discountPct?: number }[], products: Map<string, Product>, schemes: Scheme[], inter: boolean, date = today()) {
  const by = new Map<string, InvoiceLine[]>();
  for (const l of lines) {
    const p = products.get(l.productId);
    if (!p || !(l.qty > 0)) continue;
    by.set(p.companyId, [...(by.get(p.companyId) ?? []), billLine(p, l.qty, l.rate, activeSchemes(schemes, p, date), inter, { discountPct: l.discountPct })]);
  }
  return r2([...by.values()].reduce((a, ls) => a + billTotals(ls).total, 0));
}

/** the next number of the one running bill series: from the server when there is one, else the settings counter */
export function takeBillNumber(cs: ChangeSet, settings: Settings, numbers: { first: number; prefix: string } | undefined, date: string) {
  if (numbers) { const n = `${numbers.prefix}/${finYear(date)}/${String(numbers.first).padStart(5, '0')}`; numbers.first += 1; return n; } // issued by the server
  const n = `${settings.billPrefix ?? 'DBX'}/${finYear(date)}/${String(settings.nextBillNo ?? 1).padStart(5, '0')}`;
  settings.nextBillNo = (settings.nextBillNo ?? 1) + 1; cs.put('settings', { ...settings }, 'bill number');
  return n;
}

/**
 * The company-scheme claim lines of a bill, kept in step with it in the same save: only COMPANY schemes are claimed
 * (own schemes and salesman rate cuts never), valued on the paid pieces the shop kept (billed minus credited).
 * A cancelled bill, or one returned in full, drops its lines. Lines are never deleted — a dropped line says why.
 */
export async function refreshSchemeClaims(cs: ChangeSet, inv: Invoice, cns: CreditNote[], pending: ClaimEntry[] = []) {
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const schemes = await db.schemes.toArray();
  const credits = lineCredits(inv, cns);
  const want = new Map<string, { qty: number; amount: number; names: string[] }>();
  // % schemes on each line's own value; free pieces once per product on the combined kept qty (a product can sit on two lines)
  const keptOf = new Map<string, { qty: number; rate: number; free: number }>();
  if (!inv.cancelled) inv.lines.forEach((l, i) => {
    const p = products.get(l.productId); if (!p) return;
    const kept = Math.max(0, l.qty - credits[i].paid);
    const sch = applySchemes(p, kept, l.rate, activeSchemes(schemes, p, inv.date).filter(s => s.source === 'company'));
    const w = want.get(l.productId) ?? { qty: 0, amount: 0, names: [] };
    // the company pays back what the shop was actually given: never more than the line's own discount on the kept pieces
    // (the owner's Disc % may give less than the scheme, or nothing)
    const given = l.qty > 0 ? r2(l.discount * kept / l.qty) : 0;
    w.qty += kept; w.amount = r2(w.amount + Math.min(sch.coDiscount, given)); w.names = [...new Set([...w.names, ...sch.names])];
    want.set(l.productId, w);
    const k = keptOf.get(l.productId); keptOf.set(l.productId, { qty: (k?.qty ?? 0) + kept, rate: k?.rate ?? l.rate, free: (k?.free ?? 0) + Math.max(0, l.freeQty - credits[i].free) });
  });
  for (const [pid, k] of keptOf) {
    const p = products.get(pid)!; const w = want.get(pid)!;
    const sch = applySchemes(p, k.qty, k.rate, activeSchemes(schemes, p, inv.date).filter(s => s.source === 'company'));
    w.amount = r2(w.amount + Math.min(sch.coFree, k.free) * k.rate); // free pieces actually given (and kept), never more if (sch.coFree) w.names = [...new Set([...w.names, ...sch.names])];
  }
  const seen = new Map(pending.map(e => [e.id, e]));
  // a bill's scheme lines are filed in the bill's month (indexed): never read the whole claim register per bill
  for (const e of await db.claimEntries.where('month').equals(inv.date.slice(0, 7)).toArray()) if (!seen.has(e.id)) seen.set(e.id, e);
  for (const e of seen.values()) {
    if (e.invoiceId !== inv.id || e.kind !== 'scheme' || e.dropped) continue;
    const w = e.productId ? want.get(e.productId) : undefined;
    if (!w || w.amount <= 0) cs.put('claimEntries', { ...e, dropped: inv.cancelled ? 'Bill cancelled' : 'Nothing left to claim on this bill (returned / not supplied)' }, 'scheme claim dropped');
    else if (w.amount !== e.amount || w.qty !== e.qty) cs.put('claimEntries', { ...e, qty: w.qty, amount: w.amount }, 'scheme claim follows the bill');
    if (e.productId) want.delete(e.productId);
  }
  for (const [productId, w] of want) if (w.amount > 0) {
    cs.put('claimEntries', { companyId: inv.companyId, month: inv.date.slice(0, 7), kind: 'scheme', productId, qty: w.qty, amount: w.amount, invoiceId: inv.id, note: w.names.join(', ') }, 'scheme claim line');
  }
}

// one rule for a bill line's stock lots: core/lots.ts (the guard in db.ts uses it too)
export { billLotsProblem } from './lots';

// ---------- stock: oldest expiry first (FEFO) ----------
export function pickBatches(batches: Batch[], productId: string, qty: number, date = today()) {
  const usable = batches
    .filter(b => b.productId === productId && b.qty > 0 && b.expiry >= date)
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
  const picks: { batchId: string; batch: string; qty: number; expiry: string }[] = [];
  let need = qty;
  for (const b of usable) {
    if (need <= 0) break;
    const take = Math.min(b.qty, need);
    picks.push({ batchId: b.id, batch: b.batch, qty: take, expiry: b.expiry });
    need -= take;
  }
  return { picks, short: need };
}

/** every product's sellable stock in one read (the order screen did 2,000 separate reads) */
export async function allStock(): Promise<Map<string, number>> {
  const t = today(); const out = new Map<string, number>();
  for (const b of await db.batches.toArray()) if (b.expiry >= t) out.set(b.productId, (out.get(b.productId) ?? 0) + b.qty);
  return out;
}

export async function stockOf(productId: string) {
  const bs = await db.batches.where('productId').equals(productId).toArray();
  return bs.filter(b => b.expiry >= today()).reduce((s, b) => s + b.qty, 0);
}

/** a physical count: the lot is set to what was counted, with the reason kept in the audit. Never below zero. */
export function countLot(cs: ChangeSet, b: Batch, counted: number, why: string) {
  if (!Number.isInteger(counted) || counted < 0) throw new Error('A count must be a whole number, 0 or more.');
  if (!why.trim()) throw new Error('Give a reason for the difference.');
  if (counted === b.qty) return null;
  return cs.put<Batch>('batches', { ...b, qty: counted }, `count adjust ${b.qty} → ${counted}: ${why.trim()}`);
}

// ---------- checks before billing ----------
export interface OrderCheck { issues: string[]; total: number }

export async function checkOrder(shop: Shop, lines: OrderLine[]): Promise<OrderCheck> {
  const issues: string[] = [];
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const batches = await db.batches.toArray();
  const settings = await getSettings();
  const total = billValueOf(lines, products, await db.schemes.toArray(), isInterState(shop, settings));
  for (const l of lines) {
    const p = products.get(l.productId);
    if (!p) { issues.push('Unknown product'); continue; }
    const { short } = pickBatches(batches, p.id, l.qty);
    if (short > 0) issues.push(`Stock short: ${p.name} needs ${short} more pcs`);
    if (l.rate < p.rate * (1 - settings.discountAlertPct / 100)) issues.push(`Low rate for ${p.name}: ${inr(l.rate)} vs ${inr(p.rate)}`);
  }
  if (!shop.approved) issues.push('New shop not yet approved by owner');
  const out = await shopOutstanding(shop.id);
  if (isCashOnly(shop) && out.total > OWED) issues.push(`Cash-only shop has ${inr(out.total)} pending`);
  if (shop.creditLimit > 0 && out.total + total > shop.creditLimit) {
    issues.push(`Credit limit ${inr(shop.creditLimit)} crossed (pending ${inr(r2(out.total))} + this ${inr(r2(total))})`);
  }
  if (out.maxOverdueDays > 0) issues.push(`Overdue ${out.maxOverdueDays} days (${inr(out.overdue)})`);
  return { issues, total: r2(total) };
}

/** credit limit 0 (or not set) means CASH ONLY — the owner gives credit by setting a limit (owner decision, 11 Nov 2026) */
export const isCashOnly = (shop: Pick<Shop, 'cashOnly' | 'creditLimit'>) => !!shop.cashOnly || !(shop.creditLimit > 0);

// ---------- making bills (one per company) ----------
// Credit-note numbers: CN/<financial year>/<running no>. With a server they come ONLY from it (never a duplicate across
// phones); without signal the note is saved "number pending" and numbered at the next sync. No server (demo): a counter
// in settings that only moves forward.
export async function creditNoteNumbers(cs: ChangeSet, count: number): Promise<string[]> {
  const fy = finYear(today());
  let first: number | null = null;
  if (await server()) {
    try { first = (await nextNumbers('cn', count))?.first ?? null; } catch { first = null; }
    if (first === null) return Array.from({ length: count }, () => `CN/${fy}${PENDING_MARK}${newId().slice(-6)}`);
  }
  if (first === null) {
    const settings = await getSettings();
    first = settings.nextCnNo ?? (await db.creditNotes.count()) + 1;
    cs.put('settings', { ...settings, nextCnNo: first + count }, 'credit note number');
  }
  return Array.from({ length: count }, (_, i) => `CN/${fy}/${String(first! + i).padStart(5, '0')}`);
}

export function finYear(date: string) {
  const [y, m] = date.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}

export interface BillCut { productId: string; name: string; wanted: number; billed: number }
export async function makeInvoices(cs: ChangeSet, order: Order, shop: Shop, numbers?: { first: number; prefix: string }, billDate?: string, cuts?: BillCut[]): Promise<Invoice[]> {
  const settings = await getSettings();
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const schemes = await db.schemes.toArray();
  const batches = await db.batches.toArray();
  const date = billDate ?? today(); // a bill is dated the day it is made, never the order's day (closed days, GST period, number order); only demo history passes a date
  const byCompany = new Map<string, OrderLine[]>();
  for (const l of order.lines) {
    const p = products.get(l.productId);
    if (!p) continue;
    byCompany.set(p.companyId, [...(byCompany.get(p.companyId) ?? []), l]);
  }
  const inter = isInterState(shop, settings);
  const out: Invoice[] = [];
  for (const [companyId, lines] of byCompany) {
    const invLines: InvoiceLine[] = [];
    // The same product can sit on two lines (Part 2 item 34): its stock goes out once for the lines together, its scheme-free
    // pieces are worked out once on the combined paid qty and shown on its first line (GST rule 3); each line keeps its own
    // rate and Disc %. One line per product = exactly as before.
    const want = new Map<string, number>(); // product → qty billed on all its lines (cut to stock below)
    for (const l of lines) want.set(l.productId, (want.get(l.productId) ?? 0) + l.qty);
    for (const [pid, total] of want) {
      const p = products.get(pid)!; const first = lines.find(l => l.productId === pid)!;
      const usable = batches.filter(b => b.productId === pid && b.qty > 0 && b.expiry >= date).reduce((a, b) => a + b.qty, 0);
      let qty = total;
      // never bill pieces no lot can cover: cut to what stock holds (the owner sees the cut on the order)
      while (qty > 0 && qty + applySchemes(p, qty, first.rate, activeSchemes(schemes, p, date)).freeQty > usable) qty--;
      if (qty < total) cuts?.push({ productId: p.id, name: p.name, wanted: total, billed: qty });
      want.set(pid, qty);
    }
    const left = new Map(want); const seen = new Set<string>();
    for (const l0 of lines) {
      const p = products.get(l0.productId)!;
      const room = left.get(p.id) ?? 0; const qty = Math.min(l0.qty, room); left.set(p.id, room - qty);
      if (qty <= 0) continue;
      const isFirst = !seen.has(p.id); seen.add(p.id);
      const sch = activeSchemes(schemes, p, date);
      const line = billLine(p, qty, l0.rate, sch, inter, { mrp: l0.mrp, discountPct: l0.discountPct, noFree: !isFirst });
      if (isFirst && want.get(p.id)! !== qty) line.freeQty = applySchemes(p, want.get(p.id)!, l0.rate, sch).freeQty; // free on the combined paid qty
      if (l0.discountPct != null) line.discountPct = l0.discountPct;
      // the picker's batch first (what is physically in the van), the rest oldest-expiry first
      const picks: ReturnType<typeof pickBatches>['picks'] = [];
      let need = qty + line.freeQty;
      // the same rule as every other lot taken for a bill: this product's, in stock, not expired (an expired lot the picker
      // chose is never sold — the bill takes the oldest good lots instead)
      const chosen = l0.batchId ? batches.find(b => b.id === l0.batchId && b.productId === p.id && b.qty > 0 && b.expiry >= date) : undefined;
      if (chosen) { const take = Math.min(chosen.qty, need); picks.push({ batchId: chosen.id, batch: chosen.batch, qty: take, expiry: chosen.expiry }); need -= take; }
      if (need > 0) picks.push(...pickBatches(batches.filter(b => b.id !== chosen?.id), p.id, need, date).picks);
      for (const pk of picks) {
        const b = batches.find(x => x.id === pk.batchId)!;
        b.qty -= pk.qty;
        cs.put('batches', { ...b }, 'stock out');
      }
      invLines.push({ ...line, batches: picks });
    }
    if (!invLines.length) continue; // nothing of this company was in stock
    // One running series for the distributor; several companies in one order take consecutive numbers.
    const number = takeBillNumber(cs, settings, numbers, date);
    const inv = cs.put<Invoice>('invoices', {
      number, companyId, shopId: shop.id, orderId: order.id, date, kind: isB2B(shop) ? 'B2B' : 'B2C',
      lines: invLines, ...billTotals(invLines),
      deliveryStatus: 'pending',
    }, 'bill made');
    out.push(inv);
    // every COMPANY scheme given becomes a claim line automatically (TESRAX Claim Prep); own schemes are never claimed
    await refreshSchemeClaims(cs, inv, []);
  }
  return out;
}

/** the same product on two lines of a sales bill (Part 2 item 34): on unless the owner switched it off (R1) */
export const sameProductTwiceOn = (s: Pick<Settings, 'sameProductTwice'> | undefined) => s?.sameProductTwice !== false;
