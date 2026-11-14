// TESRAX round 10 (12 Nov 2026, owner: "each and every word of the app and every report it should send").
// ~4,800 real-style sentences (tests/tesrax-r10-set.ts): every screen by every role that may open it, every report with every
// period, every export, and the common actions — polite and long forms, voice-typing splits, short forms, typos, plurals.
// A role that may not open a screen is never sent there. Each group lists every miss at once.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { db, setSession } from '../src/core/db';
import { seedDemo } from '../src/core/seed';
import { handle, SCREENS } from '../src/core/engine';
import { buildReports } from '../src/core/reports';
import { periodIn } from '../src/core/reportsVoice';
import type { Role } from '../src/core/types';
import { code, loadNames } from './tesrax-code';
import { PROBES, SCREEN_ROLES, type Probe } from './tesrax-r10-set';
const ids: Partial<Record<Role, string>> = {};
beforeAll(async () => { await seedDemo(); await loadNames(); for (const s of await db.staff.toArray()) ids[s.role] ??= s.id; });

const TOKEN: Record<string, RegExp> = { today: /^Today/, yesterday: /^Yesterday/, 'this week': /^This week/, 'last week': /^Last week/, 'this month': /^This month/, 'last month': /^(?!This|Today|Yesterday|Last)/, october: /^Oct/, '90 days': /^Last 90/ };
async function misses(list: Probe[]): Promise<string[]> {
  const names = new Map((await buildReports(periodIn('this month'))).map(r => [r.en, r.key]));
  const bad: string[] = [];
  for (const p of list) {
    setSession('demo', ids[p.role]!);
    const r = await handle(p.s, [], {});
    const got = code(r);
    let ok: boolean;
    if (p.exp.startsWith('report:')) {
      const [, key, tok] = p.exp.split(':');
      const m = r.text.match(/^(.*?) — (.*?):/);
      const label = m?.[2] ?? r.text.match(/for (.*?) in one Excel/)?.[1] ?? '';
      ok = (key === 'all' ? /^All \d+ reports/.test(r.text) : names.get(m?.[1] ?? '') === key) && TOKEN[tok].test(label);
    } else if (p.exp === 'refused') ok = !!r.refused;
    else if (p.exp.startsWith('!')) ok = got !== p.exp.slice(1) && !r.go;
    else if (p.exp.startsWith('~')) ok = new RegExp(p.exp.slice(1)).test(got);
    else ok = got === p.exp;
    if (!ok) bad.push(`${p.role}: "${p.s}" → ${got} (want ${p.exp})`);
  }
  return bad;
}
const part = (f: (p: Probe) => boolean) => PROBES.filter(f);
describe('round 10: every word of the app', () => {
  it('screens opened by name, by every role that may', async () => { expect(await misses(part(p => p.exp.startsWith('go:')))).toEqual([]); }, 600000);
  it('a role that may not open a screen is never sent there', async () => { expect(await misses(part(p => p.exp.startsWith('!')))).toEqual([]); }, 600000);
  it('every report, every period', async () => { expect(await misses(part(p => p.exp.startsWith('report:')))).toEqual([]); }, 600000);
  it('every file: Tally, GSTR-1, e-invoice, claim file; staff are told no', async () => { expect(await misses(part(p => p.exp.startsWith('export:') || p.exp === 'refused'))).toEqual([]); }, 600000);
  it('orders, payments, returns, cancels, expenses, help, undo, balances', async () => {
    expect(await misses(part(p => /^(order|~|help)/.test(p.exp) && !p.exp.startsWith('go:')))).toEqual([]);
  }, 600000);
  it('who may open each screen: the set agrees with the app\'s one screen table (core/engine.ts SCREENS)', () => {
    const app = new Map(SCREENS.map(s => [s.page, [...s.roles].sort().join(',')]));
    const off = SCREEN_ROLES.filter(([page, roles]) => app.has(page) && app.get(page) !== [...roles].sort().join(',')).map(([p, r]) => `${p}: set ${[...r].sort().join(',')} / app ${app.get(p)}`);
    expect(off).toEqual([]);
  });
  it('the set is complete (screens, reports, files and actions all present)', () => { expect(PROBES.length).toBeGreaterThan(1500); });
});
