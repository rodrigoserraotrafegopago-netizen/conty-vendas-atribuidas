import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS creators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ref TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS creator_coupons (
  code TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES creators(id)
);

-- Uma linha por pedido: o id da loja é a chave de idempotência.
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  name TEXT,
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'voided')),
  financial_status TEXT NOT NULL,
  creator_id TEXT REFERENCES creators(id),
  attribution_rule TEXT NOT NULL CHECK (attribution_rule IN ('coupon', 'utm', 'none')),
  attribution TEXT NOT NULL,
  landing_site TEXT,
  order_created_at TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Sem FK para orders: o estorno pode chegar antes do pedido (applied_cents fica nulo até lá).
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  requested_cents INTEGER NOT NULL CHECK (requested_cents >= 0),
  applied_cents INTEGER CHECK (applied_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending_order', 'applied', 'capped', 'ignored')),
  reason TEXT NOT NULL,
  refund_created_at TEXT,
  received_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS refunds_by_order ON refunds (order_id, received_at);

-- Toda entrega de webhook, inclusive as repetidas. Só os campos usados: o payload tem dados pessoais.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL CHECK (topic IN ('orders', 'refunds')),
  external_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  delivery_id TEXT,
  result TEXT NOT NULL,
  received_at TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_by_order ON webhook_deliveries (order_id, seq);

-- A aplicação já limita os estornos ao saldo; os triggers garantem isso no banco também.
CREATE TRIGGER IF NOT EXISTS refunds_never_exceed_total_on_insert
BEFORE INSERT ON refunds
WHEN NEW.applied_cents IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'soma dos estornos passa do valor da venda')
  WHERE (SELECT COALESCE(SUM(applied_cents), 0) FROM refunds WHERE order_id = NEW.order_id) + NEW.applied_cents
      > (SELECT total_cents FROM orders WHERE id = NEW.order_id);
END;

CREATE TRIGGER IF NOT EXISTS refunds_never_exceed_total_on_update
BEFORE UPDATE OF applied_cents ON refunds
WHEN NEW.applied_cents IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'soma dos estornos passa do valor da venda')
  WHERE (SELECT COALESCE(SUM(applied_cents), 0) FROM refunds WHERE order_id = NEW.order_id AND id <> NEW.id) + NEW.applied_cents
      > (SELECT total_cents FROM orders WHERE id = NEW.order_id);
END;

-- Histórico não se apaga, e a atribuição é decidida uma vez só.
CREATE TRIGGER IF NOT EXISTS refunds_are_never_deleted
BEFORE DELETE ON refunds
BEGIN
  SELECT RAISE(ABORT, 'estorno não é apagado');
END;

CREATE TRIGGER IF NOT EXISTS orders_are_never_deleted
BEFORE DELETE ON orders
BEGIN
  SELECT RAISE(ABORT, 'pedido não é apagado');
END;

CREATE TRIGGER IF NOT EXISTS attribution_is_decided_once
BEFORE UPDATE OF creator_id, attribution_rule, attribution ON orders
BEGIN
  SELECT RAISE(ABORT, 'atribuição não muda depois de decidida');
END;
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}
