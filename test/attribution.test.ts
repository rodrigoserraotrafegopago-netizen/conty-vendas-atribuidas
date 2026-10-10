import { describe, expect, it } from "vitest";
import { attribute, type CreatorDirectory } from "../src/attribution.ts";

const directory: CreatorDirectory = {
  byCoupon: (code) => ({ ANA10: { id: "crt_ana", ref: "ana" }, BRUNO15: { id: "crt_bruno", ref: "bruno" } })[code],
  byRef: (ref) => ({ ana: { id: "crt_ana", ref: "ana" }, bruno: { id: "crt_bruno", ref: "bruno" } })[ref],
};

const contyUtm = (content: string) => ({ source: "conty", medium: "creator", content });

describe("regra de atribuição", () => {
  it("atribui pelo cupom do criador", () => {
    const result = attribute({ couponCodes: ["ANA10"], utm: {} }, directory);
    expect(result).toMatchObject({ creator_id: "crt_ana", rule: "coupon", conflict: false });
  });

  it("atribui pela UTM da Conty quando não há cupom de criador", () => {
    const result = attribute({ couponCodes: [], utm: contyUtm("bruno") }, directory);
    expect(result).toMatchObject({ creator_id: "crt_bruno", rule: "utm" });
  });

  it("desempate: cupom vence quando cupom e UTM apontam para criadores diferentes", () => {
    const result = attribute({ couponCodes: ["ANA10"], utm: contyUtm("bruno") }, directory);
    expect(result).toMatchObject({ creator_id: "crt_ana", rule: "coupon", conflict: true });
    expect(result.touches).toEqual([
      expect.objectContaining({ kind: "coupon", creator_id: "crt_ana", outcome: "won" }),
      expect.objectContaining({
        kind: "utm",
        creator_id: "crt_bruno",
        outcome: "lost",
        reason: "cupom tem prioridade sobre UTM",
      }),
    ]);
  });

  it("cupom e UTM do mesmo criador não são conflito", () => {
    const result = attribute({ couponCodes: ["ANA10"], utm: contyUtm("ana") }, directory);
    expect(result).toMatchObject({ creator_id: "crt_ana", conflict: false });
    expect(result.touches[1]).toMatchObject({ kind: "utm", outcome: "confirms" });
  });

  it("cupom que não é de criador não impede a UTM de valer", () => {
    const result = attribute({ couponCodes: ["BLACKFRIDAY"], utm: contyUtm("bruno") }, directory);
    expect(result).toMatchObject({ creator_id: "crt_bruno", rule: "utm" });
    expect(result.touches[0]).toMatchObject({ value: "BLACKFRIDAY", outcome: "ignored" });
  });

  it("com dois cupons de criadores diferentes, vale o primeiro na ordem do pedido", () => {
    const result = attribute({ couponCodes: ["BRUNO15", "ANA10"], utm: {} }, directory);
    expect(result).toMatchObject({ creator_id: "crt_bruno", conflict: true });
    expect(result.touches[1]).toMatchObject({ value: "ANA10", outcome: "lost" });
  });

  it("compara cupom sem diferenciar maiúscula e ignora espaços", () => {
    expect(attribute({ couponCodes: ["  ana10 "], utm: {} }, directory).creator_id).toBe("crt_ana");
  });

  it("UTM de outra origem não atribui", () => {
    const result = attribute({ couponCodes: [], utm: { source: "instagram", content: "ana" } }, directory);
    expect(result).toMatchObject({ creator_id: null, rule: "none" });
    expect(result.touches[0]).toMatchObject({ outcome: "ignored", reason: "utm_source não é da Conty" });
  });

  it("sem cupom nem UTM, a venda fica sem criador e com o motivo gravado", () => {
    const result = attribute({ couponCodes: [], utm: {} }, directory);
    expect(result).toEqual({
      creator_id: null,
      rule: "none",
      reason: "sem cupom nem UTM de criador",
      conflict: false,
      touches: [],
    });
  });
});
