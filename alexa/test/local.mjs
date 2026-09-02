/**
 * Drive the Lambda handler locally with synthetic Alexa envelopes, using the file
 * store (~/.blinkit-mcp/session.json). Turn 1 hits Blinkit for real (stock check +
 * server cart + address bind — no order, nothing charged). Turn 2 runs in DRY_RUN,
 * which stops BEFORE createOrder/payment.
 *
 *   node alexa/test/local.mjs            # launch + order + yes(dry)
 *   node alexa/test/local.mjs launch     # smoke test only
 */
process.env.BLINKIT_STORE = "file";
process.env.BLINKIT_DRY_RUN = "1";
const { handler } = await import("../lambda/index.js");

const app = { applicationId: "amzn1.ask.skill.local-test" };
const user = { userId: "amzn1.ask.account.local-test" };
let attributes = {};
function envelope(request, isNew) {
  return {
    version: "1.0",
    session: { new: isNew, sessionId: "amzn1.echo-api.session.local", application: app, attributes, user },
    context: {
      System: {
        application: app,
        user,
        device: { deviceId: "amzn1.ask.device.local", supportedInterfaces: {} },
        apiEndpoint: "https://api.eu.amazonalexa.com",
      },
    },
    request: { requestId: `amzn1.echo-api.request.${Math.random().toString(36).slice(2)}`, timestamp: new Date().toISOString(), locale: "en-IN", ...request },
  };
}
async function turn(label, request, isNew = false) {
  const t0 = Date.now();
  const res = await new Promise((ok, no) => handler(envelope(request, isNew), {}, (err, r) => (err ? no(err) : ok(r))));
  attributes = res.sessionAttributes ?? {};
  const speech = res.response?.outputSpeech?.ssml ?? res.response?.outputSpeech?.text;
  console.log(`\n=== ${label} (${Date.now() - t0} ms) shouldEndSession=${res.response?.shouldEndSession}`);
  console.log("SPEECH :", speech);
  if (res.response?.card) console.log("CARD   :", res.response.card.title, "\n", res.response.card.content);
  console.log("ATTRS  :", JSON.stringify({ ...attributes, cart_id: attributes.cart_id ? "<set>" : undefined }));
  return res;
}

const only = process.argv[2];
await turn("LaunchRequest", { type: "LaunchRequest" }, true);
if (only === "launch") process.exit(0);
await turn("OrderMilkIntent", { type: "IntentRequest", intent: { name: "OrderMilkIntent", confirmationStatus: "NONE", slots: {} } }, true);
if (attributes.cart_id) await turn("AMAZON.YesIntent (DRY RUN)", { type: "IntentRequest", intent: { name: "AMAZON.YesIntent", confirmationStatus: "NONE" } });
await turn("AMAZON.YesIntent with no cart (guard)", { type: "IntentRequest", intent: { name: "AMAZON.YesIntent", confirmationStatus: "NONE" } }, true);
