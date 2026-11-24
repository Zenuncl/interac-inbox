import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sendWebhook,
  dispatchWebhooks,
  retryFailedWebhooks,
  backoffFor,
  MAX_ATTEMPTS,
} from "../src/webhooks";

// ---------------------------------------------------------------------------
// Minimal in-memory D1 stand-in. Only supports the exact statements the
// webhook module issues; anything else throws so tests fail loudly.
// ---------------------------------------------------------------------------

interface Delivery {
  id: string;
  webhook_id: string;
  transaction_id: string;
  attempt: number;
  status: string;
  response_code: number;
  response_body: string;
  created_at: number;
}

class FakeD1 {
  webhooks: { id: string; url: string; active: number }[] = [];
  transactions: Record<string, Record<string, unknown>> = {};
  deliveries: Delivery[] = [];

  prepare(sql: string) {
    const self = this;
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        bound = args;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        if (sql.includes("FROM transactions WHERE id = ?")) {
          return (self.transactions[bound[0] as string] as T) ?? null;
        }
        throw new Error(`FakeD1.first unsupported: ${sql}`);
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (sql.includes("FROM webhooks WHERE active = 1")) {
          return {
            results: self.webhooks.filter((w) => w.active) as T[],
          };
        }
        if (sql.includes("FROM webhook_deliveries d")) {
          const [maxAttempts, limit] = bound as [number, number];
          const latest = self.deliveries.filter(
            (d) =>
              !self.deliveries.some(
                (o) =>
                  o.webhook_id === d.webhook_id &&
                  o.transaction_id === d.transaction_id &&
                  o.attempt > d.attempt,
              ),
          );
          const rows = latest
            .filter((d) => d.status === "failed" && d.attempt < maxAttempts)
            .filter((d) => self.webhooks.find((w) => w.id === d.webhook_id)?.active)
            .sort((a, b) => a.created_at - b.created_at)
            .slice(0, limit)
            .map((d) => ({
              webhook_id: d.webhook_id,
              transaction_id: d.transaction_id,
              attempt: d.attempt,
              created_at: d.created_at,
              url: self.webhooks.find((w) => w.id === d.webhook_id)!.url,
            }));
          return { results: rows as T[] };
        }
        throw new Error(`FakeD1.all unsupported: ${sql}`);
      },
      async run() {
        if (sql.startsWith("INSERT INTO webhook_deliveries")) {
          const [id, webhook_id, transaction_id, attempt, status, response_code, response_body, created_at] =
            bound as [string, string, string, number, string, number, string, number];
          self.deliveries.push({ id, webhook_id, transaction_id, attempt, status, response_code, response_body, created_at });
          return {};
        }
        throw new Error(`FakeD1.run unsupported: ${sql}`);
      },
    };
    return stmt;
  }
}

const SIGNING_KEY = "test-secret";

function okResponse(body = "ok") {
  return new Response(body, { status: 200 });
}

describe("backoffFor", () => {
  it("grows with attempt and caps", () => {
    expect(backoffFor(1)).toBe(60);
    expect(backoffFor(2)).toBe(300);
    expect(backoffFor(3)).toBe(1800);
    expect(backoffFor(4)).toBe(7200);
    expect(backoffFor(99)).toBe(7200);
  });
});

describe("sendWebhook", () => {
  let db: FakeD1;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = new FakeD1();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts a signed JSON payload and records success", async () => {
    fetchMock.mockResolvedValue(okResponse());
    const tx = { id: "tx1", amount_cents: 1500, status: "unmatched" };

    const ok = await sendWebhook(db as unknown as D1Database, { id: "wh1", url: "https://x.example/hook" }, tx, SIGNING_KEY, 1);

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://x.example/hook");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Interac-Inbox-Event"]).toBe("transaction.received");
    expect(headers["X-Interac-Inbox-Attempt"]).toBe("1");
    expect(headers["X-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(init.body as string)).toEqual({
      event: "transaction.received",
      data: tx,
    });

    expect(db.deliveries).toHaveLength(1);
    expect(db.deliveries[0]).toMatchObject({ webhook_id: "wh1", transaction_id: "tx1", attempt: 1, status: "success", response_code: 200 });
  });

  it("records failure on non-2xx", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    const ok = await sendWebhook(db as unknown as D1Database, { id: "wh1", url: "https://x.example/hook" }, { id: "tx1" }, SIGNING_KEY, 2);
    expect(ok).toBe(false);
    expect(db.deliveries[0]).toMatchObject({ attempt: 2, status: "failed", response_code: 500, response_body: "boom" });
  });

  it("records failure when fetch throws (network error)", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const ok = await sendWebhook(db as unknown as D1Database, { id: "wh1", url: "https://x.example/hook" }, { id: "tx1" }, SIGNING_KEY, 1);
    expect(ok).toBe(false);
    expect(db.deliveries[0]).toMatchObject({ status: "failed", response_code: 0 });
    expect(db.deliveries[0].response_body).toContain("ECONNREFUSED");
  });
});

describe("dispatchWebhooks", () => {
  let db: FakeD1;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = new FakeD1();
    db.transactions["tx1"] = { id: "tx1", amount_cents: 100 };
    db.webhooks = [
      { id: "a", url: "https://a.example", active: 1 },
      { id: "b", url: "https://b.example", active: 0 },
      { id: "c", url: "https://c.example", active: 1 },
    ];
    fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends only to active webhooks, loading the row from D1", async () => {
    await dispatchWebhooks(db as unknown as D1Database, "tx1", SIGNING_KEY);
    const urls = fetchMock.mock.calls.map((c) => c[0]).sort();
    expect(urls).toEqual(["https://a.example", "https://c.example"]);
    expect(db.deliveries.map((d) => d.webhook_id).sort()).toEqual(["a", "c"]);
  });

  it("does nothing for an unknown transaction", async () => {
    await dispatchWebhooks(db as unknown as D1Database, "nope", SIGNING_KEY);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("retryFailedWebhooks", () => {
  let db: FakeD1;
  let fetchMock: ReturnType<typeof vi.fn>;
  const now = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    db = new FakeD1();
    db.transactions["tx1"] = { id: "tx1" };
    db.webhooks = [{ id: "a", url: "https://a.example", active: 1 }];
    fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function failed(attempt: number, ageSeconds: number, webhook_id = "a") {
    db.deliveries.push({
      id: `d${db.deliveries.length}`,
      webhook_id,
      transaction_id: "tx1",
      attempt,
      status: "failed",
      response_code: 500,
      response_body: "",
      created_at: now - ageSeconds,
    });
  }

  it("retries a failed delivery once its backoff has elapsed", async () => {
    failed(1, 120); // backoff for attempt 1 is 60s
    const r = await retryFailedWebhooks(db as unknown as D1Database, SIGNING_KEY);
    expect(r).toEqual({ scanned: 1, retried: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const last = db.deliveries.at(-1)!;
    expect(last).toMatchObject({ attempt: 2, status: "success" });
  });

  it("waits when backoff has not elapsed", async () => {
    failed(1, 10);
    const r = await retryFailedWebhooks(db as unknown as D1Database, SIGNING_KEY);
    expect(r).toEqual({ scanned: 1, retried: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips pairs whose latest attempt succeeded", async () => {
    failed(1, 1000);
    db.deliveries.push({ ...db.deliveries[0], id: "ok", attempt: 2, status: "success" });
    const r = await retryFailedWebhooks(db as unknown as D1Database, SIGNING_KEY);
    expect(r.retried).toBe(0);
  });

  it("gives up after MAX_ATTEMPTS", async () => {
    failed(MAX_ATTEMPTS, 100_000);
    const r = await retryFailedWebhooks(db as unknown as D1Database, SIGNING_KEY);
    expect(r).toEqual({ scanned: 0, retried: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores deliveries for deactivated webhooks", async () => {
    db.webhooks[0].active = 0;
    failed(1, 1000);
    const r = await retryFailedWebhooks(db as unknown as D1Database, SIGNING_KEY);
    expect(r.retried).toBe(0);
  });
});
