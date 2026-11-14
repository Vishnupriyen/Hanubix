// The owner's two Home numbers (founder, 14 Nov 2026 — item 7). Each uses the app's own rule, so Home never disagrees with
// the screen behind it: sales = this month's net sales before GST, after credit notes (as Reports, GST and TESRAX say);
// outstanding = what active shops still owe (as the Outstanding screen counts it).
import { activeShops } from './db';
import { invoiceBalances, OWED } from './ledger';
import { period, salesSummary } from './reports';
import { r2 } from './ledger';

export async function ownerNumbers(): Promise<{ sales: number; outstanding: number }> {
  const sales = (await salesSummary(period('month'))).net.taxable;
  const shops = new Set((await activeShops()).map(s => s.id));
  const outstanding = r2((await invoiceBalances()).filter(b => b.balance > OWED && shops.has(b.invoice.shopId)).reduce((a, b) => a + b.balance, 0));
  return { sales, outstanding };
}
