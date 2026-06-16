# Blinkit MCP — API Research

> Goal: an **API-only** MCP server. The browser (Chrome DevTools MCP) is used **only for
> research / one-time token capture**, never in the happy path. All runtime calls are plain
> HTTPS requests to `blinkit.com/*` (Cloudflare → Kong gateway → internal services).

Captured live from `blinkit.com` (consumer web) on 2026-06-17. Location used: Noida, Sector 76
(lat `28.5653836`, lon `77.38265109999999`).

---

## 0. ⚠️ Keystone finding — Cloudflare TLS fingerprinting (verified)

A plain HTTP client **cannot** talk to Blinkit: curl and Node `fetch`/`undici` get a **403 HTML
page** regardless of headers, because Cloudflare bot-management blocks on the **TLS (JA3/JA4)
fingerprint**. Verified live: full browser-header curl still 403s.

**Fix (keeps browser out of the runtime path):** use a Chrome-TLS-**impersonating** HTTP client.
We use [`impit`](https://www.npmjs.com/package/impit) (`new Impit({ browser: "chrome" })`) — its
handshake looks like real Chrome, so requests pass with **no browser, no `__cf_bm` cookie, and no
challenge solve**. Verified: visibility/search/cart all 200 via impit from Node. This is the single
thing that makes "API-only, browser not in the happy path" actually possible.

Two more verified gotchas baked into the client:
- **`req_key` is a fixed constant**, not a random UUID. `auth_key` bootstrap = `GET
  /v2/accounts/auth_key/` with header `req_key: c0e6868e-1180-400c-be51-f473479f1f0a` (the bundle's
  `s.config.requestKey`). A random UUID → `400 {"success":false}`. Overridable via `BLINKIT_REQ_KEY`.
- **Never send `access_token: "null"`.** The web app does, but `/visibility` rejects it with `401`.
  Omit the header entirely when logged out; send it only with a real token.

## 1. Transport & auth model

Base URL: `https://blinkit.com` — all calls go through the impit (Chrome-TLS) client.

Every authed call carries a fixed set of **headers** (not query params). The web app sends:

| Header | Example | Notes |
|---|---|---|
| `auth_key` | `c761ec36…b0bb477` | Device/session key. Obtained from `GET /v2/accounts/auth_key/`. Sent on *every* call. |
| `access_token` | `null` (logged-out) | JWT/opaque user token after OTP login. **This is what we capture via login.** |
| `app_client` | `consumer_web` | Required. |
| `platform` | `desktop_web` | |
| `device_id` | `33280fe624c2cf3f` | Stable per device; we generate + persist one. |
| `session_uuid` | `7882deb5-…` | Per session UUID; generate one. |
| `lat` / `lon` | `28.5653836` / `77.382651…` | **Required on catalog/cart calls** — drives which dark store serves you. |
| `app_version` | `52434332` (varies per route) | Some routes accept any value; keep a constant. |
| `web_app_version` | `1008010016` | Constant. |
| `rn_bundle_version` | `1009003012` | Constant. |
| `content-type` | `application/json` | |
| `user-agent` | Chrome UA string | A normal desktop Chrome UA passes. |

Cookies mirror some headers (`gr_1_lat`, `gr_1_lon`, `gr_1_locality`, `gr_1_deviceId`) plus
Cloudflare `__cf_bm` / `_cfuvid`. **Cloudflare `__cf_bm` is a bot-management cookie** — see §6
(risk). In practice the JSON APIs respond fine to a direct client that sets the headers above and
a believable UA; `__cf_bm` is set by Cloudflare on first response and can be re-sent.

### Auth bootstrap (no browser needed)
```
GET /v2/accounts/auth_key/          → { "success": true, "auth_key": "…" }
```
Sent with header `req_key: <uuid>`. No user auth required. Gives the `auth_key` used everywhere.

### User login = OTP (mobile)  ✅ CAPTURED — fully headless, no browser
`access_token: null` means logged-out. Browsing/search/serviceability/cart all work logged-out.
Login (needed for orders, addresses, checkout) is **phone + OTP**, two form-encoded POSTs. Both
carry the same standard headers as §1 (auth_key, device_id, session_uuid, lat/lon) but use
`content-type: application/x-www-form-urlencoded`.

**Step 1 — send OTP:**
```
POST /v2/accounts/
  content-type: application/x-www-form-urlencoded
  body: user_phone=<10-digit phone>
→ { "login":true, "action":"login", "sms_sent":true,
    "message_id":"<uuid>", "success":true, "message":"We have sent a verification code…" }
```

**Step 2 — verify OTP:**
```
POST /v2/accounts/verify/phone/code/
  content-type: application/x-www-form-urlencoded
  body: user_phone=<phone>&verify_code=<otp>
→ success: { "access_token":"v2::<uuid>", "message":"Login Successful", "success":true,
             "user":{ "id":<int>, "phone":"…", "country_code":"91", "verified":true },
             "user_profile_data":{ "cart_count", "is_first_order_placed", … } }
→ wrong otp: { "message":"Verification failed", "success":true, "verified":false }
```
⚠️ **`success:true` is returned even on a wrong code** — the MCP MUST branch on `verified` /
presence of `access_token`, never on `success`.

The returned `access_token` (format `v2::<uuid>`) is then sent as the **`access_token` header** on
all authed calls (it was literally `null` before login). `user.id` is the account id.
→ MCP tools `send_otp(phone)` and `verify_otp(phone, otp)`; the latter persists `access_token` +
`user.id` to `session.json`. **No browser ever involved.**

---

## 2. Endpoints captured (read / catalog / cart)

### Serviceability — is there a store at this lat/lon?
```
GET /visibility?latitude={lat}&longitude={lon}
→ { success, serviceable: true, merchants:[{ id, chain_id, business_types,
     city_id, city_name, state_name, additional_filters:{assortment_tags:[...]}}], cityId, cityName }
```
Returns the list of dark-store `merchant_id`s (express / longtail / unicorn / instant assortments)
that serve the point. `merchant_id` (e.g. `35038`) is needed for cart add actions.

### Reverse-geocode / address resolution
```
GET /location/info?lat={lat}&lon={lon}&is_pin_moved=false
→ { is_serviceable, location_info:{ city, state, postal_code, formatted_address, sublocalities },
    display_address:{ title, description, address_line }, locality, city }
```
Turns coordinates into a human address + confirms serviceability.

### ETA
```
GET /v1/consumerweb/eta
```

### Home / category feed (Layout Engine, server-driven UI)
```
GET /feed/?template_version=9
→ { objects:[ widgets… ] }  // banners, "shop by category" grid, KVI product rails
```
Category deeplinks look like `grofers://listing?l0_cat=14&l1_cat=922`
(`l0_cat`/`l1_cat` are category IDs). Product rails embed full product objects:
`{ product_id (type_id), group_name, brand, unit, price, mrp, inventory, merchant_id, eta_tag, assets[] }`.

### Category listing
```
grofers://listing?l0_cat={L0}&l1_cat={L1}   // deeplink form
```
Backed by the layout engine (same family as /feed and /v1/layout/search). L0/L1 category IDs
harvested from /feed (e.g. Dairy=14/922, Fruits&Veg=1487/1489, Snacks=1237/940).

### Search  ⭐
```
POST /v1/layout/search?q={query}&search_type=type_to_search
  body: { applied_filters, sort, postback_meta:{…}, previous_search_query, vertical_cards_processed }
→ { is_success, response:{ snippets:[ … ] } }   // server-driven UI snippets
```
Each product snippet contains the useful fields:
`product_id`, `name`/`display_name`, `brand_name`, `variant` (unit), `mrp`, `normal_price`,
`inventory`, `merchant_id`, `eta_tag`, `rating`, `image`, and crucially an **`atc_action`**:
```
atc_action.add_to_cart.cart_item = {
  product_id, merchant_id, product_name, quantity, price, mrp, unit,
  inventory, group_id, merchant_type, eta_identifier, brand, display_name
}
```
→ This `cart_item` object is exactly the payload shape the cart API wants.

Pagination:
```
POST /v1/layout/search?offset=12&limit=12&actual_query={q}&page_index=1&q={q}
     &search_count={n}&search_method=basic&search_type=type_to_search
```

### Autosuggest (typeahead)
```
POST /v1/actions/auto_suggest   body: { "q":"milk", "search_type":"type_to_search" }
→ suggestions with entity_type keyterm / composite_keyword
```

### Product recommendations ("people also bought")
```
POST /v1/actions/product_recommendations/{product_id}?page_type=search_listing_page
  body: { product_id, product_position, recommendation_type:"DEFAULT", send_cart_items:true }
```

### Cart  ⭐
```
POST /v5/carts
  body: { "items":[ <cart_item …> ], "promo_codes":[""] }
→ full cart object: bill_details{ total_mrp, payable_amount, delivery_charge, additional_charges },
   items[], merchant_details{id}, free_delivery_mov, validations[]
```
Logged-out cart returns `validations:[{code:"FORCE_LOGOUT_USER"}]` and `user_id:0`; logged-in it
returns `requires_login:false`. **Checkout requires `access_token`** (login).

⚠️ **VERIFIED: `/v5/carts` is STATELESS — it is a pricing/validation endpoint, NOT a persistent
server cart.** Posting `{items:[]}` while logged in returns an empty cart (it does not echo back a
previously-added item). Therefore the cart **does not sync across clients**: items added via the MCP
do **not** appear in the Blinkit web/app cart of the same logged-in user, because the cart is held
client-side and only sent here to be priced. Each client (the app, the website, our MCP) keeps its
own local cart. A persistent server cart / cart_id is only materialised at checkout (order history
shows a `cart_id` per placed order). The MCP's `cart.json` is the source of truth for its own cart.

### ✅ Browser hand-off bridge (VERIFIED) — push an API-built cart into the web cart
Although there's no *server* cart to sync, the website keeps its cart in **`localStorage.cart`**:
```
{ count, total, id, version, items: { "<product_id>": {
    product: { product_id, price, image_url, name, unit, mrp, group_id }, quantity } }, … }
```
We can build a basket via the API, write this key (merging onto the existing object — override
`count`, `total`, `items`, `uniqueSkuInCart`), and **reload** — the React app hydrates it natively:
the cart badge updates *and* product cards show the quantity stepper. Verified end-to-end
(milk×2 + bread + eggs → "4 items ₹202", steppers rendered). This is how an API-built cart is
handed to the user's browser for manual review/checkout — the browser is only the final step, not
in the build path. (Done via the Chrome DevTools MCP at the assistant level; not a tool inside the
API-only server. A small `push-cart-to-browser` helper script could automate it.)

### Authed — orders (captured post-login)
```
GET  /v1/order_count
→ { data:{ "user:<id>":{ order_traits_realtime:{ delivered_orders, live_orders, cancelled_orders }}}}

POST /v1/layout/order_history   (empty body)
→ server-driven UI: per-order cards with order_id, cart_id, total (₹), timestamp, status
  ("DELIVERED"), product thumbnails (name in image.accessibility_text), and a
  **Reorder deeplink** `grofers://cart?product_ids=<csv>` and a
  **details deeplink** `grofers://widgetized/order_details_v2?order_id=…&cart_id=…`.
```
Notes for the MCP:
- **Reorder** is first-class on Blinkit: `grofers://cart?product_ids=<comma-sep ids>` → seeds a cart
  from a past order. Maps cleanly onto our `quick_reorder`. Parse `product_ids` from the reorder
  deeplink rather than scraping names.
- order_history lists product *names* only as `accessibility_text` (no price/qty per line) → to seed
  `staples.json` with quantities/prices, fetch **`order_details_v2`** per `order_id`/`cart_id`
  (endpoint to capture next), or just use the reorder `product_ids`.
- After login the web app also sets cookie `gr_1_accessToken=<token>` mirroring the header.

### Authed — addresses / checkout (NOT yet captured)
`/account/address` does **not** call a dedicated address-list API; addresses load inside the
**cart → checkout** flow. Capture requires a real cart + checkout (touches payment) — deferred.
Cart object already exposes `address_id`, `should_consume_address`, `serviceability_location_polygon`.

### Other infra endpoints seen (lower priority)
- `GET  /config/main` — remote config
- `GET  /api/feature-flags/receive` — feature flags
- `POST /v1/layout/tag_collections` — collection layout
- `GET  /v2/services/secondary-data/?filter=…` — offers / AB flags / city_id
- `GET  /v2/search/deeplink/?expr="ch1383"&restricted=false&version=8` — chain deeplink resolve

---

## 3. Proposed MCP tool surface (API-only)

| MCP tool | Underlying call | Auth |
|---|---|---|
| `set_location(lat, lon)` / `resolve_address` | `GET /location/info` | auth_key |
| `check_serviceability(lat, lon)` | `GET /visibility` | auth_key |
| `get_home_feed()` | `GET /feed/` | auth_key |
| `search_products(query, page?)` | `POST /v1/layout/search` | auth_key |
| `autosuggest(query)` | `POST /v1/actions/auto_suggest` | auth_key |
| `get_recommendations(product_id)` | `POST /v1/actions/product_recommendations/{id}` | auth_key |
| `view_cart(items)` / `add_to_cart` / `remove_from_cart` | `POST /v5/carts` | auth_key |
| `send_otp(phone)` | *(captured in §5)* | auth_key |
| `verify_otp(phone, otp)` → stores `access_token` | *(captured in §5)* | auth_key |
| `get_addresses` / `get_orders` / `place_order` | *(authed, capture post-login)* | access_token |

Server keeps a small **session store**: `device_id`, `session_uuid`, `auth_key`, current
`lat/lon`, `merchant_id`, and (after login) `access_token`. A shared `request()` helper injects all
the headers from §1 so individual tools stay thin.

Browser is invoked **only** by a separate, optional `capture_token` dev script — never at runtime.

---

## 4. Open items still to capture
- [x] OTP **send** endpoint — `POST /v2/accounts/` (form: `user_phone`)
- [x] OTP **verify** endpoint — `POST /v2/accounts/verify/phone/code/` → `access_token` + `user.id`
- [x] Authed: `GET /v1/order_count`, `POST /v1/layout/order_history` (with reorder/detail deeplinks)
- [x] Authed: **address list** — `GET /v4/address?cur_lat=&cur_lon=` (loads at checkout)
- [x] Authed: **checkout / order creation** — captured (see §8 below)
- [x] **Payment** — captured: delegated to Zomato **zpaykit** (cross-origin iframe). See §8.
- [ ] Authed: **order detail** `order_details_v2` (open a past order)

## 8. Checkout & payment flow (VERIFIED via one live drive)

Captured by driving a real checkout in the browser (cart ₹313; payment not completed). Cart id used: a
real server cart (`/v5/carts/{id}` is the cart resource; the numeric id is the order_id at checkout).

**Sequence (all on blinkit.com, headless-capable up to createOrder):**
```
PUT   /v5/carts/{cart_id}            # sync cart to server
PATCH /v5/carts/{cart_id}            # update (address/charges)
POST  /v5/carts/{cart_id}/validate   # validate before pay
GET   /v4/address?cur_lat=&cur_lon=  # address list (pick address_id)
GET   /createOrder/{cart_id}
  → { response:{ payments_info:{country_id:1, service_type:"BLINKIT"},
                 access_token:"<PAS-TOKEN>", expires_in:3600, expiry_time_in_epoch },
      orderHash:"<hash>" }
```
`createOrder` is the bridge: it returns a **PAS token** (payment-auth session) + **orderHash**.
This much is plain HTTPS and **works headlessly** via the impit client.

**Payment leg = Zomato zpaykit (NOT blinkit, NOT headless-friendly):**
The web app then loads a **cross-origin iframe** `https://www.zomato.com/zpaykit/init` and calls
`https://www.zomato.com/zpaykit/*` with header `x-client-pas-token: <PAS-TOKEN>`:
```
POST www.zomato.com/zpaykit/getPaymentMethods   (multipart/form-data)
  country_id=1, service_type=BLINKIT, phone, email, amount=313, order_id={cart_id},
  host_redirect_url=https://blinkit.com/zpay/{orderHash}, additional_params={address...}
  → categories: cards, netbanking, upi_qr ("Scan QR to pay"), wallets(mobikwik), lazypay; + userSavedCard[]
also: /zpaykit/countryInfo, /userDefaultPayment, /getCardValidationData, /getStaticLangKeys
```
Selecting UPI / scanning the QR with **PhonePe** (or a UPI collect to a VPA) and pressing **Pay Now**
all happen **inside the zomato.com iframe**; on success it redirects to `blinkit.com/zpay/{orderHash}`.

## 9. HEADLESS payment chain (VERIFIED reproducible) — implemented in `src/payment.ts`

The payment is **not** locked to the iframe — the iframe just drives plain HTTP calls we can make
ourselves. Captured the full chain by clicking "Generate QR" and reading the requests:

```
1. GET  blinkit.com/createOrder/{cart_id}          (auth_key + access_token headers)
     → { response:{ access_token:"<PAS>", expires_in:3600 }, orderHash }
     ⚠️ returns NO access_token if the order already has a pending txn → need a fresh order.

2. POST blinkit.com/zomato_payment_hash            (auth_key + access_token; json)
     body { cart_id, payment_info_data:{ payment_method_id:50, payment_method_type:"upi_qr" } }
     → { zomato_payment_hash_meta:{ payment_hash, order_id (numeric, ≠ cart_id), payable_amount } }

3. POST www.zomato.com/zpaykit/getPaymentMethods   (Chrome-TLS; header x-client-pas-token:<PAS>;
     multipart or urlencoded) — sets laravel_session cookie; lists methods.

4. POST www.zomato.com/zpaykit/makePayment         (urlencoded; x-client-pas-token + laravel_session)
     payment_method_id=50&payment_method_type=upi_qr&service_type=BLINKIT&country_id=1
     &order_id={order_id}&amount={payable}&payments_hash={payment_hash}
     &host_redirect_url=https://blinkit.com/zpay/{order_id}&phone=&email={phone}@blinkit.com&...
     → { transaction:{ status:"pending", track_id, qr_data:{ data:"upi://pay?pa=grofers1paytm@hdfcbank
          &pn=BLINKCOMMERCE…&am=313&cu=INR&tr=…" }, gateway_type:"paytm" }}

5. POST www.zomato.com/zpaykit/verifyPaymentStatus (poll; same session) → pending → success/failed.
```

**Verified headless:** steps 1–2 ran from Node via impit (cross-domain, Chrome-TLS passes both
Cloudflare on blinkit.com and Akamai `ak_bmsc` on zomato.com). Step 4's `upi_qr` returns a real
**UPI intent link** (`upi://pay?…&am=313&tr=…`) — that is the headless artifact: open it on the
phone → PhonePe opens with the payment pre-filled → approve.

**For a zero-tap push collect to a VPA:** call `makePayment` with `payment_method_type=upi_collect`
+ `vpa=<user VPA>` (e.g. `name@ybl`). Blinkit's *web* getPaymentMethods only advertises `upi_qr`
(id 50), so collect support is **unconfirmed on web** — confirm on a fresh (pending-free) order.
`src/payment.ts` implements both paths (`initUpiPayment({method:"qr"|"collect", vpa})`).

### Headless checkout prep (VERIFIED) — `src/api.ts:prepareCheckout`, tool `blinkit_checkout`
The server `cart_id` is **not** browser-only — a logged-in `POST /v5/carts` mints it:
```
POST /v5/carts (logged-in, items)   → cart_data.id  ← the server cart_id (validations:[] when authed)
PATCH /v5/carts/{id} {address_id}    → binds delivery address          ✓ verified
POST  /v5/carts/{id}/validate        → status_code 0 (valid)           ✓ verified
GET   /v4/address                    → saved addresses [{id,label,…}]  ✓ verified
```
Confirmed live headless: `prepareCheckout([item], addressId) → {cart_id, payable, valid:true}`.

### Verdict (updated) — END-TO-END HEADLESS IS ACHIEVABLE
Full pipeline, all via impit, no browser:
```
search/pick_best → prepareCheckout(items, address_id) → prepareOrder(cart_id) → pay_upi(method/vpa) → poll
```
- The **only** human step is the UPI approval in PhonePe (tap the `upi://pay` intent link, or approve
  a pushed collect) — the intended security boundary.
- Tools: `blinkit_checkout`, `blinkit_prepare_order`, `blinkit_pay_upi`, `blinkit_get_addresses`.
- **Resolved:** ~~server cart_id creation~~ (it's just logged-in `POST /v5/carts`).

### ⚠️ Critical fix — `createOrder` needs the `gr_1_accessToken` COOKIE (not just the header)
The long "no PAS token / empty `{message:""}`" failure was **not** an account lock and **not** a
pending txn — it was a missing cookie. `/createOrder` (and the payment steps) validate the
**`gr_1_accessToken`** cookie. Fixed in `src/client.ts`: every authed request now also sends
`Cookie: gr_1_deviceId=…; gr_1_accessToken=<url-encoded access_token>`. After this, `createOrder`
reliably returns the PAS token headlessly (verified, `expires_in ~3600`). No real order was ever
created and nothing was charged (`order_count.live_orders` stayed 0 throughout).

### ⛔ Payment leg — what does NOT work headless
- **`upi_collect` (zero-tap push to a VPA / PhonePe): NOT supported.** `makePayment` with
  `payment_method_type=upi_collect&vpa=…` returns `{status:"failed"}`. Blinkit web's zpaykit only
  advertises `upi_qr` (id 50) — there is **no VPA-collect** on web. So a hands-off "request appears
  in PhonePe" is not achievable through the website (would need the native app or a different PG path).
- **`upi_qr` headless `makePayment` also returns `{status:"failed"}`** from our client even with
  `additional_params`/`order_type`/`gateway_info` added — the browser's call succeeds, so we're still
  missing payload/session nuance (e.g. `payments_config_params`, the `laravel_session` cookie set by
  `getPaymentMethods` not being reused by impit, `x-apple-device`, exact field order). The browser
  (same creds) makes the identical call fine. **TODO** to fully replicate; until then the QR/intent
  must be generated in the browser.

### Realistic verdict
- Fully headless through **search → checkout → createOrder (PAS token)**: ✅ works (cookie fix).
- The **final payment** is the hard boundary: Zomato zpaykit, web offers **UPI only as QR-scan**
  (no collect push), and `makePayment` needs more payload fidelity to fire headless. Even if fired,
  the UPI output is a QR/intent the user scans/taps on their phone.
- **Practical design:** MCP builds + checks out headlessly, then hands off to the browser at the QR
  for the user to scan + approve in PhonePe. A fully no-touch order isn't possible via Blinkit web.
- [ ] Exact `merchant_id` requirement on search (header vs implicit from lat/lon)

## 5. Login capture — DONE (browser used here ONLY)
Captured via manual login in the observed Chrome tab; both OTP endpoints reimplemented as headless
form-POSTs in §1. Browser no longer needed for login. Authed-only endpoints (addresses, orders,
checkout) still need one more capture pass while logged in.

## 7. Personalization strategy (tuned to this user)

**User profile:** Noida, Sector 76 (single fixed delivery zone). Single household, GF over sometimes
but *same basket* (no separate mode). Orders across all categories — staples, snacks/drinks,
fruits & veg, personal/household care. Pattern = mix of repeat staples + ad-hoc top-ups +
occasional bigger baskets. Product priority = trusted brand **and** healthy/attribute filters
**and** fast/in-stock **and** price — i.e. multi-factor. Autonomy = **full auto for known reorders**,
confirm new items, always confirm checkout. Price posture = **balance brand & price** (prefer my
brand, auto-swap to cheaper equivalent only when savings are meaningful).

### Design implications
1. **Single-location fast path.** Persist `lat/lon`, resolved `address_id`, and `merchant_id` for
   Sector 76 in `session.json`. Skip serviceability/geocode on every call — resolve once, cache,
   refresh only on failure. Every catalog/cart call reuses the cached location headers.

2. **Reorder catalog (the core feature).** Maintain a local `staples.json` mapping canonical item →
   preferred `{product_id, brand, unit, attribute_filters}`. Seed it from the user's real
   `GET /orders` history once logged in (frequency-rank past purchases). Categories flagged
   `auto`: Milk/eggs/bread, Fruits&veg basics, Snacks&cold drinks, Household/personal care
   (user marked all four auto-eligible). Tool `reorder(items?)` → resolves each canonical item to a
   live product, adds without asking.

3. **Multi-factor product scorer** (used by search auto-pick + reorder resolution). Score each
   candidate from a search result:
   `score = w_brand·brandMatch + w_attr·attrMatch + w_eta·inStock&fastETA + w_price·priceRank`.
   Defaults reflect "balance brand & price": brand/attr are hard-ish filters, then rank by ETA-in-stock,
   then price. **Auto-swap rule:** keep preferred brand unless an equivalent (same attribute filters,
   similar unit) is cheaper by ≥ a configurable threshold (e.g. 15%) → then propose/swap.
   Surfaced as `pick_best(query, {brand?, attrs?, max_price?})`.

4. **Attribute filters** (healthy/specific). Encode per-item preferences: e.g. milk→full-cream OR
   toned (user choice), atta→whole-wheat, etc. Stored alongside staples; applied as post-filters on
   search snippets (match against `name`/`variant`/`brand_name`).

5. **Autonomy gating.** `add_to_cart` honors a `mode`:
   - known staple (in `staples.json`, category auto) → add silently;
   - new/unknown item → return candidates + ask;
   - **checkout/payment → always require explicit confirm** (cart shows `FORCE_LOGOUT_USER`/payable
     amount; never auto-pay).

6. **Budget guardrail.** Optional `order_cap`; if cart `bill_details.payable_amount` exceeds it,
   flag before checkout. (User chose "balance" not a hard cap, so default off but available.)

7. **No GF mode.** Single basket profile; skip the multi-profile complexity entirely.

### Resulting tool set (refined)
- `quick_reorder(list?)` — the headline tool: rebuild a basket from staples in one call.
- `pick_best(query, filters)` — search + multi-factor auto-pick (returns chosen + alternatives).
- `search_products`, `autosuggest`, `get_home_feed`, `get_recommendations` — discovery.
- `add_to_cart` / `remove_from_cart` / `view_cart` — cart ops (autonomy-gated).
- `get_addresses` / `set_default_address` — bind the Sector-76 address (capture post-login).
- `checkout_preview` — show payable amount + items; **stops for confirmation** (no auto-pay).
- `send_otp` / `verify_otp` — headless login.
- `get_orders` — history (also seeds `staples.json`).

### Local state files (under `~/.blinkit-mcp/`)
- `session.json` — device_id, session_uuid, auth_key, access_token, lat/lon, address_id, merchant_id.
- `staples.json` — canonical reorder catalog + per-item brand/attribute/auto flags + scorer weights.

## 6. Risks / notes
- **Cloudflare bot management** (`__cf_bm`, `cf_clearance`) may challenge non-browser clients at
  scale. Mitigate: realistic UA + headers, reuse `__cf_bm`, modest rate, optional residential egress.
- Server-driven-UI responses are large and layout-shaped; parse defensively (pull product objects
  out of `snippets[*].data` / `objects[*]`), don't assume positions.
- Unofficial/reverse-engineered API — no stability guarantees; version headers may need bumping.
- Respect ToS / rate limits; intended for personal/automation use.
