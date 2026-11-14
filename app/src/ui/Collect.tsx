import { useEffect, useState } from 'react';
import { PayBox } from './PayBox';
import { ArrowLeft, Store } from 'lucide-react';
import { activeShops } from '../core/db';
import { allOutstanding, OWED } from '../core/ledger';
import { norm } from '../core/match';
import { inr, t } from '../core/i18n';
import type { Shop } from '../core/types';

// TESRAX Collection: overdue shops first; bill number first, then amount, mode, shop ✓.
export function Collect() {
  const [shops, setShops0] = useState<(Shop & { due: number; overdue: number })[]>([]);
  const [loaded, setLoaded] = useState(false); // until the first load ends, say so — never "nothing here"
  const setShops: typeof setShops0 = v => { setLoaded(true); setShops0(v); };
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<(Shop & { due: number }) | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    (async () => {
      const me = (await import('../core/db')).session().userId;
      const role = (await (await import('../core/db')).db.staff.get(me))?.role;
      const ss = (await activeShops()).filter(s => role !== 'salesman' || !s.salesmanId || s.salesmanId === me);
      const dues = await allOutstanding(); // one pass over the bills, not one per shop
      const withDue = ss.map(s => { const o = dues.get(s.id); return { ...s, due: o?.total ?? 0, overdue: o?.maxOverdueDays ?? 0 }; });
      setShops(withDue.filter(s => s.due > OWED).sort((a, b) => b.overdue - a.overdue || b.due - a.due));
    })();
  }, [tick]);

  if (sel) return <CollectShop shop={sel} onClose={() => { setSel(null); setTick(x => x + 1); }} />;
  const list = shops.filter(s => !q || norm(s.name).includes(norm(q)) || norm(s.area).includes(norm(q)));
  return (
    <div>
      <div className="sechead"><h3>{t('collect')}</h3></div>
      <div className="field" style={{ margin: '10px 0' }}><input placeholder="Search shop…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search shop" /></div>
      <div className="list">
        {list.map(s => (
          <button key={s.id} className="item tap" onClick={() => setSel(s)}>
            <div className={`avatar ${s.overdue > 0 ? 'bad' : ''}`}><Store size={22} /></div>
            <div className="grow"><div className="t">{s.name}</div><div className="s">{s.area}</div></div>
            <div style={{ textAlign: 'right' }}><div className="amt num">{inr(s.due)}</div>{s.overdue > 0 && <span className="badge bad">{s.overdue} days late</span>}</div>
          </button>
        ))}
        {!loaded && <div className="card muted">{'Loading…'}</div>}
      {loaded && !list.length && <div className="card muted">{t('noItems')}</div>}
      </div>
    </div>
  );
}

export function CollectShop({ shop, onClose }: { shop: Shop & { due: number }; onClose: () => void }) {
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'nowrap' }}><button className="icon-btn" onClick={onClose} aria-label="Back"><ArrowLeft /></button><div className="grow"><div className="h">{shop.name}</div><div className="muted">{shop.area} · {t('outstanding')} {inr(shop.due)}</div></div></div>
      <PayBox shop={shop} onDone={onClose} />
    </div>
  );
}
