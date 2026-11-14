// Credit notes, extra bills and the bill's "after supply" life. Plain code, exact to the paisa.
// A credit note credits only PAID pieces, each at its bill line's own taxable value + tax per piece; scheme-free pieces
// are credited at ₹0. A bill's credit notes together never exceed what the bill charged. Every note keeps its tax lines
// (taxable, rate, CGST/SGST/IGST, HSN) and the original bill's number and date, so it is a legal document (Rule 53).
import { inr } from './i18n';
import { ChangeSet, db, getSettings, nowIso, session, today } from './db';
import { r2 } from './ledger';
import { activeSchemes, applySchemes, billLine, billTotals, creditNoteNumbers, refreshSchemeClaims, takeBillNumber } from './billing';
import { billIsInter, lineCredits, taxOn } from './gst';
import { nextNumbers } from './sync';
import type { ClaimEntry, CreditNote, CreditNoteLine, Invoice, Product, Scheme } from './types';

export interface CreditItem { productId: string; paid: number; free: number; restock: boolean; line?: number } // line: the bill line (index) to credit first

/** what is still open on each bill line: paid and free pieces not yet credited, and the money behind them */
export function lineRoom(inv: Invoice, cns: CreditNote[]) {
  const done = lineCredits(inv, cns);
  return inv.lines.map((l, i) => ({
    paid: Math.max(0, l.qty - done[i].paid), free: Math.max(0, l.freeQty - done[i].free),
    taxable: r2(l.taxable - done[i].taxable), cgst: r2(l.cgst - done[i].cgst), sgst: r2(l.sgst - done[i].sgst), igst: r2(l.igst - done[i].igst),
  }));
}
/** paid pieces of a product still open (not credited) on a bill */
export const openPaid = (inv: Invoice, cns: CreditNote[], productId: string) => lineRoom(inv, cns).reduce((a, r, i) => a + (inv.lines[i].productId === productId ? r.paid : 0), 0);

/** the lines and money of a credit note — refused (with the reason) if it asks for more than is open on the bill */
export function buildCreditNote(inv: Invoice, cns: CreditNote[], items: CreditItem[]) {
  const room = lineRoom(inv, cns);
  const inter = billIsInter(inv);
  const lines: CreditNoteLine[] = [];
  for (const it of items) {
    let paid = Math.max(0, Math.floor(it.paid)), free = Math.max(0, Math.floor(it.free));
    if (!paid && !free) continue;
    const idx = inv.lines.map((_, i) => i).filter(i => inv.lines[i].productId === it.productId)
      .sort((a, b) => (a === it.line ? -1 : b === it.line ? 1 : 0)); // the named line first, then the product's other lines
    const name = inv.lines[idx[0]]?.name ?? 'this item';
    if (!idx.length) throw new Error(`Bill ${inv.number} has no ${name}.`);
    const paidOpen = idx.reduce((a, i) => a + room[i].paid, 0), freeOpen = idx.reduce((a, i) => a + room[i].free, 0);
    if (paid > paidOpen) throw new Error(`Only ${paidOpen} charged pcs of ${name} are left on bill ${inv.number} to credit (asked ${paid}).`);
    if (free > freeOpen) free = freeOpen; // free pieces carry no money: never more than were given
    for (const i of idx) {
      const l = inv.lines[i], r = room[i];
      const p = Math.min(paid, r.paid), f = Math.min(free, r.free);
      if (!p && !f) continue;
      paid -= p; free -= f; r.paid -= p; r.free -= f;
      let t: { taxable: number; cgst: number; sgst: number; igst: number };
      if (p && r.paid === 0) t = { taxable: r.taxable, cgst: r.cgst, sgst: r.sgst, igst: r.igst }; // the last paid pieces take exactly what is left (no paisa drift)
      else if (p) { const taxable = Math.min(r.taxable, r2(l.taxable / (l.qty || 1) * p)); const x = taxOn(taxable, l.gst, inter); t = { taxable, cgst: Math.min(x.cgst, r.cgst), sgst: Math.min(x.sgst, r.sgst), igst: Math.min(x.igst, r.igst) }; }
      else t = { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      r.taxable = r2(r.taxable - t.taxable); r.cgst = r2(r.cgst - t.cgst); r.sgst = r2(r.sgst - t.sgst); r.igst = r2(r.igst - t.igst);
      lines.push({ productId: l.productId, line: i, qty: p, freeQty: f, amount: r2(t.taxable + t.cgst + t.sgst + t.igst), restock: it.restock, hsn: l.hsn, gst: l.gst, ...t });
    }
  }
  const taxable = r2(lines.reduce((a, l) => a + (l.taxable ?? 0), 0)), cgst = r2(lines.reduce((a, l) => a + (l.cgst ?? 0), 0));
  const sgst = r2(lines.reduce((a, l) => a + (l.sgst ?? 0), 0)), igst = r2(lines.reduce((a, l) => a + (l.igst ?? 0), 0));
  const exact = r2(taxable + cgst + sgst + igst);
  const open = r2(inv.total - cns.reduce((a, c) => a + c.total, 0));
  // everything charged is now credited: the note is exactly what is left of the bill (the bill's own round-off comes back)
  const total = room.every(r => r.paid === 0) ? Math.max(0, open) : Math.max(0, Math.min(exact, open));
  return { lines, taxable, cgst, sgst, igst, roundOff: r2(total - exact), total };
}

/** the credit a return would give, without saving (TESRAX shows it; the save computes it again) */
export async function creditValue(invoiceId: string, items: CreditItem[]) {
  const inv = await db.invoices.get(invoiceId); if (!inv) throw new Error('Bill not found.');
  return buildCreditNote(inv, await db.creditNotes.where('invoiceId').equals(invoiceId).toArray(), items).total;
}

/**
 * Makes a credit note on a bill. takeOffBill: the pieces come off the bill's stock lots now (a shop return); good pieces go
 * back to stock. Without it (a delivery difference) the pieces already came off at delivery. Damaged returns go to the
 * company claim register. The bill's scheme claim lines follow in the same save.
 */
export async function makeCreditNote(cs: ChangeSet, inv: Invoice, items: CreditItem[], opts: { reason: string; source: 'delivery' | 'return'; takeOffBill: boolean; earlier?: CreditNote[]; number?: string }) {
  if (inv.cancelled) throw new Error(`Bill ${inv.number} is already cancelled — nothing to credit.`);
  // a return on a bill whose delivery difference is not settled yet would credit the same pieces twice
  if (opts.source === 'return' && inv.delivery && !inv.diffAction && ((inv.delivery.shortages?.length ?? 0) + (inv.delivery.excess?.length ?? 0)) > 0)
    throw new Error(`Bill ${inv.number} has a delivery difference not settled yet — settle it at day close first, then make the return.`);
  const cns = [...(await db.creditNotes.where('invoiceId').equals(inv.id).toArray()), ...(opts.earlier ?? [])];
  const built = buildCreditNote(inv, cns, items);
  if (!built.lines.length) throw new Error('Nothing to credit.');
  if (opts.takeOffBill) {
    const batches = await db.batches.toArray();
    // the pieces come off the bill's lots of that product (a product can sit on two lines of one bill: any of its lines)
    for (const cl of built.lines) {
      const twins = inv.lines.filter(x => x.productId === cl.productId);
      const name = inv.lines[cl.line!]?.name ?? 'this item';
      let left = cl.qty + (cl.freeQty ?? 0);
      const out = twins.reduce((a, l) => a + l.batches.reduce((x, b) => x + b.qty, 0), 0);
      if (left > out) throw new Error(`Only ${out} pcs of ${name} are still with the shop on bill ${inv.number}.`);
      for (const l of [inv.lines[cl.line!], ...twins.filter(x => x !== inv.lines[cl.line!])]) for (const lb of l.batches) { if (left <= 0) break; const take = Math.min(left, lb.qty); lb.qty -= take; left -= take; if (cl.restock && take) { const b = batches.find(x => x.id === lb.batchId); if (b) { b.qty += take; cs.put('batches', { ...b }, 'return to stock'); } } }
    }
    cs.put('invoices', { ...inv }, 'returned pieces off the bill');
    // damaged returns: the company is asked to pay for them (claim register), valued at the buying rate
    const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
    for (const cl of built.lines) if (!cl.restock) {
      const pcs = cl.qty + (cl.freeQty ?? 0); const v = costValue(products.get(cl.productId), pcs);
      cs.put<ClaimEntry>('claimEntries', { companyId: inv.companyId, month: today().slice(0, 7), kind: 'damage', productId: cl.productId, qty: pcs, amount: v.amount, valuePending: v.pending || undefined, invoiceId: inv.id, note: `Damaged return · ${opts.reason}` } as ClaimEntry, 'damaged return → claim');
    }
  }
  const number = opts.number ?? (await creditNoteNumbers(cs, 1))[0];
  const cn = cs.put<CreditNote>('creditNotes', {
    number, invoiceId: inv.id, invoiceNumber: inv.number, invoiceDate: inv.date, shopId: inv.shopId, companyId: inv.companyId,
    date: today(), reason: opts.reason, source: opts.source, ...built,
  }, 'credit note');
  await refreshSchemeClaims(cs, inv, [...cns, cn]);
  return cn;
}

/** a shortage of S pieces on a line, split into paid and free: the shop keeps the most paid pieces whose free pieces still fit.
 *  The free pieces are earned on the product's combined qty (the same product may sit on other lines of the bill: their
 *  paid pieces, `otherQty`, count too — as refreshSchemeClaims and priceLines work them out). */
export function splitShort(line: Invoice['lines'][0], short: number, p: Product | undefined, schemes: Scheme[], date: string, otherQty = 0) {
  const delivered = Math.max(0, line.qty + line.freeQty - short);
  const free = (q: number) => p ? applySchemes(p, q + otherQty, line.rate, activeSchemes(schemes, p, date)).freeQty : Math.floor(line.freeQty * q / (line.qty || 1));
  let keep = Math.min(line.qty, delivered);
  while (keep > 0 && keep + Math.min(free(keep), line.freeQty) > delivered) keep--;
  const paid = line.qty - keep;
  return { paid, free: Math.max(0, Math.min(line.freeQty, short - paid)) };
}
/** paid pieces of the same product on the bill's other lines (for splitShort) */
export const otherQty = (lines: Invoice['lines'], i: number) => lines.reduce((a, l, k) => k !== i && l.productId === lines[i]?.productId ? a + l.qty : a, 0);

/**
 * Extra pieces given from the van at delivery: a delivered bill is never re-written, so they go on a NEW bill (next number),
 * at the same rate. The pieces were already taken from stock at delivery — they move from the first bill's lots to the new one.
 */
export async function extraBill(cs: ChangeSet, inv: Invoice, excess: { productId: string; qty: number }[]) {
  const settings = await getSettings();
  const shop = await db.shops.get(inv.shopId);
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const schemes = (await db.schemes.toArray()).filter(s => s.type === 'pct');
  const inter = billIsInter(inv);
  const lines = [];
  for (const x of excess) {
    const l = inv.lines.find(y => y.productId === x.productId); const p = products.get(x.productId);
    if (!l || !p || x.qty <= 0) continue;
    // the extra pieces were added to the end of the line's lots at delivery: move them over (from any line of this
    // product — a product can sit on two lines of one bill, and each got its extra pieces)
    let need = x.qty; const moved: typeof l.batches = [];
    for (const tl of [...inv.lines].reverse().filter(y => y.productId === x.productId)) for (let k = tl.batches.length - 1; k >= 0 && need > 0; k--) { const b = tl.batches[k]; const take = Math.min(need, b.qty); if (!take) continue; b.qty -= take; need -= take; moved.push({ ...b, qty: take }); }
    if (need > 0) throw new Error(`The extra ${l.name} is not on bill ${inv.number} any more.`);
    lines.push({ ...billLine(p, x.qty, l.rate, activeSchemes(schemes, p, today()), inter, { mrp: l.mrp, noFree: true }), batches: moved });
  }
  if (!lines.length) return null;
  const numbers = (await nextNumbers('bill', 1)) ?? undefined;
  const number = takeBillNumber(cs, settings, numbers, today());
  const extra = cs.put<Invoice>('invoices', {
    number, companyId: inv.companyId, shopId: inv.shopId, date: today(), kind: inv.kind, lines, ...billTotals(lines),
    deliveryStatus: 'delivered', delivery: { at: nowIso(), by: inv.delivery?.by ?? session().userId, shortages: [], excess: [] },
    extraOf: inv.id, vanId: inv.vanId, tripId: inv.tripId, stopNo: inv.stopNo,
  }, `extra pieces given with ${inv.number}${shop ? ` to ${shop.name}` : ''}`);
  await refreshSchemeClaims(cs, extra, []);
  return extra;
}

/** money at buying rate (claims, damage, purchase lines). On a staff phone the buying rate is hidden: the value is left
 *  pending (₹0, marked) and filled in by the owner's phone — never NaN, never shown to the staff. */
export function costValue(p: Pick<Product, 'purchaseRate'> | undefined, qty: number) {
  const rate = p?.purchaseRate;
  return typeof rate === 'number' && Number.isFinite(rate) ? { amount: r2(qty * rate), pending: false } : { amount: 0, pending: true };
}

/** on the owner's phone (which has the buying rates): value every claim line and purchase saved without one */
let lastFill = 0;
export async function fillPendingValues(opts: { throttle?: boolean } = {}) {
  if (opts.throttle && Date.now() - lastFill < 5 * 60_000) return 0; // the home screen: at most every 5 minutes
  lastFill = Date.now();
  const me = await db.staff.get(session().userId);
  if (me && me.role !== 'owner') return 0;
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const known = (id?: string) => { const r = products.get(id ?? '')?.purchaseRate; return typeof r === 'number' && Number.isFinite(r) ? r : null; };
  const cs = new ChangeSet();
  for (const e of await db.claimEntries.toArray()) {
    if (!e.valuePending) continue; const rate = known(e.productId); if (rate == null) continue;
    cs.put('claimEntries', { ...e, amount: r2(e.qty * rate), valuePending: false }, 'valued at buying rate');
  }
  for (const pu of await db.purchases.toArray()) {
    if (!pu.valuePending) continue;
    if (pu.lines.some(l => !(l.rate > 0) && known(l.productId) == null)) continue;
    const lines = pu.lines.map(l => { const rate = l.rate > 0 ? l.rate : known(l.productId)!; return { ...l, rate, amount: r2(l.qty * rate - (l.discount || 0)) }; });
    const taxable = r2(lines.reduce((a, l) => a + l.amount, 0)), tax = r2(lines.reduce((a, l) => a + l.amount * l.gst / 100, 0));
    cs.put('purchases', { ...pu, lines, taxable, tax, total: r2(taxable + tax), valuePending: false }, 'valued at buying rate');
  }
  if (!cs.size) return 0;
  await cs.commit('Values filled in');
  return cs.size;
}

/** Print / PDF: the ONE place a bill is marked printed (from then on it changes only by credit note or cancel) */
export async function markPrinted(invoiceId: string) {
  const inv = await db.invoices.get(invoiceId);
  if (!inv || inv.printedAt || inv.cancelled) return inv;
  const cs = new ChangeSet();
  const upd = cs.put<Invoice>('invoices', { ...inv, printedAt: nowIso() }, 'printed');
  await cs.commit('Bill printed');
  return upd;
}

/** "Previous balance" printed on a bill: what the shop owed before this bill, as of the bill's date (reprints stay the same) */
export async function balanceBefore(inv: Invoice) {
  const before = (x: Invoice) => x.date < inv.date || (x.date === inv.date && x.number < inv.number);
  const bills = (await db.invoices.where('shopId').equals(inv.shopId).toArray()).filter(x => !x.cancelled && x.id !== inv.id && before(x));
  const ids = new Set(bills.map(b => b.id));
  const cns = (await db.creditNotes.where('shopId').equals(inv.shopId).toArray()).filter(c => ids.has(c.invoiceId) && c.date <= inv.date);
  const pays = (await db.payments.where('shopId').equals(inv.shopId).toArray()).filter(p => (p.status === 'ok' || p.status === 'waiting_shop') && p.date < inv.date && !(p.mode === 'cheque' && p.chequeDate && p.chequeDate >= inv.date));
  // the shop's old dues (opening balance) are part of what it owed before
  const old = (await db.openingDues.where('shopId').equals(inv.shopId).toArray()).filter(o => o.date <= inv.date);
  return r2(bills.reduce((a, b) => a + b.total, 0) + old.reduce((a, o) => a + o.amount, 0) - cns.reduce((a, c) => a + c.total, 0) - pays.reduce((a, p) => a + p.amount, 0));
}

/** a collection bigger than everything the shop owes is usually a typing mistake: ask before saving */
export async function collectionCheck(shopId: string, amount: number) {
  const { shopOutstanding } = await import('./ledger');
  const due = Math.max(0, (await shopOutstanding(shopId)).total);
  return amount > due + 0.5 ? `Is ${inr(amount)} right? This shop owes only ${inr(due)} in all — the extra ${inr(r2(amount - due))} will be kept as advance.` : null;
}
