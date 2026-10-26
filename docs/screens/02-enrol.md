# 02 — Enrol this device

**Route** `/enrol`. Shown whenever the browser has no valid device token (`kv.device_token` missing or `/api/me` returns `401 DEVICE_REVOKED` / `UNAUTHENTICATED`). Flow details: [05 §2](../05-auth-and-roles.md#2-device-enrolment).

No Dukaan screenshot: Dukaan uses a vendor account + trial activation, which Bikri deliberately does not have (REQ-B05).

## Layout

Centered card: Bikri wordmark, heading "Connect this device to your shop", two options as tabs:

1. **I have a code** — 8 character input (auto-uppercase, groups of 4 shown as `ABCD-EFGH`, ambiguous characters `0 O 1 I L` not used by the generator; input normalises them), Device name (text, default from user agent, e.g. "Chrome on Windows"), `Connect` button. A "Scan QR" button opens the camera (zxing-wasm) to read the QR shown on the admin page.
2. **I'm the owner** — explains "Sign in with your owner email to connect this browser" and a button `Owner sign-in` that navigates to `/admin/enrol-this-browser` (Cloudflare Access login; after the token is stored the browser goes to `/`, and the router sends it to `/setup` or the PIN lock).

Footer: language switcher; "Revoked?" helper text when the reason is `DEVICE_REVOKED`: "This device was disconnected by the owner. Unsynced sales were kept on this device." with button `Export unsynced data` ([03 §8](../03-sync.md#8-device-revocation-and-data-loss-window)).

## Validation and errors

| Case | Message |
|---|---|
| Code not 8 valid characters | "Enter the 8-character code from the owner" |
| `BAD_ENROLMENT_CODE` | "That code is wrong or expired. Ask the owner for a new one." |
| `RATE_LIMITED` | "Too many tries. Wait a minute." |
| Offline | Button disabled; "You need internet to connect a device." |

## On success

Store token in IndexedDB `kv.device_token` (never localStorage), store `device_id`, `device_code`, `branch_id`; call `navigator.storage.persist()`; run the initial full pull with a progress bar "Downloading your shop… 1,240 of 3,000"; then go to `/setup` (if not completed) or `/lock`.

## Acceptance criteria

1. A valid code enrols the device, and the device appears in the admin devices list with the typed name.
2. The same code used a second time returns "wrong or expired".
3. Lowercase and dashed input `abcd-efgh` works.
4. After revocation, the next sync shows this screen with the revoked notice, and local unsynced ops can be exported to a JSON file.
5. Token is not visible in `localStorage` or cookies.
