/**
 * "Milk man" — Alexa skill that orders 4 x one fixed milk SKU on Blinkit.
 *
 *   Turn 1  "order milk"  → OrderMilkIntent, or LaunchRequest once configured (so an Alexa
 *                            Routine with the phrase "order milk" that opens the skill starts the
 *                            order straight away) : stock check → server cart → bind address →
 *                            validate → speak REAL total → wait for yes/no (cart_id kept in
 *                            session attributes only).
 *   Turn 2  "yes"         → AMAZON.YesIntent (guarded by cart_id) : createOrder → CASH ON DELIVERY
 *                            (default; verified offered for this cart) — or, with payment="upi", a UPI
 *                            collect to the configured VPA (fallback: upi:// link on an Alexa-app card).
 *   Launch  "open milk man" → BEFORE the DynamoDB item is seeded: connectivity smoke test
 *                            (impit + Blinkit bootstrap) — the Gate-2 test; a native-module load
 *                            failure is spoken and written to the card. AFTER seeding: same as
 *                            "order milk". StatusIntent ("check connection") always runs the test.
 *
 * Errors are classified (logged out / blocked / Blinkit down / unreachable / pending payment /
 * other) and each has its own spoken line; the generic one and the success/unavailable lines can
 * be overridden from the DynamoDB item (speech_error, speech_success, speech_unavailable).
 *
 * Nothing is ever substituted, nothing is ordered without the spoken total + a "yes".
 * The access_token is never logged and never spoken.
 */
import Alexa from "ask-sdk-core";
import { createStore } from "./store.js";

const store = createStore();

/**
 * The blinkit library pulls in `impit`, a native module. It is imported LAZILY so that if
 * the binary cannot load on this Lambda runtime (old glibc / wrong arch) the failure is
 * caught and SPOKEN by the smoke test instead of killing the whole function at init.
 */
let libPromise;
function lib() {
  libPromise ??= (async () => {
    const [session, client, api, payment] = await Promise.all([
      import("./blinkit/session.js"),
      import("./blinkit/client.js"),
      import("./blinkit/api.js"),
      import("./blinkit/payment.js"),
    ]);
    if (store) session.useSessionStore(store);
    return { ...session, ...client, ...api, ...payment };
  })();
  return libPromise;
}

/** Drop the library's in-process session cache on every request so a seeded/edited DynamoDB
 *  item is picked up immediately, even by a warm container. */
const FreshSessionInterceptor = {
  async process() {
    if (!store) return;
    const { useSessionStore } = await lib();
    useSessionStore(store);
  },
};

/* ----------------------------- config ----------------------------- */

const DEFAULTS = {
  product_id: 564250, // Vijaya Dairy Gold Full Cream Milk, 500 ml, ₹39 (verified in stock 2026-09-02)
  product_query: "Vijaya milk", // search that reliably surfaces product_id at this store
  product_spoken: "Vijaya Gold full cream milk, five hundred ml",
  quantity: 4,
};
const CART_TTL_MS = 5 * 60 * 1000; // a quoted cart is only confirmable for 5 minutes

async function config() {
  const { loadSession } = await lib();
  const s = await loadSession();
  const num = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));
  return {
    ...s,
    product_id: num(s.product_id, DEFAULTS.product_id),
    product_query: s.product_query ?? DEFAULTS.product_query,
    product_spoken: s.product_spoken ?? DEFAULTS.product_spoken,
    address_spoken: s.address_spoken ?? "your home address",
    payment: String(s.payment ?? "cod").toLowerCase(), // "cod" (default) | "upi"
    speech_error: s.speech_error || undefined, // overrides the generic error line
    speech_success: s.speech_success || undefined, // overrides the COD success line ({total} is replaced)
    speech_unavailable: s.speech_unavailable || undefined, // overrides the out-of-stock line
    quantity: num(s.quantity, DEFAULTS.quantity),
    address_id: num(s.address_id, undefined),
    vpa: s.vpa || undefined,
    ready: Boolean(s.access_token && s.lat !== undefined && s.lon !== undefined && s.address_id && s.phone),
  };
}

const rupees = (n) => (n === undefined || n === null ? "an unknown amount" : `${Math.round(Number(n))} rupees`);
const redact = (msg) => String(msg ?? "").replace(/v2::[0-9a-f-]+/gi, "v2::<redacted>").slice(0, 600);

/**
 * Turn an exception into a spoken line. `stage` is "quoting" (nothing could have been ordered),
 * "paying" (an order MAY have been placed) or "smoke". `custom` is the DynamoDB override.
 */
function explainError(err, stage, custom) {
  const status = Number(err?.status ?? 0);
  const body = JSON.stringify(err?.body ?? "").toLowerCase();
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  const tail =
    stage === "paying"
      ? " I'm not sure whether the order went through, so please check the Blinkit app."
      : " Nothing was ordered.";
  if (status === 401 || body.includes("force_logout") || msg.includes("not logged in")) {
    return { kind: "logged_out", speech: "Blinkit has logged me out. Please log in again on the computer and update my token." + tail };
  }
  if (status === 403 || status === 429) {
    return { kind: "blocked", speech: "Blinkit is blocking my requests right now. Please try again in a few minutes." + tail };
  }
  if (status >= 500) {
    return { kind: "blinkit_down", speech: "Blinkit's servers are having trouble. Please try again in a few minutes." + tail };
  }
  if (/econn|enotfound|etimedout|timeout|timed out|network|socket|tls|fetch failed|impit/.test(msg)) {
    return { kind: "unreachable", speech: "I couldn't reach Blinkit at all. Check the internet connection and try again." + tail };
  }
  if (msg.includes("pending payment") || msg.includes("no pas token")) {
    return { kind: "pending_payment", speech: "Blinkit says this order already has a payment pending. Please check the Blinkit app before trying again." };
  }
  return { kind: "unknown", speech: (custom ?? "Sorry, something went wrong with Blinkit.") + tail };
}

/** Best-effort "Checking Blinkit…" while the API calls run (Alexa otherwise sits silent). */
function progressive(handlerInput, text) {
  try {
    const { requestId } = handlerInput.requestEnvelope.request;
    const client = handlerInput.serviceClientFactory?.getDirectiveServiceClient();
    if (!client) return;
    const p = client.enqueue({ header: { requestId }, directive: { type: "VoicePlayer.Speak", speech: text } });
    p.catch(() => {});
  } catch {
    /* no API access token in the console simulator — ignore */
  }
}

/* ----------------------------- handlers ----------------------------- */

async function smokeTest(h) {
    const t0 = Date.now();
    try {
      const { ensureAuthKey } = await lib(); // loads impit — the Gate-2 moment
      const key = await ensureAuthKey(); // exercises impit's native TLS client end-to-end
      const cfg = await config();
      const ms = Date.now() - t0;
      const setup = cfg.ready
        ? "Login and address are configured."
        : `Setup incomplete: missing ${[
            !cfg.access_token && "access token",
            cfg.lat === undefined && "location",
            !cfg.address_id && "address id",
            !cfg.phone && "phone",
          ]
            .filter(Boolean)
            .join(", ")}.`;
      const speech = `Milk man is ready. Blinkit connection OK in ${ms} milliseconds. ${setup} ${
        cfg.ready ? "Say order milk." : ""
      }`;
      return h.responseBuilder
        .speak(speech)
        .withSimpleCard(
          "Milk man — smoke test",
          `impit + Blinkit bootstrap OK (${ms} ms, auth_key ${key.length} chars)\nstore: ${store?.kind ?? "file"}\nnode: ${process.version} ${process.arch}\n${setup}`,
        )
        .withShouldEndSession(!cfg.ready)
        .reprompt(cfg.ready ? "Say order milk, or stop." : undefined)
        .getResponse();
    } catch (err) {
      const detail = redact(err?.stack ?? err?.message ?? err);
      console.error("smoke test failed:", detail);
      const { speech } = explainError(err, "smoke");
      return h.responseBuilder
        .speak(`Milk man could not reach Blinkit on node ${process.version}. ${speech} ${redact(err?.message ?? err).slice(0, 160)}`)
        .withSimpleCard("Milk man — smoke test FAILED", `node ${process.version} ${process.arch}\n${detail}`)
        .withShouldEndSession(true)
        .getResponse();
    }
}

/** Is the DynamoDB item seeded? Cheap: no network. Used to pick smoke test vs. order on launch. */
async function isConfigured() {
  try {
    return (await config()).ready;
  } catch {
    return false; // e.g. impit failed to load — fall through to the smoke test, which explains it
  }
}

const LaunchRequestHandler = {
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === "LaunchRequest",
  async handle(h) {
    // Once configured, launching IS ordering — so an Alexa Routine whose phrase is "order milk"
    // and whose action is "open Milk Man" gives a name-free "Alexa, order milk".
    if (await isConfigured()) return quoteAndAsk(h);
    return smokeTest(h);
  },
};

const StatusIntentHandler = {
  canHandle: (h) =>
    Alexa.getRequestType(h.requestEnvelope) === "IntentRequest" &&
    Alexa.getIntentName(h.requestEnvelope) === "StatusIntent",
  handle: (h) => smokeTest(h),
};

const OrderMilkIntentHandler = {
  canHandle: (h) =>
    Alexa.getRequestType(h.requestEnvelope) === "IntentRequest" &&
    Alexa.getIntentName(h.requestEnvelope) === "OrderMilkIntent",
  handle: (h) => quoteAndAsk(h),
};

/** Turn 1: stock check → server cart → spoken real total → wait for yes/no. */
async function quoteAndAsk(h) {
    h.attributesManager.setRequestAttributes({ stage: "quoting" });
    const t0 = Date.now();
    const lap = (l) => console.log(`[order ${Date.now() - t0}ms] ${l}`);
    const { searchProducts, prepareCheckout } = await lib();
    const cfg = await config();
    if (!cfg.ready) {
      return h.responseBuilder
        .speak("Milk man isn't set up yet. The Blinkit login, location, address, or phone is missing. Open milk man to see what's missing.")
        .withShouldEndSession(true)
        .getResponse();
    }
    progressive(h, "Checking Blinkit.");

    // 1. Stock check — search, then require the EXACT product id. Never substitute.
    const results = await searchProducts(cfg.product_query);
    lap(`search returned ${results.length}`);
    const hit = results.find((p) => p.product_id === cfg.product_id);
    if (!hit || (hit.inventory ?? 0) <= 0) {
      lap(`product ${cfg.product_id} not available`);
      return h.responseBuilder
        .speak(cfg.speech_unavailable ?? `Sorry, ${cfg.product_spoken} isn't available at your Blinkit store right now. I haven't ordered anything.`)
        .withShouldEndSession(true)
        .getResponse();
    }
    if ((hit.inventory ?? 0) < cfg.quantity) {
      return h.responseBuilder
        .speak(`Blinkit only has ${hit.inventory} of ${cfg.product_spoken} right now, not ${cfg.quantity}. I haven't ordered anything.`)
        .withShouldEndSession(true)
        .getResponse();
    }

    // 2. Server cart bound to the fixed address. NOTE: /v5/carts returns 422 if you echo the
    //    full search `cart_item` back (its `meta` map / image fields). A minimal line item works
    //    (verified 2026-09-02); Blinkit re-prices from product_id + merchant_id anyway.
    const item = {
      product_id: hit.product_id,
      merchant_id: hit.merchant_id ?? hit.cart_item?.merchant_id ?? cfg.merchant_id,
      quantity: cfg.quantity,
    };
    const co = await prepareCheckout([item], cfg.address_id);
    lap(`checkout cart_id=${co.cart_id} payable=${co.payable} valid=${co.valid}`);
    if (!co.valid || co.payable === undefined) {
      return h.responseBuilder
        .speak("Blinkit accepted the items but couldn't validate the cart for your address. I haven't ordered anything.")
        .withShouldEndSession(true)
        .getResponse();
    }

    // 3. Read back the REAL total and wait for yes/no. cart_id lives only in session attributes.
    h.attributesManager.setSessionAttributes({
      cart_id: String(co.cart_id),
      payable: co.payable,
      quoted_at: Date.now(),
      product: hit.name,
      quantity: cfg.quantity,
    });
    const each = hit.price !== undefined ? `at ${rupees(hit.price)} each` : "";
    const speech =
      `${cfg.quantity} ${cfg.product_spoken}, ${each}. ` +
      `Your total including fees is ${rupees(co.payable)}, delivered to ${cfg.address_spoken}. ` +
      `Shall I place the order?`;
    return h.responseBuilder
      .speak(speech)
      .reprompt(`Should I place the order for ${rupees(co.payable)}? Say yes or no.`)
      .withSimpleCard(
        "Milk man — confirm",
        `${cfg.quantity} × ${hit.name} (${hit.unit ?? ""}) @ ₹${hit.price}\nTotal: ₹${co.payable}\nAddress id ${cfg.address_id}\nSay "yes" to pay via UPI.`,
      )
      .withShouldEndSession(false)
      .getResponse();
}

const YesIntentHandler = {
  canHandle: (h) =>
    Alexa.getRequestType(h.requestEnvelope) === "IntentRequest" &&
    Alexa.getIntentName(h.requestEnvelope) === "AMAZON.YesIntent",
  async handle(h) {
    const attrs = h.attributesManager.getSessionAttributes() ?? {};
    // Guard: only pay a cart that THIS session quoted, and only recently.
    if (!attrs.cart_id) {
      return h.responseBuilder
        .speak("There's nothing to confirm. Say order milk first.")
        .withShouldEndSession(true)
        .getResponse();
    }
    if (Date.now() - Number(attrs.quoted_at ?? 0) > CART_TTL_MS) {
      h.attributesManager.setSessionAttributes({});
      return h.responseBuilder
        .speak("That quote is too old, so I won't place it. Say order milk to get a fresh price.")
        .withShouldEndSession(true)
        .getResponse();
    }
    h.attributesManager.setRequestAttributes({ stage: "quoting" });
    const { prepareOrder, initUpiPayment, placeCashOrder, orderCount, CASH } = await lib();
    const cfg = await config();
    const t0 = Date.now();
    const lap = (l) => console.log(`[pay ${Date.now() - t0}ms] ${l}`);
    progressive(h, "Placing the order.");

    if (process.env.BLINKIT_DRY_RUN) {
      h.attributesManager.setSessionAttributes({});
      return h.responseBuilder
        .speak(`Dry run. I would now create order for cart ${attrs.cart_id}, ${rupees(attrs.payable)}, and ${cfg.payment === "cod" ? "place it as cash on delivery" : `send a UPI request to ${cfg.vpa ?? "a QR link"}`}.`)
        .withShouldEndSession(true)
        .getResponse();
    }

    if (cfg.payment === "cod") {
      const order = await prepareOrder(attrs.cart_id, CASH); // createOrder + zomato_payment_hash(cash)
      lap(`order ${order.orderId} payable=${order.payable} (cod)`);
      h.attributesManager.setSessionAttributes({}); // one shot — never place the same cart twice
      h.attributesManager.setRequestAttributes({ stage: "paying" }); // from here an order may exist
      const r = await placeCashOrder(order, cfg.phone);
      lap(`cod: available=${r.available} status=${r.status}`);
      const total = rupees(order.payable ?? attrs.payable);
      if (!r.available) {
        return h.responseBuilder
          .speak("Cash on delivery isn't available for this order right now, so I haven't placed it. Try again later, or switch milk man to UPI.")
          .withShouldEndSession(true)
          .getResponse();
      }
      if (/fail|declin|error/i.test(r.status ?? "")) {
        return h.responseBuilder
          .speak(`Blinkit rejected the cash on delivery order for ${total}. Nothing was placed. The details are in the Alexa app.`)
          .withSimpleCard("Milk man — COD rejected", `Order ${r.orderId}, ₹${r.payable}\nstatus: ${r.status}\n${JSON.stringify(r.raw).slice(0, 900)}`)
          .withShouldEndSession(true)
          .getResponse();
      }
      const live = await orderCount().then((oc) => oc?.live_orders).catch(() => undefined);
      lap(`live_orders=${live}`);
      const confirmed = live !== undefined && Number(live) > 0;
      return h.responseBuilder
        .speak(
          confirmed
            ? (cfg.speech_success ?? "Done. Your milk is ordered. Pay {total} in cash when it arrives.").replace("{total}", total)
            : `Blinkit accepted the cash on delivery request for ${total} with status ${r.status}. Please check the Blinkit app to confirm the order is live.`,
        )
        .withSimpleCard("Milk man — ordered (cash on delivery)", `Order ${r.orderId}\n${attrs.quantity} × ${attrs.product}\nPay ₹${r.payable} in cash\nstatus: ${r.status}\nlive orders: ${live ?? "?"}`)
        .withShouldEndSession(true)
        .getResponse();
    }

    const order = await prepareOrder(attrs.cart_id); // createOrder + zomato_payment_hash (upi_qr)
    lap(`order ${order.orderId} payable=${order.payable}`);
    h.attributesManager.setSessionAttributes({}); // one shot — never pay the same cart twice
    h.attributesManager.setRequestAttributes({ stage: "paying" });

    let result;
    let method = cfg.vpa ? "collect" : "qr";
    ({ result } = await initUpiPayment(order, cfg.phone, { method, vpa: cfg.vpa }));
    lap(`makePayment ${method}: ${result.status}`);
    if (method === "collect" && /fail/i.test(result.status ?? "")) {
      method = "qr";
      ({ result } = await initUpiPayment(order, cfg.phone, { method }));
      lap(`makePayment qr fallback: ${result.status}`);
    }

    const total = rupees(order.payable ?? attrs.payable);
    if (/fail/i.test(result.status ?? "")) {
      return h.responseBuilder
        .speak(`Blinkit created order ${order.orderId} for ${total}, but the UPI payment request failed. Nothing has been charged. Please pay it from the Blinkit app.`)
        .withSimpleCard("Milk man — payment failed", `Order ${order.orderId}, ₹${order.payable}\n${JSON.stringify(result.raw ?? result).slice(0, 800)}`)
        .withShouldEndSession(true)
        .getResponse();
    }
    if (method === "collect") {
      return h.responseBuilder
        .speak(`Done. A UPI request for ${total} is on its way to your phone. Approve it in PhonePe and Blinkit will deliver the milk.`)
        .withSimpleCard("Milk man — approve in PhonePe", `Order ${order.orderId}\n₹${order.payable} collect request sent to ${cfg.vpa}\nStatus: ${result.status}`)
        .withShouldEndSession(true)
        .getResponse();
    }
    return h.responseBuilder
      .speak(`The order for ${total} is ready to pay. I couldn't push the request to PhonePe, so I've put the UPI payment link in the Alexa app on your phone.`)
      .withSimpleCard("Milk man — pay via UPI link", `Order ${order.orderId}, ₹${order.payable}\nOpen this in a UPI app:\n${result.upiIntent ?? "(no link returned)"}`)
      .withShouldEndSession(true)
      .getResponse();
  },
};

const NoOrStopHandler = {
  canHandle: (h) =>
    Alexa.getRequestType(h.requestEnvelope) === "IntentRequest" &&
    ["AMAZON.NoIntent", "AMAZON.CancelIntent", "AMAZON.StopIntent", "AMAZON.NavigateHomeIntent"].includes(
      Alexa.getIntentName(h.requestEnvelope),
    ),
  handle(h) {
    const had = Boolean(h.attributesManager.getSessionAttributes()?.cart_id);
    h.attributesManager.setSessionAttributes({});
    return h.responseBuilder
      .speak(had ? "Okay, I won't order it. Nothing was charged." : "Okay.")
      .withShouldEndSession(true)
      .getResponse();
  },
};

const HelpIntentHandler = {
  canHandle: (h) =>
    Alexa.getRequestType(h.requestEnvelope) === "IntentRequest" &&
    Alexa.getIntentName(h.requestEnvelope) === "AMAZON.HelpIntent",
  handle: (h) =>
    h.responseBuilder
      .speak("Say order milk. I'll check Blinkit, tell you the total, and place the order only after you say yes. You pay cash when it arrives.")
      .reprompt("Say order milk, or stop.")
      .getResponse(),
};

const FallbackIntentHandler = {
  canHandle: (h) =>
    Alexa.getRequestType(h.requestEnvelope) === "IntentRequest" &&
    Alexa.getIntentName(h.requestEnvelope) === "AMAZON.FallbackIntent",
  handle(h) {
    const pending = h.attributesManager.getSessionAttributes()?.cart_id;
    return h.responseBuilder
      .speak(pending ? "Sorry, I didn't catch that. Should I place the milk order? Yes or no." : "I can only order milk. Say order milk, or stop.")
      .reprompt(pending ? "Yes or no?" : "Say order milk.")
      .getResponse();
  },
};

const SessionEndedRequestHandler = {
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === "SessionEndedRequest",
  handle: (h) => h.responseBuilder.getResponse(),
};

const ErrorHandler = {
  canHandle: () => true,
  async handle(h, error) {
    const detail = redact(error?.stack ?? error?.message ?? error);
    const body = error?.body ? redact(JSON.stringify(error.body)) : "";
    console.error("handler error:", detail, body);
    const stage = h.attributesManager.getRequestAttributes()?.stage ?? "quoting";
    let custom;
    try {
      custom = (await config()).speech_error;
    } catch {
      /* config itself failed — use the built-in line */
    }
    const { kind, speech } = explainError(error, stage, custom);
    h.attributesManager.setSessionAttributes({});
    return h.responseBuilder
      .speak(speech)
      .withSimpleCard(`Milk man — error (${kind}, while ${stage})`, `${detail}\n${body}`)
      .withShouldEndSession(true)
      .getResponse();
  },
};

export const handler = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    StatusIntentHandler,
    OrderMilkIntentHandler,
    YesIntentHandler,
    NoOrStopHandler,
    HelpIntentHandler,
    FallbackIntentHandler,
    SessionEndedRequestHandler,
  )
  .addRequestInterceptors(FreshSessionInterceptor)
  .addErrorHandlers(ErrorHandler)
  .withApiClient(new Alexa.DefaultApiClient())
  .withCustomUserAgent("milk-man/0.1.0")
  .lambda();
