/**
 * Session/config persistence for Lambda.
 *
 * Lambda has no durable filesystem, so the blinkit library's session (device id,
 * auth_key, access_token, location) plus this skill's own config (address_id,
 * product_id, quantity, vpa) live in ONE DynamoDB item:
 *
 *   Table : $DYNAMODB_PERSISTENCE_TABLE_NAME  (provisioned by Alexa-hosted skills)
 *   Key   : { id: "blinkit" }
 *
 * Every other attribute on the item is spread into the Session object, so the
 * blinkit library sees access_token / lat / lon exactly as it would from
 * ~/.blinkit-mcp/session.json. Override with BLINKIT_TABLE / BLINKIT_REGION /
 * BLINKIT_CONFIG_ID when running in your own AWS account.
 *
 * Set BLINKIT_STORE=file to keep the library's default file store (local testing
 * against ~/.blinkit-mcp/session.json).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Simplest backend for a self-hosted Lambda: the whole session as ONE JSON string in the
 * `BLINKIT_SESSION` environment variable (Lambda encrypts env vars at rest). No database, no IAM.
 * Read-only — the library's in-memory cache handles per-invocation writes, and auth_key is cheap to
 * refetch on a cold start. To rotate the token you edit this one env var (see scripts/make-env.mjs).
 */
function envStore() {
  const raw = process.env.BLINKIT_SESSION;
  if (!raw) return null;
  let seed;
  try {
    seed = JSON.parse(raw);
  } catch (e) {
    throw new Error("BLINKIT_SESSION is not valid JSON: " + e.message);
  }
  return {
    kind: "env:BLINKIT_SESSION",
    async load() {
      return seed;
    },
    async save() {
      /* env vars are read-only from inside the function; the in-memory cache holds runtime updates */
    },
  };
}

export function createStore() {
  if (process.env.BLINKIT_STORE === "file") return null;
  const env = envStore();
  if (env) return env; // preferred for own-account Lambda — no DynamoDB needed
  const table = process.env.BLINKIT_TABLE ?? process.env.DYNAMODB_PERSISTENCE_TABLE_NAME;
  if (!table) return null;
  const region =
    process.env.BLINKIT_REGION ?? process.env.DYNAMODB_PERSISTENCE_REGION ?? process.env.AWS_REGION;
  const id = process.env.BLINKIT_CONFIG_ID ?? "blinkit";
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return {
    kind: `dynamodb:${table}/${id}`,
    async load() {
      const r = await doc.send(new GetCommand({ TableName: table, Key: { id } }));
      if (!r.Item) return null;
      const { id: _drop, ...rest } = r.Item;
      return rest;
    },
    async save(s) {
      await doc.send(new PutCommand({ TableName: table, Item: { ...s, id } }));
    },
  };
}
