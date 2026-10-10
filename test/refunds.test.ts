import { describe, expect, it } from "vitest";
import { body, orderPayload, refundPayload, setup } from "./helpers.ts";

type RefundOut = {
  result: string;
  refund: { id: string; requested_cents: number; applied_cents: number | null; status: string; reason: string };
};

async function paidOrderFromAna() {
  const t = setup();
  await t.seedCreators();
  await t.post("/webhooks/orders", orderPayload({ discount_codes: [{ code: "ANA10" }] })); // R$ 199,90
  return t;
}

describe("estorno", () => {
  it("parcial reduz a atribuição e fica rastreável", async () => {
    const t = await paidOrderFromAna();
    const res = await t.post("/webhooks/refunds", refundPayload("r-1", "5001", "50.00"));
    expect(res.status).toBe(201);
    expect((await body<RefundOut>(res)).refund).toMatchObject({
      requested_cents: 5000,
      applied_cents: 5000,
      status: "applied",
    });

    const order = await t.order("5001");
    expect(order).toMatchObject({ refunded_cents: 5000, net_cents: 14990 });
    expect(order.attribution).toMatchObject({
      creator_id: "crt_ana",
      state: "partially_reverted",
      attributed_net_cents: 14990,
    });
    expect(order.refunds).toHaveLength(1);
  });

  it("repetido (mesmo estorno entregue de novo) não é aplicado duas vezes", async () => {
    const t = await paidOrderFromAna();
    await t.post("/webhooks/refunds", refundPayload("r-1", "5001", "50.00"));
    const again = await t.post("/webhooks/refunds", refundPayload("r-1", "5001", "50.00"));
    expect(again.status).toBe(200);
    expect((await body<RefundOut>(again)).result).toBe("duplicate");

    const view = await t.order("5001");
    expect(view.refunded_cents).toBe(5000);
    expect(view.refunds).toHaveLength(1);
    expect(view.deliveries.filter((d) => d.topic === "refunds").map((d) => d.result)).toEqual(["applied", "duplicate"]);
  });

  it("vários estornos nunca passam do valor da venda: o excedente é limitado e registrado", async () => {
    const t = await paidOrderFromAna();
    const results: RefundOut[] = [];
    for (const id of ["r-1", "r-2", "r-3", "r-4"]) {
      results.push(await body<RefundOut>(await t.post("/webhooks/refunds", refundPayload(id, "5001", "80.00"))));
    }
    expect(results.map((r) => [r.refund.status, r.refund.applied_cents])).toEqual([
      ["applied", 8000],
      ["applied", 8000],
      ["capped", 3990],
      ["ignored", 0],
    ]);
    expect(results[2]?.refund.reason).toBe("pedido de 80.00 limitado ao saldo de 39.90");

    const view = await t.order("5001");
    expect(view.refunded_cents).toBe(19990);
    expect(view.net_cents).toBe(0);
    expect(view.attribution).toMatchObject({ creator_id: "crt_ana", state: "zeroed", attributed_net_cents: 0 });
    expect(view.refunds).toHaveLength(4);
  });

  it("total zera a atribuição sem apagar o histórico", async () => {
    const t = await paidOrderFromAna();
    await t.post("/webhooks/refunds", refundPayload("r-1", "5001", "199.90"));

    const sales = (await (await t.get("/creators/crt_ana/sales")).json()) as {
      totals: { paid_orders: number; gross_cents: number; refunded_cents: number; net_cents: number };
      orders: Array<{ order_id: string; state: string }>;
    };
    expect(sales.totals).toEqual({ paid_orders: 1, gross_cents: 19990, refunded_cents: 19990, net_cents: 0 });
    expect(sales.orders).toEqual([expect.objectContaining({ order_id: "5001", state: "zeroed" })]);
  });

  it("que chega antes do pedido fica pendente e é aplicado quando o pedido chega", async () => {
    const t = setup();
    await t.seedCreators();
    const early = await t.post("/webhooks/refunds", refundPayload("r-early", "5001", "30.00"));
    expect(early.status).toBe(202);
    expect((await body<RefundOut>(early)).refund).toMatchObject({ status: "pending_order", applied_cents: null });
    expect((await t.get("/orders/5001")).status).toBe(404);

    t.advance(60_000);
    const created = await body(await t.post("/webhooks/orders", orderPayload({ discount_codes: [{ code: "ANA10" }] })));
    expect(created.order).toMatchObject({ refunded_cents: 3000, net_cents: 16990 });
    expect(created.order.refunds[0]).toMatchObject({
      id: "r-early",
      status: "applied",
      applied_cents: 3000,
      reason: "chegou antes do pedido; aplicado",
    });
  });

  it("vários que chegam antes do pedido são aplicados na ordem de chegada, com o limite", async () => {
    const t = setup();
    await t.post("/webhooks/refunds", refundPayload("r-a", "5001", "30.00"));
    t.advance(1_000);
    await t.post("/webhooks/refunds", refundPayload("r-b", "5001", "200.00"));
    const created = await body(await t.post("/webhooks/orders", orderPayload()));
    expect(created.order.refunds.map((r) => [r.id, r.status, r.applied_cents])).toEqual([
      ["r-a", "applied", 3000],
      ["r-b", "capped", 16990],
    ]);
    expect(created.order.refunded_cents).toBe(19990);
  });

  it("que chega antes do pedido, repetido, é aplicado uma vez só", async () => {
    const t = setup();
    await t.post("/webhooks/refunds", refundPayload("r-early", "5001", "30.00"));
    const again = await t.post("/webhooks/refunds", refundPayload("r-early", "5001", "30.00"));
    expect((await body<RefundOut>(again)).result).toBe("duplicate");

    const created = await body(await t.post("/webhooks/orders", orderPayload()));
    expect(created.order.refunded_cents).toBe(3000);
    expect(created.order.refunds).toHaveLength(1);
  });

  it("que chega antes do pedido com valor maior que a venda é limitado ao valor da venda", async () => {
    const t = setup();
    await t.post("/webhooks/refunds", refundPayload("r-early", "5001", "500.00"));
    const created = await body(await t.post("/webhooks/orders", orderPayload()));
    expect(created.order.refunded_cents).toBe(19990);
    expect(created.order.refunds[0]).toMatchObject({ status: "capped", applied_cents: 19990, requested_cents: 50000 });
  });

  it("o banco recusa estorno que faria a soma passar do valor da venda", async () => {
    const t = await paidOrderFromAna();
    expect(() =>
      t.db
        .prepare(
          "INSERT INTO refunds (id, order_id, requested_cents, applied_cents, status, reason, received_at) VALUES ('x', '5001', 20000, 20000, 'applied', 'x', 'agora')",
        )
        .run(),
    ).toThrow(/passa do valor da venda/);
  });
});
