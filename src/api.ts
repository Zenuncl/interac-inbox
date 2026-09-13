import type { Env } from "./types";

export async function handleApiRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${env.API_KEY}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/api/transactions") {
    return getTransactions(url, env);
  }

  const txMatch = path.match(/^\/api\/transactions\/([^/]+)$/);
  if (txMatch) {
    const id = txMatch[1];
    if (method === "GET") return getTransaction(id, env);
  }

  const matchRoute = path.match(
    /^\/api\/transactions\/([^/]+)\/match$/,
  );
  if (matchRoute && method === "POST") {
    return matchTransaction(matchRoute[1], request, env);
  }

  if (method === "GET" && path === "/api/webhooks") {
    return getWebhooks(env);
  }

  if (method === "POST" && path === "/api/webhooks") {
    return createWebhook(request, env);
  }

  const whDeleteMatch = path.match(/^\/api\/webhooks\/([^/]+)$/);
  if (whDeleteMatch && method === "DELETE") {
    return deleteWebhook(whDeleteMatch[1], env);
  }

  return json({ error: "Not Found" }, 404);
}

async function getTransactions(
  url: URL,
  env: Env,
): Promise<Response> {
  const reference = url.searchParams.get("reference");
  const status = url.searchParams.get("status");
  const fromDate = url.searchParams.get("from_date");
  const toDate = url.searchParams.get("to_date");
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") ?? "50", 10) || 50,
    200,
  );
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10) || 0;

  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (reference) {
    conditions.push("reference = ?");
    bindings.push(reference);
  }
  if (status) {
    conditions.push("status = ?");
    bindings.push(status);
  }
  if (fromDate) {
    conditions.push("created_at >= ?");
    bindings.push(parseInt(fromDate, 10));
  }
  if (toDate) {
    conditions.push("created_at <= ?");
    bindings.push(parseInt(toDate, 10));
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM transactions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  bindings.push(limit, offset);

  const result = await env.DB.prepare(query)
    .bind(...bindings)
    .all();

  return json(result.results);
}

async function getTransaction(
  id: string,
  env: Env,
): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT * FROM transactions WHERE id = ?",
  )
    .bind(id)
    .first();
  if (!row) return json({ error: "Not Found" }, 404);
  return json(row);
}

async function matchTransaction(
  id: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await request.json<{ order_id: string }>();
  if (!body.order_id) {
    return json({ error: "order_id is required" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE transactions SET status = 'matched', order_id = ?, updated_at = ? WHERE id = ?",
  )
    .bind(body.order_id, now, id)
    .run();

  const updated = await env.DB.prepare(
    "SELECT * FROM transactions WHERE id = ?",
  )
    .bind(id)
    .first();
  if (!updated) return json({ error: "Not Found" }, 404);
  return json(updated);
}

async function getWebhooks(env: Env): Promise<Response> {
  const result = await env.DB.prepare("SELECT * FROM webhooks").all();
  return json(result.results);
}

async function createWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await request.json<{
    url: string;
    description?: string;
  }>();
  if (!body.url) {
    return json({ error: "url is required" }, 400);
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO webhooks (id, url, description, active, created_at) VALUES (?, ?, ?, 1, ?)",
  )
    .bind(id, body.url, body.description ?? null, now)
    .run();

  const webhook = await env.DB.prepare(
    "SELECT * FROM webhooks WHERE id = ?",
  )
    .bind(id)
    .first();

  return json(webhook, 201);
}

async function deleteWebhook(
  id: string,
  env: Env,
): Promise<Response> {
  await env.DB.prepare(
    "UPDATE webhooks SET active = 0 WHERE id = ?",
  )
    .bind(id)
    .run();
  return new Response(null, { status: 204 });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
