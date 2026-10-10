import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { seedCreators } from "./seed.ts";

const db = openDatabase(process.env.DB_PATH ?? "data/vendas.sqlite");
seedCreators(db);
const port = Number(process.env.PORT ?? 3005);

serve({ fetch: createApp({ db, webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET }).fetch, port }, (info) => {
  console.log(`vendas atribuídas em http://127.0.0.1:${info.port}`);
});
