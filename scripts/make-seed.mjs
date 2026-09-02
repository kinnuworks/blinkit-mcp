#!/usr/bin/env node
/**
 * Build the DynamoDB item the Lambda reads, from the local MCP session.
 * Writes ~/.blinkit-mcp/dynamo-seed.json (chmod 600). NEVER prints the token.
 *
 * Paste the file's contents into the hosted skill's DynamoDB table
 * (Alexa console → Code → "AWS resources" link → DynamoDB → the table → Create item →
 * JSON view, "View DynamoDB JSON" OFF) — or `node scripts/make-seed.mjs --put` with AWS
 * credentials + BLINKIT_TABLE set to write it directly (own-account Lambda fallback).
 */
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = join(homedir(), ".blinkit-mcp");
const s = JSON.parse(await readFile(join(HOME, "session.json"), "utf8"));
for (const k of ["access_token", "device_id", "session_uuid", "lat", "lon", "phone", "address_id"]) {
  if (s[k] === undefined) throw new Error(`session.json is missing ${k} — log in first`);
}
const arg = (name, d) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const item = {
  id: "blinkit",
  device_id: s.device_id,
  session_uuid: s.session_uuid,
  auth_key: s.auth_key,
  access_token: s.access_token,
  user_id: s.user_id,
  phone: s.phone,
  lat: s.lat,
  lon: s.lon,
  merchant_id: s.merchant_id,
  location_label: s.location_label,
  address_id: Number(arg("address", s.address_id ?? 153331019)), // the saved Vijayawada home address (verified via /v4/address)
  address_spoken: arg("address-spoken", s.address_spoken ?? "your home address"), // short readback, e.g. "Sirivillu apartment"
  product_id: Number(arg("product", 564250)), // Vijaya Dairy Gold Full Cream Milk 500 ml
  product_query: "Vijaya milk",
  product_spoken: "Vijaya Gold full cream milk, five hundred ml",
  quantity: Number(arg("qty", 4)),
  payment: arg("payment", s.payment ?? "cod"), // "cod" (Cash on Delivery, verified offered) | "upi"
  vpa: arg("vpa", s.vpa ?? ""), // only for payment=upi: your UPI id, e.g. name@ybl — empty → QR-link fallback
};
const out = join(HOME, "dynamo-seed.json");
await writeFile(out, JSON.stringify(item, null, 2), { mode: 0o600 });
console.log(`wrote ${out}`);
console.log("keys:", Object.keys(item).join(", "));
console.log(`address_id=${item.address_id} product_id=${item.product_id} quantity=${item.quantity} payment=${item.payment} vpa=${item.vpa || "(none)"}`);

if (process.argv.includes("--put")) {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const table = process.env.BLINKIT_TABLE ?? process.env.DYNAMODB_PERSISTENCE_TABLE_NAME;
  if (!table) throw new Error("set BLINKIT_TABLE");
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.BLINKIT_REGION ?? process.env.AWS_REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  await doc.send(new PutCommand({ TableName: table, Item: item }));
  console.log(`put item id=blinkit into ${table}`);
}
