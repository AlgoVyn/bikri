# 03 — PIN lock

**Route** `/lock`. Shown at app start (after enrolment and setup), on auto-lock (default 10 min idle), on `Ctrl+L`, and on rail avatar → Lock. Rules: [05 §4](../05-auth-and-roles.md#4-staff-pins-and-session).

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan web-pin-unlock](../reference/dukaan/web-pin-unlock.png) | Profile chips + numeric keypad, big touch targets |

## Layout

Full screen, app background, following the device theme selected in Settings → Scanner & display (light, dark or system). Top-start: the Bikri logo mark and wordmark with the shop name underneath. Top-end: sync badge, printer status and language switcher. Center: "Who's selling?" then a row of profile chips (initials avatar, name, role tag), active staff only, ordered owner → managers → cashiers then name. After choosing a profile: 4–6 PIN dots and a 3×4 keypad (1–9, `Clear`, 0, `⌫`). Bottom: clock and date (Asia/Karachi), "Carts and held bills are kept while locked."

If only one active staff exists, the chip is pre-selected.

## Behaviour

- Physical keyboard digits, numpad digits and Urdu digits work. `Backspace` deletes, `Esc` clears / returns to chip selection.
- Auto-submit when the PIN length for that staff is reached (no Enter needed).
- Wrong PIN: dots shake (200 ms; disabled with `prefers-reduced-motion`), "Wrong PIN, n tries left before a 5-minute lock".
- Lockout per profile as in 05 §4: profile chip shows "Locked for 4:59" countdown.
- Success: returns to the route that was active before locking (default `/sell` for cashiers, `/` for owner/manager).
- "Forgot PIN?" link: cashiers → "Ask the owner to reset it in Settings → Cashiers"; owner → "Another owner of your shop can reset it in Settings → Cashiers. If you are the only owner, contact Algovyn (the platform operator) to reset it after checking it's you" ([05 §3](../05-auth-and-roles.md#3-shop-admin-on-admin-devices)).

## Acceptance criteria

1. Correct PIN unlocks in < 300 ms on a mid-range phone (PBKDF2 150k in WebCrypto).
2. 5 wrong tries lock that profile for 5 minutes while other profiles still work.
3. Locking with an open cart and unlocking as another cashier keeps the cart; the sale records the second cashier.
4. Idle 10 minutes on any screen locks; a print job in progress still completes.
5. Works fully offline.
