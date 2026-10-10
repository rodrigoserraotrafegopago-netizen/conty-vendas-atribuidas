// Tradução do formato Shopify para o formato interno. O resto do código não conhece o payload da loja.

import type { Utm } from "./attribution.ts";
import { DomainError } from "./errors.ts";
import { parseCents } from "./money.ts";

export type OrderStatus = "pending" | "paid" | "voided";

export type OrderInput = {
  id: string;
  name: string | null;
  totalCents: number;
  currency: string;
  /** null quando o financial_status não é conhecido. */
  status: OrderStatus | null;
  financialStatus: string;
  couponCodes: string[];
  utm: Utm;
  landingSite: string | null;
  createdAt: string | null;
};

export type RefundInput = {
  id: string;
  orderId: string;
  amountCents: number;
  createdAt: string | null;
};

// financial_status do Shopify → status que importa para a atribuição.
// O valor estornado nunca vem daqui: vem só do webhook de estorno, com o valor de cada estorno.
const FINANCIAL_STATUS: Record<string, OrderStatus> = {
  pending: "pending",
  authorized: "pending",
  partially_paid: "pending",
  paid: "paid",
  partially_refunded: "paid",
  refunded: "paid",
  voided: "voided",
  expired: "voided",
};

function invalid(message: string): never {
  throw new DomainError("payload_invalido", message, 422);
}

function record(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalid("O corpo precisa ser um objeto JSON.");
  return payload as Record<string, unknown>;
}

function readId(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[A-Za-z0-9_\-:/.]{1,100}$/.test(value.trim())) return value.trim();
  invalid(`${field} é obrigatório.`);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function utmFromLandingSite(landingSite: string | null): Utm {
  if (!landingSite) return {};
  let url: URL;
  try {
    url = new URL(landingSite, "https://loja.invalid");
  } catch {
    return {};
  }
  const get = (name: string) => url.searchParams.get(name) ?? undefined;
  return {
    source: get("utm_source"),
    medium: get("utm_medium"),
    campaign: get("utm_campaign"),
    content: get("utm_content"),
    term: get("utm_term"),
  };
}

export function parseOrder(payload: unknown): OrderInput {
  const body = record(payload);
  const id = readId(body.id, "id");

  const totalCents = parseCents(body.total_price);
  if (totalCents === null) invalid('total_price precisa ser um valor como "199.90".');

  const financialStatus = optionalString(body.financial_status)?.toLowerCase() ?? "";
  const status = Object.hasOwn(FINANCIAL_STATUS, financialStatus) ? (FINANCIAL_STATUS[financialStatus] ?? null) : null;

  const discountCodes = Array.isArray(body.discount_codes) ? body.discount_codes : [];
  const couponCodes = discountCodes
    .map((d) => (d && typeof d === "object" ? (d as Record<string, unknown>).code : undefined))
    .filter((code): code is string => typeof code === "string" && code.trim() !== "");

  const landingSite = optionalString(body.landing_site);
  return {
    id,
    name: optionalString(body.name),
    totalCents,
    currency: optionalString(body.currency)?.toUpperCase() ?? "BRL",
    status,
    financialStatus,
    couponCodes,
    utm: utmFromLandingSite(landingSite),
    landingSite,
    createdAt: optionalString(body.created_at),
  };
}

export function parseRefund(payload: unknown): RefundInput {
  const body = record(payload);
  const id = readId(body.id, "id");
  const orderId = readId(body.order_id, "order_id");

  // Soma só transações de estorno que deram certo, como o Shopify manda em refunds/create.
  const transactions = Array.isArray(body.transactions) ? body.transactions : [];
  let amountCents = 0;
  for (const raw of transactions) {
    const t = record(raw);
    if (t.kind !== "refund" || t.status !== "success") continue;
    const cents = parseCents(t.amount);
    if (cents === null) invalid('amount de transação precisa ser um valor como "50.00".');
    amountCents += cents;
  }

  return { id, orderId, amountCents, createdAt: optionalString(body.created_at) };
}
