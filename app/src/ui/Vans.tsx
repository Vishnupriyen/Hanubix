// Menu > Delivery > Vans (Part 2 item 12 — docs/PART2_UX.md 2a): add, edit, delete or hide a van; capacity in cases per trip.
// The logic (unique numbers, blocked while a trip is open, hide when it has history, driver link) is core/vans.ts.
import { useEffect, useState } from 'react';
import { Pencil, Trash2, Truck } from 'lucide-react';
import { db } from '../core/db';
import { activeVans, removeVan, saveVan, vanRemoval } from '../core/vans';
import type { Staff, Van } from '../core/types';
import { confirmBox, notify } from './dialog';

const KINDS: { value: Van['kind']; label: string }[] = [{ value: 'own', label: 'Own' }, { value: 'hired', label: 'Hired' }, { value: 'auto', label: 'Auto' }];
const LAST_KIND = 'hanubix.vanKind';
type Form = { id?: string; name: string; number: string; kind: Van['kind']; driverId: string; capacity: string };
const blank = (): Form => ({ name: '', number: '', kind: ((typeof localStorage !== 'undefined' && localStorage.getItem(LAST_KIND)) as Van['kind']) || 'own', driverId: '', capacity: '' });

export function VansPage({ editable }: { editable: boolean }) {
  const [vans, setVans] = useState<Van[] | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { setVans(await activeVans()); setStaff(await db.staff.toArray()); };
  useEffect(() => { void load(); }, []);
  const drivers = staff.filter(s => s.role === 'delivery' && s.active);
  const save = async () => {
    if (!form || busy) return;
    setBusy(true);
    try {
      await saveVan({ id: form.id, name: form.name, number: form.number, kind: form.kind, driverId: form.driverId || undefined, capacity: form.capacity.trim() ? Number(form.capacity) : null });
      try { localStorage.setItem(LAST_KIND, form.kind); } catch { /* no storage */ }
      setForm(null); await load();
    } catch (e) { void notify('Not saved', (e as Error).message); } finally { setBusy(false); }
  };
  const remove = async (v: Van) => {
    const r = await vanRemoval(v.id);
    if (r.block) { void notify(r.block); return; }
    const ok = r.mode === 'hide'
      ? await confirmBox(`Hide ${v.name}?`, 'Old trips keep its name.', 'Hide van')
      : await confirmBox(`Delete ${v.name}?`, 'It has no trips, bills or expenses.', 'Delete van');
    if (!ok) return;
    try { await removeVan(v.id); await load(); } catch (e) { void notify('Not saved', (e as Error).message); }
  };
  const edit = (v: Van) => setForm({ id: v.id, name: v.name, number: v.number, kind: v.kind, driverId: v.driverId ?? '', capacity: v.capacity ? String(v.capacity) : '' });
  return (
    <div className="stack">
      <div className="sechead"><h3>Vans</h3></div>
      {vans && !vans.length && <div className="muted">{'No vans yet. Add your first van'}</div>}
      <div className="list">
        {(vans ?? []).map(v => {
          const driver = staff.find(s => s.id === v.driverId)?.name.replace(/\s*\(.*\)$/, '');
          return (
            <div key={v.id} className="item">
              <div className="avatar"><Truck size={18} /></div>
              <div className="grow">
                <div className="t">{v.name}</div>
                {v.number && <div className="s num">{v.number}</div>}
                <div className="s">{[KINDS.find(k => k.value === v.kind)?.label ?? v.kind, driver, v.capacity ? `${v.capacity} cases/trip` : 'no limit'].filter(Boolean).join(' · ')}</div>
              </div>
              {editable && <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                <button className="icon-btn" aria-label={`Edit ${v.name}`} onClick={() => edit(v)}><Pencil size={18} /></button>
                <button className="icon-btn" aria-label={`Delete ${v.name}`} onClick={() => void remove(v)}><Trash2 size={18} /></button>
              </div>}
            </div>
          );
        })}
      </div>
      {editable && !form && <div className="row"><button className="btn small" onClick={() => setForm(blank())}>{'+ Add van'}</button></div>}
      {editable && form && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{form.id ? `Edit ${form.name || 'van'}` : 'Add van'}</h3>
          <div className="fields">
            <div className="field"><label>Name</label><input value={form.name} placeholder="Van 2" onChange={e => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field"><label>Number</label><input value={form.number} placeholder="TN 31 AB 1234" onChange={e => setForm({ ...form, number: e.target.value.toUpperCase() })} /></div>
            <div className="field"><label>Driver</label><select value={form.driverId} onChange={e => setForm({ ...form, driverId: e.target.value })}><option value="">{'No driver'}</option>{drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
            <div className="field"><label>{'Cases per trip'}</label><input inputMode="numeric" value={form.capacity} onChange={e => setForm({ ...form, capacity: e.target.value.replace(/\D/g, '').slice(0, 4) })} /><div className="muted">{'Leave empty for no limit'}</div></div>
            <div className="field"><label>Kind</label><div className="segmented">{KINDS.map(k => <button key={k.value} type="button" className={form.kind === k.value ? 'on' : ''} onClick={() => setForm({ ...form, kind: k.value })}>{k.label}</button>)}</div></div>
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save van'}</button>
            <button className="btn" disabled={busy} onClick={() => setForm(null)}>{'Cancel'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
