import { inr, showDate, showDay, showMonth, plural } from './i18n';
// A Proposal is what the TESRAX prepares for a person to check: a header + an Excel-style table.
// Nothing is written until the person taps ✓. Code (not AI) validates every row before that.
import { ChangeSet, db, getSettings, nowIso, session, today, undoBatch, UNDO_SYNCED, UNDO_SYNCED_MSG } from './db';
import { NO_ORDER_REASONS } from './field';
import { activeSchemes, applySchemes, checkOrder, stockOf } from './billing';
import { bookOrder, cancelInvoice, changeOrder } from './pipeline';
import { buildCreditNote, collectionCheck, openPaid } from './credit';
import { applyReturn, countOrRequest, countValue, damageOrRequest, damageValue, makeRequest, needsRequest, type CountRow, type DamageRow } from './requests';
import { receiptNumber } from './receipts';
import { isPendingNumber } from './sync';
import { commitOpeningDues, commitOpeningStock, validateOpeningDues, validateOpeningStock } from './opening';
import { billChangeBlock, creditNoteDeadline, GST_RATES, shopStateCode } from './gst';
import { allocateOldestFirst, invoiceBalances, r2, validGstin } from './ledger';
import { toIsoDate } from './readers';
import type { Advance, Batch, Company, Expense, Invoice, LeaveRequest, Payment, Product, Purchase, Scheme, Shop, Visit } from './types';

export type CellValue = string | number;
export type Row = Record<string, CellValue>;

export interface Col {
  key: string; label: string;
  type?: 'text' | 'number' | 'date' | 'select';
  options?: { value: string; label: string }[];
  readonly?: boolean;
  width?: number;
}

export type ProposalKind =
  | 'purchase' | 'expense' | 'bank' | 'order' | 'payment' | 'claim' | 'return'
  | 'products' | 'shops' | 'newshop' | 'schemes' | 'view' | 'paymentFix'
  | 'orderEdit' | 'orderCancel' | 'billCancel' | 'paymentCancel' | 'expenseFix' | 'stockFix' | 'productEdit' | 'shopEdit' | 'undo'
  | 'advance' // an advance to a staff member: asked by staff (waits for the owner) or given by the owner
  | 'leave' // a leave: asked by staff (waits for the owner) or given by the owner
  | 'visit' // a shop visited with no order, and why (TESRAX: "no order ganapathi shop closed")
  | 'fieldOrder' // company rep: an order sent to the shop's distributor
  | 'openingDues' | 'openingStock'; // the day a distributor starts: old shop dues and opening stock from Excel

export interface Proposal {
  id: string;
  kind: ProposalKind;
  title: string;
  fields: (Col & { value: CellValue })[]; // header values (bill no, shop, date …)
  columns: Col[];
  rows: Row[];
  meta: Record<string, unknown>;
  readonly?: boolean;
  note?: string;
  downloadName?: string;
}

export interface Validation {
  errors: Record<number, Record<string, string>>; // row → column → message
  fieldErrors: Record<string, string>;
  warnings: string[];
  summary: string;
}

/** a stock count more than 1 case off the system needs the counted total typed again ('again' field) */
function stockRetype(p: Proposal, caseSize: number, diff: number, counted: number): string | null {
  if (Math.abs(diff) <= Math.max(1, caseSize)) return null;
  const again = p.fields.find(f => f.key === 'again');
  if (again && String(again.value ?? '').trim() !== '' && Number(again.value) === counted) return null;
  return again && String(again.value ?? '').trim() !== '' ? 'Does not match the count — type the counted total again' : `More than 1 case different: type the counted total again to confirm`;
}
export const fieldValue = (p: Proposal, key: string) => p.fields.find(f => f.key === key)?.value ?? '';
const n = (v: CellValue | undefined) => Number(v) || 0;
const s = (v: CellValue | undefined) => String(v ?? '').trim();
const err = (v: Validation, row: number, col: string, msg: string) => { (v.errors[row] ??= {})[col] = msg; };

export async function productOptions(companyId?: string) {
  const ps = (await db.products.toArray()).filter(p => p.active && (!companyId || p.companyId === companyId));
  return [{ value: '', label: '— pick —' }, { value: '__new', label: '+ New product' },
    ...ps.sort((a, b) => a.name.localeCompare(b.name)).map(p => ({ value: p.id, label: p.name }))];
}
export async function shopOptions() {
  const ss = await db.shops.toArray();
  return [{ value: '', label: '— pick —' }, ...ss.sort((a, b) => a.name.localeCompare(b.name)).map(x => ({ value: x.id, label: `${x.name} · ${x.area}` }))];
}
export async function companyOptions() {
  return [{ value: '', label: '— pick —' }, ...(await db.companies.toArray()).map(c => ({ value: c.id, label: c.name }))];
}

export async function orderRow(product: Product, qty: number, said: string, schemes?: Scheme[], rate = product.rate): Promise<Row> {
  const sc = schemes ?? await db.schemes.toArray();
  const sch = applySchemes(product, qty, rate, activeSchemes(sc, product, today()));
  const amount = r2((sch.gross - sch.discount) * (1 + product.gst / 100));
  return { said, productId: product.id, qty, rate, free: sch.freeQty, amount, stock: await stockOf(product.id) };
}

// Re-compute dependent cells when a person edits an order row.
export async function refreshOrderRow(r: Row): Promise<Row> {
  const p = await db.products.get(String(r.productId));
  if (!p) return r;
  const sch = applySchemes(p, Number(r.qty) || 0, Number(r.rate) || p.rate, activeSchemes(await db.schemes.toArray(), p, today()));
  return { ...r, free: sch.freeQty, amount: r2((sch.gross - sch.discount) * (1 + p.gst / 100)), stock: await stockOf(p.id), rate: Number(r.rate) || p.rate };
}

// ---------------------------------------------------------------------------------------------
// VALIDATE
// ---------------------------------------------------------------------------------------------
export async function validate(p: Proposal): Promise<Validation> {
  const v: Validation = { errors: {}, fieldErrors: {}, warnings: [], summary: '' };
  const products = new Map((await db.products.toArray()).map(x => [x.id, x]));
  switch (p.kind) {
    case 'fieldOrder': {
      const { checkFieldOrder } = await import('./field');
      const shop = await db.shops.get(s(fieldValue(p, 'shopId')));
      if (!shop) v.fieldErrors.shopId = 'Pick the shop';
      p.rows.forEach((r, i) => {
        if (!products.get(s(r.productId))) err(v, i, 'productId', 'Pick the product');
        if (!Number.isInteger(n(r.qty)) || n(r.qty) <= 0) err(v, i, 'qty', 'Whole pieces, more than 0');
      });
      if (shop && !Object.keys(v.errors).length) {
        const bad = checkFieldOrder(shop, p.rows.map(r => ({ productId: s(r.productId), qty: n(r.qty) })), products);
        if (bad) v.fieldErrors.shopId = bad;
        v.summary = `${plural(p.rows.length, 'item')} · about ${inr(r2(p.rows.reduce((a, r) => a + n(r.qty) * (products.get(s(r.productId))?.rate ?? 0), 0)))} before GST · goes to the distributor for billing`;
      }
      break;
    }
    case 'purchase': {
      if (!s(fieldValue(p, 'companyId'))) v.fieldErrors.companyId = 'Pick the company';
      if (!s(fieldValue(p, 'billNo'))) v.fieldErrors.billNo = 'Bill number needed';
      else if ((await db.purchases.where('companyId').equals(s(fieldValue(p, 'companyId'))).toArray()).some(x => String(x.billNo ?? '').trim().toUpperCase() === s(fieldValue(p, 'billNo')).trim().toUpperCase()))
        v.fieldErrors.billNo = 'This company bill is already entered';
      const gstin = s(fieldValue(p, 'supplierGstin')).toUpperCase();
      if (gstin && !validGstin(gstin)) v.fieldErrors.supplierGstin = 'GSTIN looks wrong';
      let sumTaxable = 0, sumTax = 0;
      p.rows.forEach((r, i) => {
        const prod = products.get(s(r.productId));
        if (!s(r.productId)) err(v, i, 'productId', 'Pick the product (or + New product)');
        if (n(r.qty) <= 0) err(v, i, 'qty', 'Quantity must be more than 0');
        if (n(r.rate) <= 0) err(v, i, 'rate', 'Rate missing');
        if (!s(r.batch)) err(v, i, 'batch', 'Batch missing');
        const exp = toIsoDate(s(r.expiry));
        // the same product on two lines is fine (another batch, another rate — each its own lot); the same product, batch,
        // expiry and rate twice is the bill typed twice
        const key = (x: typeof r) => `${s(x.productId)}|${s(x.batch).toUpperCase()}|${toIsoDate(s(x.expiry))}|${n(x.rate)}`;
        if (s(r.productId) && s(r.productId) !== '__new' && p.rows.slice(0, i).some(x => key(x) === key(r))) err(v, i, 'productId', 'This product is listed twice with the same batch and expiry. Check the bill.');
        if (!exp) err(v, i, 'expiry', 'Expiry date missing');
        else if (exp < today()) err(v, i, 'expiry', 'Already expired');
        else if ((new Date(exp).getTime() - Date.now()) / 86400000 < 60) v.warnings.push(`Row ${i + 1}: expires within 60 days`);
        if (prod && n(r.gst) && n(r.gst) !== prod.gst) err(v, i, 'gst', `Product master says ${prod.gst}%`);
        if (prod && n(r.mrp) && prod.mrp && n(r.mrp) !== prod.mrp) v.warnings.push(`Row ${i + 1}: MRP changed ${prod.mrp} → ${n(r.mrp)}`);
        const taxable = r2(n(r.qty) * n(r.rate) - n(r.discount));
        const gst = n(r.gst) || prod?.gst || 0;
        const withTax = r2(taxable * (1 + gst / 100));
        if (n(r.amount) && Math.abs(n(r.amount) - taxable) > 1 && Math.abs(n(r.amount) - withTax) > 1) {
          err(v, i, 'amount', `Qty × rate − disc = ${taxable} (with GST ${withTax})`);
        }
        sumTaxable += taxable; sumTax += r2(taxable * gst / 100);
      });
      const billTotal = n(fieldValue(p, 'billTotal'));
      const computed = r2(sumTaxable + sumTax);
      const tol = Math.max(2, p.rows.length * 0.5);
      if (billTotal && Math.abs(billTotal - computed) > tol && Math.abs(billTotal - r2(sumTaxable)) > tol) {
        v.fieldErrors.billTotal = `Lines add up to ${inr(computed)}, bill says ${inr(billTotal)}`;
      }
      v.summary = `${plural(p.rows.length, 'item')} · taxable ${inr(r2(sumTaxable))} · GST ${inr(r2(sumTax))} · total ${inr(computed)}`;
      break;
    }
    case 'expense': {
      p.rows.forEach((r, i) => {
        if (n(r.amount) <= 0) err(v, i, 'amount', 'Amount missing');
        if (!s(r.category)) err(v, i, 'category', 'Pick a category');
        if (!toIsoDate(s(r.date))) err(v, i, 'date', 'Date missing');
      });
      v.summary = `${plural(p.rows.length, 'expense')} · ${inr(r2(p.rows.reduce((a, r) => a + n(r.amount), 0)))}`;
      break;
    }
    case 'bank': {
      let matched = 0, amt = 0;
      p.rows.forEach((r, i) => {
        if (s(r.action) === 'match') {
          if (!s(r.shopId)) err(v, i, 'shopId', 'Pick the shop, or set Ignore');
          matched++; amt += n(r.credit);
        }
        if (s(r.action) === 'check') err(v, i, 'action', 'Unclear — pick the shop and Match, or Ignore');
      });
      v.summary = `${plural(matched, 'payment')} matched · ${inr(r2(amt))}`;
      break;
    }
    case 'order': {
      const shop = await db.shops.get(s(fieldValue(p, 'shopId')));
      if (!shop) { v.fieldErrors.shopId = 'Pick the shop'; }
      p.rows.forEach((r, i) => {
        if (!products.get(s(r.productId))) err(v, i, 'productId', 'Pick the product');
        if (!Number.isInteger(n(r.qty)) || n(r.qty) <= 0) err(v, i, 'qty', 'Whole pieces, more than 0');
        if (products.get(s(r.productId)) && !(n(r.rate) > 0)) err(v, i, 'rate', 'Rate must be more than 0');
      });
      if (shop && !Object.keys(v.errors).length) {
        const lines = p.rows.map(r => ({ productId: s(r.productId), qty: n(r.qty), rate: n(r.rate) }));
        const c = await checkOrder(shop, lines);
        v.warnings.push(...c.issues);
        const me = await db.staff.get(session().userId);
        // the owner's or office's own order goes straight to the godown; a salesman's waits for the owner
        const own = me?.role === 'owner' || me?.role === 'office';
        v.summary = `${plural(lines.length, 'item')} · about ${inr(c.total)} with GST · ` + (own ? 'your ✓ sends it to the godown for packing' : 'goes to the owner to approve');
      }
      break;
    }
    case 'payment': case 'paymentFix': {
      if (!s(fieldValue(p, 'shopId'))) v.fieldErrors.shopId = 'Pick the shop';
      const total = n(fieldValue(p, 'amount'));
      if (total <= 0) v.fieldErrors.amount = 'Amount missing';
      const mode = s(fieldValue(p, 'mode'));
      if ((mode === 'upi' || mode === 'cheque') && !s(fieldValue(p, 'ref'))) v.warnings.push('Add the UPI / cheque number to match the bank later');
      const cd = mode === 'cheque' ? s(fieldValue(p, 'chequeDate')) : '';
      if (cd && !toIsoDate(cd)) v.fieldErrors.chequeDate = 'Cheque date looks wrong';
      const postDated = cd && toIsoDate(cd) && toIsoDate(cd)! > today() ? toIsoDate(cd)! : '';
      if (p.kind === 'payment' && total > 0 && s(fieldValue(p, 'shopId'))) { const big = await collectionCheck(s(fieldValue(p, 'shopId')), total); if (big) v.warnings.push(big); }
      let alloc = 0;
      p.rows.forEach((r, i) => {
        if (n(r.pay) > n(r.balance) + 0.5) err(v, i, 'pay', `More than balance ${inr(r.balance)}`);
        alloc += n(r.pay);
      });
      if (alloc > total + 0.5) v.fieldErrors.amount = `Bills add up to ${inr(r2(alloc))}, more than amount`;
      const extra = r2(total - alloc);
      v.summary = `${inr(total)} · to bills ${inr(r2(alloc))}` + (extra > 0.5 ? ` · ${inr(extra)} kept as advance` : '') + (postDated ? ` · cheque to clear on ${showDate(postDated)}: the bills stay open until then` : '');
      break;
    }
    case 'claim': {
      p.rows.forEach((r, i) => {
        if (!products.get(s(r.productId))) err(v, i, 'productId', 'Pick the product');
        if (!Number.isInteger(n(r.qty)) || n(r.qty) <= 0) err(v, i, 'qty', 'Whole pieces, more than 0');
      });
      // the stock is checked before the line can become a request (an owner ✓ on pieces that are not there would fail)
      {
        const want = new Map<string, number>();
        p.rows.forEach((r, i) => { if (s(r.fromStock) !== 'no' && products.get(s(r.productId)) && n(r.qty) > 0) want.set(s(r.productId), (want.get(s(r.productId)) ?? 0) + n(r.qty)); void i; });
        for (const [pid, q] of want) {
          const have = (await db.batches.where('productId').equals(pid).toArray()).reduce((a, b) => a + b.qty, 0); // expired lots too: an expiry claim writes those off
          if (q > have) p.rows.forEach((r, i) => { if (s(r.productId) === pid && s(r.fromStock) !== 'no' && !v.errors[i]?.qty) err(v, i, 'qty', `Only ${have} pcs in stock`); });
        }
      }
      v.summary = `${plural(p.rows.length, 'line')} · ${inr(r2(p.rows.reduce((a, r) => a + n(r.amount), 0)))}`;
      const wo = await needsRequest('damage', await damageValue(damageRows(p)));
      if (wo.request) v.summary += ' · above the write-off limit: sent to the owner to approve';
      break;
    }
    case 'openingDues': await validateOpeningDues(p, v); break;
    case 'openingStock': await validateOpeningStock(p, v); break;
    case 'return': {
      const shopId = s(fieldValue(p, 'shopId'));
      if (!shopId) v.fieldErrors.shopId = 'Pick the shop';
      const chk = await checkReturn(p);
      for (const e of chk.errors) err(v, e.row, e.key, e.msg);
      v.warnings.push(...chk.warnings);
      const asked = await needsRequest('return', chk.total);
      v.summary = asked.request
        ? `Return ${inr(chk.total)} → sent to the ${asked.ownerOnly ? 'owner' : 'owner or office'} to approve; the credit note is made on their phone`
        : `Credit note ${inr(chk.total)} (the bill's own value of these pieces, with GST)`;
      break;
    }
    case 'products': {
      p.rows.forEach((r, i) => {
        if (!s(r.name)) err(v, i, 'name', 'Name missing');
        if (!s(r.companyId) && !s(r.companyName)) err(v, i, 'companyId', 'Pick company');
        if (n(r.rate) <= 0) err(v, i, 'rate', 'Selling rate missing');
        if (!GST_RATES.includes(n(r.gst))) err(v, i, 'gst', `GST % should be ${GST_RATES.join('/')}`);
        if (!/^\d{4,8}$/.test(s(r.hsn))) err(v, i, 'hsn', 'HSN should be 4–8 digits');
        else if (!/^(\d{6}|\d{8})$/.test(s(r.hsn))) v.warnings.push(`Row ${i + 1}: e-invoice needs a 6 or 8 digit HSN`);
      });
      v.summary = `${plural(p.rows.length, 'product')}`;
      break;
    }
    case 'schemes': {
      p.rows.forEach((r, i) => {
        if (!s(r.companyId) && !s(r.companyName)) err(v, i, 'companyId', 'Pick company');
        if (!s(r.name)) err(v, i, 'name', 'Give the scheme a name');
        if (s(r.type) === 'pct' && (n(r.value) <= 0 || n(r.value) > 50)) err(v, i, 'value', '% between 0 and 50');
        if (s(r.type) === 'free' && (n(r.buyQty) <= 0 || n(r.freeQty) <= 0)) err(v, i, 'buyQty', 'Buy and free quantities needed');
        if (!s(r.from) || !s(r.to) || s(r.from) > s(r.to)) err(v, i, 'to', 'End date must be after start date');
      });
      v.summary = `${plural(p.rows.length, 'scheme')} — applied automatically on every bill in these dates`;
      break;
    }
    case 'shops':
    case 'newshop': {
      p.rows.forEach((r, i) => {
        if (!s(r.name)) err(v, i, 'name', 'Name missing');
        if (s(r.gstin) && !validGstin(s(r.gstin).toUpperCase())) err(v, i, 'gstin', 'GSTIN looks wrong');
        if (s(r.phone) && !/^[6-9]\d{9}$/.test(s(r.phone).replace(/\D/g, '').slice(-10))) err(v, i, 'phone', '10-digit mobile number');
      });
      v.summary = `${plural(p.rows.length, 'shop')}`;
      break;
    }
    case 'orderEdit': {
      const seen = new Set<string>();
      p.rows.forEach((r, i) => {
        if (!products.get(s(r.productId))) err(v, i, 'productId', 'Pick the product');
        else if (seen.has(s(r.productId))) err(v, i, 'productId', 'This product is already in the order');
        seen.add(s(r.productId));
        if (n(r.qty) < 0 || !Number.isInteger(n(r.qty))) err(v, i, 'qty', 'Whole pieces, 0 or more (0 removes it)');
        if (n(r.qty) > 0 && n(r.rate) <= 0) err(v, i, 'rate', 'Rate missing');
      });
      const keep = p.rows.filter(r => n(r.qty) > 0);
      if (!keep.length && !Object.keys(v.errors).length) v.fieldErrors.shopId = 'Every item is 0 — say "cancel the order" instead';
      const order = await db.orders.get(String(p.meta.orderId ?? ''));
      if (order && keep.length) {
        const shop = await db.shops.get(order.shopId);
        if (shop) v.warnings.push(...(await checkOrder(shop, keep.map(r => ({ productId: s(r.productId), qty: n(r.qty), rate: n(r.rate) })))).issues);
      }
      const changed = p.rows.filter(r => n(r.qty) !== n(r.was)).length;
      v.summary = `${plural(keep.length, 'item')} · ${changed} changed · about ${inr(r2(keep.reduce((a, r) => a + n(r.amount), 0)))} with GST`;
      break;
    }
    case 'orderCancel': {
      if (!s(fieldValue(p, 'reason'))) v.fieldErrors.reason = 'Say why';
      v.summary = `The whole order (${p.rows.length} item${p.rows.length > 1 ? 's' : ''}) will be cancelled`;
      break;
    }
    case 'billCancel': {
      if (!s(fieldValue(p, 'reason'))) v.fieldErrors.reason = 'A reason is needed to cancel a bill';
      const inv = await db.invoices.get(String(p.meta.invoiceId ?? ''));
      if (!inv || inv.cancelled) v.fieldErrors.number = 'This bill is already cancelled';
      else {
        const paid = (await db.payments.where('shopId').equals(inv.shopId).toArray()).filter(x => x.status === 'ok').reduce((a, x) => a + x.allocations.filter(al => al.invoiceId === inv.id).reduce((b, al) => b + al.amount, 0), 0);
        if (paid > 0.5) v.warnings.push(`${inr(r2(paid))} already paid against this bill will stay with the shop as advance`);
        // a delivered bill (or one already in the GST return) can't be cancelled: say so now, before the tick, not after it
        const block = billChangeBlock(inv, 'cancel', today());
        if (block) v.fieldErrors.number = `${block.replace(/^Bill \S+ is already delivered\./, 'Delivered —')}`;
      }
      v.summary = `Bill ${s(fieldValue(p, 'number'))} · ${inr(n(fieldValue(p, 'total')))} will be cancelled and its stock put back`;
      break;
    }
    case 'paymentCancel': {
      if (!s(fieldValue(p, 'reason'))) v.fieldErrors.reason = 'Say why';
      v.summary = `${inr(n(fieldValue(p, 'amount')))} payment will be cancelled · its bills open again`;
      break;
    }
    case 'expenseFix': {
      const del = s(fieldValue(p, 'action')) === 'delete';
      p.rows.forEach((r, i) => {
        if (del) return;
        if (n(r.amount) <= 0) err(v, i, 'amount', 'Amount missing (or pick "Delete it")');
        if (!s(r.category)) err(v, i, 'category', 'Pick a category');
        if (!toIsoDate(s(r.date))) err(v, i, 'date', 'Date missing');
      });
      v.summary = del ? `${inr(n(fieldValue(p, 'was')))} expense deleted` : `${inr(n(fieldValue(p, 'was')))} → ${inr(n(p.rows[0]?.amount))}`;
      break;
    }
    case 'stockFix': {
      if (!s(fieldValue(p, 'reason'))) v.fieldErrors.reason = 'Give a reason for the difference';
      let sys = 0, cnt = 0;
      p.rows.forEach((r, i) => {
        if (!Number.isInteger(n(r.counted)) || n(r.counted) < 0 || s(r.counted) === '') err(v, i, 'counted', 'Whole pieces, 0 or more');
        sys += n(r.system); cnt += n(r.counted);
      });
      const prod = products.get(s(fieldValue(p, 'productId')));
      const d = cnt - sys;
      // a count more than 1 case off the system is typed a second time before Approve (a slip must not wipe stock)
      const retype = stockRetype(p, prod?.caseSize ?? 1, d, cnt);
      if (retype) { if (p.fields.some(f => f.key === 'again')) v.fieldErrors.again = retype; else err(v, 0, 'counted', retype); }
      if (prod && Math.abs(d) > prod.caseSize * 5) v.warnings.push(`Big difference: ${d > 0 ? '+' : ''}${d} pcs (${r2(Math.abs(d) / prod.caseSize)} cases). Count again before saving.`);
      v.summary = `System ${sys} → counted ${cnt} (${d >= 0 ? '+' : ''}${d} pcs${prod && Number.isFinite(prod.purchaseRate) ? ` · ${inr(r2(Math.abs(d) * prod.purchaseRate))}` : ''})`;
      if ((await needsRequest('count', await countValue(countRows(p)))).request) v.summary += ' · above the write-off limit: sent to the owner to approve';
      break;
    }
    case 'leave': {
      const who = await db.staff.get(s(fieldValue(p, 'staffId')));
      if (!who) v.fieldErrors.staffId = 'Pick the person';
      const r = p.rows[0] ?? {};
      const from = toIsoDate(s(r.from)), to = toIsoDate(s(r.to)) || from;
      if (!from) err(v, 0, 'from', 'Pick the day');
      if (from && to < from) err(v, 0, 'to', 'Ends before it starts');
      if (from && to >= from) { const days = Math.round((Date.parse(`${to}T12:00:00`) - Date.parse(`${from}T12:00:00`)) / 86400000) + 1; v.summary = `${who?.name.split(' ')[0] ?? ''}: leave ${showDay(from)}${to !== from ? ` to ${showDay(to)}` : ''} · ${plural(days, 'day')}${p.meta.status === 'waiting' ? ' · goes to the owner' : ''}`; }
      break;
    }
    case 'advance': {
      const who = await db.staff.get(s(fieldValue(p, 'staffId')));
      if (!who) v.fieldErrors.staffId = 'Pick the person';
      const amt = n(p.rows[0]?.amount);
      if (!(amt > 0)) err(v, 0, 'amount', 'Amount must be more than 0');
      else if (amt !== Math.round(amt * 100) / 100) err(v, 0, 'amount', 'Rupees and paise only');
      if (who && amt > 0) v.summary = `Advance ${inr(amt)} ${p.meta.status === 'waiting' ? '· goes to the owner' : `to ${who.name.split(' ')[0]} · recovered from the next salary`}`;
      break;
    }
    case 'visit': {
      const shop = await db.shops.get(s(fieldValue(p, 'shopId')));
      if (!shop) v.fieldErrors.shopId = 'Pick the shop';
      if (!NO_ORDER_REASONS.includes(s(fieldValue(p, 'reason')))) v.fieldErrors.reason = 'Pick why there was no order';
      if (shop) v.summary = `${shop.name}: no order · ${s(fieldValue(p, 'reason'))}`;
      break;
    }
    case 'productEdit': {
      const prod = products.get(s(fieldValue(p, 'productId')));
      if (!prod) v.fieldErrors.productId = 'Pick the product';
      const get = (k: string, d: number) => { const r = p.rows.find(x => s(x.key) === k); return r ? n(r.value) : d; };
      p.rows.forEach((r, i) => {
        const k = s(r.key), val = n(r.value);
        if (k === 'gst') { if (!GST_RATES.includes(val)) err(v, i, 'value', `GST % should be ${GST_RATES.join('/')}`); return; }
        if (val <= 0) err(v, i, 'value', 'Must be more than 0');
        if (k === 'caseSize' && !Number.isInteger(val)) err(v, i, 'value', 'Whole pieces');
      });
      if (prod) {
        const rate = get('rate', prod.rate), mrp = get('mrp', prod.mrp), buy = get('purchaseRate', prod.purchaseRate);
        const ri = p.rows.findIndex(x => s(x.key) === 'rate' || s(x.key) === 'mrp');
        if (mrp > 0 && rate * (1 + prod.gst / 100) > mrp + 0.01 && ri >= 0) err(v, ri, 'value', `Selling rate with GST (${inr(r2(rate * (1 + prod.gst / 100)))}) is above MRP ${inr(mrp)}`);
        if (buy > rate) v.warnings.push(`Buying rate ${inr(buy)} is above selling rate ${inr(rate)}: every sale loses money`);
        if (p.rows.some(x => s(x.key) === 'mrp')) v.warnings.push('Lots already in stock keep the MRP printed on them');
      }
      v.summary = p.rows.map(r => `${r.field} ${r.was} → ${r.value}`).join(' · ');
      break;
    }
    case 'shopEdit': {
      p.rows.forEach((r, i) => {
        const k = s(r.key), val = s(r.value);
        if (k === 'phone' && !/^[6-9]\d{9}$/.test(val.replace(/\D/g, '').slice(-10))) err(v, i, 'value', '10-digit mobile number');
        if (k === 'gstin' && val && !validGstin(val.toUpperCase())) err(v, i, 'value', 'GSTIN looks wrong');
        if (k === 'creditLimit' && (!(Number(val) >= 0) || val === '')) err(v, i, 'value', 'Amount, 0 or more');
        if (k === 'creditDays' && !(Number.isInteger(Number(val)) && Number(val) >= 0 && Number(val) <= 365)) err(v, i, 'value', 'Days between 0 and 365');
        if (k === 'cashOnly' && !['yes', 'no'].includes(val)) err(v, i, 'value', 'yes or no');
        if (k === 'beat' && !['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].includes(val)) err(v, i, 'value', 'A day of the week');
        if ((k === 'name' || k === 'address' || k === 'owner' || k === 'area') && !val) err(v, i, 'value', 'Empty');
      });
      v.summary = p.rows.map(r => `${r.field}: ${r.was || '—'} → ${r.value}`).join(' · ');
      break;
    }
    case 'undo': {
      v.summary = `${plural(p.rows.length, 'change')} will be put back`;
      break;
    }
    default:
      break;
  }
  return v;
}

export const hasErrors = (v: Validation) => Object.keys(v.errors).length > 0 || Object.keys(v.fieldErrors).length > 0;

// ---------------------------------------------------------------------------------------------
// COMMIT — the only place data is written. One ChangeSet = one undo.
// ---------------------------------------------------------------------------------------------
type Committed = { message: string; batchId: string; invoices?: Invoice[]; orderId?: string };
// a proposal is saved once: the same proposal (same id and same content) committed again — a double tap, a retry after a slow
// screen — is refused and writes nothing more. A save that failed is forgotten, so it can be tried again.
// kinds that already answer a second tap themselves (a visit is updated, a leave already there, "already loaded", "already cancelled" …)
const SELF_GUARDED = new Set<ProposalKind>(['visit', 'leave', 'openingDues', 'openingStock', 'undo', 'billCancel', 'paymentCancel', 'paymentFix', 'orderEdit', 'orderCancel', 'expenseFix', 'productEdit', 'shopEdit']);
const committing = new Map<string, Promise<Committed>>();
export function commit(p: Proposal): Promise<Committed> {
  const key = `${p.id}|${JSON.stringify([p.kind, p.fields.map(f => f.value), p.rows, p.meta])}`;
  if (committing.has(key) && !SELF_GUARDED.has(p.kind)) return Promise.reject(new Error('This was already saved.'));
  const run = commitProposal(p);
  committing.set(key, run);
  run.catch(() => { if (committing.get(key) === run) committing.delete(key); });
  return run;
}
async function commitProposal(p: Proposal): Promise<Committed> {
  if (p.kind === 'undo') {
    const k = await undoBatch(String(p.meta.batchId ?? ''));
    if (k === UNDO_SYNCED) throw new Error(UNDO_SYNCED_MSG);
    if (k < 0) throw new Error("Can't undo this: something changed after it (for example a later bill used the same stock). Change or cancel it instead.");
    if (k === 0) throw new Error('This was already undone.');
    return { message: `Undone: ${s(fieldValue(p, 'label'))} (${k} change${k > 1 ? 's' : ''} put back).`, batchId: '' };
  }
  if (p.kind === 'billCancel') {
    const batchId = await cancelInvoice(String(p.meta.invoiceId ?? ''), s(fieldValue(p, 'reason')));
    return { message: `Bill ${s(fieldValue(p, 'number'))} cancelled. Stock is back in the godown.`, batchId };
  }
  const cs = new ChangeSet();
  const products = new Map((await db.products.toArray()).map(x => [x.id, x]));
  let message = '';
  let invoices: Invoice[] | undefined;
  let orderId: string | undefined;
  switch (p.kind) {
    case 'fieldOrder': {
      const { placeFieldOrder } = await import('./field');
      const o = await placeFieldOrder(s(fieldValue(p, 'shopId')), p.rows.map(r => ({ productId: s(r.productId), qty: n(r.qty) })));
      const shop = await db.shops.get(o.shopId);
      // saved by placeFieldOrder in its own change set (one ✓ = one order)
      return { message: `Order for ${shop?.name ?? 'the shop'} sent to the distributor for billing.`, batchId: '', orderId: o.id };
    }
    case 'purchase': {
      const companyId = s(fieldValue(p, 'companyId'));
      const batches = await db.batches.toArray();
      const lines: Purchase['lines'] = [];
      for (const r of p.rows) {
        let prod = products.get(s(r.productId));
        if (s(r.productId) === '__new' || !prod) {
          prod = cs.put<Product>('products', {
            companyId, name: s(r.item) || 'New product', hsn: s(r.hsn), gst: n(r.gst), mrp: n(r.mrp),
            rate: r2(n(r.rate) * 1.06), purchaseRate: n(r.rate), caseSize: 1, aliases: [s(r.code)].filter(Boolean),
            code: s(r.code), active: true,
          }, 'new product from bill');
          products.set(prod.id, prod);
        } else {
          const upd = { ...prod, purchaseRate: n(r.rate) || prod.purchaseRate, mrp: n(r.mrp) || prod.mrp, hsn: prod.hsn || s(r.hsn) };
          if (s(r.code) && !prod.aliases.includes(s(r.code))) upd.aliases = [...prod.aliases, s(r.code)]; // learn supplier code
          if (s(r.item) && !prod.aliases.includes(s(r.item)) && s(r.item) !== prod.name) upd.aliases = [...upd.aliases, s(r.item)];
          cs.put('products', upd, 'rate/MRP from bill');
        }
        const qty = n(r.qty) + n(r.free);
        const expiry = toIsoDate(s(r.expiry));
        const existing = batches.find(b => b.productId === prod!.id && b.batch === s(r.batch));
        let lotId: string;
        if (existing) { existing.qty += qty; lotId = cs.put('batches', { ...existing }, 'stock in').id; }
        else lotId = cs.put<Batch>('batches', { productId: prod.id, batch: s(r.batch), expiry, mrp: n(r.mrp) || prod.mrp, qty, godown: 'Main' }, 'stock in').id;
        lines.push({ productId: prod.id, batch: s(r.batch), expiry, mrp: n(r.mrp), qty: n(r.qty), freeQty: n(r.free), rate: n(r.rate), discount: n(r.discount), gst: n(r.gst) || prod.gst, amount: n(r.amount), batchId: lotId });
      }
      const taxable = r2(lines.reduce((a, l) => a + l.qty * l.rate - l.discount, 0));
      const tax = r2(lines.reduce((a, l) => a + (l.qty * l.rate - l.discount) * l.gst / 100, 0));
      cs.put<Purchase>('purchases', {
        companyId, billNo: s(fieldValue(p, 'billNo')), date: toIsoDate(s(fieldValue(p, 'date'))) || today(),
        supplierGstin: s(fieldValue(p, 'supplierGstin')).toUpperCase(), lines, taxable, tax, total: r2(taxable + tax),
        source: (p.meta.source as Purchase['source']) ?? 'typed',
      }, 'purchase bill');
      message = `Stock updated: ${plural(lines.length, 'item')} added. Purchase bill ${s(fieldValue(p, 'billNo'))} saved.`;
      break;
    }
    case 'expense': {
      const company = (await getSettings()).kind === 'company'; // a field rep's expense waits for the month's claim
      for (const r of p.rows) {
        cs.put<Expense>('expenses', { by: session().userId, date: toIsoDate(s(r.date)) || today(), category: s(r.category), amount: n(r.amount), vanId: s(r.vanId) || undefined, note: s(r.note), photo: p.meta.photo as string | undefined, ...(company ? { status: 'waiting' as const } : {}) }, 'expense');
      }
      message = `Expense recorded: ${inr(r2(p.rows.reduce((a, r) => a + n(r.amount), 0)))}.`;
      break;
    }
    case 'bank': {
      const pays = await db.payments.toArray();
      let count = 0;
      for (const r of p.rows) {
        const action = s(r.action);
        const line = cs.put('bankLines', {
          date: s(r.date), narration: s(r.narration), credit: n(r.credit), debit: n(r.debit), ref: s(r.ref),
          shopId: s(r.shopId) || undefined, status: action === 'match' ? 'matched' : 'ignored', statement: String(p.meta.statement ?? ''),
        });
        if (action !== 'match' || !s(r.shopId)) continue;
        // link to a UPI/cheque payment already recorded by staff, else create a bank receipt
        const existing = pays.find(x => x.id === s(r.paymentId)) ??
          pays.find(x => x.shopId === s(r.shopId) && !x.bankLineId && x.mode !== 'cash' && Math.abs(x.amount - n(r.credit)) < 1);
        if (existing) {
          cs.put('payments', { ...existing, bankLineId: line.id, status: 'ok' }, 'matched to bank');
          cs.put('bankLines', { ...line, paymentId: existing.id }, 'link');
        } else {
          const { allocations, advance } = await allocateOldestFirst(s(r.shopId), n(r.credit));
          const pay = cs.put<Payment>('payments', {
            shopId: s(r.shopId), amount: n(r.credit), mode: 'bank', ref: s(r.ref), date: s(r.date), collectedBy: 'bank',
            shopConfirmed: true, allocations, advance, settled: true, bankLineId: line.id, status: 'ok',
          }, 'bank receipt');
          cs.put('bankLines', { ...line, paymentId: pay.id }, 'link');
        }
        count++;
      }
      message = `Bank statement saved. ${plural(count, 'payment')} matched and shop balances updated.`;
      break;
    }
    case 'order': {
      const shop = (await db.shops.get(s(fieldValue(p, 'shopId'))))!;
      const lines = p.rows.map(r => ({ productId: s(r.productId), qty: n(r.qty), rate: n(r.rate) }));
      // a salesman typing his order is his order (the owner is not asked how it came)
      const by = await db.staff.get(session().userId);
      // the owner's or office's own order is approved as it is booked: it goes straight to the godown. A salesman's waits.
      const own = by?.role === 'owner' || by?.role === 'office';
      const order = await bookOrder(cs, shop, lines, session().userId, { source: by?.role === 'salesman' ? 'salesman' : 'office', ...(own ? { status: 'approved' as const, approvedBy: session().userId, approvedAt: new Date().toISOString() } : {}) });
      orderId = order.id;
      message = own
        ? `Order for ${shop.name} approved and sent to the godown for packing. When it is packed, it waits in Bill → Picked for your ✓ to make the bill.` + (order.issues.length ? ` Note: ${order.issues.join('; ')}.` : '')
        : `Order for ${shop.name} sent to the owner to approve. Once approved, the godown packs it.` + (order.issues.length ? ` The owner will see: ${order.issues.join('; ')}.` : '');
      break;
    }
    case 'payment': {
      const allocations = p.rows.filter(r => n(r.pay) > 0).map(r => ({ invoiceId: s(r.invoiceId), amount: n(r.pay) }));
      const amount = n(fieldValue(p, 'amount'));
      const advance = r2(amount - allocations.reduce((a, x) => a + x.amount, 0));
      const me = await db.staff.get(session().userId);
      const inOffice = me?.role === 'owner' || me?.role === 'office';
      const receiptNo = await receiptNumber(cs);
      const isCheque = s(fieldValue(p, 'mode')) === 'cheque';
      cs.put<Payment>('payments', {
        shopId: s(fieldValue(p, 'shopId')), amount, mode: s(fieldValue(p, 'mode')) as Payment['mode'], ref: s(fieldValue(p, 'ref')),
        ...(isCheque ? { chequeDate: toIsoDate(s(fieldValue(p, 'chequeDate'))) || today(), ...(s(fieldValue(p, 'chequeBank')) ? { chequeBank: s(fieldValue(p, 'chequeBank')) } : {}) } : {}),
        date: today(), collectedBy: session().userId, shopConfirmed: inOffice || !!p.meta.shopConfirmed,
        confirmPhoto: p.meta.photo as string | undefined, allocations, advance: advance > 0.5 ? advance : 0,
        settled: inOffice, status: 'ok', receiptNo,
      }, 'payment');
      message = `Payment ${inr(amount)} recorded. Receipt ${isPendingNumber(receiptNo) ? '(numbered at next sync)' : receiptNo}.`;
      break;
    }
    case 'paymentFix': {
      // money records are never overwritten: the old payment is cancelled (kept for the audit) and a corrected one is made
      const old = await db.payments.get(String(p.meta.paymentId ?? ''));
      if (!old || old.status !== 'ok') throw new Error('That payment was already changed or cancelled.');
      const allocations = p.rows.filter(r => n(r.pay) > 0).map(r => ({ invoiceId: s(r.invoiceId), amount: n(r.pay) }));
      const amount = n(fieldValue(p, 'amount'));
      const advance = r2(amount - allocations.reduce((a, x) => a + x.amount, 0));
      cs.put<Payment>('payments', { ...old, status: 'cancelled', note: `corrected to ${inr(amount)}` }, 'payment corrected (old)');
      cs.put<Payment>('payments', {
        shopId: old.shopId, amount, mode: s(fieldValue(p, 'mode')) as Payment['mode'], ref: s(fieldValue(p, 'ref')), date: old.date,
        collectedBy: old.collectedBy, shopConfirmed: old.shopConfirmed, confirmPhoto: old.confirmPhoto, allocations,
        advance: advance > 0.5 ? advance : 0, settled: old.settled, status: 'ok', correctionOf: old.id, receiptNo: await receiptNumber(cs),
      }, 'payment corrected (new)');
      message = `Payment corrected: ${inr(old.amount)} → ${inr(amount)}.`;
      break;
    }
    case 'claim': {
      // a write-off above the owner's limit (godown, office) waits for the owner: nothing leaves stock until then
      const d = await damageOrRequest(cs, damageRows(p), p.meta.photo as string | undefined);
      message = d.requested ? `Damage write-off of about ${inr(d.value)} is above the limit: sent to the owner to approve. Stock changes when the owner approves.`
        : `Added to claim register for ${showMonth(today().slice(0, 7))}.`;
      break;
    }
    case 'openingDues': { const r = await commitOpeningDues(cs, p); message = r.message; break; }
    case 'openingStock': {
      const r = await commitOpeningStock(cs, p);
      const batchId = await cs.commit(p.title);
      p.meta.loaded = true; // a second ✓ on the same table loads nothing again
      return { message: r.message, batchId };
    }
    case 'return': {
      const chk = await checkReturn(p);
      if (chk.errors.length) throw new Error(chk.errors[0].msg);
      const rows = p.rows.map(r => ({ invoiceId: s(r.invoiceId), productId: s(r.productId), qty: n(r.qty), restock: s(r.restock) !== 'no' }));
      const reason = s(fieldValue(p, 'reason')) || 'Return';
      // salesman, godown, delivery (and office above the owner's limit): a request; the credit note is made on the
      // owner's or office's phone when they approve it, with a server number
      const asked = await needsRequest('return', chk.total);
      if (asked.request) {
        await makeRequest(cs, { kind: 'return', shopId: s(fieldValue(p, 'shopId')), reason, value: chk.total, rows: rows.map(r => ({ ...r, restock: r.restock ? 'yes' : 'no' })), ownerOnly: asked.ownerOnly });
        message = `Return of ${inr(chk.total)} sent to the ${asked.ownerOnly ? 'owner' : 'owner / office'} to approve. The shop's balance changes when it is approved.`;
        break;
      }
      // returned pieces come off the bill's lots (so a later cancel can't restock them again); good ones go back to stock;
      // the credit is the bill line's own value of those pieces, never a typed amount
      await applyReturn(cs, rows, reason);
      message = `Credit note made (${inr(chk.total)}). Shop balance reduced.`;
      break;
    }
    case 'products': {
      // companies named in the sheet but not on this phone yet: made once each (a new distributor starts with none)
      const cos = await db.companies.toArray();
      const made = new Map<string, string>();
      const taken = new Set(cos.map(c => c.code));
      const companyFor = (name: string) => {
        const k = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        const have = cos.find(c => c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === k)?.id ?? made.get(k);
        if (have) return have;
        const words = name.split(/\s+/).filter(w => /^[a-z]/i.test(w));
        let code = (words.length > 1 ? words.map(w => w[0]).join('') : name.replace(/[^a-z]/gi, '').slice(0, 3)).toUpperCase().slice(0, 4) || 'CO';
        for (let i = 2; taken.has(code); i++) code = code.replace(/\d+$/, '') + i;
        taken.add(code);
        const c = cs.put<Company>('companies', { name: name.trim(), code, gstin: '', nextBillNo: 1 }, 'company added from product sheet');
        made.set(k, c.id);
        return c.id;
      };
      for (const r of p.rows) {
        cs.put<Product>('products', {
          id: s(r.id) || undefined, companyId: s(r.companyId) || companyFor(s(r.companyName)), name: s(r.name), code: s(r.code), hsn: s(r.hsn), gst: n(r.gst),
          mrp: n(r.mrp), rate: n(r.rate), purchaseRate: n(r.purchaseRate), caseSize: n(r.caseSize) || 1,
          aliases: [s(r.code)].filter(Boolean), active: true,
        }, 'product');
      }
      message = `${plural(p.rows.length, 'product')} saved.`;
      break;
    }
    case 'schemes': {
      for (const r of p.rows) {
        cs.put('schemes', {
          companyId: s(r.companyId), productId: s(r.productId) || undefined, name: s(r.name), type: s(r.type) || 'pct',
          value: n(r.value), buyQty: n(r.buyQty) || undefined, freeQty: n(r.freeQty) || undefined,
          from: s(r.from), to: s(r.to), source: s(r.source) || 'company', combine: s(r.combine) || 'add',
        }, 'scheme');
      }
      message = `${plural(p.rows.length, 'scheme')} saved. They apply automatically and company schemes go into the monthly claim.`;
      break;
    }
    case 'shops':
    case 'newshop': {
      const me = await db.staff.get(session().userId);
      for (const r of p.rows) {
        const gstin = s(r.gstin).toUpperCase() || undefined;
        cs.put<Shop>('shops', {
          name: s(r.name), owner: s(r.owner), phone: s(r.phone), gstin, stateCode: shopStateCode({ gstin, stateCode: s(r.stateCode) || undefined }),
          area: s(r.area), beat: s(r.beat), creditLimit: n(r.creditLimit), creditDays: n(r.creditDays) || 7,
          // credit limit 0 = cash only until the owner sets a limit (owner decision, 11 Nov 2026)
          cashOnly: s(r.cashOnly) === 'yes' || !(n(r.creditLimit) > 0), type: (s(r.type) || 'retail') as Shop['type'],
          approved: me?.role === 'owner' || p.kind === 'shops', aliases: [], address: s(r.address),
          salesmanId: me?.role === 'salesman' ? me.id : undefined,
        }, 'shop');
      }
      message = p.kind === 'newshop' && me?.role !== 'owner'
        ? 'New shop saved. Owner must approve it before the first bill.'
        : `${plural(p.rows.length, 'shop')} saved.`;
      break;
    }
    case 'orderEdit': case 'orderCancel': {
      const orderIdIn = String(p.meta.orderId ?? '');
      const shopName = (await db.shops.get(s(fieldValue(p, 'shopId'))))?.name ?? '';
      if (p.kind === 'orderCancel') { await changeOrder(cs, orderIdIn, null, s(fieldValue(p, 'reason'))); message = `${shopName}'s order cancelled.`; break; }
      const o = await db.orders.get(orderIdIn);
      const lines = p.rows.map(r => {
        const old = o?.lines.find(l => l.productId === s(r.productId));
        return { ...(old ?? {}), productId: s(r.productId), qty: n(r.qty), rate: n(r.rate) };
      });
      await changeOrder(cs, orderIdIn, lines);
      orderId = orderIdIn;
      message = `${shopName}'s order changed.`;
      break;
    }
    case 'paymentCancel': {
      const old = await db.payments.get(String(p.meta.paymentId ?? ''));
      if (!old || old.status !== 'ok') throw new Error('That payment was already changed or cancelled.');
      if (old.bankLineId) throw new Error('This payment is matched to the bank statement. Unmatch it in Accounts → Bank first.');
      cs.put<Payment>('payments', { ...old, status: 'cancelled', note: s(fieldValue(p, 'reason')) }, 'payment cancelled');
      message = `Payment ${inr(old.amount)} cancelled. The bills are open again.`;
      break;
    }
    case 'expenseFix': {
      const old = await db.expenses.get(String(p.meta.expenseId ?? ''));
      if (!old) throw new Error('That expense is not there any more.');
      const r = p.rows[0];
      if (s(fieldValue(p, 'action')) === 'delete') {
        cs.put<Expense>('expenses', { ...old, amount: 0, note: `Deleted (was ${inr(old.amount)})${old.note ? ` · ${old.note}` : ''}` }, 'expense deleted');
        message = `Expense ${inr(old.amount)} deleted.`;
      } else {
        cs.put<Expense>('expenses', { ...old, date: toIsoDate(s(r.date)) || old.date, category: s(r.category), amount: n(r.amount), vanId: s(r.vanId) || undefined, note: s(r.note) }, 'expense corrected');
        message = `Expense corrected: ${inr(old.amount)} → ${inr(n(r.amount))}.`;
      }
      break;
    }
    case 'stockFix': {
      // a count more than 1 case off the system must be typed again (r4) before it is saved or sent to the owner (r3)
      { const prod = products.get(s(fieldValue(p, 'productId'))); const c0 = p.rows.reduce((a, r) => a + n(r.counted), 0), s0 = p.rows.reduce((a, r) => a + n(r.system), 0); const rt = stockRetype(p, prod?.caseSize ?? 1, c0 - s0, c0); if (rt) throw new Error(rt); }
      const c = await countOrRequest(cs, countRows(p), s(fieldValue(p, 'reason')));
      message = c.requested ? `Count writes off about ${inr(c.value)} — above the limit: sent to the owner to approve. Stock changes when the owner approves.`
        : `Stock count saved: ${c.sys} → ${c.cnt} pcs.`;
      break;
    }
    case 'leave': {
      const staffId = s(fieldValue(p, 'staffId')); const who = await db.staff.get(staffId);
      if (!who) throw new Error('Pick the person.');
      const r = p.rows[0] ?? {}; const from = toIsoDate(s(r.from)); const to = toIsoDate(s(r.to)) || from;
      if (!from || to < from) throw new Error('Pick the day of the leave.');
      const status = p.meta.status === 'waiting' ? 'waiting' : 'approved';
      // a second tap (or the same leave said twice) saves nothing more
      if ((await db.leaves.where('staffId').equals(staffId).toArray()).some(l => l.status !== 'rejected' && l.from === from && l.to === to)) throw new Error(`${who.name.split(' ')[0]}'s leave on ${showDay(from)} is already there.`);
      const reason = s(fieldValue(p, 'reason')) || 'personal';
      cs.put<LeaveRequest>('leaves', { staffId, from, to, reason, status }, 'leave');
      const when = `${showDay(from)}${to !== from ? ` to ${showDay(to)}` : ''}`;
      message = status === 'waiting' ? `Leave request ${when} (${reason}) sent to the owner.` : `${who.name.split(' ')[0]}: leave ${when} recorded (${reason}).`;
      break;
    }
    case 'advance': {
      const who = await db.staff.get(s(fieldValue(p, 'staffId')));
      if (!who) throw new Error('Pick the person.');
      const amount = n(p.rows[0]?.amount);
      if (!(amount > 0)) throw new Error('Amount must be more than 0.');
      const waiting = p.meta.status === 'waiting';
      cs.put<Advance>('advances', { staffId: who.id, amount, reason: s(fieldValue(p, 'reason')), status: waiting ? 'waiting' : 'approved', instalments: 1, recovered: 0 }, 'advance');
      if (!waiting) cs.put('expenses', { date: today(), category: 'advance', amount, note: `Advance to ${who.name}` }, 'advance paid');
      message = waiting ? `Advance request ${inr(amount)} sent to the owner.` : `Advance ${inr(amount)} to ${who.name.split(' ')[0]} recorded; recovered from next salary.`;
      break;
    }
    case 'visit': {
      // one visit per shop, per person, per day: a second tap (or saying it twice) updates the same visit
      const shopId = s(fieldValue(p, 'shopId'));
      const shop = await db.shops.get(shopId);
      if (!shop) throw new Error('Pick the shop.');
      const reason = s(fieldValue(p, 'reason'));
      if (!NO_ORDER_REASONS.includes(reason)) throw new Error('Pick why there was no order.');
      const me = session().userId;
      const cur = (await db.visits.where('date').equals(today()).toArray()).find(v => v.staffId === me && v.shopId === shopId);
      if (cur?.outcome === 'order') throw new Error(`${shop.name} already has an order from you today.`);
      cs.put<Visit>('visits', { ...(cur ?? { shopId, staffId: me, date: today(), at: nowIso() }), outcome: 'no_order', reason } as Visit, cur ? 'visit updated' : 'visit');
      message = `${shop.name}: visit saved — no order (${reason.toLowerCase()}).`;
      break;
    }
    case 'productEdit': {
      const prod = products.get(s(fieldValue(p, 'productId')));
      if (!prod) throw new Error('Product not found.');
      const upd: Product = { ...prod };
      for (const r of p.rows) (upd as unknown as Record<string, number>)[s(r.key)] = n(r.value);
      cs.put<Product>('products', upd, 'product changed');
      message = `${prod.name} updated.`;
      break;
    }
    case 'shopEdit': {
      const shop = await db.shops.get(s(fieldValue(p, 'shopId')));
      if (!shop) throw new Error('Shop not found.');
      const upd: Shop = { ...shop };
      for (const r of p.rows) {
        const k = s(r.key), val = s(r.value);
        if (k === 'cashOnly') upd.cashOnly = val === 'yes';
        else if (k === 'creditLimit' || k === 'creditDays') (upd as unknown as Record<string, number>)[k] = Number(val);
        else if (k === 'phone') upd.phone = val.replace(/\D/g, '').slice(-10);
        else if (k === 'gstin') upd.gstin = val.toUpperCase() || undefined;
        else (upd as unknown as Record<string, string>)[k] = val;
      }
      // a credit limit decides cash-only unless cash-only was set in the same change
      if (p.rows.some(r => s(r.key) === 'creditLimit') && !p.rows.some(r => s(r.key) === 'cashOnly')) upd.cashOnly = !(upd.creditLimit > 0);
      if (p.rows.some(r => s(r.key) === 'gstin' || s(r.key) === 'stateCode')) upd.stateCode = shopStateCode(upd);
      cs.put<Shop>('shops', upd, 'shop details changed');
      message = `${upd.name} updated.`;
      break;
    }
    default:
      throw new Error('Nothing to approve');
  }
  const batchId = await cs.commit(p.title);
  return { message, batchId, invoices, orderId };
}

export async function balancesForShop(shopId: string) {
  return (await invoiceBalances(shopId)).filter(b => b.balance > 0.5);
}

/**
 * A shop return, checked against its bill: pieces never more than billed minus already returned, credit = the bill line's
 * own value (taxable + GST) of those pieces (a typed amount can only match it), and above the owner's limit only the
 * owner can make it — on any other phone nothing is saved. Also the 30 November GST date for last year's bills.
 */
async function checkReturn(p: Proposal) {
  const errors: { row: number; key: string; msg: string }[] = []; const warnings: string[] = [];
  const shopId = s(fieldValue(p, 'shopId'));
  const byInv = new Map<string, { rows: number[]; items: { productId: string; paid: number; free: number; restock: boolean }[] }>();
  p.rows.forEach((r, i) => {
    if (!s(r.productId)) errors.push({ row: i, key: 'productId', msg: 'Pick the product' });
    if (!Number.isInteger(n(r.qty)) || n(r.qty) <= 0) errors.push({ row: i, key: 'qty', msg: 'Whole pieces, more than 0' });
    if (!s(r.invoiceId)) errors.push({ row: i, key: 'invoiceId', msg: 'No bill found for this item at this shop' });
    const g = byInv.get(s(r.invoiceId)) ?? { rows: [], items: [] }; g.rows.push(i); g.items.push({ productId: s(r.productId), paid: Math.max(0, n(r.qty)), free: 0, restock: s(r.restock) !== 'no' }); byInv.set(s(r.invoiceId), g);
  });
  let total = 0;
  for (const [invoiceId, g] of byInv) {
    if (!invoiceId) continue;
    const inv = await db.invoices.get(invoiceId);
    if (!inv || inv.shopId !== shopId || inv.cancelled) { for (const i of g.rows) errors.push({ row: i, key: 'invoiceId', msg: inv?.cancelled ? 'That bill is cancelled' : 'Not a bill of this shop' }); continue; }
    const cns = await db.creditNotes.where('invoiceId').equals(invoiceId).toArray();
    const asked = new Map<string, number>();
    g.items.forEach((it, k) => {
      asked.set(it.productId, (asked.get(it.productId) ?? 0) + it.paid);
      const left = openPaid(inv, cns, it.productId);
      if ((asked.get(it.productId) ?? 0) > left) errors.push({ row: g.rows[k], key: 'qty', msg: `Only ${left} pcs left on bill ${inv.number} (billed minus already returned)` });
    });
    try {
      const built = buildCreditNote(inv, cns, g.items);
      total = r2(total + built.total);
      // a typed amount can never be more than the bill's own value of these pieces
      g.rows.forEach((i, k) => { const r = p.rows[i]; const v = built.lines.filter(l => l.productId === g.items[k].productId).reduce((a, l) => a + l.amount, 0); if (n(r.amount) > r2(v) + 0.51) errors.push({ row: i, key: 'amount', msg: `Most is ${inr(r2(v))} for these pieces` }); });
    } catch { /* the qty error above says why */ }
    const deadline = creditNoteDeadline(inv.date);
    if (today() > deadline) warnings.push(`Bill ${inv.number} is from an earlier GST year: after ${deadline} a credit note no longer reduces GST (s.34(2)). The shop's account is still credited.`);
    else if (today() >= `${deadline.slice(0, 4)}-10-01`) warnings.push(`Bill ${inv.number}: make this credit note before ${deadline} for it to reduce GST (s.34(2)).`);
  }
  return { errors, warnings, total };
}

/** the damage table's rows as write-off lines */
function damageRows(p: Proposal): DamageRow[] {
  return p.rows.map(r => ({ productId: s(r.productId), qty: n(r.qty), kind: s(r.kind) || 'damage', fromStock: s(r.fromStock) !== 'no', note: s(r.note), amount: n(r.amount) }));
}
/** the count table's rows (the product comes with the table's header) */
function countRows(p: Proposal): CountRow[] {
  const productId = s(fieldValue(p, 'productId')) || undefined;
  return p.rows.map(r => ({ batchId: s(r.batchId), productId, system: n(r.system), counted: n(r.counted) }));
}
