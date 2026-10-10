import { createHmac, timingSafeEqual } from "node:crypto";

// Assinatura do webhook no formato do Shopify: base64(HMAC-SHA256(segredo, corpo cru)),
// no header X-Shopify-Hmac-Sha256.
export function signBody(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

export function isValidSignature(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(signBody(secret, rawBody));
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
