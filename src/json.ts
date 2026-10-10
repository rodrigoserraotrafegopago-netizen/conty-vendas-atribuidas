// IDs do Shopify (ex.: 820982911946154508) passam de Number.MAX_SAFE_INTEGER, e o JSON.parse padrão
// arredonda: dois pedidos vizinhos virariam o mesmo id. Inteiros acima do limite voltam como texto.

type Reviver = (key: string, value: unknown, context?: { source?: string }) => unknown;

const keepUnsafeIntegersAsText: Reviver = (_key, value, context) => {
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    if (context?.source) return context.source;
    throw new Error("inteiro acima do limite seguro sem acesso ao texto original");
  }
  return value;
};

export function parseJson(text: string): unknown {
  return (JSON.parse as (text: string, reviver: Reviver) => unknown)(text, keepUnsafeIntegersAsText);
}
