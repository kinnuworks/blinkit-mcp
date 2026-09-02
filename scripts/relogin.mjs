#!/usr/bin/env node
/**
 * Refresh the Blinkit access_token by OTP, then (optionally) push it to the skill's DynamoDB item.
 * Run this if the skill ever says "Blinkit has logged me out".
 *
 *   node scripts/relogin.mjs 9650299514           # login only → updates ~/.blinkit-mcp/session.json
 *   node scripts/relogin.mjs 9650299514 --put      # login, then write the DynamoDB item too
 *                                                   #   (needs AWS creds + BLINKIT_TABLE=<table>)
 *
 * YOU type the OTP that Blinkit texts you — the script never asks for a password.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { sendOtp, verifyOtp } = await import(join(root, "dist/api.js"));
const { loadSession } = await import(join(root, "dist/session.js"));

const phone = process.argv[2];
if (!phone || !/^\d{10}$/.test(phone)) {
  console.error("usage: node scripts/relogin.mjs <10-digit-phone> [--put]");
  process.exit(1);
}

console.log(`Sending OTP to ${phone} …`);
const sent = await sendOtp(phone);
if (!sent?.sms_sent) console.warn("warning: Blinkit did not confirm sms_sent —", JSON.stringify(sent));

const rl = createInterface({ input: stdin, output: stdout });
const code = (await rl.question("Enter the OTP Blinkit just texted you: ")).trim();
await rl.close();

const res = await verifyOtp(phone, code);
if (!res.ok) {
  console.error("Login failed:", res.message);
  process.exit(1);
}
const s = await loadSession();
console.log(`Login OK. user_id ${s.user_id}. session.json updated (token not printed).`);

if (process.argv.includes("--put")) {
  console.log("Writing DynamoDB item …");
  const r = spawnSync(process.execPath, [join(root, "scripts/make-seed.mjs"), "--put"], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}
console.log('Done. If the skill runs on Alexa-hosted (not your own AWS account), open the DynamoDB');
console.log('link in the Code tab and paste the new access_token into the "blinkit" item — or run:');
console.log("  node scripts/make-seed.mjs   (then paste ~/.blinkit-mcp/dynamo-seed.json)");
