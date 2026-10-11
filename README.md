# Vendas atribuídas ao criador

[![ci](https://github.com/rodrigoserraotrafegopago-netizen/conty-vendas-atribuidas/actions/workflows/ci.yml/badge.svg)](https://github.com/rodrigoserraotrafegopago-netizen/conty-vendas-atribuidas/actions/workflows/ci.yml)

Recebe pedidos de uma loja por webhook (o essencial de um pedido Shopify), atribui cada venda a no máximo um criador, por cupom ou UTM, e aplica estornos sem apagar o histórico. O estorno pode ser parcial, chegar repetido ou chegar antes do pedido.

Node 22.13+ · TypeScript · Hono · SQLite (`node:sqlite`) · Vitest

```bash
npm install
npm test            # 28 testes
npm run dev         # http://127.0.0.1:3005, com os criadores crt_ana (ANA10) e crt_bruno (BRUNO15)
```

`npm run lint` e `npm run typecheck` também rodam no CI. Variáveis opcionais em `.env.example` (o `.env` é lido se existir). Com `SHOPIFY_WEBHOOK_SECRET` definido, os webhooks passam a exigir assinatura (`X-Shopify-Hmac-Sha256`, no mesmo formato do Shopify); o servidor diz na partida se está verificando.

## Atribuição

A regra fica em `src/attribution.ts`, com testes em `test/attribution.test.ts`:

1. Cupom de criador. Com dois cupons de criador no pedido, vale o primeiro da lista.
2. Sem cupom de criador, a UTM da Conty: `utm_source=conty` e `utm_content=<ref do criador>`, lidas do `landing_site`.
3. Sem nenhum dos dois, a venda fica sem criador (`rule: "none"`), com o motivo.

**Desempate:** quando cupom e UTM apontam para criadores diferentes, o cupom vence. O comprador digita o cupom no checkout, na hora da compra; a UTM é o último link clicado, que pode ser antigo ou ter sido repassado. O toque que perdeu fica em `attribution.touches`, com o motivo, e `conflict: true` marca o caso.

Link esperado: `https://loja.com/produto?utm_source=conty&utm_medium=creator&utm_campaign=verao26&utm_content=ana`

A atribuição é decidida no primeiro webhook do pedido e não muda depois (um trigger no banco garante isso).

## Pedidos e estornos

- **Pedido repetido:** o id do pedido é a chave, então o mesmo pedido nunca soma a venda de novo. A entrega fica registrada como `duplicate`. Num reenvio, só vale o pagamento avançar (`pending` → `paid` ou `voided`). Só venda paga entra no total do criador.
- **Estorno repetido:** o id do estorno é a chave. O mesmo estorno de novo devolve `200 duplicate` e não é aplicado outra vez.
- **Parcial ou total:** o estorno reduz o valor atribuído. O total zera a atribuição (`state: "zeroed"`), mas pedido, criador e estornos continuam no histórico.
- **Limite:** a soma dos estornos nunca passa do valor da venda. Se um estorno pede mais que o saldo, entra só o saldo (`capped`, com `requested_cents` e `applied_cents`). Com saldo zero, ele fica `ignored`. Triggers no banco garantem o mesmo limite.
- **Estorno antes do pedido:** fica `pending_order` (`202`) e já pode ser consultado em `GET /refunds/:id`. Quando o pedido chega, os pendentes são aplicados na ordem em que chegaram, com o mesmo limite.
- **Rastreio:** `GET /orders/:id` mostra cada estorno (pedido, aplicado, status, motivo, datas) e cada entrega de webhook, inclusive as repetidas. `GET /refunds/:id` mostra um estorno e as entregas dele, inclusive antes de o pedido chegar. Das entregas guardo só os campos usados, porque o payload tem dados pessoais do comprador.
- IDs do Shopify passam de 2^53. O corpo é lido preservando o texto desses números, senão dois pedidos vizinhos virariam o mesmo id.

## Endpoints

| Método | Rota | |
| --- | --- | --- |
| `POST` | `/webhooks/orders` | `201` pedido novo; `200` repetido ou pagamento confirmado |
| `POST` | `/webhooks/refunds` | `201` aplicado/limitado/ignorado; `202` pendente; `200` repetido |
| `GET` | `/orders/:id` | pedido, atribuição, estornos e entregas |
| `GET` | `/refunds/:id` | estorno e entregas, mesmo antes de o pedido chegar |
| `GET` | `/creators/:id/sales` | bruto, estornado e líquido do criador |
| `POST` | `/creators` | `{ id, name, ref, coupons: [] }` |

Do pedido, uso `id`, `name`, `total_price`, `currency`, `financial_status`, `discount_codes[].code`, `landing_site` e `created_at`. Do estorno, `id`, `order_id` e a soma de `transactions[]` com `kind: "refund"` e `status: "success"`. Valores ficam em centavos inteiros.

## Exemplos

Respostas reais, cortadas (`…`).

Pedido com cupom da Ana e UTM do Bruno:

```bash
curl -s -X POST localhost:3005/webhooks/orders -H 'content-type: application/json' -d '{
  "id": 820982911946154508, "name": "#1001", "total_price": "199.90", "currency": "BRL",
  "financial_status": "paid", "discount_codes": [{ "code": "ANA10", "amount": "20.00" }],
  "landing_site": "/produtos/protetor?utm_source=conty&utm_medium=creator&utm_campaign=verao26&utm_content=bruno"
}'
```

```json
{
  "result": "created",
  "order": {
    "order_id": "820982911946154508",
    "total_cents": 19990,
    "net_cents": 19990,
    "attribution": {
      "creator_id": "crt_ana",
      "rule": "coupon",
      "conflict": true,
      "state": "active",
      "touches": [
        { "kind": "coupon", "value": "ANA10", "creator_id": "crt_ana", "outcome": "won", "reason": "primeiro cupom de criador no pedido" },
        { "kind": "utm", "value": "utm_source=conty&utm_content=bruno", "creator_id": "crt_bruno", "outcome": "lost", "reason": "cupom tem prioridade sobre UTM" }
      ]
    },
    "…": "…"
  }
}
```

O mesmo webhook de novo devolve `200` com `"result": "duplicate"`.

Estorno parcial de R$ 50,00:

```bash
curl -s -X POST localhost:3005/webhooks/refunds -H 'content-type: application/json' -d '{
  "id": 509562969, "order_id": 820982911946154508,
  "transactions": [{ "kind": "refund", "status": "success", "amount": "50.00" }]
}'
```

```json
{
  "result": "applied",
  "refund": { "id": "509562969", "requested_cents": 5000, "applied_cents": 5000, "status": "applied" },
  "order": { "total_cents": 19990, "refunded_cents": 5000, "net_cents": 14990, "attribution": { "state": "partially_reverted" }, "…": "…" }
}
```

Estorno que chega antes do pedido (`202`):

```json
{
  "result": "pending_order",
  "refund": { "id": "r-77", "order_id": "1002", "requested_cents": 3000, "applied_cents": null, "status": "pending_order", "…": "…" },
  "order": null
}
```

Enquanto o pedido não chega, `GET /orders/1002` dá `404`, mas o estorno aparece em `GET /refunds/r-77`:

```json
{
  "id": "r-77",
  "order_id": "1002",
  "requested_cents": 3000,
  "applied_cents": null,
  "status": "pending_order",
  "reason": "pedido ainda não chegou; aplica quando chegar",
  "order_received": false,
  "deliveries": [{ "topic": "refunds", "external_id": "r-77", "result": "pending_order", "…": "…" }],
  "…": "…"
}
```

Quando o pedido `1002` chega (R$ 89,90, UTM da Ana), o estorno pendente entra:

```json
{
  "result": "created",
  "order": {
    "refunded_cents": 3000,
    "net_cents": 5990,
    "attribution": { "creator_id": "crt_ana", "rule": "utm", "state": "partially_reverted" },
    "refunds": [{ "id": "r-77", "applied_cents": 3000, "status": "applied", "reason": "chegou antes do pedido; aplicado" }],
    "…": "…"
  }
}
```

`GET /creators/crt_ana/sales`:

```json
{
  "creator": { "id": "crt_ana", "name": "Ana", "ref": "ana" },
  "totals": { "paid_orders": 2, "gross_cents": 28980, "refunded_cents": 8000, "net_cents": 20980 },
  "orders": [
    { "order_id": "820982911946154508", "rule": "coupon", "state": "partially_reverted", "net_cents": 14990 },
    { "order_id": "1002", "rule": "utm", "state": "partially_reverted", "net_cents": 5990 }
  ]
}
```

## Testes

- `attribution.test.ts`: cupom, UTM, desempate cupom × UTM, mesmo criador nos dois, cupom da loja que não é de criador, dois cupons de criadores diferentes, UTM de outra origem, venda sem criador.
- `orders.test.ts`: pedido duplicado, pagamento confirmado num reenvio, atribuição que não muda, status desconhecido, pedido de valor zero, id acima de 2^53, payload inválido, assinatura HMAC.
- `refunds.test.ts`: estorno parcial, repetido, vários estornos até o limite, estorno total, estorno antes do pedido (simples, consultado em `GET /refunds/:id`, vários, repetido e maior que a venda) e os triggers.

## Decisões

- Estorno acima do saldo entra limitado em vez de ser recusado: o total fica sempre consistente, e o valor pedido continua registrado para conferência.
- `financial_status: refunded` sozinho não gera estorno. O valor vem só do webhook de estorno, que traz quanto foi devolvido.
- Status desconhecido num pedido novo devolve `422`. Num pedido já gravado, a entrega é registrada e ignorada, para a loja não ficar reenviando.
- Se a Conty preferir "último toque" no lugar de "cupom vence", a troca é toda em `src/attribution.ts`.

## Com mais tempo

- Alerta para estorno pendente há muitos dias (provável pedido perdido) e uma rota para reprocessar.
- Comissão por campanha, calculada sobre o líquido atribuído.
- Fila para processar webhooks fora da requisição, conversão de moeda e migrations versionadas.

## Uso de IA

O código, os testes e esta documentação foram escritos com o Claude (Anthropic), a partir das minhas instruções. Acompanhei a sessão, defini o escopo e aprovei a publicação. Não revisei o código linha a linha.
