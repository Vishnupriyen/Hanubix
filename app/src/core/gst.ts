// GST rules in one place: the shop's state, how tax is split, and when a bill may still be changed.
// Pure functions only (no screens, no saves) so billing, printing, GSTR-1 and the tests all use the same answer.
import { showDate, showMonth } from './i18n';
import { r2, validGstin } from './ledger';
import type { CreditNote, Invoice, Settings, Shop } from './types';

export const STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};
export const stateName = (code: string) => STATES[code] ?? 'Tamil Nadu';
/** "33-Tamil Nadu": the place-of-supply form GSTR-1 and the printed bill use */
export const stateLabel = (code: string) => `${code}-${stateName(code)}`;
export const DEFAULT_STATE = '33';
/** GST rates in force (12% and 28% were removed in Sept 2025) */
export const GST_RATES = [0, 0.25, 3, 5, 18, 40];
/** unit of quantity printed on bills and filed in GSTR-1 (a product without its own unit) */
export const UQC = 'PCS';
/** GSTR-1 writes the unit as CODE-NAME (the GST portal's UQC list); a code not in this list is filed as it is */
const UQC_NAMES: Record<string, string> = { PCS: 'PIECES', NOS: 'NUMBERS', KGS: 'KILOGRAMS', GMS: 'GRAMMES', LTR: 'LITRES', MLT: 'MILILITRE', BOX: 'BOX',
  BTL: 'BOTTLES', CTN: 'CARTONS', PAC: 'PACKS', DOZ: 'DOZENS', BAG: 'BAGS', TIN: 'TINS', SET: 'SETS', ROL: 'ROLLS', TBS: 'TABLETS', UNT: 'UNITS', OTH: 'OTHERS' };
export const uqcLabel = (code: string) => { const c = (code || UQC).toUpperCase(); return UQC_NAMES[c] ? `${c}-${UQC_NAMES[c]}` : c; };

/** the shop's state: from its GSTIN when it has one, else the state chosen on the shop form, else Tamil Nadu */
export function shopStateCode(shop: Pick<Shop, 'gstin' | 'stateCode'> | undefined, _settings?: Pick<Settings, 'stateCode'>): string {
  const g = shop?.gstin?.trim().toUpperCase();
  if (g && /^\d{2}/.test(g) && STATES[g.slice(0, 2)]) return g.slice(0, 2);
  if (shop?.stateCode && STATES[shop.stateCode]) return shop.stateCode;
  return DEFAULT_STATE;
}
export const isInterState = (shop: Parameters<typeof shopStateCode>[0], settings: Pick<Settings, 'stateCode'>) => shopStateCode(shop, settings) !== (settings.stateCode || DEFAULT_STATE);
/** a registered shop (a real GSTIN) gets a B2B bill */
export const isRegistered = (shop?: { gstin?: string }) => !!shop?.gstin && validGstin(shop.gstin.trim().toUpperCase());

/** tax on a taxable value: CGST and SGST each at half the rate (never one derived from the other), or IGST at the full rate */
export function taxOn(taxable: number, gst: number, inter: boolean) {
  if (inter) return { cgst: 0, sgst: 0, igst: r2(taxable * gst / 100) };
  const half = r2(taxable * gst / 200);
  return { cgst: half, sgst: half, igst: 0 };
}
/** a bill is inter-state when it carries IGST, or when its shop is in another state */
export const billIsInter = (inv: Pick<Invoice, 'igst' | 'cgst' | 'sgst'>, fallback = false) => inv.igst > 0 ? true : inv.cgst > 0 || inv.sgst > 0 ? false : fallback;

/** GSTR-1 for a month is due on the 11th of the next month; after that the month's bills are filed and fixed */
export function gstr1Due(billDate: string) {
  const [y, m] = billDate.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-11`;
}
/** credit notes for a financial year's bills reduce GST only if issued by 30 November after that year ends (s.34(2)) */
export function creditNoteDeadline(billDate: string) {
  const [y, m] = billDate.split('-').map(Number);
  return `${m >= 4 ? y + 1 : y}-11-30`;
}

/**
 * Why a bill can't be cancelled or edited now, or null if it can. Once the goods are supplied (delivered) or the month's
 * GSTR-1 is due, the bill is a filed tax document: less goes on a credit note, extra goes on a new bill.
 * A printed bill may still be cancelled (with a reason) before delivery, but never edited.
 */
export function billChangeBlock(inv: Invoice, action: 'cancel' | 'edit', now: string): string | null {
  if (inv.cancelled) return 'This bill is already cancelled.';
  if (['delivered', 'partial', 'returned'].includes(inv.deliveryStatus))
    return `Bill ${inv.number} is already delivered. Make a credit note for anything less, or a new bill for anything extra.`;
  const due = gstr1Due(inv.date);
  if (now > due) return `Bill ${inv.number} is already in the GST return for ${showMonth(inv.date.slice(0, 7))} (due ${showDate(due)}). Make a credit note for anything less, or a new bill for anything extra.`;
  if (action === 'edit' && inv.printedAt) return `Bill ${inv.number} is already printed. Cancel it with a reason, or make a credit note.`;
  return null;
}

export interface LineCredit { paid: number; free: number; taxable: number; cgst: number; sgst: number; igst: number; amount: number }
/**
 * What each bill line has already been credited, from the bill's credit notes: paid pieces, free pieces and money.
 * Old credit notes (before tax lines were stored) are read the old way: pieces beyond the paid ones were free, and the
 * money is split into taxable and tax in the line's own proportion.
 */
export function lineCredits(inv: Pick<Invoice, 'lines'>, cns: Pick<CreditNote, 'lines'>[]): LineCredit[] {
  const out: LineCredit[] = inv.lines.map(() => ({ paid: 0, free: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, amount: 0 }));
  for (const c of cns) for (const cl of c.lines) {
    let i = cl.line != null && inv.lines[cl.line]?.productId === cl.productId ? cl.line : inv.lines.findIndex((l, k) => l.productId === cl.productId && out[k].paid < l.qty);
    if (i < 0) i = inv.lines.findIndex(l => l.productId === cl.productId);
    if (i < 0) continue;
    const l = inv.lines[i], o = out[i];
    const legacy = cl.taxable == null;
    const paid = legacy ? Math.min(cl.qty, Math.max(0, l.qty - o.paid)) : cl.qty;
    o.paid += paid;
    o.free += (cl.freeQty ?? 0) + (legacy ? cl.qty - paid : 0);
    if (legacy) {
      const f = l.total ? cl.amount / l.total : 0;
      o.taxable = r2(o.taxable + l.taxable * f); o.cgst = r2(o.cgst + l.cgst * f); o.sgst = r2(o.sgst + l.sgst * f); o.igst = r2(o.igst + l.igst * f);
    } else { o.taxable = r2(o.taxable + (cl.taxable ?? 0)); o.cgst = r2(o.cgst + (cl.cgst ?? 0)); o.sgst = r2(o.sgst + (cl.sgst ?? 0)); o.igst = r2(o.igst + (cl.igst ?? 0)); }
    o.amount = r2(o.amount + cl.amount);
  }
  return out;
}
/** a bill's HSN summary (GST rule 6, Part 2): one row per HSN + unit + rate, built from the bill LINES (never by product) —
 *  qty includes free pieces, taxable value does not; two lines of one product add up; rows add to the bill to the paisa */
export function hsnSummary(lines: Pick<Invoice['lines'][number], 'hsn' | 'gst' | 'qty' | 'freeQty' | 'taxable' | 'cgst' | 'sgst' | 'igst'>[], unitOf: (l: unknown) => string = () => 'PCS') {
  const rows = new Map<string, { hsn: string; unit: string; gst: number; qty: number; taxable: number; cgst: number; sgst: number; igst: number; tax: number }>();
  for (const l of lines) {
    const unit = unitOf(l), k = `${l.hsn}|${unit}|${l.gst}`;
    const r = rows.get(k) ?? { hsn: l.hsn, unit, gst: l.gst, qty: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
    r.qty += l.qty + (l.freeQty ?? 0); r.taxable = r2(r.taxable + l.taxable); r.cgst = r2(r.cgst + l.cgst); r.sgst = r2(r.sgst + l.sgst); r.igst = r2(r.igst + l.igst);
    r.tax = r2(r.cgst + r.sgst + r.igst);
    rows.set(k, r);
  }
  return [...rows.values()];
}
/** the money of a credit note per GST rate (and HSN), for GSTR-1, Tally and the printed note */
export function cnTaxLines(c: Pick<CreditNote, 'lines'>, inv?: Pick<Invoice, 'lines'>, unitOf: (productId: string) => string = () => UQC) {
  const rows = new Map<string, { hsn: string; unit: string; gst: number; qty: number; taxable: number; cgst: number; sgst: number; igst: number; name: string }>();
  for (const cl of c.lines) {
    const l = inv?.lines[cl.line ?? -1]?.productId === cl.productId ? inv.lines[cl.line!] : inv?.lines.find(x => x.productId === cl.productId);
    const gst = cl.gst ?? l?.gst ?? 0, hsn = cl.hsn ?? l?.hsn ?? '';
    let t = { taxable: cl.taxable, cgst: cl.cgst, sgst: cl.sgst, igst: cl.igst };
    if (t.taxable == null) { const f = l?.total ? cl.amount / l.total : 0; t = l ? { taxable: r2(l.taxable * f), cgst: r2(l.cgst * f), sgst: r2(l.sgst * f), igst: r2(l.igst * f) } : { taxable: r2(cl.amount / (1 + gst / 100)), cgst: 0, sgst: 0, igst: 0 }; }
    const unit = unitOf(cl.productId), k = `${hsn}|${unit}|${gst}`;
    const r = rows.get(k) ?? { hsn, unit, gst, qty: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, name: l?.name ?? '' };
    r.qty += cl.qty + (cl.freeQty ?? 0); r.taxable = r2(r.taxable + (t.taxable ?? 0)); r.cgst = r2(r.cgst + (t.cgst ?? 0)); r.sgst = r2(r.sgst + (t.sgst ?? 0)); r.igst = r2(r.igst + (t.igst ?? 0));
    rows.set(k, r);
  }
  return [...rows.values()];
}
