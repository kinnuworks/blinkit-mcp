/**
 * Blinkit responses are server-driven UI (deeply nested "snippets"/"objects"
 * trees). These helpers pull clean domain objects out of that tree defensively,
 * without assuming positions or widget order.
 */

export interface Product {
  product_id: number;
  name: string;
  brand?: string;
  unit?: string;
  price?: number;
  mrp?: number;
  inventory?: number;
  merchant_id?: number;
  merchant_type?: string;
  eta?: string;
  image?: string;
  /** The exact line-item object the cart API (/v5/carts) expects. */
  cart_item?: CartItem;
}

export interface CartItem {
  product_id: number;
  merchant_id: number;
  product_name?: string;
  quantity: number;
  price?: number;
  mrp?: number;
  unit?: string;
  inventory?: number;
  group_id?: number;
  merchant_type?: string;
  eta_identifier?: string;
  brand?: string;
  display_name?: string;
  [k: string]: unknown;
}

function asNum(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function textOf(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "text" in (v as any)) return (v as any).text;
  return undefined;
}

/**
 * Walk an arbitrary SDUI tree and collect every node that looks like a product
 * (has a product_id and an add-to-cart action / cart_item). Deduped by id.
 */
export function extractProducts(root: unknown): Product[] {
  const out = new Map<number, Product>();
  const seen = new Set<unknown>();

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const obj = node as Record<string, any>;

    const cartItem: CartItem | undefined =
      obj?.atc_action?.add_to_cart?.cart_item ??
      obj?.rfc_action?.remove_from_cart?.cart_item ??
      (typeof obj?.product_id !== "undefined" && typeof obj?.merchant_id !== "undefined"
        ? undefined
        : undefined);

    const pid = asNum(obj.product_id ?? obj.type_id ?? cartItem?.product_id);
    const looksProduct =
      pid !== undefined && (cartItem || obj.atc_action || obj.normal_price || obj.mrp || obj.assets);

    if (pid !== undefined && looksProduct) {
      const existing = out.get(pid);
      const product: Product = existing ?? { product_id: pid, name: "" };
      product.name =
        product.name ||
        textOf(obj.display_name) ||
        textOf(obj.name) ||
        cartItem?.display_name ||
        cartItem?.product_name ||
        obj.group_name ||
        "";
      product.brand = product.brand ?? (textOf(obj.brand_name) || obj.brand || cartItem?.brand);
      product.unit = product.unit ?? (textOf(obj.variant) || obj.unit || cartItem?.unit);
      product.price = product.price ?? (asNum(textOf(obj.normal_price)) ?? asNum(obj.price) ?? cartItem?.price);
      product.mrp = product.mrp ?? (asNum(textOf(obj.mrp)) ?? asNum(obj.mrp) ?? cartItem?.mrp);
      product.inventory = product.inventory ?? asNum(obj.inventory) ?? cartItem?.inventory;
      product.merchant_id =
        product.merchant_id ?? asNum(obj.merchant_id) ?? cartItem?.merchant_id;
      product.merchant_type = product.merchant_type ?? obj.merchant_type ?? cartItem?.merchant_type;
      product.eta = product.eta ?? textOf(obj?.eta_tag?.title) ?? textOf(obj?.eta_tag);
      product.image = product.image ?? obj?.image?.url ?? obj?.assets?.[0]?.image_url;
      if (cartItem && !product.cart_item) product.cart_item = cartItem;
      out.set(pid, product);
    }

    for (const key of Object.keys(obj)) visit(obj[key]);
  };

  visit(root);
  return [...out.values()].filter((p) => p.name);
}

/** Pull product_ids out of a Blinkit reorder deeplink (grofers://cart?product_ids=1,2,3). */
export function parseReorderIds(deeplink: string | undefined): number[] {
  if (!deeplink) return [];
  const m = deeplink.match(/product_ids=([\d,]+)/);
  if (!m) return [];
  return m[1].split(",").map((x) => Number(x)).filter(Number.isFinite);
}

export interface OrderSummary {
  order_id?: string;
  cart_id?: string;
  total?: number;
  placed_at?: string;
  status?: string;
  product_names: string[];
  reorder_product_ids: number[];
}

/** Extract order summaries from /v1/layout/order_history SDUI. */
export function extractOrders(root: unknown): OrderSummary[] {
  const orders: OrderSummary[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) return node.forEach(visit);
    const obj = node as Record<string, any>;

    if (obj.widget_type === "order_history_container_vr") {
      const common = obj?.tracking?.common_attributes ?? {};
      const names: string[] = [];
      const ids = new Set<number>();
      let total: number | undefined;
      let placedAt: string | undefined;

      const inner = (n: unknown): void => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(inner);
        const o = n as Record<string, any>;
        const acc = o?.image?.accessibility_text?.text;
        if (typeof acc === "string") names.push(acc);
        const sub = textOf(o.left_underlined_subtitle);
        if (sub && total === undefined) total = asNum(sub);
        const ts = textOf(o.subtitle);
        if (ts && /\d/.test(ts) && !placedAt) placedAt = ts;
        for (const dl of [o?.click_action?.blinkit_deeplink?.url, o?.bottom_button?.click_action?.blinkit_deeplink?.url]) {
          parseReorderIds(dl).forEach((id) => ids.add(id));
        }
        for (const k of Object.keys(o)) inner(o[k]);
      };
      inner(obj);

      orders.push({
        order_id: common.order_id,
        cart_id: common.deeplink?.match(/cart_id=(\d+)/)?.[1],
        total,
        placed_at: placedAt,
        status: common.order_status,
        product_names: [...new Set(names)],
        reorder_product_ids: [...ids],
      });
      return; // don't descend again
    }

    for (const k of Object.keys(obj)) visit(obj[k]);
  };

  visit(root);
  return orders;
}
