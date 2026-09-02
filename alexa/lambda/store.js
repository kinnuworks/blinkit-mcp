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

export function createStore() {
  if (process.env.BLINKIT_STORE === "file") return null;
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
