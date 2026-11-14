# Next chat — start here ("hanu tech 5", from 14 Nov 2026, 23:00)

Read this, then `CLAUDE.md`, `docs/HANDOVER.md` (top sections + "Part 2 build log"), `docs/CHECKLISTS.md`. Branch `apk`.
**Always `git fetch origin apk` and read `git log --oneline origin/apk -15` first — never trust commit ids or check results here.**

## How the owner wants work done now (all in CLAUDE.md)
- The main chat is the MANAGER only: every piece of work goes to a team agent (developer, independent-tester, ui-designer,
  security-operations, gst-accounts-specialist, tesrax-language-specialist, business-analyst, systems-engineer, ux-designer,
  check-runner). Pick the work size first (small / medium / big). Reviewers run in PARALLEL; one combined fix job per batch;
  the developer ticks docs/CHECKLISTS.md; no local full gate (GitHub's Quality gate is the gate; fix red before moving on).
- **Owner approved (14 Nov 18:57) running Parts 2–5 through the team without his per-part yes.** Stop only for anything that can't
  be undone (real data, payments, merging to main). He gets one short update per batch.
- **Speed + usage (owner, 14 Nov 23:00): run 2 developers in parallel**, each in its own git worktree, on parts that don't touch the
  same files; reviewers/checks on cheaper models (sonnet/haiku). Keep this chat short; suggest a fresh chat once when it gets long.
- Plain simple words, one recommendation, critically evaluate the owner's ideas (point out problems and better options).

## Where things stand (14 Nov night)
- **Part 1 (look & TESRAX): DONE**, green, APK out. Bigger sphere with TESRAX inside the disc; bar everywhere; Home = 6 modules;
  Menu cards + Business Boost; type scale 11/12/14/16/20/26; TESRAX answers in place with Excel/PDF; My files + chat history
  (30 days, per person, phone only; wiped at logout/removal/erase; not in backups).
- **Part 2 (bill & delivery) — plan:** docs/PART2_SPEC.md, PART2_UX.md, PART2_SYSTEMS.md, PART2_GST.md, WRITEOFF_DESIGN.md.
  - **Batch 1 (2a0, 2a, 2b, 2c, 2d) DONE + reviewed + fixed** (security blockers on order sync closed, GRN per-line shortages,
    scheme claims as given, every paisa owed shown (OWED = 0.005), 44 px targets). Gate fix a2685d0 (godown may open Verify picked,
    never bills).
  - **Step 2n (bill/CN/receipt numbers restart every 1 April, ≤16 chars, `P/YY-YY/NNNNNN`)**: the chat-4 developer was told to
    finish, push and stop — CHECK `git log` for it. If it is not on origin/apk, redo 2n from PART2_GST.md §2.
  - **Batch 2 still to build:** 2e (unit, delivery address, GST-shop address guard, billTo snapshot, ₹5 crore e-invoice warning),
    2f (printed bill to Rule 46 + PART2_GST §1, 3 copies), 2g (bill card + View full bill), 2w (round-off at collection,
    WRITEOFF_DESIGN.md).
  - **Batch 3 still to build:** 2h (Settings → Shops + upload with check — the shared upload piece Part 3 reuses), 2i (Select
    shops), 2j (load sheet per van), 2k/2l (outside PDF bills: pdfjs-dist text layer on the phone, externalBills table, split across
    vans, "Dues collected for other suppliers"; issuer in the duplicate key per PART2_GST §5).
  - **Pending:** the independent tester's live two-phone/offline + GST-example check of batch 1 was started in chat 4 and may not
    have reported — rerun it (use a separate git worktree so it never touches the developer's tree).
- **Parts 3, 4, 5:** not started. Items in docs/HANUBIX_CORRECTIONS_LOCKED.md (Part 3: 17–24, 35; Part 4: 14, 15, 25–32, 36, 39,
  46, 47; Part 5: 37, 38, 40–42, 45, 48).

## Suggested order for the 2 parallel developers
- **Developer A:** Part 2 batch 2 (2e, 2f, 2g, 2w), then batch 3 (2h–2l). Bills/GST/collection files.
- **Developer B:** Part 3 planning (business-analyst + parallel systems/UX/GST reviews of the plan), then build Part 3 — but its
  "upload with check" templates must reuse 2h's shared piece: B builds the shared upload piece FIRST as its own small step and A's
  2h uses it (agree the file name in the plan), or B starts with items that don't need uploads (19 beats, 20–22 purchase renames,
  23 Samples & Free, 24 ageing to Reports).
- Part 4 starts after Part 2 batch 2 (it builds on billing/collection). Part 5 after Part 3.

## Owner-to-do (not app work)
Hostinger KVM 2 + domain; server IP/login; Google Maps key (MAPS_API_KEY secret); WhatsApp number for Business Boost
(VITE_SUPPORT_WHATSAPP); security items in HANDOVER (age key, deploy/.env values, GCS bucket, sign policies).
