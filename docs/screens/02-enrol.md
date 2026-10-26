# 02 — Enrol this device

**Route** `/enrol`. Shown whenever the browser has no active shop (`localStorage['bikri.active_tenant']` missing) or no valid device token (`kv.device_token` missing or `/api/me` returns `401 DEVICE_REVOKED` / `UNAUTHENTICATED`). The code decides which shop (tenant) the device joins; the screen never asks for or shows a shop list. Flow details: [05 §2](../05-auth-and-roles.md#2-device-enrolment).

No Dukaan screenshot: Dukaan uses a vendor account + trial activation, which Bikri deliberately does not have (REQ-B05).

## Layout

Centered card: Bikri wordmark, heading "Connect this device to your shop", two options as tabs (`?code=` in the URL pre-fills the code and opens tab 1; the code is removed from the address bar with `history.replaceState`):

1. **I have a code** — 8 character input (auto-uppercase, groups of 4 shown as `ABCD-EFGH`, ambiguous characters `0 O 1 I L` not used by the generator; input normalises them), Device name (text, default from user agent, e.g. "Chrome on Windows"), `Connect` button. A "Scan QR" button opens the camera (zxing-wasm) to read the QR shown in Settings → Devices on an admin device (or in the operator console).
2. **New shop** — explains "Setting up a new shop? Enter the owner pairing code you got from Algovyn. It works once and expires in 3 days." and switches to the same code field (owner pairing codes make this device an admin device, [05 §2](../05-auth-and-roles.md#2-device-enrolment)). There is no email or Access sign-in for shop owners.

Footer: language switcher; "Revoked?" helper text when the reason is `DEVICE_REVOKED`: "This device was disconnected by the owner. Unsynced sales were kept on this device." with button `Export unsynced data` ([03 §8](../03-sync.md#8-device-revocation-and-data-loss-window)).

After a successful `Connect`, a confirmation line shows the shop name from the response ("Connected to **Hall Road Mobiles**") before the download starts; `Not my shop?` revokes nothing but tells the user to ask the owner for the right code and runs "Leave this shop".

If the browser already belongs to another shop (`bikri.active_tenant` set, D-073), the screen first shows "This browser is connected to <shop>." with `Open <shop>` and `Leave that shop` (owner PIN; blocked while there are unsynced ops unless they were exported; deletes Dexie database `bikri-<old tenant_id>`).

## Validation and errors

| Case | Message |
|---|---|
| Code not 8 valid characters | "Enter the 8-character code from the owner" |
| `BAD_ENROLMENT_CODE` | "That code is wrong or expired. Ask the owner for a new one." |
| `TENANT_SUSPENDED` | "This shop's account is paused. Contact Algovyn." |
| `RATE_LIMITED` | "Too many tries. Wait a minute." |
| Offline | Button disabled; "You need internet to connect a device." |

## On success

Open (create) the Dexie database `bikri-<tenant_id>` from the response, set `localStorage['bikri.active_tenant'] = tenant_id`; store token in that database's `kv.device_token` (never localStorage), store `device_id`, `device_code`, `branch_id`, `is_admin`, `kv.tenant` (`id`, `display_name`) and `poll_after_ms`; call `navigator.storage.persist()`; run the initial full pull with a progress bar "Downloading your shop… 1,240 of 3,000"; then go to `/setup` (if not completed) or `/lock`.

## Acceptance criteria

1. A valid code enrols the device into the code's shop, and the device appears in that shop's Settings → Devices list (and the operator console) with the typed name; it never appears in another shop's list.
2. The same code used a second time returns "wrong or expired".
3. Lowercase and dashed input `abcd-efgh` works.
4. After revocation, the next sync shows this screen with the revoked notice, and local unsynced ops can be exported to a JSON file.
5. Token is not visible in `localStorage` or cookies.
6. An owner pairing code makes the device an admin device and leads to `/setup`; a 15-minute till code leads to the PIN lock after the initial download.
7. A browser connected to shop A cannot enrol into shop B until "Leave that shop" ran; afterwards no Dexie database or cache of shop A remains (isolation, [10 §8](../10-testing.md#8-cross-tenant-isolation-suite-mandatory)).
