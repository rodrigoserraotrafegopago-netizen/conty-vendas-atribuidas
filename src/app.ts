import type { DatabaseSync } from "node:sqlite";
import { type Context, Hono } from "hono";
import { type Clock, systemClock } from "./clock.ts";
import { DomainError } from "./errors.ts";
import { isValidSignature } from "./hmac.ts";
import { parseJson } from "./json.ts";
import { createSalesService } from "./sales.ts";

export function createApp({
  db,
  clock = systemClock,
  webhookSecret,
}: {
  db: DatabaseSync;
  clock?: Clock;
  /** Quando definido, todo webhook precisa vir assinado (X-Shopify-Hmac-Sha256). */
  webhookSecret?: string;
}) {
  const sales = createSalesService({ db, clock });
  const app = new Hono();

  async function readWebhook(c: Context): Promise<unknown> {
    const raw = await c.req.text();
    if (webhookSecret && !isValidSignature(webhookSecret, raw, c.req.header("x-shopify-hmac-sha256"))) {
      throw new DomainError("assinatura_invalida", "Assinatura do webhook inválida.", 401);
    }
    try {
      return parseJson(raw);
    } catch {
      throw new DomainError("json_invalido", "O corpo precisa ser um JSON válido.", 400);
    }
  }

  async function readJson(c: Context): Promise<unknown> {
    try {
      return await c.req.json();
    } catch {
      throw new DomainError("json_invalido", "O corpo precisa ser um JSON válido.", 400);
    }
  }

  app.onError((error, c) => {
    if (error instanceof DomainError) return c.json(error.toJSON(), error.status);
    console.error(error);
    return c.json({ error: "erro_interno", message: "Erro inesperado." }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/webhooks/orders", async (c) => {
    const out = sales.ingestOrder(await readWebhook(c), c.req.header("x-shopify-webhook-id"));
    return c.json(out, out.result === "created" ? 201 : 200);
  });

  app.post("/webhooks/refunds", async (c) => {
    const out = sales.ingestRefund(await readWebhook(c), c.req.header("x-shopify-webhook-id"));
    const status = out.result === "duplicate" ? 200 : out.result === "pending_order" ? 202 : 201;
    return c.json(out, status);
  });

  app.get("/orders/:id", (c) => c.json(sales.getOrder(c.req.param("id"))));
  app.get("/refunds/:id", (c) => c.json(sales.getRefund(c.req.param("id"))));

  app.post("/creators", async (c) => c.json(sales.createCreator(await readJson(c)), 201));
  app.get("/creators/:id/sales", (c) => c.json(sales.creatorSales(c.req.param("id"))));

  return app;
}
