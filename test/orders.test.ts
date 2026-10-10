import { describe, expect, it } from "vitest";
import { signBody } from "../src/hmac.ts";
import { body, orderPayload, setup } from "./helpers.ts";

describe("webhook de pedido", () => {
  it("registra a venda e atribui ao criador do cupom", async () => {
    const t = setup();
    await t.seedCreators();
    const res = await t.post(
      "/webhooks/orders",
      orderPayload({ discount_codes: [{ code: "ANA10", amount: "20.00" }] }),
    );
    expect(res.status).toBe(201);
    const { result, order } = await body(res);
    expect(result).toBe("created");
    expect(order).toMatchObject({ order_id: "5001", status: "paid", total_cents: 19990, net_cents: 19990 });
    expect(order.attribution).toMatchObject({
      creator_id: "crt_ana",
      rule: "coupon",
      state: "active",
      attributed_net_cents: 19990,
    });
  });

  it("webhook repetido não soma a venda de novo", async () => {
    const t = setup();
    await t.seedCreators();
    const payload = orderPayload({ discount_codes: [{ code: "ANA10" }] });
    expect((await t.post("/webhooks/orders", payload, { "x-shopify-webhook-id": "d-1" })).status).toBe(201);
    const again = await t.post("/webhooks/orders", payload, { "x-shopify-webhook-id": "d-1" });
    expect(again.status).toBe(200);
    expect((await body(again)).result).toBe("duplicate");

    const sales = await body<{ totals: { paid_orders: number; gross_cents: number } }>(
      await t.get("/creators/crt_ana/sales"),
    );
    expect(sales.totals).toMatchObject({ paid_orders: 1, gross_cents: 19990 });

    const order = await t.order("5001");
    expect(order.deliveries.map((d) => d.result)).toEqual(["created", "duplicate"]);
  });

  it("pedido aguardando pagamento só conta quando o reenvio chega pago, e não volta atrás", async () => {
    const t = setup();
    await t.seedCreators();
    const pending = await body(
      await t.post(
        "/webhooks/orders",
        orderPayload({ financial_status: "pending", discount_codes: [{ code: "ANA10" }] }),
      ),
    );
    expect(pending.order).toMatchObject({ status: "pending", net_cents: 0 });
    expect(pending.order.attribution.state).toBe("not_counted");

    const paid = await body(
      await t.post("/webhooks/orders", orderPayload({ financial_status: "paid", discount_codes: [{ code: "ANA10" }] })),
    );
    expect(paid.result).toBe("status_updated");
    expect(paid.order).toMatchObject({ status: "paid", net_cents: 19990 });

    const stale = await body(await t.post("/webhooks/orders", orderPayload({ financial_status: "pending" })));
    expect(stale.result).toBe("duplicate");
    expect(stale.order.status).toBe("paid");
  });

  it("a atribuição é decidida no primeiro webhook e não muda num reenvio com outro cupom", async () => {
    const t = setup();
    await t.seedCreators();
    await t.post("/webhooks/orders", orderPayload({ discount_codes: [{ code: "ANA10" }] }));
    const again = await body(await t.post("/webhooks/orders", orderPayload({ discount_codes: [{ code: "BRUNO15" }] })));
    expect(again.result).toBe("duplicate");
    expect(again.order.attribution.creator_id).toBe("crt_ana");
  });

  it("guarda id de pedido acima de 2^53 sem arredondar (ids vizinhos não colidem)", async () => {
    const t = setup();
    const raw = (id: string) =>
      `{"id":${id},"total_price":"10.00","financial_status":"paid","discount_codes":[],"landing_site":null}`;
    expect((await t.postRaw("/webhooks/orders", raw("820982911946154508"))).status).toBe(201);
    expect((await t.postRaw("/webhooks/orders", raw("820982911946154509"))).status).toBe(201);
    expect((await t.get("/orders/820982911946154508")).status).toBe(200);
    expect((await t.get("/orders/820982911946154509")).status).toBe(200);
  });

  it("reenvio com financial_status desconhecido não derruba o pedido já gravado", async () => {
    const t = setup();
    await t.post("/webhooks/orders", orderPayload());
    const again = await t.post("/webhooks/orders", orderPayload({ financial_status: "status_novo_da_loja" }));
    expect(again.status).toBe(200);
    expect((await body(again)).order.status).toBe("paid");
  });

  it("pedido de valor zero (brinde) não aparece como estornado", async () => {
    const t = setup();
    await t.seedCreators();
    const { order } = await body(
      await t.post("/webhooks/orders", orderPayload({ total_price: "0.00", discount_codes: [{ code: "ANA10" }] })),
    );
    expect(order.attribution.state).toBe("active");
  });

  it("recusa payload sem total ou com financial_status desconhecido", async () => {
    const t = setup();
    expect((await t.post("/webhooks/orders", orderPayload({ total_price: undefined }))).status).toBe(422);
    expect((await t.post("/webhooks/orders", orderPayload({ total_price: "19,90" }))).status).toBe(422);
    expect((await t.post("/webhooks/orders", orderPayload({ financial_status: "inventado" }))).status).toBe(422);
    expect((await t.get("/orders/5001")).status).toBe(404);
  });

  it("com segredo configurado, só aceita webhook assinado no formato do Shopify", async () => {
    const t = setup({ webhookSecret: "segredo-de-teste" });
    const raw = JSON.stringify(orderPayload());
    expect((await t.postRaw("/webhooks/orders", raw)).status).toBe(401);
    expect((await t.postRaw("/webhooks/orders", raw, { "x-shopify-hmac-sha256": "errado" })).status).toBe(401);
    const signed = await t.postRaw("/webhooks/orders", raw, {
      "x-shopify-hmac-sha256": signBody("segredo-de-teste", raw),
    });
    expect(signed.status).toBe(201);
  });
});
