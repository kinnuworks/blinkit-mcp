import { request, ensureAuthKey, BlinkitError } from "./client.js";
import { loadSession, updateSession } from "./session.js";
import { extractProducts, extractOrders } from "./parse.js";
/* ----------------------------- Auth / login ----------------------------- */
export async function sendOtp(phone) {
    await ensureAuthKey();
    return request("/v2/accounts/", { method: "POST", form: { user_phone: phone } });
}
/**
 * Verify OTP. IMPORTANT: Blinkit returns `success:true` even for a WRONG code —
 * the real signal is `verified` / presence of `access_token`. We branch on that.
 */
export async function verifyOtp(phone, code) {
    await ensureAuthKey();
    const res = await request("/v2/accounts/verify/phone/code/", {
        method: "POST",
        form: { user_phone: phone, verify_code: code },
    });
    if (res?.verified && res?.access_token) {
        await updateSession({ access_token: res.access_token, user_id: res?.user?.id, phone: res?.user?.phone ?? phone });
        return { ok: true, message: res.message ?? "Login successful", user_id: res?.user?.id };
    }
    return { ok: false, message: res?.message ?? "Verification failed" };
}
export async function logout() {
    await updateSession({ access_token: undefined, user_id: undefined });
}
/* ----------------------------- Location ----------------------------- */
export async function checkServiceability(lat, lon) {
    await ensureAuthKey();
    return request("/visibility", { query: { latitude: lat, longitude: lon } });
}
export async function locationInfo(lat, lon) {
    await ensureAuthKey();
    return request("/location/info", { query: { lat, lon, is_pin_moved: false } });
}
/**
 * Resolve a lat/lon, confirm serviceability, pick the express dark store, and
 * persist it all as the default location. This is the single-location fast path.
 */
export async function setLocation(lat, lon) {
    await ensureAuthKey();
    const [info, vis] = await Promise.all([
        locationInfo(lat, lon),
        checkServiceability(lat, lon),
    ]);
    const merchants = vis?.merchants ?? [];
    // Prefer the "express" assortment store, else the top-ranked one.
    const express = merchants.find((m) => m?.additional_filters?.assortment_tags?.includes("express"));
    const merchant = express ?? merchants[0];
    await updateSession({
        lat,
        lon,
        merchant_id: merchant ? Number(merchant.id) : undefined,
        location_label: info?.display_address?.address_line ?? info?.locality,
    });
    return {
        serviceable: Boolean(vis?.serviceable && info?.is_serviceable),
        address: info?.display_address ?? null,
        city: vis?.cityName,
        merchant_id: merchant ? Number(merchant.id) : null,
        assortments: merchants.map((m) => ({
            id: Number(m.id),
            tags: m?.additional_filters?.assortment_tags ?? [],
        })),
    };
}
/* ----------------------------- Catalog ----------------------------- */
export async function getHomeFeed() {
    await ensureAuthKey();
    const res = await request("/feed/", { query: { template_version: 9 } });
    return extractProducts(res);
}
export async function searchProducts(query, page = 0) {
    await ensureAuthKey();
    const q = { q: query, search_type: "type_to_search" };
    if (page > 0) {
        q.offset = page * 12;
        q.limit = 12;
        q.page_index = page;
        q.actual_query = query;
        q.search_method = "basic";
    }
    const res = await request("/v1/layout/search", {
        method: "POST",
        query: q,
        json: { applied_filters: null, sort: "", previous_search_query: query },
    });
    return extractProducts(res);
}
export async function autosuggest(query) {
    await ensureAuthKey();
    const res = await request("/v1/actions/auto_suggest", {
        method: "POST",
        json: { q: query, search_type: "type_to_search" },
    });
    const out = new Set();
    const walk = (n) => {
        if (!n || typeof n !== "object")
            return;
        const v = n?.click_action?.update_search_query?.query;
        if (typeof v === "string")
            out.add(v);
        Object.values(n).forEach(walk);
    };
    walk(res);
    return [...out];
}
export async function getRecommendations(productId) {
    await ensureAuthKey();
    const res = await request(`/v1/actions/product_recommendations/${productId}`, {
        method: "POST",
        query: { page_type: "search_listing_page" },
        json: { product_id: String(productId), recommendation_type: "DEFAULT", send_cart_items: true },
    });
    return extractProducts(res);
}
/**
 * Recompute the cart for a set of line items. Blinkit's cart is stateless on the
 * client side — you POST the full item list each time and get back the priced cart.
 */
export async function computeCart(items) {
    await ensureAuthKey();
    const res = await request("/v5/carts", {
        method: "POST",
        json: { items, promo_codes: [""] },
    });
    const cart = res?.cart_data ?? {};
    const bill = cart?.bill_details ?? {};
    const validations = cart?.validations ?? [];
    return {
        items: bill?.total_items ?? items.length,
        payable_amount: bill?.payable_amount,
        total_mrp: bill?.total_mrp,
        delivery_charge: bill?.delivery_charge,
        free_delivery_mov: bill?.free_delivery_mov,
        raw_bill: bill,
        requires_login: validations.some((v) => v?.code === "FORCE_LOGOUT_USER"),
    };
}
/* ----------------------------- Orders ----------------------------- */
export async function orderCount() {
    const s = await loadSession();
    await ensureAuthKey();
    const res = await request("/v1/order_count", { authed: true });
    const node = res?.data?.[`user:${s.user_id}`]?.order_traits_realtime;
    return node ?? res?.data ?? res;
}
export async function getAddresses() {
    const s = await loadSession();
    await ensureAuthKey();
    const res = await request("/v4/address", {
        authed: true,
        query: { cur_lat: s.lat, cur_lon: s.lon },
    });
    const list = res?.addresses?.addresses_data ?? res?.addresses ?? [];
    return list.map((a) => ({
        id: a.id,
        label: a.label_id ?? a.label,
        lat: a.latitude,
        lon: a.longitude,
        formatted: a.formatted_address ?? a.address,
    }));
}
/**
 * Headless checkout prep: create a real server cart from items, bind the delivery address, and
 * validate. Returns the server `cart_id` to hand to the payment chain (prepareOrder).
 */
export async function prepareCheckout(items, addressId) {
    await ensureAuthKey();
    const created = await request("/v5/carts", {
        method: "POST",
        authed: true,
        json: { items, promo_codes: [""] },
    });
    const cartId = created?.cart_data?.id;
    if (!cartId)
        throw new BlinkitError("Failed to create server cart", 0, created);
    await request(`/v5/carts/${cartId}`, { method: "PATCH", authed: true, json: { address_id: addressId } });
    const validated = await request(`/v5/carts/${cartId}/validate`, { method: "POST", authed: true, json: {} });
    return {
        cart_id: cartId,
        payable: validated?.cart_data?.bill_details?.payable_amount ?? created?.cart_data?.bill_details?.payable_amount,
        valid: (validated?.cart_data?.status_code ?? 0) === 0,
    };
}
export async function orderHistory() {
    await ensureAuthKey();
    const res = await request("/v1/layout/order_history", { method: "POST", authed: true });
    return extractOrders(res);
}
//# sourceMappingURL=api.js.map