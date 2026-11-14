# Small-balance round-off at collection — design (systems-engineer, 14 Nov 2026; GST rule from PART2_GST.md)
Small dues are never hidden (OWED = 0.005). A leftover is cleared only by an explicit, audited round-off made by a person.
1. Lives on the payment (existing synced table): optional `writeOff?: { amount; by; reason: 'round_off' }` on Payment (and
   `writeOffs?: {invoiceId, amount}[]` if one receipt rounds off several bills). No new table; no Dexie bump unless a store string
   changes; server stores Payment as JSON (confirm no migration).
2. `allocations` stay cash-only. Balance = bill − cash allocations − credit notes − write-offs, in ONE helper in ledger.ts
   (invoiceBalances); statement, ageing, OWED checks and cash-only blocks all read it. A payment may be write-off only (cash 0).
3. Who/how much: owner, office/accounts and the collecting salesman/driver, up to a per-bill cap — a firm setting, default ₹1.00,
   hard maximum ₹5.00, applied to the SUM of write-offs on a bill. It must equal the whole remaining balance after cash (> OWED,
   ≤ cap), never creates a credit; never on a bounced/cancelled payment; a cancelled/corrected payment reverses it via correctionOf.
4. Server enforces: recomputes the bill balance from its own rows; rejects wrong role, amount > cap, ≠ remaining balance, bill not
   found / other distributor / already settled. Two phones offline: first sync wins, second rejected "already settled" (shown in
   sync problems). Idempotency key = payment id + invoiceId.
5. Audit row per write-off (who, shop, bill, amount, balance before, cap, server time; UTC stored, IST shown). Weekly owner report
   by person; count + total in the owner's day close.
6. Ledger: one line "Round-off / write-off" with the receipt number (receipt "Cash ₹X + Round-off ₹0.40"); statement credit
   against that bill; balance exactly 0.00.
7. P&L: indirect expense "Round-off / write-off"; sales, taxable value and GST unchanged.
8. GSTR-1: no change (not a credit note, not CDNR, not the bill's roundOff field) — test: GSTR-1 JSON byte-identical before/after.
   GST specialist to confirm the shop-side wording "settlement rounding".
9. Tally receipt voucher: Cr shop (cash + write-off), Dr cash/bank (cash), Dr "Round-off Written Off" (expense); balanced to the paisa.
10. Collect UI: when cash leaves a balance in (OWED, cap] on a bill → one button "Round off ₹0.40"; disabled after the first tap;
    hidden when role/cap don't allow; nothing auto-clears.
11. TESRAX: "Round off ₹0.40 on bill INV-123" / "Write off 40 paise on this bill" — same cap, role, audit; one-tap confirm.
12. Tests first: ₹0.40 open until write-off; ₹1.50 refused at cap ₹1; wrong role refused by the server; double tap = one entry;
    cancel reverses; GSTR-1 unchanged; Tally voucher balanced; P&L expense; audit row exists.
