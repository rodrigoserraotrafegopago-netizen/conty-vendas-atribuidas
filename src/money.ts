// Dinheiro sempre em centavos inteiros. O Shopify manda valores como texto ("199.90").

const MONEY_RE = /^(\d{1,12})(?:\.(\d{1,2}))?$/;

// "199.90" → 19990; null se não for um valor não negativo com até duas casas.
export function parseCents(value: unknown): number | null {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string") return null;
  const match = MONEY_RE.exec(text.trim());
  if (!match) return null;
  const reais = Number(match[1]);
  const cents = Number((match[2] ?? "0").padEnd(2, "0"));
  return reais * 100 + cents;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
