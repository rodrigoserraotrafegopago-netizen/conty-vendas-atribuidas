// Quem fica com a venda: cupom de criador > UTM da Conty (utm_source=conty, utm_content=<ref>) > ninguém.
// Com dois cupons de criador no pedido, vale o primeiro da lista.
// Cupom vence UTM porque é digitado no checkout; a UTM é o último link clicado e pode ser antiga ou
// compartilhada. O toque que perdeu fica em `touches`, com o motivo.

export type Creator = { id: string; ref: string };

export type CreatorDirectory = {
  byCoupon(code: string): Creator | undefined;
  byRef(ref: string): Creator | undefined;
};

export type Utm = {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
};

export type Touch = {
  kind: "coupon" | "utm";
  value: string;
  creator_id: string | null;
  outcome: "won" | "lost" | "confirms" | "ignored";
  reason: string;
};

export type Attribution = {
  creator_id: string | null;
  rule: "coupon" | "utm" | "none";
  reason: string;
  conflict: boolean;
  touches: Touch[];
};

export const CONTY_UTM_SOURCE = "conty";

export function normalizeCoupon(code: string): string {
  return code.trim().toUpperCase();
}

export function attribute(input: { couponCodes: string[]; utm: Utm }, creators: CreatorDirectory): Attribution {
  const touches: Touch[] = [];

  let couponWinner: Creator | undefined;
  for (const raw of input.couponCodes) {
    const code = normalizeCoupon(raw);
    if (!code) continue;
    const creator = creators.byCoupon(code);
    if (!creator) {
      touches.push({
        kind: "coupon",
        value: code,
        creator_id: null,
        outcome: "ignored",
        reason: "cupom não pertence a nenhum criador",
      });
    } else if (!couponWinner) {
      couponWinner = creator;
      touches.push({
        kind: "coupon",
        value: code,
        creator_id: creator.id,
        outcome: "won",
        reason: "primeiro cupom de criador no pedido",
      });
    } else {
      touches.push({
        kind: "coupon",
        value: code,
        creator_id: creator.id,
        outcome: creator.id === couponWinner.id ? "confirms" : "lost",
        reason: "vale o primeiro cupom de criador na ordem do pedido",
      });
    }
  }

  const source = input.utm.source?.trim().toLowerCase();
  const content = input.utm.content?.trim().toLowerCase();
  const utmCreator = source === CONTY_UTM_SOURCE && content ? creators.byRef(content) : undefined;
  if (source || content) {
    const value = `utm_source=${input.utm.source ?? ""}&utm_content=${input.utm.content ?? ""}`;
    if (source !== CONTY_UTM_SOURCE) {
      touches.push({ kind: "utm", value, creator_id: null, outcome: "ignored", reason: "utm_source não é da Conty" });
    } else if (!utmCreator) {
      touches.push({
        kind: "utm",
        value,
        creator_id: null,
        outcome: "ignored",
        reason: "utm_content não corresponde a nenhum criador",
      });
    } else if (!couponWinner) {
      touches.push({
        kind: "utm",
        value,
        creator_id: utmCreator.id,
        outcome: "won",
        reason: "sem cupom de criador, vale a UTM da Conty",
      });
    } else if (utmCreator.id === couponWinner.id) {
      touches.push({
        kind: "utm",
        value,
        creator_id: utmCreator.id,
        outcome: "confirms",
        reason: "UTM aponta para o mesmo criador do cupom",
      });
    } else {
      touches.push({
        kind: "utm",
        value,
        creator_id: utmCreator.id,
        outcome: "lost",
        reason: "cupom tem prioridade sobre UTM",
      });
    }
  }

  if (couponWinner) {
    const conflict = touches.some((t) => t.outcome === "lost");
    return {
      creator_id: couponWinner.id,
      rule: "coupon",
      reason: conflict ? "cupom de criador vence; havia outro criador nos toques" : "cupom de criador",
      conflict,
      touches,
    };
  }
  if (utmCreator) {
    return {
      creator_id: utmCreator.id,
      rule: "utm",
      reason: "UTM da Conty, sem cupom de criador",
      conflict: false,
      touches,
    };
  }
  return { creator_id: null, rule: "none", reason: "sem cupom nem UTM de criador", conflict: false, touches };
}
