/**
 * Route-level tests for URL ingress on /url-lists.
 *
 * These run against the real router and the development database: the point is
 * to prove that normalization happens before persistence, and that a partially
 * invalid submission is rejected atomically (nothing saved).
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import express from "express";
import { eq } from "drizzle-orm";
import { db, pool, urlListsTable, urlListItemsTable } from "@workspace/db";

import router from "./urlLists";

let server: Server;
let baseUrl: string;
const createdListIds: number[] = [];

before(async () => {
  const app = express();
  app.use(express.json());
  // Stand in for requireAuth — the routes under test are admin-only.
  app.use((req, _res, next) => {
    req.user = { userId: 0, email: "test@example.com", role: "admin" } as never;
    next();
  });
  app.use(router);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const id of createdListIds) {
    await db.delete(urlListsTable).where(eq(urlListsTable.id, id));
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

async function post(path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function patch(path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function storedUrls(listId: number): Promise<string[]> {
  const rows = await db
    .select({ url: urlListItemsTable.url })
    .from(urlListItemsTable)
    .where(eq(urlListItemsTable.urlListId, listId));
  return rows.map((r) => r.url);
}

test("POST /url-lists stores normalized URLs for messy but usable input", async () => {
  const created = await post("/url-lists", {
    name: "normalize-test",
    urls: [
      "www.haps.org",
      "  avda-tx.org, ",
      "<http://WWW.OAKFORESTPTA.COM/>",
      "",
      "https://www.haps.org/",
    ],
  });

  assert.equal(created.status, 201);
  const listId = created.body.id as number;
  createdListIds.push(listId);

  assert.deepEqual(await storedUrls(listId), [
    "https://www.haps.org",
    "https://avda-tx.org",
    "http://www.oakforestpta.com",
  ]);
  assert.equal(created.body.urlCount, 3);
});

test("POST /url-lists saves nothing and names the bad lines on mixed input", async () => {
  const before = await db.select({ id: urlListsTable.id }).from(urlListsTable);

  const result = await post("/url-lists", {
    name: "mixed-test",
    urls: ["www.haps.org", "ftp://files.example.org", "bgcgh.org", "http://localhost:3000", "not a url"],
  });

  assert.equal(result.status, 400);
  assert.deepEqual(result.body.invalidUrls, [
    "ftp://files.example.org",
    "http://localhost:3000",
    "not a url",
  ]);

  const message = String(result.body.error);
  assert.match(message, /^One or more URLs are not valid public HTTP\/HTTPS addresses/);
  assert.match(message, /ftp:\/\/files\.example\.org/);
  assert.match(message, /http:\/\/localhost:3000/);
  assert.match(message, /not a url/);
  // Valid lines are not blamed.
  assert.ok(!message.includes("bgcgh.org"), `valid entry named in error: ${message}`);

  // Nothing persisted.
  const after = await db.select({ id: urlListsTable.id }).from(urlListsTable);
  assert.equal(after.length, before.length);
});

test("PATCH /url-lists/:id normalizes on update and rejects bad lines without touching stored URLs", async () => {
  const created = await post("/url-lists", { name: "patch-test", urls: ["example.org"] });
  assert.equal(created.status, 201);
  const listId = created.body.id as number;
  createdListIds.push(listId);

  const rejected = await patch(`/url-lists/${listId}`, {
    urls: ["good.example.org", "javascript:alert(1)"],
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(rejected.body.invalidUrls, ["javascript:alert(1)"]);
  assert.deepEqual(await storedUrls(listId), ["https://example.org"]);

  const accepted = await patch(`/url-lists/${listId}`, {
    urls: ["WWW.Example.ORG/Events;", "www.example.org/Events"],
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await storedUrls(listId), ["https://www.example.org/Events"]);
});
