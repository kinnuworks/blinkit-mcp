# Milk man — Alexa skill (Blinkit, 4 × one milk SKU)

One phrase → four Vijaya Dairy Gold Full Cream Milk (500 ml) to the saved Vijayawada home address
(id 153331019), paid by UPI. Runs in an Alexa-hosted Lambda; imports the blinkit library from `./lambda/blinkit`
(vendored from `dist/`). No MCP at runtime.

```
"Alexa, ask milk man to order milk"
  → stock check → server cart → bind address 153331019 → validate
  → "4 Vijaya Gold full cream milk at 39 rupees each. Your total including fees is 166 rupees … Shall I place the order?"
"Yes"
  → createOrder → UPI collect to your VPA (fallback: upi:// link on an Alexa-app card) → "approve it in PhonePe"
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
node scripts/make-seed.mjs --vpa yourid@ybl
```
writes `~/.blinkit-mcp/dynamo-seed.json`. Code tab → **"AWS resources"** link (bottom-left) → DynamoDB → the table →
Explore items → open item `id = blinkit` (created by the smoke test) → JSON view (DynamoDB JSON **off**) → replace
with the file's contents → Save. Delete the local seed file afterwards.

Fields: `access_token, device_id, session_uuid, user_id, phone, lat, lon, merchant_id` (from the login),
`address_id=153331019`, `address_spoken`, `product_id=564250`, `quantity=4`, `product_query`, `product_spoken`, `vpa`.

### 6. Test as text, then on the Echo
Test tab: `ask milk man to order milk` → hear the total → `no` (nothing charged). Repeat with `yes` for the first
real order — **open the Blinkit app and confirm the delivery address before it arrives.** A Development-stage skill
is live on every Echo on the same account; no publishing needed.

### 7. Fallback: own AWS account (if hosted is Node ≤ 18)
Lambda **nodejs22.x** (x86_64, 512 MB, 8 s timeout), zip `alexa/lambda` after `npm ci`, DynamoDB table with
partition key `id` (String), env `BLINKIT_TABLE=<table>`; give the role `dynamodb:GetItem/PutItem` on it. Seed with
`node scripts/make-seed.mjs --put` (needs AWS creds + `BLINKIT_TABLE`). Alexa trigger → skill endpoint = the Lambda ARN.

## Open risks
- **UPI collect unverified.** RESEARCH.md §9 says web zpaykit only advertises `upi_qr`; a `upi_collect` attempt once
  returned `failed`. The handler tries collect first (if `vpa` set) and falls back to the QR intent link on an Alexa-app
  card. Verify on the first real order.
- **Token expiry.** `gr_1_accessToken` cookie was set to expire 2026-09-09; the token itself may live longer. If
  Blinkit starts returning 401/FORCE_LOGOUT, re-login locally (`blinkit_send_otp` / `blinkit_verify_otp`) and re-seed.
- **8-second budget.** Turn 1 measured ~0.6 s from a Mac; Lambda cold start + impit init adds ~1 s. Fine.
- **`req_key` rotation.** If the bootstrap starts returning 400, Blinkit rotated the web bundle's request key.
  It's read from `BLINKIT_REQ_KEY`; hosted skills have no env-var UI, so edit the constant in `blinkit/client.js`.
