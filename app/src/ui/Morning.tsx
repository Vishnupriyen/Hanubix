import { useEffect, useState } from 'react';
import { AlertTriangle, Banknote, Boxes, CalendarClock, Target, TrendingUp, Undo2, Truck } from 'lucide-react';
import { ChangeSet, db, today, undoBatch, undoRefusal, daysFrom } from '../core/db';
import { invoiceBalances, OWED, r2 } from '../core/ledger';
import { inr, plural, inrR } from '../core/i18n';
import { confirmBox, notify } from './dialog';
import type { AuditEntry, Order } from '../core/types';

interface Data {
  y: { sales: number; bills: number; profit: number; margin: number; prevSales: number };
  collect: { dueToday: number; overdue: number; shops: { name: string; amount: number; days: number }[] };
  cash: { staffId: string; name: string; amount: number; since: string }[];
  stock: { out: string[]; expiring: { name: string; days: number; qty: number }[]; over: { name: string; days: number }[] };
  needsOk: (Order & { shopName: string })[];
  targets: { company: string; kind: string; target: number; done: number; perDay: number; behind: boolean }[];
  vans: { name: string; pending: number; delivered: number }[];
  recent: AuditEntry[];
}


// Owner's morning view (4.13): yesterday's sales & profit → money to collect → cash with staff → stock alerts.
export function Morning({ only }: { only?: 'cash' | 'stock' } = {}) {
  const [d, setD] = useState<Data | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { load().then(setD); }, [tick]);
  if (!d) return <div className="muted">…</div>;
  const refresh = () => setTick(x => x + 1);
  const delta = d.y.prevSales ? Math.round((d.y.sales - d.y.prevSales) / d.y.prevSales * 100) : 0;
  const show = (k: 'cash' | 'stock' | 'rest') => !only || only === k;

  return (
    <div className="stack">
      {show('rest') && <div className="kpis">
        <div className="kpi navy"><div className="v">{inr(d.y.sales)}</div><div className="l">{"Yesterday's sales"} · {plural(d.y.bills, 'bill')}</div>{d.y.prevSales > 0 && <div className={`d ${delta >= 0 ? 'up' : 'down'}`}>{delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}% vs day before</div>}</div>
        <div className="kpi navy"><div className="v">{inr(d.y.profit)}</div><div className="l">{'Gross profit'} · {d.y.margin}%</div><div className="d" style={{ color: 'var(--on-navy-2)' }}>{'after schemes & discounts'}</div></div>
        <div className="kpi"><div className="v">{inr(d.collect.dueToday)}</div><div className="l">{'To collect today'}</div></div>
        <div className="kpi"><div className="v" style={{ color: d.collect.overdue > 0 ? 'var(--bad)' : undefined }}>{inr(d.collect.overdue)}</div><div className="l">{'Overdue in market'}</div></div>
      </div>}

      {show('rest') && <section className="card">
        <div className="sechead"><h3><CalendarClock size={18} style={{ verticalAlign: -3 }} /> {'Money to collect'}</h3></div>
        {d.collect.shops.length ? (
          <div className="list">
            {d.collect.shops.map(s => (
              <div key={s.name} className="row" style={{ flexWrap: 'nowrap', minHeight: 40 }}>
                <span className="grow">{s.name}</span>
                {s.days > 0 && <span className="badge bad">{s.days}d {'late'}</span>}
                <span className="amt num">{inr(s.amount)}</span>
              </div>
            ))}
          </div>
        ) : <div className="muted">{'Nothing overdue. 🎉'}</div>}
      </section>}

      {show('cash') && <section className="card">
        <div className="sechead"><h3><Banknote size={18} style={{ verticalAlign: -3 }} /> {'Cash with staff'}</h3></div>
        {d.cash.length ? d.cash.map(c => (
          <div key={c.staffId} className="row" style={{ flexWrap: 'nowrap', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
            <div className="avatar">{c.name[0]}</div>
            <div className="grow"><div className="t">{c.name}</div><div className="s">{'since'} {c.since}{c.since < today() && <span className="badge bad" style={{ marginLeft: 6 }}>{'held overnight'}</span>}</div></div>
            <span className="amt num">{inr(c.amount)}</span>
            <button className="btn small primary" onClick={async () => {
              const pays = (await db.payments.toArray()).filter(p => p.collectedBy === c.staffId && p.mode === 'cash' && !p.settled && p.status === 'ok');
              const cs = new ChangeSet(); for (const p of pays) cs.put('payments', { ...p, settled: true }, 'cash received'); await cs.commit('Evening cash settlement'); refresh();
            }}>{'Received'}</button>
          </div>
        )) : <div className="muted">{'All cash handed over.'}</div>}
      </section>}

      {show('stock') && <section className="card">
        <div className="sechead"><h3><Boxes size={18} style={{ verticalAlign: -3 }} /> {'Stock alerts'}</h3></div>
        <div className="stack" style={{ gap: 8 }}>
          {d.stock.out.length > 0 && <div className="alert bad"><AlertTriangle /><div><b>{'Out of stock'}:</b> {d.stock.out.join(', ')}</div></div>}
          {d.stock.expiring.map(e => <div key={e.name} className="alert"><AlertTriangle /><div><b>{e.name}</b> · {e.qty} pcs {'expire in'} {e.days} {'days'} — {'push or return'}</div></div>)}
          {d.stock.over.map(e => <div key={e.name} className="alert" style={{ background: 'var(--info-soft)' }}><TrendingUp style={{ color: 'var(--navy)' }} /><div><b>{e.name}</b> · {e.days} {'days of stock'} — {'overstock'}</div></div>)}
          {!d.stock.out.length && !d.stock.expiring.length && !d.stock.over.length && <div className="muted">{'Stock looks fine.'}</div>}
        </div>
      </section>}

      {show('rest') && d.targets.length > 0 && (
        <section className="card">
          <div className="sechead"><h3><Target size={18} style={{ verticalAlign: -3 }} /> {'Company targets this month'}</h3></div>
          <div className="stack" style={{ gap: 10 }}>
            {d.targets.map(tg => {
              const pct = Math.min(100, Math.round(tg.done / tg.target * 100));
              return (
                <div key={tg.company + tg.kind}>
                  <div className="row" style={{ justifyContent: 'space-between' }}><span><b>{tg.company}</b> · {tg.kind}</span><span className="num">{inr(tg.done)} / {inr(tg.target)}</span></div>
                  <div style={{ height: 10, background: 'var(--paper-2)', borderRadius: 999, overflow: 'hidden', margin: '4px 0' }}><div style={{ width: `${pct}%`, height: '100%', background: tg.behind ? 'var(--bad)' : 'var(--ok)' }} /></div>
                  <div className="muted">{pct}% {'done'} · {'needed per day'} {inrR(tg.perDay)}{tg.behind && <span className="badge bad" style={{ marginLeft: 6 }}>{'falling behind'}</span>}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {show('rest') && d.vans.length > 0 && (
        <section className="card">
          <div className="sechead"><h3><Truck size={18} style={{ verticalAlign: -3 }} /> {'Vans today'}</h3></div>
          {d.vans.map(v => <div key={v.name} className="row" style={{ justifyContent: 'space-between', minHeight: 36 }}><b>{v.name}</b><span><span className="badge ok">{v.delivered} {'delivered'}</span> <span className="badge">{v.pending} {'pending'}</span></span></div>)}
        </section>
      )}

      {show('rest') && <section className="card">
        <div className="sechead"><h3>{'Recent changes'}</h3></div>
        <div className="list">
          {d.recent.map(a => (
            <div key={a.id} className="row" style={{ flexWrap: 'nowrap', minHeight: 40 }}>
              <span className="grow"><b>{a.action.split(':')[0]}</b> <span className="muted">· {new Date(a.at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })} · {a.by === 'owner' ? 'owner' : ''}</span></span>
              <button className="btn small" onClick={async () => { if (await confirmBox('Undo this whole action?', 'Everything this approval changed goes back.', 'Undo')) { const n = await undoBatch(a.batchId); if (n < 0) await notify("Can't undo", undoRefusal(n)); refresh(); } }}><Undo2 /> {'Undo'}</button>
            </div>
          ))}
        </div>
      </section>}
    </div>
  );
}

async function load(): Promise<Data> {
  const t = today();
  const yday = daysFrom(-1);
  const invs = (await db.invoices.toArray()).filter(i => !i.cancelled);
  const products = new Map((await db.products.toArray()).map(p => [p.id, p]));
  const shops = new Map((await db.shops.toArray()).map(s => [s.id, s]));
  const staff = new Map((await db.staff.toArray()).map(s => [s.id, s.name]));
  const companies = new Map((await db.companies.toArray()).map(c => [c.id, c.name]));
  // yesterday (fall back to the latest day with bills, so the demo always shows something)
  let yInv = invs.filter(i => i.date === yday);
  let y = yday;
  if (!yInv.length) { const days = [...new Set(invs.map(i => i.date))].sort().reverse(); y = days[0] ?? yday; yInv = invs.filter(i => i.date === y); }
  const prev = invs.filter(i => i.date < y).sort((a, b) => b.date.localeCompare(a.date));
  const prevDay = prev[0]?.date; const prevSales = r2(prev.filter(i => i.date === prevDay).reduce((a, i) => a + i.total, 0));
  const sales = r2(yInv.reduce((a, i) => a + i.total, 0));
  let cost = 0, taxable = 0;
  for (const i of yInv) for (const l of i.lines) { cost += (l.qty + l.freeQty) * (products.get(l.productId)?.purchaseRate ?? 0); taxable += l.taxable; }
  const profit = r2(taxable - cost);
  // collect
  const bal = (await invoiceBalances()).filter(b => b.balance > OWED);
  const byShop = new Map<string, { amount: number; days: number }>();
  for (const b of bal) { const v = byShop.get(b.invoice.shopId) ?? { amount: 0, days: 0 }; v.amount = r2(v.amount + b.balance); v.days = Math.max(v.days, b.overdueDays); byShop.set(b.invoice.shopId, v); }
  const dueToday = r2(bal.filter(b => { const s = shops.get(b.invoice.shopId); const due = new Date(b.invoice.date).getTime() + (s?.creditDays ?? 0) * 86400000; return due <= Date.now(); }).reduce((a, b) => a + b.balance, 0));
  const overdue = r2(bal.filter(b => b.overdueDays > 0).reduce((a, b) => a + b.balance, 0));
  // cash
  const unsettled = (await db.payments.toArray()).filter(p => p.mode === 'cash' && !p.settled && p.status === 'ok');
  const cashBy = new Map<string, { amount: number; since: string }>();
  for (const p of unsettled) { const v = cashBy.get(p.collectedBy) ?? { amount: 0, since: p.date }; v.amount = r2(v.amount + p.amount); if (p.date < v.since) v.since = p.date; cashBy.set(p.collectedBy, v); }
  // stock
  const batches = await db.batches.toArray();
  const soldLast30 = new Map<string, number>();
  for (const i of invs.filter(x => x.date >= daysFrom(-30))) for (const l of i.lines) soldLast30.set(l.productId, (soldLast30.get(l.productId) ?? 0) + l.qty);
  const out: string[] = []; const over: { name: string; days: number }[] = [];
  for (const p of products.values()) {
    const st = batches.filter(b => b.productId === p.id && b.expiry >= t).reduce((a, b) => a + b.qty, 0);
    if (st <= 0) out.push(p.name);
    else { const perDay = (soldLast30.get(p.id) ?? 0) / 30; if (perDay > 0 && st / perDay > 60) over.push({ name: p.name, days: Math.round(st / perDay) }); }
  }
  const expiring = batches.filter(b => b.qty > 0 && b.expiry >= t).map(b => ({ name: products.get(b.productId)?.name ?? '', days: Math.round((new Date(b.expiry).getTime() - Date.now()) / 86400000), qty: b.qty })).filter(e => e.days <= 45).sort((a, b) => a.days - b.days).slice(0, 4);
  // targets
  const month = t.slice(0, 7);
  const targets = (await db.targets.where('month').equals(month).toArray()).map(tg => {
    const done = tg.kind === 'sales' ? r2(invs.filter(i => i.companyId === tg.companyId && i.date.startsWith(month)).reduce((a, i) => a + i.taxable, 0)) : 0;
    const dim = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate(); const dayN = Number(t.slice(8));
    const left = Math.max(1, dim - dayN); const expect = tg.value * dayN / dim;
    return { company: companies.get(tg.companyId) ?? '', kind: tg.kind, target: tg.value, done, perDay: r2(Math.max(0, tg.value - done) / left), behind: done < expect * 0.85 };
  });
  const vansAll = await db.vans.toArray();
  const vans = vansAll.map(v => ({ name: v.name, pending: invs.filter(i => i.vanId === v.id && i.deliveryStatus === 'pending').length, delivered: invs.filter(i => i.vanId === v.id && i.date === t && i.deliveryStatus !== 'pending').length })).filter(v => v.pending || v.delivered);
  const audit = (await db.audit.orderBy('at').reverse().limit(300).toArray()).filter(a => !a.undone && !a.action.startsWith('Demo'));
  const seen = new Set<string>(); const recent: AuditEntry[] = [];
  for (const a of audit) { if (seen.has(a.batchId)) continue; seen.add(a.batchId); recent.push(a); if (recent.length >= 6) break; }
  return {
    y: { sales, bills: yInv.length, profit, margin: taxable ? Math.round(profit / taxable * 100) : 0, prevSales },
    collect: { dueToday, overdue, shops: [...byShop.entries()].map(([id, v]) => ({ name: shops.get(id)?.name ?? '', ...v })).sort((a, b) => b.days - a.days || b.amount - a.amount).slice(0, 6) },
    cash: [...cashBy.entries()].map(([staffId, v]) => ({ staffId, name: staff.get(staffId) ?? staffId, ...v })),
    stock: { out: out.slice(0, 5), expiring, over: over.slice(0, 3) },
    needsOk: (await db.orders.where('status').equals('needs_ok').toArray()).map(o => ({ ...o, shopName: shops.get(o.shopId)?.name ?? '' })),
    targets, vans, recent,
  };
}
