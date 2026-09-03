#!/usr/bin/env node
/**
 * Produce the ONE environment-variable value the self-hosted Lambda needs.
 * Writes ~/.blinkit-mcp/blinkit-session.env.txt (chmod 600) — copy its single line into the
 * Lambda's `BLINKIT_SESSION` environment variable. Contains the access_token; keep it private.
 *
 *   node scripts/make-env.mjs                         # payment=cod, address 153331019, 4 units
 *   node scripts/make-env.mjs --payment upi --vpa you@ybl
 */
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = join(homedir(), ".blinkit-mcp");
const s = JSON.parse(await readFile(join(HOME, "session.json"), "utf8"));
for (const k of ["access_token", "device_id", "session_uuid", "lat", "lon", "phone"]) {
  if (s[k] === undefined) throw new Error(`session.json missing ${k} — log in first (scripts/relogin.mjs)`);
}
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const session = {
  device_id: s.device_id, session_uuid: s.session_uuid, auth_key: s.auth_key,
  access_token: s.access_token, user_id: s.user_id, phone: s.phone,
  lat: s.lat, lon: s.lon, merchant_id: s.merchant_id, location_label: s.location_label,
  address_id: Number(arg("address", s.address_id ?? 153331019)),
  address_spoken: arg("address-spoken", s.address_spoken ?? "your home address"),
  product_id: Number(arg("product", 564250)),
  product_query: "Vijaya milk",
  product_spoken: "Vijaya Gold full cream milk, five hundred ml",
  quantity: Number(arg("qty", 4)),
  payment: arg("payment", s.payment ?? "cod"),
  vpa: arg("vpa", s.vpa ?? ""),
};
const value = JSON.stringify(session);
const out = join(HOME, "blinkit-session.env.txt");
await writeFile(out, value + "\n", { mode: 0o600 });
console.log(`wrote ${out}  (${value.length} chars)`);
console.log(`Copy that ONE line into the Lambda env var  BLINKIT_SESSION`);
console.log(`payment=${session.payment} address_id=${session.address_id} product_id=${session.product_id} qty=${session.quantity}`);
