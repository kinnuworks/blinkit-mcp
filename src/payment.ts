import { Impit } from "impit";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { request } from "./client.js";
import { loadSession } from "./session.js";

/**
 * HEADLESS payment via Blinkit → Zomato zpaykit. Captured from a live checkout.
 *
 * Chain (all reproducible server-side; zpaykit calls go to www.zomato.com and need a
 * Chrome-TLS client + the PAS token from createOrder):
 *
 *   1. GET  /createOrder/{cart_id}                  → { response.access_token = PAS token, orderHash }
 *   2. POST /zomato_payment_hash                     → { payment_hash, order_id, payable_amount }
 *        body { cart_id, payment_info_data:{ payment_method_id, payment_method_type } }
 *   3. POST zomato.com/zpaykit/getPaymentMethods     (establishes laravel_session cookie)
 *   4. POST zomato.com/zpaykit/makePayment           → transaction (UPI intent / collect)
 *        upi_qr  → returns qr_data.data = "upi://pay?pa=…&am=…&tr=…"  (open on phone to approve)
 *        upi_collect + vpa → pushes a collect request to that VPA's UPI app (PhonePe)  [see note]
 *   5. POST zomato.com/zpaykit/verifyPaymentStatus   (poll until success/failed)
 *
 * NOTE on collect: Blinkit's *web* zpaykit config only advertises `upi_qr` (id 50) in
 * getPaymentMethods. A zero-tap `upi_collect` (+ payer `vpa`) is the standard zpaykit method but
 * may require app config / a different payment_method_id — confirm on a *fresh* order (a pending
 * txn blocks createOrder from minting a new PAS token). The always-works headless artifact is the
 * `upi://pay?…` intent link from upi_qr, which can be handed to the phone to approve in PhonePe.
 */

const ZBASE = "https://www.zomato.com/zpaykit";
// Per-flow Impit instance so the laravel_session cookie set by getPaymentMethods is reused by
// makePayment / verifyPaymentStatus. Chrome TLS passes Zomato's Akamai bot manager (ak_bmsc).
function zomatoClient() {
  return new Impit({ browser: "chrome" });
}

export interface PreparedOrder {
  cartId: string;
  pasToken: string;
  orderHash: string;
  orderId: number;
  payable: number;
  paymentHash: string;
}

/** A zpaykit payment method as sent to /zomato_payment_hash and makePayment. */
export interface PaymentMethod {
  id: number;
  type: string;
}
export const UPI_QR: PaymentMethod = { id: 50, type: "upi_qr" };
/** Cash on Delivery. Offered by zpaykit for Blinkit (category "cash", subtype id 1) when eligible. */
export const CASH: PaymentMethod = { id: 1, type: "cash" };

/** Steps 1–2: mint a payment session for a (server-synced) cart. Throws if a payment is already pending. */
export async function prepareOrder(cartId: string, method: PaymentMethod = UPI_QR): Promise<PreparedOrder> {
  const co = await request<any>(`/createOrder/${cartId}`, { authed: true });
  const pasToken = co?.response?.access_token;
  const orderHash = co?.orderHash;
  if (!pasToken) {
    throw new Error(
      "createOrder returned no PAS token — the order likely has a pending payment. " +
        "Use a fresh cart/order, or wait for the pending transaction to expire.",
    );
  }
  const ph = await request<any>(`/zomato_payment_hash`, {
    method: "POST",
    authed: true,
    json: { cart_id: String(cartId), payment_info_data: { payment_method_id: method.id, payment_method_type: method.type } },
  });
  const meta = ph?.zomato_payment_hash_meta;
  if (!meta?.payment_hash) throw new Error(`zomato_payment_hash returned no hash for ${method.type}: ${JSON.stringify(ph).slice(0, 300)}`);
  return {
    cartId: String(cartId),
    pasToken,
    orderHash,
    orderId: meta?.order_id,
    payable: meta?.payable_amount,
    paymentHash: meta?.payment_hash,
  };
}

function commonForm(o: PreparedOrder, phone: string): Record<string, string> {
  return {
    service_type: "BLINKIT",
    country_id: "1",
    order_type: "null",
    order_id: String(o.orderId),
    amount: String(o.payable),
    payments_hash: o.paymentHash,
    host_redirect_url: `https://blinkit.com/zpay/${o.orderId}`,
    phone,
    email: `${phone}@blinkit.com`,
    promo_code: "",
    locale: "en",
    gateway_info: "null",
    online_payments_flag: "1",
    isMobileView: "false",
    // The gateway requires additional_params (block list + user address). Minimal valid shape:
    additional_params: JSON.stringify({
      block_payment_methods: [],
      eligible_bank_codes: null,
      emi_details: null,
      hidden_payment_methods: [],
      service_type: "BLINKIT",
      show_warning_banner: 1,
      user_details: { addressDetails: null },
    }),
  };
}

async function zpost(client: Impit, path: string, pasToken: string, form: Record<string, string>) {
  const res = await client.fetch(`${ZBASE}/${path}`, {
    method: "POST",
    headers: {
      "x-client-pas-token": pasToken,
      "content-type": "application/x-www-form-urlencoded",
      locale: "en",
      referer: "https://www.zomato.com/zpaykit/init",
      origin: "https://www.zomato.com",
    },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: res.status, raw: text.slice(0, 200) };
  }
}

export interface UpiPaymentResult {
  trackId?: string;
  status?: string;
  upiIntent?: string; // upi://pay?… (for qr / intent flows)
  gatewayType?: string;
  raw?: unknown;
}

/**
 * Steps 3–4. method "qr" → returns the upi://pay intent link (open on phone to approve).
 * method "collect" + vpa → attempts a push collect to the VPA (PhonePe). The Impit instance is
 * returned so the caller can poll verifyPaymentStatus on the same session.
 */
export async function initUpiPayment(
  o: PreparedOrder,
  phone: string,
  opts: { method: "qr" | "collect"; vpa?: string } = { method: "qr" },
): Promise<{ result: UpiPaymentResult; client: Impit }> {
  const client = zomatoClient();
  // 3) establish zpaykit session
  await zpost(client, "getPaymentMethods", o.pasToken, { ...commonForm(o, phone), online_payments_flag: "1", isMobileView: "false" });
  // 4) makePayment
  // makePayment additionally requires payments_config_params (the web app literally sends the string
  // "[object Object]" here due to a serialization quirk; the gateway accepts it). Omitting it →
  // {status:"failed", message:"Missing params"}.
  const form =
    opts.method === "collect"
      ? { ...commonForm(o, phone), payment_method_type: "upi_collect", vpa: opts.vpa ?? "", payments_config_params: "[object Object]" }
      : { ...commonForm(o, phone), payment_method_id: "50", payment_method_type: "upi_qr", payments_config_params: "[object Object]" };
  const mp = await zpost(client, "makePayment", o.pasToken, form);
  const t = mp?.response?.transaction;
  await savePaymentContext({ ...o, phone, trackId: t?.track_id });
  return {
    client,
    result: {
      trackId: t?.track_id,
      status: t?.status ?? mp?.response?.status,
      upiIntent: t?.qr_data?.data,
      gatewayType: t?.gateway_type,
      raw: mp?.response ? undefined : mp,
    },
  };
}

export interface OfferedMethod {
  id?: number;
  type: string;
  title: string;
  category: string;
  enabled: boolean;
}

/**
 * Step 3 only: what zpaykit offers for THIS order (read-only, nothing is charged). Verified 2026-09-02
 * for a ₹166 Blinkit cart: wallets(mobikwik), card, netbanking, upi_qr(50), **cash(1) "Cash on Delivery"**,
 * lazypay. The returned client holds the laravel_session cookie for a follow-up makePayment.
 */
export async function listPaymentMethods(
  o: PreparedOrder,
  phone: string,
): Promise<{ methods: OfferedMethod[]; client: Impit; raw: unknown }> {
  const client = zomatoClient();
  const pm = await zpost(client, "getPaymentMethods", o.pasToken, { ...commonForm(o, phone), online_payments_flag: "1", isMobileView: "false" });
  const cats: any[] = pm?.response?.paymentMethods?.categories ?? [];
  const methods: OfferedMethod[] = [];
  for (const c of cats) {
    const subs: any[] = c?.subtypes?.length ? c.subtypes : [c];
    for (const m of subs) {
      methods.push({
        id: m.id,
        type: m.type,
        title: m.display_text ?? m.title ?? c.title ?? m.type,
        category: m.payment_category ?? c.type,
        enabled: (m.status ?? 1) === 1 && (m.visible ?? 1) === 1,
      });
    }
  }
  return { methods, client, raw: pm };
}

export interface CashOrderResult {
  orderId: number;
  payable: number;
  /** false → COD not offered/enabled for this order; nothing was placed. */
  available: boolean;
  status?: string;
  raw?: unknown;
}

/**
 * Steps 3–4 for CASH ON DELIVERY. `o` must come from `prepareOrder(cartId, CASH)`.
 * ⚠️ This PLACES A REAL ORDER when it succeeds — there is no approval step after it.
 * Returns available:false (and places nothing) if zpaykit does not list cash as enabled.
 */
export async function placeCashOrder(o: PreparedOrder, phone: string): Promise<CashOrderResult> {
  const { methods, client } = await listPaymentMethods(o, phone);
  const cash = methods.find((m) => m.type === "cash" || m.category === "cash");
  if (!cash?.enabled) return { orderId: o.orderId, payable: o.payable, available: false, raw: methods };
  const mp = await zpost(client, "makePayment", o.pasToken, {
    ...commonForm(o, phone),
    payment_method_id: String(cash.id ?? CASH.id),
    payment_method_type: "cash",
    payments_config_params: "[object Object]",
  });
  const t = mp?.response?.transaction;
  const status = String(t?.status ?? mp?.response?.status ?? mp?.status ?? "unknown");
  await savePaymentContext({ ...o, phone, trackId: t?.track_id });
  return { orderId: o.orderId, payable: o.payable, available: true, status, raw: mp };
}

/**
 * Step 5: poll verifyPaymentStatus until terminal or timeout. `onUpdate(status, attempt)` fires on
 * every poll so callers can emit MCP notifications while waiting for the PhonePe approval.
 */
export async function pollPaymentStatus(
  client: Impit,
  o: PreparedOrder,
  phone: string,
  {
    tries = 40,
    intervalMs = 5000,
    onUpdate,
  }: { tries?: number; intervalMs?: number; onUpdate?: (status: string, attempt: number) => void | Promise<void> } = {},
): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const r = await zpost(client, "verifyPaymentStatus", o.pasToken, { ...commonForm(o, phone) });
    const status = String(r?.response?.status ?? r?.status ?? "unknown");
    await onUpdate?.(status, i + 1);
    if (status && !/pending|processing|unknown/i.test(status)) return status;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return "timeout";
}

/* ----------------------------- Payment context (for on-demand status) ----------------------------- */

export interface PaymentContext extends PreparedOrder {
  phone: string;
  trackId?: string;
}

const CTX_FILE = join(homedir(), ".blinkit-mcp", "payment.json");

/** Persist the in-flight payment so status can be re-checked across tool calls / restarts. */
export async function savePaymentContext(ctx: PaymentContext): Promise<void> {
  // Best-effort: on read-only filesystems (Lambda) the write fails and the caller
  // should not — the in-flight payment result has already been returned to it.
  try {
    await mkdir(join(homedir(), ".blinkit-mcp"), { recursive: true, mode: 0o700 });
    await writeFile(CTX_FILE, JSON.stringify(ctx, null, 2), { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

export async function loadPaymentContext(): Promise<PaymentContext | null> {
  try {
    return JSON.parse(await readFile(CTX_FILE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * One-shot status check for the last (or given) in-flight payment. Re-establishes a zpaykit session
 * (getPaymentMethods sets laravel_session) then reads verifyPaymentStatus once.
 */
export async function checkPaymentStatus(cartId?: string): Promise<{ cart_id?: string; order_id?: number; status: string }> {
  const ctx = await loadPaymentContext();
  if (!ctx || (cartId && ctx.cartId !== String(cartId))) {
    return { status: "no_pending_payment" };
  }
  const client = zomatoClient();
  await zpost(client, "getPaymentMethods", ctx.pasToken, { ...commonForm(ctx, ctx.phone), online_payments_flag: "1", isMobileView: "false" });
  const r = await zpost(client, "verifyPaymentStatus", ctx.pasToken, { ...commonForm(ctx, ctx.phone) });
  return { cart_id: ctx.cartId, order_id: ctx.orderId, status: String(r?.response?.status ?? r?.status ?? "unknown") };
}

export async function userPhone(): Promise<string> {
  const s = await loadSession();
  // phone isn't stored in session today; derive from a configured value or extend session.
  return (s as any).phone ?? process.env.BLINKIT_PHONE ?? "";
}
