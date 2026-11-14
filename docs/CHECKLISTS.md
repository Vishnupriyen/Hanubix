# Developer self-check before handing over (owner, 14 Nov 2026 — built from the team's findings so reviews find less)
Tick every line that applies before you report "done". A reviewer finding something on this list is a miss.

## Data and security (security-operations findings)
- [ ] Every new or changed field is enforced on the SERVER (server/src/rules.ts), not only on the phone: who may write it, which
      status moves each role may make, ownership (a salesman/rep only his own rows), allowed ranges (e.g. Disc % 0–100).
- [ ] Non-owner/office roles cannot change rates, discounts, approvals or another person's records by a crafted sync push.
- [ ] Logs and histories only grow (prefix check); the actor is stamped from the token, never trusted from the phone.
- [ ] A server-side refusal returns a clear message to the phone; one sync() integration test per refusal.
- [ ] Personal phone data (chats, My files, drafts) never goes into backups or another person's view; wiped on logout/removal.
- [ ] Stock can never go below zero; double taps and retries write once (deterministic ids or locks).

## Money and GST (gst-accounts-specialist findings)
- [ ] Every paisa owed stays visible (no hiding small balances); write-offs only by an explicit, audited entry.
- [ ] Line-level maths: discount before tax, tax rounded per line then summed, totals match to the paisa; a test with real numbers.
- [ ] Anything keyed by product must also work with the same product on two lines (use line numbers, not productId).
- [ ] Claims to companies use what was actually given, never the scheme's full value.
- [ ] Exports (GSTR-1, Tally, e-invoice) use the same rules and keys as the printed bill (HSN + UQC + rate).

## Look (ui-designer findings)
- [ ] 360 px and 412 px: no sideways scroll, nothing under the TESRAX sphere, nothing cut.
- [ ] Every tap target ≥ 44 px (including small buttons, chips and date inputs); inputs share one style.
- [ ] Only the type-scale tokens --f1..--f6; the same control looks the same on every screen.
- [ ] No card inside a card; clear spacing between headings, fields and buttons.

## TESRAX (tesrax-language-specialist findings)
- [ ] New screens and actions have English phrases incl. messy/short forms; TESRAX answers in place (no auto-jump).
- [ ] Screen words don't swallow question words (e.g. "orders to approve" answers, "orders received" opens).

## Tests
- [ ] Regression test written FIRST for every bug; touched test files + e2e flow/company + 360 px sweep green locally.
