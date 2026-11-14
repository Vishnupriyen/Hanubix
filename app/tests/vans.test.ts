// Part 2 step 2a, item 12 (docs/PART2_SPEC.md, PART2_UX.md): vans — add, edit, delete or hide, capacity, unique numbers,
// blocked while a trip is open or a bill waits on it; a hidden van keeps its name in old trips and expenses.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ChangeSet, db, setSession, today } from '../src/core/db';
import { seedDemo } from '../src/core/seed';
import { activeVans, removeVan, saveVan, vanRemoval } from '../src/core/vans';
import { handle } from '../src/core/engine';
import type { Trip, Van } from '../src/core/types';

let owner = '', driver = '';
beforeAll(async () => {
  await seedDemo();
  const st = await db.staff.toArray();
  owner = st.find(s => s.role === 'owner')!.id; driver = st.find(s => s.role === 'delivery')!.id;
});
beforeEach(() => setSession('demo', owner));
const byName = async (name: string) => (await db.vans.toArray()).find(v => v.name === name);

describe('vans: add and edit', () => {
  it('adds a van with capacity (cases per trip); empty capacity = no limit', async () => {
    const v = await saveVan({ name: 'Van 7', number: 'TN 31 AZ 7777', kind: 'own', capacity: 40 });
    expect(v).toMatchObject({ name: 'Van 7', capacity: 40, active: true });
    const w = await saveVan({ name: 'Van 8', number: 'TN 31 AZ 8888', kind: 'auto' });
    expect(w.capacity).toBeUndefined();
  });
  it('a double tap makes one van', async () => {
    const before = (await db.vans.toArray()).length;
    await Promise.allSettled([saveVan({ name: 'Van 9', number: 'TN 31 AZ 9999', kind: 'own' }), saveVan({ name: 'Van 9', number: 'TN 31 AZ 9999', kind: 'own' })]);
    expect((await db.vans.toArray()).length).toBe(before + 1);
  });
  it('van numbers are unique among active vans (spaces and case do not matter)', async () => {
    await expect(saveVan({ name: 'Van X', number: 'tn31az7777', kind: 'own' })).rejects.toThrow('Number already used by Van 7');
    // the guard holds it too, for any path that saves a van
    const cs = new ChangeSet(); cs.put<Van>('vans', { name: 'Sneaky', number: 'TN 31 AZ 7777', kind: 'own' });
    await expect(cs.commit('t')).rejects.toThrow(/Number already used by Van 7/);
  });
  it('capacity must be a whole number more than 0; a name is needed', async () => {
    await expect(saveVan({ name: 'Van Y', number: 'TN 1', kind: 'own', capacity: 2.5 })).rejects.toThrow('Cases per trip must be a whole number');
    await expect(saveVan({ name: ' ', number: 'TN 2', kind: 'own' })).rejects.toThrow('Give the van a name');
  });
  it('edit: a new driver takes the van; the old driver\'s link is cleared', async () => {
    const v = (await byName('Van 7'))!;
    await saveVan({ ...v, driverId: driver });
    expect((await db.staff.get(driver))!.vanId).toBe(v.id);
    const w = (await byName('Van 8'))!;
    await saveVan({ ...w, driverId: driver }); // the same driver moves to Van 8
    expect((await byName('Van 7'))!.driverId).toBeUndefined();
    expect((await db.staff.get(driver))!.vanId).toBe(w.id);
  });
});

describe('vans: delete or hide', () => {
  it('a van with no history is deleted (gone from every list)', async () => {
    const v = await saveVan({ name: 'Van D', number: 'TN 31 DD 1', kind: 'own' });
    expect((await vanRemoval(v.id)).mode).toBe('delete');
    await removeVan(v.id);
    expect((await activeVans()).some(x => x.id === v.id)).toBe(false);
  });
  it('an open trip blocks it: "Van 2 has a trip open. Finish it first"', async () => {
    const v = await saveVan({ name: 'Van 2b', number: 'TN 31 TT 2', kind: 'own' });
    const cs = new ChangeSet(); cs.put<Trip>('trips', { vanId: v.id, date: today(), status: 'out', stops: [], track: [] }); await cs.commit('t');
    expect((await vanRemoval(v.id)).block).toBe('Van 2b has a trip open. Finish it first');
    await expect(removeVan(v.id)).rejects.toThrow('Van 2b has a trip open. Finish it first');
  });
  it('a van with history is hidden, never erased: last month\'s trip report still shows its name; the driver link clears', async () => {
    const v = await saveVan({ name: 'Van H', number: 'TN 31 HH 1', kind: 'hired', driverId: driver });
    const cs = new ChangeSet(); cs.put<Trip>('trips', { vanId: v.id, date: '2026-10-10', status: 'done', stops: [], track: [] }); await cs.commit('t');
    expect((await vanRemoval(v.id)).mode).toBe('hide');
    await removeVan(v.id);
    const kept = (await db.vans.get(v.id))!;
    expect(kept).toMatchObject({ name: 'Van H', active: false }); expect(kept.driverId).toBeUndefined();
    expect((await db.staff.get(driver))!.vanId).toBeUndefined();
    expect((await activeVans()).some(x => x.id === v.id)).toBe(false);
    // its number is free again for a new active van
    await saveVan({ name: 'Van H2', number: 'TN 31 HH 1', kind: 'own' });
    // editing the hidden van (its name, for old reports) keeps it hidden — it never comes back with a number in use
    const edited = await saveVan({ id: v.id, name: 'Van H (old)', number: 'TN 31 HH 1', kind: 'hired' });
    expect(edited.active).toBe(false);
    expect((await activeVans()).filter(x => x.number === 'TN 31 HH 1').map(x => x.name)).toEqual(['Van H2']);
  });
  it('removing twice is safe', async () => {
    const v = await saveVan({ name: 'Van T', number: 'TN 31 T 1', kind: 'own' });
    await Promise.allSettled([removeVan(v.id), removeVan(v.id)]);
    expect((await db.vans.get(v.id))!.active).toBe(false);
  });
});

describe('vans: TESRAX', () => {
  it('"vans" opens the Vans screen; "add van TN31 driver ravi" answers with the next step', async () => {
    expect((await handle('vans', [], {})).go).toBe('vans');
    const r = await handle('add van TN31 driver ravi', [], {});
    expect(r.go).toBe('vans');
  });
});
