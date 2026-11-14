import { inr, showMonth, plural } from './i18n';
// TESRAX Accounts + TESRAX Claim Prep outputs. Pure code: exact, repeatable, explainable.
import { ChangeSet, db, getSettings, localDay } from './db';
import { isB2B, r2 } from './ledger';
import { cnTaxLines, shopStateCode, stateLabel, uqcLabel } from './gst';
import { uqcOf } from './orderEdit';
import { claimable } from './claims';
import { downloadText, downloadWorkbook } from './readers';
import type { Reply } from './engine';
import type { Invoice } from './types';

const inMonth = (d: string, m: string) => d.startsWith(m);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tdate = (d: string) => d.replace(/-/g, '');
const dmy = (d: string) => d.split('-').reverse().join('/');

// ---------------------------------------------------------------- Tally (XML import file)
export async function tallyXml(month: string): Promise<{ xml: string; counts: Record<string, number> }> {
  const s = await getSettings();
  const allInvs = await db.invoices.toArray();
  const invById = new Map(allInvs.map(i => [i.id, i]));
  const invs = allInvs.filter(i => inMonth(i.date, month) && !i.cancelled);
  const allPays = await db.payments.toArray();
  const pays = allPays.filter(p => inMonth(p.date, month) && (p.status === 'ok' || p.status === 'bounced'));
  const bounced = allPays.filter(p => p.status === 'bounced' && inMonth(localDay(p.updatedAt), month));
  const cns = (await db.creditNotes.toArray()).filter(c => inMonth(c.date, month));
  // expenses: only approved, non-zero ones (a rejected or still-waiting claim is not money spent)
  const exps = (await db.expenses.toArray()).filter(e => inMonth(e.date, month) && e.amount > 0 && e.status !== 'rejected' && (e.approved || e.category === 'advance' || e.category === 'salary'));
  const purchases = (await db.purchases.toArray()).filter(p => inMonth(p.date, month) && p.total > 0 && !p.valuePending);
  const coPays = (await db.purchases.toArray()).flatMap(p => (p.settlements ?? []).filter(x => x.kind === 'payment' && inMonth(x.date, month)).map(x => ({ ...x, companyId: p.companyId, billNo: p.billNo })));
  const shops = new Map((await db.shops.toArray()).map(x => [x.id, x]));
  const cos = new Map((await db.companies.toArray()).map(c => [c.id, c]));
  const party = (id: string) => shops.get(id)?.name ?? 'Cash Sales';
  const entry = (ledger: string, amount: number, debit: boolean) =>
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${(debit ? -1 : 1) * r2(amount)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
  const voucher = (type: string, date: string, no: string, partyName: string, entries: string[], narration = '') =>
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${type}" ACTION="Create"><DATE>${tdate(date)}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(no)}</VOUCHERNUMBER><PARTYLEDGERNAME>${esc(partyName)}</PARTYLEDGERNAME><NARRATION>${esc(narration)}</NARRATION><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>${entries.join('')}</VOUCHER></TALLYMESSAGE>`;

  const ledgers = new Map<string, string>(); // name → group
  const out: string[] = [];
  for (const i of invs) {
    const p = party(i.shopId); ledgers.set(p, 'Sundry Debtors');
    const byRate = new Map<number, number>();
    for (const l of i.lines) byRate.set(l.gst, r2((byRate.get(l.gst) ?? 0) + l.taxable));
    const e = [entry(p, i.total, true)];
    for (const [rate, amt] of byRate) { const n = `Sales @${rate}%`; ledgers.set(n, 'Sales Accounts'); e.push(entry(n, amt, false)); }
    if (i.cgst) { ledgers.set('Output CGST', 'Duties & Taxes'); e.push(entry('Output CGST', i.cgst, false)); }
    if (i.sgst) { ledgers.set('Output SGST', 'Duties & Taxes'); e.push(entry('Output SGST', i.sgst, false)); }
    if (i.igst) { ledgers.set('Output IGST', 'Duties & Taxes'); e.push(entry('Output IGST', i.igst, false)); }
    if (i.roundOff) { ledgers.set('Round Off', 'Indirect Expenses'); e.push(entry('Round Off', Math.abs(i.roundOff), i.roundOff < 0)); }
    out.push(voucher('Sales', i.date, i.number, p, e, `Hanubix ${i.kind}`));
  }
  // credit note: the sale AND its GST are reversed, per rate (Dr sales, Dr output tax, round-off, Cr party)
  for (const c of cns) {
    const p = party(c.shopId); ledgers.set(p, 'Sundry Debtors');
    const rows = cnTaxLines(c, invById.get(c.invoiceId));
    const byRate = new Map<number, number>(); for (const r of rows) byRate.set(r.gst, r2((byRate.get(r.gst) ?? 0) + r.taxable));
    const e: string[] = [];
    for (const [rate, amt] of byRate) { const n = `Sales @${rate}%`; ledgers.set(n, 'Sales Accounts'); e.push(entry(n, amt, true)); }
    const tax = { cgst: r2(rows.reduce((a, r) => a + r.cgst, 0)), sgst: r2(rows.reduce((a, r) => a + r.sgst, 0)), igst: r2(rows.reduce((a, r) => a + r.igst, 0)) };
    if (tax.cgst) { ledgers.set('Output CGST', 'Duties & Taxes'); e.push(entry('Output CGST', tax.cgst, true)); }
    if (tax.sgst) { ledgers.set('Output SGST', 'Duties & Taxes'); e.push(entry('Output SGST', tax.sgst, true)); }
    if (tax.igst) { ledgers.set('Output IGST', 'Duties & Taxes'); e.push(entry('Output IGST', tax.igst, true)); }
    const ro = r2(c.total - r2([...byRate.values()].reduce((a, x) => a + x, 0) + tax.cgst + tax.sgst + tax.igst));
    if (ro) { ledgers.set('Round Off', 'Indirect Expenses'); e.push(entry('Round Off', Math.abs(ro), ro > 0)); }
    e.push(entry(p, c.total, false));
    out.push(voucher('Credit Note', c.date, c.number, p, e, `${c.reason}${c.invoiceNumber ? ` · against ${c.invoiceNumber}` : ''}`));
  }
  for (const pay of pays) {
    const p = party(pay.shopId); ledgers.set(p, 'Sundry Debtors');
    const cashLedger = pay.mode === 'cash' ? 'Cash' : 'Bank Account';
    ledgers.set(cashLedger, pay.mode === 'cash' ? 'Cash-in-Hand' : 'Bank Accounts');
    out.push(voucher('Receipt', pay.date, pay.id.slice(-8), p, [entry(cashLedger, pay.amount, true), entry(p, pay.amount, false)], `${pay.mode} ${pay.ref ?? ''}`));
  }
  // a bounced cheque: the receipt is reversed (Dr party, Cr bank)
  for (const pay of bounced) {
    const p = party(pay.shopId); ledgers.set(p, 'Sundry Debtors'); ledgers.set('Bank Account', 'Bank Accounts');
    out.push(voucher('Journal', localDay(pay.updatedAt), `${pay.id.slice(-8)}-B`, p, [entry(p, pay.amount, true), entry('Bank Account', pay.amount, false)], `Cheque bounced ${pay.ref ?? ''}`));
  }
  for (const ex of exps) {
    ledgers.set('Cash', 'Cash-in-Hand');
    if (ex.category === 'income') { // money that came in (not an expense)
      ledgers.set('Other Income', 'Indirect Incomes');
      out.push(voucher('Receipt', ex.date, ex.id.slice(-8), 'Cash', [entry('Cash', ex.amount, true), entry('Other Income', ex.amount, false)], ex.note ?? ''));
      continue;
    }
    const led = ex.category === 'Drawings' ? 'Drawings' : ex.category === 'advance' ? 'Staff Advances' : ex.category;
    ledgers.set(led, ex.category === 'Drawings' ? 'Capital Account' : ex.category === 'advance' ? 'Loans & Advances (Asset)' : 'Indirect Expenses');
    out.push(voucher('Payment', ex.date, ex.id.slice(-8), 'Cash', [entry(led, ex.amount, true), entry('Cash', ex.amount, false)], ex.note ?? ''));
  }
  // company bills: purchase with input GST (IGST when the company is in another state)
  for (const pu of purchases) {
    const co = cos.get(pu.companyId)?.name ?? 'Company'; ledgers.set(co, 'Sundry Creditors');
    const inter = !!pu.supplierGstin && /^\d{2}/.test(pu.supplierGstin) && pu.supplierGstin.slice(0, 2) !== (s.stateCode || '33');
    const byRate = new Map<number, number>(); let tax = 0;
    for (const l of pu.lines) { const t = r2(l.qty * l.rate - (l.discount || 0)); byRate.set(l.gst, r2((byRate.get(l.gst) ?? 0) + t)); }
    const e: string[] = [];
    for (const [rate, amt] of byRate) { const n = `Purchase @${rate}%`; ledgers.set(n, 'Purchase Accounts'); e.push(entry(n, amt, true)); }
    for (const [rate, amt] of byRate) {
      if (inter) { const t = r2(amt * rate / 100); if (t) { ledgers.set('Input IGST', 'Duties & Taxes'); e.push(entry('Input IGST', t, true)); tax = r2(tax + t); } }
      else { const h = r2(amt * rate / 200); if (h) { ledgers.set('Input CGST', 'Duties & Taxes'); ledgers.set('Input SGST', 'Duties & Taxes'); e.push(entry('Input CGST', h, true), entry('Input SGST', h, true)); tax = r2(tax + 2 * h); } }
    }
    const ro = r2(pu.total - r2([...byRate.values()].reduce((a, x) => a + x, 0) + tax));
    if (ro) { ledgers.set('Round Off', 'Indirect Expenses'); e.push(entry('Round Off', Math.abs(ro), ro > 0)); }
    e.push(entry(co, pu.total, false));
    out.push(voucher('Purchase', pu.date, pu.billNo, co, e, `Company bill ${pu.billNo}`));
  }
  for (const x of coPays) {
    const co = cos.get(x.companyId)?.name ?? 'Company'; ledgers.set(co, 'Sundry Creditors');
    const bankL = x.mode === 'cash' ? 'Cash' : 'Bank Account'; ledgers.set(bankL, x.mode === 'cash' ? 'Cash-in-Hand' : 'Bank Accounts');
    out.push(voucher('Payment', x.date, `${x.billNo}-P`, co, [entry(co, x.amount, true), entry(bankL, x.amount, false)], `Paid against ${x.billNo} ${x.ref ?? ''}`));
  }
  const masters = [...ledgers.entries()].map(([name, parent]) =>
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(name)}" ACTION="Create"><NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST><PARENT>${esc(parent)}</PARENT></LEDGER></TALLYMESSAGE>`);
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(s.firmName)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${masters.join('')}${out.join('')}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  return { xml, counts: { sales: invs.length, creditNotes: cns.length, receipts: pays.length + exps.filter(e => e.category === 'income').length, expenses: exps.filter(e => e.category !== 'income').length, purchases: purchases.length, companyPayments: coPays.length, bounced: bounced.length } };
}

export async function exportTally(month: string): Promise<Reply> {
  const { xml, counts } = await tallyXml(month);
  return {
    text: `Tally file for ${showMonth(month)}: ${counts.sales} sales, ${counts.creditNotes} credit notes, ${counts.receipts} receipts, ${counts.expenses} expenses, ${counts.purchases} purchases. In Tally: Import → Vouchers → pick this file. New party ledgers are created under Sundry Debtors / Sundry Creditors.`,
    table: { name: `Tally ${month}`, columns: ['Type', 'Count'], rows: Object.entries(counts) },
    actions: [{ label: 'Download Tally XML', run: () => downloadText(`Hanubix-Tally-${month}.xml`, xml, 'application/xml') }],
  };
}

// ---------------------------------------------------------------- GSTR-1 (Excel in the offline-tool layout)
export async function exportGstr1(month: string): Promise<Reply> {
  const s = await getSettings();
  const own = s.stateCode || '33';
  const allInvs = await db.invoices.toArray();
  const invById = new Map(allInvs.map(i => [i.id, i])); // a credit note's bill may be from an earlier month
  const monthAll = allInvs.filter(i => inMonth(i.date, month));
  const invs = monthAll.filter(i => !i.cancelled);
  const shops = new Map((await db.shops.toArray()).map(x => [x.id, x]));
  const cns = (await db.creditNotes.toArray()).filter(c => inMonth(c.date, month)).sort((a, b) => a.number.localeCompare(b.number));
  const posOf = (shopId: string) => stateLabel(shopStateCode(shops.get(shopId), s));
  const isB2CL = (i: Invoice) => i.kind === 'B2C' && shopStateCode(shops.get(i.shopId), s) !== own && i.total > 100000;
  const b2b: (string | number)[][] = [], b2cl: (string | number)[][] = [];
  const b2cs = new Map<string, number>();
  type H = { desc: string; qty: number; value: number; taxable: number; igst: number; cgst: number; sgst: number; rate: number };
  const hsnB2B = new Map<string, H>(), hsnB2C = new Map<string, H>();
  // one row per HSN + UQC + rate — the same key as the bill's own HSN summary (gst.ts hsnSummary); the description is the
  // first bill line of that key (a credit note brings its own line's name), never a line of another key
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const unitOf = (pid: string) => uqcOf(products.get(pid));
  const hsnAdd = (m: Map<string, H>, hsn: string, unit: string, rate: number, desc: string, sign: number, x: { qty: number; value: number; taxable: number; igst: number; cgst: number; sgst: number }) => {
    const k = `${hsn}|${unit}|${rate}`; const h = m.get(k) ?? { desc, qty: 0, value: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, rate };
    if (!h.desc && desc) h.desc = desc;
    h.qty += sign * x.qty; h.value = r2(h.value + sign * x.value); h.taxable = r2(h.taxable + sign * x.taxable);
    h.igst = r2(h.igst + sign * x.igst); h.cgst = r2(h.cgst + sign * x.cgst); h.sgst = r2(h.sgst + sign * x.sgst); m.set(k, h);
  };
  for (const i of invs) {
    const byRate = new Map<number, number>();
    for (const l of i.lines) {
      byRate.set(l.gst, r2((byRate.get(l.gst) ?? 0) + l.taxable));
      hsnAdd(i.kind === 'B2B' ? hsnB2B : hsnB2C, l.hsn, unitOf(l.productId), l.gst, l.name, 1, { qty: l.qty + l.freeQty, value: l.total, taxable: l.taxable, igst: l.igst, cgst: l.cgst, sgst: l.sgst });
    }
    for (const [rate, taxable] of byRate) {
      const shop = shops.get(i.shopId);
      if (i.kind === 'B2B') b2b.push([shop?.gstin ?? '', shop?.name ?? '', i.number, dmy(i.date), i.total, posOf(i.shopId), 'N', '', 'Regular B2B', '', rate, taxable, 0]);
      else if (isB2CL(i)) b2cl.push([i.number, dmy(i.date), i.total, posOf(i.shopId), '', rate, taxable, 0, '']);
      else { const k = `${posOf(i.shopId)}|${rate}`; b2cs.set(k, r2((b2cs.get(k) ?? 0) + taxable)); }
    }
  }
  // credit notes: one row per rate from the note's own tax lines; registered shops → CDNR, B2C → netted into B2CS
  const cdnr: (string | number)[][] = [], cdnur: (string | number)[][] = [];
  for (const c of cns) {
    const inv = invById.get(c.invoiceId);
    const shop = shops.get(c.shopId);
    const b2bNote = inv ? inv.kind === 'B2B' : isB2B(shop ?? ({} as never));
    const rows = cnTaxLines(c, inv, unitOf);
    for (const r of rows) hsnAdd(b2bNote ? hsnB2B : hsnB2C, r.hsn, r.unit, r.gst, r.name, -1, { qty: r.qty, value: r2(r.taxable + r.cgst + r.sgst + r.igst), taxable: r.taxable, igst: r.igst, cgst: r.cgst, sgst: r.sgst });
    const byRate = new Map<number, number>(); for (const r of rows) byRate.set(r.gst, r2((byRate.get(r.gst) ?? 0) + r.taxable));
    for (const [rate, taxable] of byRate) {
      if (b2bNote) cdnr.push([shop?.gstin ?? '', shop?.name ?? '', c.number, dmy(c.date), 'C', posOf(c.shopId), 'N', 'Regular B2B', c.total, '', rate, taxable, 0]);
      else if (inv && isB2CL(inv)) cdnur.push(['B2CL', c.number, dmy(c.date), 'C', posOf(c.shopId), c.total, '', rate, taxable, 0]);
      else { const k = `${posOf(c.shopId)}|${rate}`; b2cs.set(k, r2((b2cs.get(k) ?? 0) - taxable)); }
    }
  }
  // Table 13: documents issued — per series, first and last number, how many, how many cancelled
  const seriesOf = (n: string) => n.replace(/\d+$/, '');
  const docs: (string | number)[][] = [];
  const docRows = (nature: string, list: { number: string; cancelled?: unknown }[]) => {
    const by = new Map<string, typeof list>(); for (const x of list) by.set(seriesOf(x.number), [...(by.get(seriesOf(x.number)) ?? []), x]);
    for (const xs of by.values()) { const sorted = xs.map(x => x.number).sort(); docs.push([nature, sorted[0], sorted[sorted.length - 1], xs.length, xs.filter(x => x.cancelled).length]); }
  };
  docRows('Invoices for outward supply', monthAll);
  docRows('Credit Note', cns);
  const hsnRows = (m: Map<string, H>) => [...m.entries()].filter(([, h]) => h.qty || h.taxable).map(([k, h]) => [k.split('|')[0], h.desc, uqcLabel(k.split('|')[1]), h.qty, h.value, h.rate, h.taxable, h.igst, h.cgst, h.sgst, 0]);
  const hsnHeader = ['HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount'];
  const sheets = [
    { name: 'b2b', header: ['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Reverse Charge', 'Applicable % of Tax Rate', 'Invoice Type', 'E-Commerce GSTIN', 'Rate', 'Taxable Value', 'Cess Amount'], rows: b2b },
    { name: 'b2cl', header: ['Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'], rows: b2cl },
    { name: 'b2cs', header: ['Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'], rows: [...b2cs.entries()].filter(([, v]) => v !== 0).map(([k, v]) => { const [p, r] = k.split('|'); return ['OE', p, '', Number(r), v, 0, '']; }) },
    { name: 'cdnr', header: ['GSTIN/UIN of Recipient', 'Receiver Name', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Reverse Charge', 'Note Supply Type', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'], rows: cdnr },
    { name: 'cdnur', header: ['UR Type', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'], rows: cdnur },
    { name: 'hsn(b2b)', header: hsnHeader, rows: hsnRows(hsnB2B) },
    { name: 'hsn(b2c)', header: hsnHeader, rows: hsnRows(hsnB2C) },
    { name: 'docs', header: ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'], rows: docs },
  ];
  const tot = r2(invs.reduce((a, i) => a + i.taxable, 0) - cns.reduce((a, c) => a + cnTaxLines(c, invById.get(c.invoiceId)).reduce((x, r) => x + r.taxable, 0), 0));
  const cancelled = monthAll.filter(i => i.cancelled).length;
  return {
    text: `GSTR-1 for ${showMonth(month)}: ${b2b.length} B2B lines, ${b2cl.length} B2C large, ${sheets[2].rows.length} B2C summary lines, ${plural(cns.length, 'credit note')}, taxable ${inr(tot)} after credit notes. Documents: ${plural(monthAll.length, 'bill')} issued, ${cancelled} cancelled, ${monthAll.length - cancelled} net. Give this to your CA or load it in the GST offline tool.`,
    table: { name: `GSTR1 ${month}`, columns: hsnHeader, rows: [...sheets[5].rows, ...sheets[6].rows] },
    actions: [{ label: 'Download GSTR-1 Excel', run: () => downloadWorkbook(`Hanubix-GSTR1-${month}`, sheets) }],
  };
}

// ---------------------------------------------------------------- e-invoice JSON (NIC schema 1.1, bulk upload)
export async function exportEinvoice(month: string): Promise<Reply> {
  const s = await getSettings();
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const unitOf = (pid: string) => uqcOf(products.get(pid)); // the product's GST unit (KGS, LTR …), PCS when it has none
  const shops = new Map((await db.shops.toArray()).map(x => [x.id, x]));
  const invs = (await db.invoices.toArray()).filter(i => inMonth(i.date, month) && !i.cancelled && i.kind === 'B2B');
  const pin = (addr?: string) => Number(addr?.match(/\b(6\d{5})\b/)?.[1] ?? 0);
  const sellerPin = pin(s.address);
  const missing: string[] = [];
  const docs = invs.map(i => {
    const shop = shops.get(i.shopId)!;
    if (!pin(shop.address)) missing.push(shop.name);
    return {
      Version: '1.1',
      TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
      DocDtls: { Typ: 'INV', No: i.number, Dt: dmy(i.date) },
      SellerDtls: { Gstin: s.gstin, LglNm: s.firmName, Addr1: s.address.slice(0, 100), Loc: s.address.split(',').slice(-2, -1)[0]?.trim() || 'Tamil Nadu', Pin: sellerPin, Stcd: s.stateCode },
      BuyerDtls: { Gstin: shop.gstin, LglNm: shop.name, Pos: shop.gstin!.slice(0, 2), Addr1: (shop.address || shop.area).slice(0, 100), Loc: shop.area || 'NA', Pin: pin(shop.address), Stcd: shop.gstin!.slice(0, 2) },
      ItemList: i.lines.map((l, k) => ({
        SlNo: String(k + 1), PrdDesc: l.name, IsServc: 'N', HsnCd: l.hsn, Qty: l.qty, FreeQty: l.freeQty, Unit: unitOf(l.productId),
        UnitPrice: l.rate, TotAmt: l.gross, Discount: l.discount, AssAmt: l.taxable, GstRt: l.gst,
        IgstAmt: l.igst, CgstAmt: l.cgst, SgstAmt: l.sgst, TotItemVal: l.total,
      })),
      ValDtls: { AssVal: i.taxable, CgstVal: i.cgst, SgstVal: i.sgst, IgstVal: i.igst, RndOffAmt: i.roundOff, TotInvVal: i.total },
    };
  });
  // Checks from the e-invoice schema: HSN 6 or 8 digits, bill no ≤16 chars (no leading 0, / or -), names ≥3 letters
  const shortHsn = new Set<string>();
  const badNo: string[] = [];
  for (const i of invs) {
    for (const l of i.lines) if (!/^(\d{6}|\d{8})$/.test(l.hsn)) shortHsn.add(`${l.name} (${l.hsn || 'blank'})`);
    if (!/^[a-zA-Z1-9][a-zA-Z0-9/-]{0,15}$/.test(i.number)) badNo.push(i.number);
  }
  const shortNames = invs.map(i => shops.get(i.shopId)!).filter(x => x.name.trim().length < 3 || (x.area || '').trim().length < 3).map(x => x.name);
  const warn = [
    !sellerPin ? 'Your firm address has no 6-digit PIN code (More → Settings).' : '',
    missing.length ? `PIN code missing in address for: ${[...new Set(missing)].join(', ')}.` : '',
    shortHsn.size ? `HSN must be 6 or 8 digits for e-invoice: ${[...shortHsn].slice(0, 8).join(', ')}${shortHsn.size > 8 ? '…' : ''}.` : '',
    badNo.length ? `Bill numbers the portal will reject: ${badNo.slice(0, 5).join(', ')}.` : '',
    shortNames.length ? `Shop name or area too short (min 3 letters): ${[...new Set(shortNames)].join(', ')}.` : '',
  ].filter(Boolean).join('\n⚠ ');
  return {
    text: `${plural(docs.length, 'B2B bill')} for ${showMonth(month)} in the government e-invoice format. Upload this file in the free bulk tool on the e-invoice portal, then download the IRN file.` + (warn ? `\n⚠ ${warn}` : ''),
    tone: warn ? 'warn' : 'ok',
    table: { name: `E-invoice ${month}`, columns: ['Bill', 'Date', 'Buyer', 'Value ₹'], rows: invs.map(i => [i.number, i.date, shops.get(i.shopId)?.name ?? '', i.total]) },
    actions: [{ label: 'Download e-invoice JSON', run: () => downloadText(`Hanubix-einvoice-${month}.json`, JSON.stringify(docs, null, 2)) }],
  };
}

// ---------------------------------------------------------------- TESRAX Claim Prep
export async function exportClaims(month: string): Promise<Reply> {
  await (await import('./credit')).fillPendingValues(); // values saved on staff phones (no buying rate there)
  // only valid lines: not dropped (bill cancelled / returned / dropped by the owner) and valued — the file total is their sum
  const entries = (await db.claimEntries.toArray()).filter(e => e.month === month && claimable(e));
  const companies = await db.companies.toArray();
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const invs = new Map((await db.invoices.toArray()).map(i => [i.id, i]));
  const claims = await db.claims.toArray();
  const rows: (string | number)[][] = [];
  const sheets: { name: string; header: string[]; rows: (string | number)[][] }[] = [];
  const cs = new ChangeSet();
  for (const c of companies) {
    const es = entries.filter(e => e.companyId === c.id);
    if (!es.length) continue;
    const scheme = r2(es.filter(e => e.kind === 'scheme').reduce((a, e) => a + e.amount, 0));
    const damage = r2(es.filter(e => e.kind !== 'scheme').reduce((a, e) => a + e.amount, 0));
    const total = r2(scheme + damage);
    rows.push([c.name, scheme, damage, total]);
    const existing = claims.find(x => x.companyId === c.id && x.month === month);
    if (!existing) cs.put('claims', { companyId: c.id, month, amount: total, status: 'draft' }, 'claim draft');
    else if (existing.status === 'draft') cs.put('claims', { ...existing, amount: total }, 'claim refresh');
    sheets.push({
      name: `${c.code} ${month}`,
      header: ['Type', 'Bill / note', 'Date', 'Product', 'Qty', 'Claim ₹', 'Scheme / reason'],
      rows: es.map(e => [e.kind, e.invoiceId ? invs.get(e.invoiceId)?.number ?? '' : 'Godown entry', e.invoiceId ? invs.get(e.invoiceId)?.date ?? '' : localDay(e.createdAt), products.get(e.productId ?? '')?.name ?? '', e.qty, e.amount, e.note ?? '']),
    });
  }
  if (cs.size) await cs.commit('Claim drafts');
  return {
    text: rows.length ? `Claims for ${showMonth(month)}: ${inr(r2(rows.reduce((a, r) => a + Number(r[3]), 0)))} across ${rows.length} compan${rows.length > 1 ? 'ies' : 'y'}. Every line has its bill as proof.` : `No claim lines for ${showMonth(month)}.`,
    table: { name: `Claims ${month}`, columns: ['Company', 'Scheme ₹', 'Damage/expiry ₹', 'Total ₹'], rows },
    actions: sheets.length ? [{ label: 'Download claim file', run: () => downloadWorkbook(`Hanubix-Claims-${month}`, [{ name: 'Summary', header: ['Company', 'Scheme ₹', 'Damage/expiry ₹', 'Total ₹'], rows }, ...sheets]) }] : [],
  };
}
