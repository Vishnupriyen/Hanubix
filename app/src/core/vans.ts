// Vans (Part 2 item 12 — docs/PART2_SPEC.md, PART2_UX.md): add, edit, delete or hide. A van with history (trips, bills,
// expenses) is hidden (active = false), never erased, so old trips and expenses keep its name. Capacity = cases per trip
// (one number, empty = no limit — the measure suggestPlan uses). Numbers are unique among active vans (a guard holds it).
import { ChangeSet, db } from './db';
import type { Staff, Van } from './types';

export const vanActive = (v: Pick<Van, 'active'>) => v.active !== false;
/** vans that can be picked today (hidden vans keep their names in old records only) */
export async function activeVans(): Promise<Van[]> {
  return (await db.vans.toArray()).filter(vanActive).sort((a, b) => a.name.localeCompare(b.name));
}
/** a van number compared without spaces, dashes or case ("TN 31 AB 1234" = "tn31ab1234") */
export const vanKey = (n: string | undefined) => String(n ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export type VanInput = Pick<Van, 'name' | 'number' | 'kind'> & { id?: string; driverId?: string; capacity?: number | null };
const saving = new Set<string>();

/** add (no id) or edit a van. A double tap makes one van; the driver link follows (one van per driver). */
export async function saveVan(input: VanInput): Promise<Van> {
  const name = input.name.trim(), number = input.number.trim();
  if (!name) throw new Error('Give the van a name (e.g. Van 2).');
  const cap = input.capacity == null || (input.capacity as unknown) === '' ? undefined : Number(input.capacity);
  if (cap !== undefined && (!Number.isInteger(cap) || cap <= 0)) throw new Error('Cases per trip must be a whole number more than 0. Leave it empty for no limit.');
  const lock = input.id ?? `new:${name.toLowerCase()}|${vanKey(number)}`;
  if (saving.has(lock)) throw new Error('This van is already being saved.');
  saving.add(lock);
  try {
    const all = await db.vans.toArray();
    if (!input.id && all.some(v => vanActive(v) && v.name.trim().toLowerCase() === name.toLowerCase() && vanKey(v.number) === vanKey(number))) throw new Error(`${name} is already added.`);
    const was = input.id ? all.find(v => v.id === input.id) : undefined;
    if (input.id && !was) throw new Error('Van not found.');
    const twin = vanKey(number) && (!was || vanActive(was)) && all.find(v => v.id !== input.id && vanActive(v) && vanKey(v.number) === vanKey(number));
    if (twin) throw new Error(`Number already used by ${twin.name}`);
    const cs = new ChangeSet();
    const { capacity: _c, ...rest } = { ...(was ?? {}), ...input } as Van & { capacity?: number | null }; void _c;
    const van = cs.put<Van>('vans', { ...rest, name, number, driverId: input.driverId || undefined, ...(cap !== undefined ? { capacity: cap } : {}), active: was ? was.active : true }, was ? 'van changed' : 'van added');
    await linkDriver(cs, van, was?.driverId, all);
    await cs.commit(was ? 'Van changed' : 'Van added');
    return van;
  } finally { saving.delete(lock); }
}

/** one van per driver: the driver's staff record points at this van; another van that had him lets go; an old driver lets go */
async function linkDriver(cs: ChangeSet, van: Van, oldDriver: string | undefined, all: Van[]) {
  const staff = new Map((await db.staff.toArray()).map(s => [s.id, s]));
  if (oldDriver && oldDriver !== van.driverId) { const s = staff.get(oldDriver); if (s?.vanId === van.id) cs.put<Staff>('staff', { ...s, vanId: undefined }, 'van unassigned'); }
  if (!van.driverId) return;
  for (const v of all) if (v.id !== van.id && v.driverId === van.driverId) cs.put<Van>('vans', { ...v, driverId: undefined }, 'driver moved to another van');
  const d = staff.get(van.driverId);
  if (d && d.vanId !== van.id) cs.put<Staff>('staff', { ...d, vanId: van.id }, 'van assigned');
}

/** what removing a van would do: blocked (with the reason), hide (it has history) or delete (nothing points at it) */
export async function vanRemoval(id: string): Promise<{ mode: 'delete' | 'hide'; block?: string }> {
  const v = await db.vans.get(id);
  if (!v) return { mode: 'delete', block: 'Van not found.' };
  const trips = (await db.trips.toArray()).filter(t => t.vanId === id);
  if (trips.some(t => t.status !== 'done')) return { mode: 'hide', block: `${v.name} has a trip open. Finish it first` };
  const bills = (await db.invoices.toArray()).filter(i => i.vanId === id && !i.cancelled);
  if (bills.some(i => i.deliveryStatus === 'planned' || i.deliveryStatus === 'out')) return { mode: 'hide', block: `${v.name} has bills waiting to go out. Move them to another van first` };
  const history = trips.length > 0 || bills.length > 0 || (await db.expenses.toArray()).some(e => e.vanId === id);
  return { mode: history ? 'hide' : 'delete' };
}

/** delete or hide a van: either way it leaves every list (active = false) and its driver link clears. Nothing is erased,
 *  so a trip or expense from before still shows its name. Safe to tap twice. */
export async function removeVan(id: string): Promise<'delete' | 'hide'> {
  const r = await vanRemoval(id);
  if (r.block) throw new Error(r.block);
  const v = (await db.vans.get(id))!;
  if (!vanActive(v)) return r.mode;
  const cs = new ChangeSet();
  cs.put<Van>('vans', { ...v, active: false, driverId: undefined }, r.mode === 'hide' ? 'van hidden' : 'van deleted');
  if (v.driverId) { const d = await db.staff.get(v.driverId); if (d?.vanId === id) cs.put<Staff>('staff', { ...d, vanId: undefined }, 'van unassigned'); }
  await cs.commit(r.mode === 'hide' ? 'Van hidden' : 'Van deleted');
  return r.mode;
}
