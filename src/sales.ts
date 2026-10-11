import type { DatabaseSync } from "node:sqlite";
import { type Attribution, attribute, type Creator, type CreatorDirectory, normalizeCoupon } from "./attribution.ts";
import type { Clock } from "./clock.ts";
import { DomainError } from "./errors.ts";
import { formatCents } from "./money.ts";
import { type OrderStatus, parseOrder, parseRefund } from "./shopify.ts";

type OrderRow = {
  id: string;
  name: string | null;
  total_cents: number;
  currency: string;
  status: OrderStatus;
  financial_status: string;
  creator_id: string | null;
  attribution_rule: Attribution["rule"];
  attribution: string;
  landing_site: string | null;
  order_created_at: string | null;
  received_at: string;
  updated_at: string;
};

type RefundStatus = "pending_order" | "applied" | "capped" | "ignored";

type RefundRow = {
  id: string;
  order_id: string;
  requested_cents: number;
  applied_cents: number | null;
  status: RefundStatus;
  reason: string;
  refund_created_at: string | null;
  received_at: string;
  applied_at: string | null;
};

type DeliveryRow = {
  seq: number;
  topic: "orders" | "refunds";
  external_id: string;
  delivery_id: string | null;
  result: string;
  received_at: string;
};

export type OrderView = ReturnType<ReturnType<typeof createSalesService>["getOrder"]>;

function refundView(row: RefundRow) {
  return {
    id: row.id,
    order_id: row.order_id,
    requested_cents: row.requested_cents,
    applied_cents: row.applied_cents,
    status: row.status,
    reason: row.reason,
    refund_created_at: row.refund_created_at,
    received_at: row.received_at,
    applied_at: row.applied_at,
  };
}

// Pedido que chega de novo só avança de "aguardando pagamento" para pago ou cancelado.
// Qualquer outra mudança de status num reenvio (inclusive status desconhecido) é ignorada,
// e a entrega fica registrada.
function nextOrderStatus(current: OrderStatus, incoming: OrderStatus | null): OrderStatus {
  if (current === "pending" && (incoming === "paid" || incoming === "voided")) return incoming;
  return current;
}

export function createSalesService({ db, clock }: { db: DatabaseSync; clock: Clock }) {
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const creators: CreatorDirectory = {
    byCoupon: (code) =>
      db
        .prepare("SELECT c.id, c.ref FROM creator_coupons cc JOIN creators c ON c.id = cc.creator_id WHERE cc.code = ?")
        .get(code) as Creator | undefined,
    byRef: (ref) => db.prepare("SELECT id, ref FROM creators WHERE ref = ?").get(ref) as Creator | undefined,
  };

  function orderRow(id: string): OrderRow | undefined {
    return db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
  }

  function appliedSoFar(orderId: string): number {
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(applied_cents), 0) AS total FROM refunds WHERE order_id = ? AND applied_cents IS NOT NULL",
      )
      .get(orderId) as { total: number };
    return row.total;
  }

  function recordDelivery(
    topic: "orders" | "refunds",
    externalId: string,
    orderId: string,
    deliveryId: string | undefined,
    result: string,
    now: string,
    summary: Record<string, unknown>,
  ) {
    db.prepare(
      "INSERT INTO webhook_deliveries (topic, external_id, order_id, delivery_id, result, received_at, summary) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(topic, externalId, orderId, deliveryId ?? null, result, now, JSON.stringify(summary));
  }

  // Decide quanto de um estorno entra, sem deixar a soma passar do valor da venda.
  function settleRefund(
    order: OrderRow,
    requestedCents: number,
  ): { applied: number; status: RefundStatus; reason: string } {
    const remaining = order.total_cents - appliedSoFar(order.id);
    if (requestedCents === 0) return { applied: 0, status: "ignored", reason: "estorno sem valor em dinheiro" };
    if (remaining <= 0) return { applied: 0, status: "ignored", reason: "venda já totalmente estornada" };
    if (requestedCents > remaining) {
      return {
        applied: remaining,
        status: "capped",
        reason: `pedido de ${formatCents(requestedCents)} limitado ao saldo de ${formatCents(remaining)}`,
      };
    }
    return { applied: requestedCents, status: "applied", reason: "aplicado" };
  }

  function getOrder(id: string) {
    const order = orderRow(id);
    if (!order) throw new DomainError("pedido_nao_encontrado", "Pedido não encontrado.", 404);
    const refunds = db
      .prepare("SELECT * FROM refunds WHERE order_id = ? ORDER BY received_at, rowid")
      .all(id) as RefundRow[];
    const deliveries = db
      .prepare(
        "SELECT seq, topic, external_id, delivery_id, result, received_at FROM webhook_deliveries WHERE order_id = ? ORDER BY seq",
      )
      .all(id) as DeliveryRow[];

    const attribution = JSON.parse(order.attribution) as Attribution;
    const refundedCents = refunds.reduce((sum, r) => sum + (r.applied_cents ?? 0), 0);
    const counts = order.status === "paid";
    const netCents = counts ? Math.max(0, order.total_cents - refundedCents) : 0;

    let state: "none" | "not_counted" | "active" | "partially_reverted" | "zeroed";
    if (!order.creator_id) state = "none";
    else if (!counts) state = "not_counted";
    else if (order.total_cents > 0 && refundedCents >= order.total_cents) state = "zeroed";
    else if (refundedCents > 0) state = "partially_reverted";
    else state = "active";

    return {
      order_id: order.id,
      name: order.name,
      status: order.status,
      financial_status: order.financial_status,
      currency: order.currency,
      total_cents: order.total_cents,
      refunded_cents: refundedCents,
      net_cents: netCents,
      attribution: {
        creator_id: order.creator_id,
        rule: order.attribution_rule,
        reason: attribution.reason,
        conflict: attribution.conflict,
        state,
        attributed_net_cents: order.creator_id ? netCents : 0,
        touches: attribution.touches,
      },
      refunds: refunds.map(refundView),
      deliveries,
      received_at: order.received_at,
      updated_at: order.updated_at,
    };
  }

  // O estorno pode chegar antes do pedido; aqui ele aparece mesmo enquanto GET /orders/:id ainda dá 404.
  function getRefund(id: string) {
    const row = db.prepare("SELECT * FROM refunds WHERE id = ?").get(id) as RefundRow | undefined;
    if (!row) throw new DomainError("estorno_nao_encontrado", "Estorno não encontrado.", 404);
    const deliveries = db
      .prepare(
        "SELECT seq, topic, external_id, delivery_id, result, received_at FROM webhook_deliveries WHERE topic = 'refunds' AND external_id = ? ORDER BY seq",
      )
      .all(id) as DeliveryRow[];
    return { ...refundView(row), order_received: orderRow(row.order_id) !== undefined, deliveries };
  }

  return {
    getOrder,
    getRefund,

    createCreator(input: unknown) {
      const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
      const id = typeof body.id === "string" ? body.id.trim() : "";
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const ref = typeof body.ref === "string" ? body.ref.trim().toLowerCase() : "";
      const coupons = Array.isArray(body.coupons)
        ? body.coupons
            .filter((c): c is string => typeof c === "string")
            .map(normalizeCoupon)
            .filter(Boolean)
        : [];
      if (!id || !name || !/^[a-z0-9_-]{2,40}$/.test(ref)) {
        throw new DomainError("criador_invalido", "id, name e ref (a-z, 0-9, _ ou -) são obrigatórios.", 422);
      }
      try {
        transaction(() => {
          db.prepare("INSERT INTO creators (id, name, ref) VALUES (?, ?, ?)").run(id, name, ref);
          for (const code of coupons) {
            db.prepare("INSERT INTO creator_coupons (code, creator_id) VALUES (?, ?)").run(code, id);
          }
        });
      } catch (error) {
        if (String(error).includes("UNIQUE")) {
          throw new DomainError("criador_conflito", "id, ref ou cupom já pertence a outro criador.", 409);
        }
        throw error;
      }
      return { id, name, ref, coupons };
    },

    ingestOrder(payload: unknown, deliveryId?: string) {
      const input = parseOrder(payload);
      const now = clock.now().toISOString();
      const summary = {
        total_cents: input.totalCents,
        financial_status: input.financialStatus,
        coupons: input.couponCodes,
        utm: input.utm,
      };

      const result = transaction((): "created" | "duplicate" | "status_updated" => {
        const existing = orderRow(input.id);
        if (existing) {
          // Webhook repetido: nunca soma a venda de novo.
          const next = nextOrderStatus(existing.status, input.status);
          if (next !== existing.status) {
            db.prepare("UPDATE orders SET status = ?, financial_status = ?, updated_at = ? WHERE id = ?").run(
              next,
              input.financialStatus,
              now,
              input.id,
            );
            recordDelivery("orders", input.id, input.id, deliveryId, "status_updated", now, summary);
            return "status_updated";
          }
          recordDelivery("orders", input.id, input.id, deliveryId, "duplicate", now, summary);
          return "duplicate";
        }

        // Pedido novo com status desconhecido: não dá para saber se conta como venda.
        if (input.status === null) {
          throw new DomainError("payload_invalido", `financial_status desconhecido: "${input.financialStatus}".`, 422);
        }
        const attribution = attribute({ couponCodes: input.couponCodes, utm: input.utm }, creators);
        db.prepare(
          `INSERT INTO orders (id, name, total_cents, currency, status, financial_status, creator_id, attribution_rule,
                               attribution, landing_site, order_created_at, received_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.id,
          input.name,
          input.totalCents,
          input.currency,
          input.status,
          input.financialStatus,
          attribution.creator_id,
          attribution.rule,
          JSON.stringify({ reason: attribution.reason, conflict: attribution.conflict, touches: attribution.touches }),
          input.landingSite,
          input.createdAt,
          now,
          now,
        );
        recordDelivery("orders", input.id, input.id, deliveryId, "created", now, summary);

        // Estornos que chegaram antes do pedido: aplica agora, na ordem em que chegaram.
        const order = orderRow(input.id) as OrderRow;
        const waiting = db
          .prepare("SELECT * FROM refunds WHERE order_id = ? AND status = 'pending_order' ORDER BY received_at, rowid")
          .all(input.id) as RefundRow[];
        for (const refund of waiting) {
          const settled = settleRefund(order, refund.requested_cents);
          db.prepare("UPDATE refunds SET applied_cents = ?, status = ?, reason = ?, applied_at = ? WHERE id = ?").run(
            settled.applied,
            settled.status,
            `chegou antes do pedido; ${settled.reason}`,
            now,
            refund.id,
          );
        }
        return "created";
      });

      return { result, order: getOrder(input.id) };
    },

    ingestRefund(payload: unknown, deliveryId?: string) {
      const input = parseRefund(payload);
      const now = clock.now().toISOString();
      const summary = { order_id: input.orderId, requested_cents: input.amountCents };

      const result = transaction((): "duplicate" | RefundStatus => {
        const existing = db.prepare("SELECT id FROM refunds WHERE id = ?").get(input.id);
        if (existing) {
          // Mesmo estorno entregue de novo: não aplica outra vez.
          recordDelivery("refunds", input.id, input.orderId, deliveryId, "duplicate", now, summary);
          return "duplicate";
        }

        const order = orderRow(input.orderId);
        if (!order) {
          db.prepare(
            `INSERT INTO refunds (id, order_id, requested_cents, applied_cents, status, reason, refund_created_at, received_at)
             VALUES (?, ?, ?, NULL, 'pending_order', ?, ?, ?)`,
          ).run(
            input.id,
            input.orderId,
            input.amountCents,
            "pedido ainda não chegou; aplica quando chegar",
            input.createdAt,
            now,
          );
          recordDelivery("refunds", input.id, input.orderId, deliveryId, "pending_order", now, summary);
          return "pending_order";
        }

        const settled = settleRefund(order, input.amountCents);
        db.prepare(
          `INSERT INTO refunds (id, order_id, requested_cents, applied_cents, status, reason, refund_created_at, received_at, applied_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.id,
          input.orderId,
          input.amountCents,
          settled.applied,
          settled.status,
          settled.reason,
          input.createdAt,
          now,
          now,
        );
        recordDelivery("refunds", input.id, input.orderId, deliveryId, settled.status, now, summary);
        return settled.status;
      });

      const refund = db.prepare("SELECT * FROM refunds WHERE id = ?").get(input.id) as RefundRow;
      return {
        result,
        refund: refundView(refund),
        order: orderRow(input.orderId) ? getOrder(input.orderId) : null,
      };
    },

    creatorSales(creatorId: string) {
      const creator = db.prepare("SELECT id, name, ref FROM creators WHERE id = ?").get(creatorId) as
        | { id: string; name: string; ref: string }
        | undefined;
      if (!creator) throw new DomainError("criador_nao_encontrado", "Criador não encontrado.", 404);
      const ids = db
        .prepare("SELECT id FROM orders WHERE creator_id = ? ORDER BY received_at, rowid")
        .all(creatorId) as Array<{ id: string }>;
      const orders = ids.map(({ id }) => getOrder(id));
      const counted = orders.filter((o) => o.status === "paid");
      const gross = counted.reduce((sum, o) => sum + o.total_cents, 0);
      const net = counted.reduce((sum, o) => sum + o.net_cents, 0);
      return {
        creator,
        totals: { paid_orders: counted.length, gross_cents: gross, refunded_cents: gross - net, net_cents: net },
        orders: orders.map((o) => ({
          order_id: o.order_id,
          status: o.status,
          rule: o.attribution.rule,
          state: o.attribution.state,
          total_cents: o.total_cents,
          refunded_cents: o.refunded_cents,
          net_cents: o.net_cents,
        })),
      };
    },
  };
}
