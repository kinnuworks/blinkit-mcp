# Milk man — Alexa skill (Blinkit, 4 × one milk SKU)

One phrase → four Vijaya Dairy Gold Full Cream Milk (500 ml) to the saved Vijayawada home address
(id 153331019), paid by UPI. Runs in an Alexa-hosted Lambda; imports the blinkit library from `./lambda/blinkit`
(vendored from `dist/`). No MCP at runtime.

```
"Alexa, ask milk man to order milk"
  → stock check → server cart → bind address 153331019 → validate
  → "4 Vijaya Gold full cream milk at 39 rupees each. Your total including fees is 166 rupees … Shall I place the order?"
"Yes"
  → createOrder → Cash on Delivery via zpaykit (method id 1 "cash") → "Done. Pay 166 rupees in cash when it arrives."
     (payment="upi" instead: UPI collect to your VPA, fallback upi:// link on an Alexa-app card)
```

Nothing is substituted. Nothing is paid without the spoken total and a "yes". The `cart_id` lives only
in Alexa session attributes and expires after 5 minutes.

## Layout

| Path | What |
|---|---|
| `lambda/index.js` | Handlers: Launch (smoke test), `OrderMilkIntent`, `AMAZON.YesIntent` (guarded), No/Stop/Help/Fallback, error handler |
| `lambda/store.js` | DynamoDB-backed session store (`useSessionStore`) — one item `{ id: "blinkit", … }` |
| `lambda/blinkit/` | Vendored library (`scripts/build-lambda.sh` regenerates from `dist/`) |
| `lambda/package.json` | `impit` **0.14.1** pinned, ask-sdk, aws-sdk v3 |
| `skill-package/` | Manifest + interaction model (`en-IN`, `en-US`, `en-GB`), invocation **"milk man"** |
| `test/local.mjs` | Drives the handler locally against live Blinkit (dry-run payment) |
| `../scripts/make-seed.mjs` | Builds the DynamoDB item from `~/.blinkit-mcp/session.json` (never prints the token) |

## Runbook

### 0. Local sanity (done 2026-09-02)
```bash
node alexa/test/local.mjs
```
Expected: launch OK; `OrderMilkIntent` quotes the real total (₹166 today: 4 × ₹39 + ₹10 handling, free delivery);
`YesIntent` dry-runs; the no-cart guard fires.

### 1. Create the skill (console; must be the SAME Amazon account as the Echo)
developer.amazon.com/alexa/console/ask → Create Skill → name **Milk Man**, locale **English (IN)** →
Custom → **Alexa-hosted (Node.js)** → Start from scratch.

**GATE 2 check happens here:** the hosting step shows the Node.js runtime. `impit`'s Linux binary needs
glibc ≥ 2.34 → the Lambda must be a **Node 20+ (Amazon Linux 2023)** runtime. Node 16/18 (Amazon Linux 2) **will not
load impit**. If only Node ≤ 18 is offered, skip hosted and use your own AWS account (step 7).

### 2. Interaction model
Build → Interaction Model → JSON Editor → paste `skill-package/interactionModels/custom/en-IN.json` → Save → Build.

### 3. Code
Code tab. Replace `lambda/index.js` and `lambda/package.json` with the ones here, add `lambda/store.js`, and
upload `lambda/blinkit/*.js` into a `blinkit/` folder. (Or `ask init --hosted-skill-id <id>` and copy `alexa/lambda/*`
into the cloned repo's `lambda/`, then `git push origin master`.) Deploy.

### 4. GATE 2 — impit smoke test
Test tab → enable Development → type `open milk man`.
- **"Milk man is ready. Blinkit connection OK in N milliseconds. Setup incomplete: missing access token…"** → impit
  loaded, TLS impersonation passed Cloudflare, plan is alive. The Lambda also created the DynamoDB item.
- **"Milk man could not reach Blinkit…"** → read the card/CloudWatch log. `GLIBC_2.34 not found` / `Cannot find module
  'impit-linux-x64-gnu'` = runtime too old → step 7.

### 5. Seed the config (DynamoDB only — never commit the token)
```bash
node scripts/make-seed.mjs            # payment=cod by default; add --payment upi --vpa you@ybl for UPI
```
writes `~/.blinkit-mcp/dynamo-seed.json`. Code tab → **"AWS resources"** link (bottom-left) → DynamoDB → the table →
Explore items → open item `id = blinkit` (created by the smoke test) → JSON view (DynamoDB JSON **off**) → replace
with the file's contents → Save. Delete the local seed file afterwards.

Fields: `access_token, device_id, session_uuid, user_id, phone, lat, lon, merchant_id` (from the login),
`address_id=153331019`, `address_spoken`, `product_id=564250`, `quantity=4`, `product_query`, `product_spoken`,
`payment` (`cod`|`upi`), `vpa`.

### 6. Test as text, then on the Echo
Test tab: `ask milk man to order milk` → hear the total → `no` (nothing charged). Repeat with `yes` for the first
real order — **open the Blinkit app and confirm the delivery address before it arrives.** A Development-stage skill
is live on every Echo on the same account; no publishing needed.

### 7. Fallback: own AWS account (if hosted is Node ≤ 18)
Lambda **nodejs22.x** (x86_64, 512 MB, 8 s timeout), zip `alexa/lambda` after `npm ci`, DynamoDB table with
partition key `id` (String), env `BLINKIT_TABLE=<table>`; give the role `dynamodb:GetItem/PutItem` on it. Seed with
`node scripts/make-seed.mjs --put` (needs AWS creds + `BLINKIT_TABLE`). Alexa trigger → skill endpoint = the Lambda ARN.

## Open risks
- **COD `makePayment` never fired yet.** `getPaymentMethods` lists "Cash on Delivery" (id 1, `cash`) as enabled for
  the ₹166 cart at this address, and `zomato_payment_hash` accepts the cash method (both verified 2026-09-02,
  read-only). The final `makePayment(cash)` call is the one that actually places the order, so it was NOT run.
  The first live "yes" is the test; the handler then reads `order_count.live_orders` and says whether it saw the order.
- **UPI collect unverified** (only matters if `payment=upi`). RESEARCH.md §9 says web zpaykit only advertises `upi_qr`; a `upi_collect` attempt once
  returned `failed`. The handler tries collect first (if `vpa` set) and falls back to the QR intent link on an Alexa-app
  card. Verify on the first real order.
- **Token expiry.** `gr_1_accessToken` cookie was set to expire 2026-09-09; the token itself may live longer. If
  Blinkit starts returning 401/FORCE_LOGOUT, re-login locally (`blinkit_send_otp` / `blinkit_verify_otp`) and re-seed.
- **8-second budget.** Turn 1 measured ~0.6 s from a Mac; Lambda cold start + impit init adds ~1 s. Fine.
- **`req_key` rotation.** If the bootstrap starts returning 400, Blinkit rotated the web bundle's request key.
  It's read from `BLINKIT_REQ_KEY`; hosted skills have no env-var UI, so edit the constant in `blinkit/client.js`.

## Keeping the token alive

The skill acts as you using one **access_token** (format `v2::<uuid>`) captured at login — an opaque
server-side session id, not a JWT with a readable expiry. Verified alive 2026-09-02. The `2026-09-09`
date you may have seen is only the browser **cookie's** expiry from the other (Playwright) app, not the
token's own lifetime; the token itself typically outlives that. There is **no refresh token** and login
is phone + OTP, so renewal cannot be fully hands-off — you type the SMS code once.

**When it dies** the skill detects the 401 and says *"Blinkit has logged me out. Please log in again on
the computer and update my token."* To fix (about two minutes):
```bash
node scripts/relogin.mjs <your-10-digit-phone>        # you enter the OTP; updates session.json
node scripts/make-seed.mjs                            # rebuild the DynamoDB item
# → paste ~/.blinkit-mcp/dynamo-seed.json into the "blinkit" item (Code tab → DynamoDB link)
```
On an own-AWS-account Lambda it's one step: `node scripts/relogin.mjs <phone> --put` (with `BLINKIT_TABLE` set).

You don't need the laptop to *order* — only to *re-login* on the rare occasions the token lapses.

