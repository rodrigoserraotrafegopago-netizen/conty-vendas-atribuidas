import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { seedCreators } from "./seed.ts";

const db = openDatabase(process.env.DB_PATH || "data/vendas.sqlite");
seedCreators(db);
const port = Number(process.env.PORT || 3005);

const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET || undefined;

serve({ fetch: createApp({ db, webhookSecret }).fetch, port }, (info) => {
  const signature = webhookSecret ? "webhooks exigem assinatura" : "webhooks sem verificação de assinatura";
  console.log(`vendas atribuídas em http://127.0.0.1:${info.port} (${signature})`);
});
