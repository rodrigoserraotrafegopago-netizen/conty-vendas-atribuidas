import type { DatabaseSync } from "node:sqlite";

// Criadores de exemplo para rodar a API localmente.
export function seedCreators(db: DatabaseSync): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM creators").get() as { n: number };
  if (row.n > 0) return;
  const creator = db.prepare("INSERT INTO creators (id, name, ref) VALUES (?, ?, ?)");
  const coupon = db.prepare("INSERT INTO creator_coupons (code, creator_id) VALUES (?, ?)");
  creator.run("crt_ana", "Ana", "ana");
  coupon.run("ANA10", "crt_ana");
  creator.run("crt_bruno", "Bruno", "bruno");
  coupon.run("BRUNO15", "crt_bruno");
}
