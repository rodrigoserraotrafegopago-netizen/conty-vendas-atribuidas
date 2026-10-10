import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import type { OrderView } from "../src/sales.ts";

export function setup(options: { webhookSecret?: string } = {}) {
  let current = new Date("2026-03-12T21:05:00.000Z");
  const db = openDatabase(":memory:");
  const app = createApp({ db, clock: { now: () => new Date(current) }, webhookSecret: options.webhookSecret });

  const postRaw = (path: string, raw: string, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    postRaw(path, JSON.stringify(body), headers);

  return {
    app,
    db,
    post,
    postRaw,
    get: (path: string) => app.request(path),
    async order(id: string): Promise<OrderView> {
      const res = await app.request(`/orders/${id}`);
      if (res.status !== 200) throw new Error(`pedido ${id} não encontrado: ${res.status}`);
      return (await res.json()) as OrderView;
    },
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    async seedCreators() {
      for (const creator of [
        { id: "crt_ana", name: "Ana", ref: "ana", coupons: ["ANA10"] },
        { id: "crt_bruno", name: "Bruno", ref: "bruno", coupons: ["BRUNO15"] },
        { id: "crt_caio", name: "Caio", ref: "caio", coupons: ["CAIO5"] },
      ]) {
        const res = await post("/creators", creator);
        if (res.status !== 201) throw new Error(`criador não criado: ${res.status}`);
      }
    },
  };
}

export function orderPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "5001",
    name: "#5001",
    total_price: "199.90",
    currency: "BRL",
    financial_status: "paid",
    discount_codes: [],
    landing_site: "/produtos/protetor",
    created_at: "2026-03-12T18:05:00-03:00",
    ...overrides,
  };
}

export function refundPayload(id: string, orderId: string, amount: string) {
  return {
    id,
    order_id: orderId,
    created_at: "2026-03-15T10:00:00-03:00",
    transactions: [{ kind: "refund", status: "success", amount }],
  };
}

export async function body<T = { result: string; order: OrderView }>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
