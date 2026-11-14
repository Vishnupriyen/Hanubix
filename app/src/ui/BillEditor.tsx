import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, X, Plus, Printer } from 'lucide-react';
import { db, getSettings, today } from '../core/db';
import { billTotals, priceLines, sameProductTwiceOn } from '../core/billing';
import { billChangeBlock, isInterState } from '../core/gst';
import { saveBillEdit } from '../core/pipeline';
import { inr } from '../core/i18n';
import { norm } from '../core/match';
import { ask, notify } from './dialog';
import { NumBox } from './OrdersReceived';
import type { Invoice, InvoiceLine, Product, Scheme, Settings, Shop } from '../core/types';

type Edit = { productId: string; qty: number; rate: number; mrp: number; discount?: number; discountPct?: number }; // discountPct: the line's Disc %; discount: an old line's ₹ (kept until switched to %)

// Full bill editor, laid out like the bill itself: shop, every line (qty, rate, discount, MRP), add or remove lines.
// Allowed until the bill is printed or delivered (and before the month's GST return); the number never changes; the
// original is kept inside the bill. Prices, free pieces and stock are worked out by the same core code as a new bill.
export function BillEditor({ invoice, onClose }: { invoice: Invoice; onClose: (saved: boolean) => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [shops, setShops] = useState<Shop[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [shopId, setShopId] = useState(invoice.shopId);
  // a line's Disc % as saved; an old line typed in ₹ keeps its ₹ (shown read-only, "₹50 off", until tapped); a scheme's own
  // discount is worked out again by the same pricing (shown as its Disc % with "= ₹…" under it)
  const [edits, setEdits] = useState<Edit[]>(invoice.lines.map(l => ({ productId: l.productId, qty: l.qty, rate: l.rate, mrp: l.mrp, ...(l.discountPct != null ? { discountPct: l.discountPct } : l.discount > 0 && !(l.schemeNames ?? []).length ? { discount: l.discount } : {}) })));
  const [q, setQ] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { getSettings().then(setS); db.shops.toArray().then(x => setShops(x.filter(y => y.active !== false))); db.products.toArray().then(ps => setProducts(ps.filter(p => p.companyId === invoice.companyId))); db.schemes.toArray().then(setSchemes); }, [invoice]);
  const shop = shops.find(x => x.id === shopId);
  const inter = !!s && !!shop && isInterState(shop, s);
  const pmap = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  // priced exactly as the save will price them (core/billing.ts priceLines): Disc % or an old ₹, free pieces once per product
  const priced = useMemo(() => priceLines(edits.map(e => ({ ...e, qty: Math.max(0, Math.floor(e.qty)) })), pmap, schemes, inter, invoice.date), [edits, pmap, schemes, inter, invoice.date]);
  const lines: InvoiceLine[] = useMemo(() => priced.filter((l): l is InvoiceLine => !!l), [priced]);
  const set = (i: number, patch: Partial<Edit>) => setEdits(es => es.map((e, k) => k === i ? { ...e, ...patch } : e));
  const totals = useMemo(() => { const t = billTotals(lines); return { ...t, saving: t.schemeSaving }; }, [lines]);
  const adding = useRef(false);
  const addProduct = async (p: Product) => {
    if (adding.current) return; adding.current = true; // a double tap adds one line, not two
    try {
      const at = edits.findIndex(l => l.productId === p.id);
      // the same product again on a SALES bill (item 34): "Add to line N" (default) or "Keep as new line"; flag off = add to it
      const choice = at < 0 ? 'new' : !sameProductTwiceOn(s ?? undefined) ? 'add'
        : await ask(`Already in bill (line ${at + 1})`, { choices: [{ label: 'Keep as new line', value: 'new' }, { label: `Add to line ${at + 1}`, value: 'add', tone: 'primary' }] });
      if (!choice) return;
      if (choice === 'add') set(at, { qty: edits[at].qty + (p.caseSize || 1) });
      else setEdits(es => [...es, { productId: p.id, qty: p.caseSize || 1, rate: p.rate, mrp: p.mrp }]);
      setQ('');
    } finally { adding.current = false; }
  };
  const block = billChangeBlock(invoice, 'edit', today());
  const save = async () => {
    if (!shop || saving) return;
    if (block) { void notify('Bill can\'t be changed', block); return; }
    setSaving(true);
    try { await saveBillEdit(invoice.id, shop.id, edits.map(e => ({ ...e, qty: Math.floor(e.qty) }))); onClose(true); }
    catch (e) { await notify('Not saved', (e as Error).message); }
    finally { setSaving(false); }
  };
  if (!s) return null;
  const found = q ? products.filter(p => p.active && norm(p.name).includes(norm(q))).slice(0, 6) : [];
  return (
    <div className="sheet-wrap" onClick={() => onClose(false)}>
      <div className="sheet" onClick={e => e.stopPropagation()} style={{ height: 'min(92vh, 900px)' }}>
        <div className="sheet-head"><b className="grow">{'Edit bill'} {invoice.number}</b><button className="icon-btn" onClick={() => onClose(false)} aria-label="Close"><X /></button></div>
        <div className="stack" style={{ padding: 14, overflowY: 'auto', gap: 10 }}>
          {/* bill head, laid out as on paper */}
          <div className="bill-head">
            <div><b>{s.firmName}</b><div className="muted">{s.address}</div><div className="muted">GSTIN {s.gstin}</div></div>
            <div style={{ textAlign: 'right' }}><b>{'TAX INVOICE'}</b><div className="billno">{invoice.number}</div><div className="muted">{invoice.date.split('-').reverse().join('-')}</div></div>
          </div>
          <div className="field"><label>{'Bill to'}</label>
            <select value={shopId} onChange={e => setShopId(e.target.value)}>{shops.map(x => <option key={x.id} value={x.id}>{x.name} · {x.area}</option>)}</select>
            {shop && <div className="muted">{shop.address ?? shop.area}{shop.gstin ? ` · GSTIN ${shop.gstin}` : ` · B2C`}</div>}
          </div>
          {edits.map((e, i) => {
            const l = priced[i]; const p = pmap.get(e.productId);
            const first = edits.findIndex(x => x.productId === e.productId);
            return (
              <div key={i} className="linecard">
                <div className="lc-head"><div className="lc-name">{i + 1}. {p?.name ?? 'Unknown item'}</div>
                  <button className="icon-btn" onClick={() => setEdits(es => es.filter((_, k) => k !== i))} aria-label={`Remove ${p?.name ?? 'line'}`}><X size={18} /></button></div>
                <div className="lc-boxes four">
                  <div className="lc-box"><label>{'Qty'}</label><NumBox whole value={e.qty} onChange={v => set(i, { qty: v })} label="Qty" /></div>
                  <div className="lc-box"><label>{'Rate'}</label><NumBox value={e.rate} onChange={v => set(i, { rate: v })} label="Rate" /></div>
                  <div className="lc-box"><label>{'Disc %'}</label>
                    {e.discountPct == null && e.discount != null
                      ? <input readOnly value={`${inr(e.discount!)} off`} aria-label="Old ₹ discount — tap to change to Disc %" onClick={() => set(i, { discount: undefined, discountPct: l && l.gross ? Math.round(e.discount! / l.gross * 10000) / 100 : 0 })} />
                      : <NumBox value={e.discountPct ?? (l && l.gross ? Math.round(l.discount / l.gross * 10000) / 100 : 0)} onChange={v => set(i, { discountPct: v, discount: undefined })} label="Disc %" />}
                    {l && l.discount > 0 && e.discount == null && <div className="lc-note">= {inr(l.discount)}</div>}</div>
                  <div className="lc-box"><label>MRP</label><NumBox value={e.mrp} onChange={v => set(i, { mrp: v })} label="MRP" /></div>
                </div>
                <div className="lc-foot"><span>GST {p?.gst ?? 0}%{l?.freeQty ? ` · +${l.freeQty} free` : first !== i && priced[first]?.freeQty ? ` · Free: included in line ${first + 1}` : ''}</span><span className="lc-amt num">{inr(l?.total ?? 0)}</span></div>
              </div>
            );
          })}
          <div className="field"><input placeholder={'Add a product…'} value={q} onChange={e => setQ(e.target.value)} aria-label="Add product" />
            {found.length > 0 && <div className="list">{found.map(p => <button key={p.id} className="item tap" onClick={() => void addProduct(p)}><Plus size={16} /><span className="grow">{p.name}</span><span className="muted">{inr(p.rate)} · MRP {p.mrp}</span></button>)}</div>}
          </div>
          <div className="bill-totals">
            <div><span>{'Taxable'}</span><b className="num">{inr(totals.taxable)}</b></div>
            {inter ? <div><span>IGST</span><b className="num">{inr(totals.igst)}</b></div> : <><div><span>CGST</span><b className="num">{inr(totals.cgst)}</b></div><div><span>SGST</span><b className="num">{inr(totals.sgst)}</b></div></>}
            <div><span>{'Round off'}</span><b className="num">{totals.roundOff}</b></div>
            <div className="grand"><span>{'Total'}</span><b className="num">{inr(totals.total)}</b></div>
            {totals.saving > 0 && <div className="muted"><span>{'You saved'}</span><b className="num">{inr(totals.saving)}</b></div>}
          </div>
          {block ? <div className="alert"><Printer /><div>{block}</div></div>
            : <button className="btn primary big block" disabled={saving} onClick={save}><Check /> {'Save bill (same number)'}</button>}
        </div>
      </div>
    </div>
  );
}
