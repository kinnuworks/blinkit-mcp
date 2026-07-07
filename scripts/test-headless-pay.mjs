// Headless payment-chain probe (READ-ONLY: stops before makePayment so nothing is charged).
// Proves: createOrder + zomato_payment_hash (blinkit) + zpaykit/getPaymentMethods (zomato) all
// work headlessly via impit, cross-domain, and reveals which UPI methods are available.
import { Impit } from "impit";
import { request } from "../dist/client.js";
import { loadSession } from "../dist/session.js";

const CART_ID = process.argv[2] || "3333605227";
const s = await loadSession();
if (!s.access_token) { console.error("not logged in"); process.exit(1); }

// 1) createOrder → PAS token (blinkit, via our impit client)
const co = await request(`/createOrder/${CART_ID}`, { authed: true });
const pas = co?.response?.access_token, orderHash = co?.orderHash;
console.log("createOrder:", { pas: pas?.slice(0,12)+"…", orderHash: orderHash?.slice(0,12)+"…", expires_in: co?.response?.expires_in });

// 2) zomato_payment_hash → payment_hash + numeric order_id (blinkit)
const ph = await request(`/zomato_payment_hash`, { method:"POST", authed:true,
  json:{ cart_id:String(CART_ID), payment_info_data:{ payment_method_id:50, payment_method_type:"upi_qr" } } });
const meta = ph?.zomato_payment_hash_meta;
console.log("payment_hash:", { hash: meta?.payment_hash?.slice(0,10)+"…", order_id: meta?.order_id, payable: meta?.payable_amount });

// 3) zpaykit/getPaymentMethods (zomato.com) — establishes session + lists methods
const zomato = new Impit({ browser: "chrome" });
const form = new URLSearchParams({
  country_id:"1", service_type:"BLINKIT", phone:String(s.phone),
  email:`${s.phone}@blinkit.com`, amount:String(meta?.payable_amount ?? 313), locale:"en",
  order_id:String(meta?.order_id), host_redirect_url:`https://blinkit.com/zpay/${meta?.order_id}`,
  online_payments_flag:"1", isMobileView:"false",
}).toString();
const r = await zomato.fetch("https://www.zomato.com/zpaykit/getPaymentMethods", {
  method:"POST",
  headers:{ "x-client-pas-token":pas, "content-type":"application/x-www-form-urlencoded", "locale":"en",
            referer:"https://www.zomato.com/zpaykit/init", origin:"https://www.zomato.com" },
  body: form,
});
console.log("getPaymentMethods status:", r.status);
const j = await r.json().catch(()=>null);
const cats = j?.response?.paymentMethods?.categories || [];
const upiLike = [];
const walk = (n)=>{ if(!n||typeof n!=="object")return; if(/upi/i.test(n.type||"")||/upi/i.test(n.subtype||"")) upiLike.push({type:n.type,id:n.id,display:n.display_text||n.title}); Object.values(n).forEach(walk); };
walk(cats);
console.log("UPI-like methods offered:", JSON.stringify(upiLike));
console.log("all category types:", cats.map(c=>c.type));
