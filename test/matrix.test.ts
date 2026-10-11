import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { MatrixClient, type MatrixEvent } from "../src/matrix.js";

const BOT = "@voicebot:example.org";

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

test("sync skips history, emits live events and invites; send retries on 429", async () => {
  const requests: { method: string; path: string; body: string }[] = [];
  let syncs = 0;
  let rateLimited = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    requests.push({ method: req.method!, path: url.pathname, body: await body(req) });
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer secret") return res.writeHead(401).end("{}");
    if (url.pathname.endsWith("/account/whoami")) return res.end(JSON.stringify({ user_id: BOT }));
    if (url.pathname.endsWith("/sync")) {
      syncs++;
      const room = (events: unknown[]) => ({ next_batch: `s${syncs}`, rooms: { join: { "!dm:x": { timeline: { events } } } } });
      if (syncs === 1) {
        assert.equal(url.searchParams.get("since"), null);
        return res.end(JSON.stringify({
          next_batch: "s1",
          rooms: {
            join: {
              "!dm:x": {
                state: { events: [{ type: "m.room.member", state_key: "@me:x", sender: "@me:x", content: { membership: "join" } }] },
                timeline: { events: [{ type: "m.call.invite", sender: "@me:x", event_id: "$old", content: {} }] },
              },
              "!enc:x": { state: { events: [{ type: "m.room.encryption", state_key: "", sender: "@me:x", content: {} }] } },
            },
          },
        }));
      }
      if (syncs === 2) {
        assert.equal(url.searchParams.get("since"), "s1");
        return res.end(JSON.stringify({
          ...room([{ type: "m.call.invite", sender: "@me:x", event_id: "$new", content: { call_id: "c" } }]),
          rooms: {
            ...room([{ type: "m.call.invite", sender: "@me:x", event_id: "$new", content: { call_id: "c" } }]).rooms,
            invite: { "!inv:x": { invite_state: { events: [{ type: "m.room.member", state_key: BOT, sender: "@me:x", content: { membership: "invite" } }] } } },
          },
        }));
      }
      // Further syncs: long-poll that never returns before the test stops.
      return;
    }
    if (req.method === "PUT" && url.pathname.includes("/send/")) {
      if (!rateLimited) {
        rateLimited = true;
        return res.writeHead(429).end(JSON.stringify({ errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 50 }));
      }
      return res.end(JSON.stringify({ event_id: "$sent" }));
    }
    res.writeHead(404).end(JSON.stringify({ errcode: "M_NOT_FOUND" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  const client = new MatrixClient(`http://127.0.0.1:${port}/`, "secret");
  assert.equal(await client.whoami(), BOT);
  const events: MatrixEvent[] = [];
  const invites: [string, string][] = [];
  client.on("event", (_roomId, ev) => events.push(ev));
  client.on("invite", (roomId, inviter) => invites.push([roomId, inviter]));
  let ready = false;
  client.once("ready", () => (ready = true));
  const running = client.run();

  for (let i = 0; i < 100 && invites.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(ready);
  assert.deepEqual(events.map((e) => e.event_id), ["$new"]);
  assert.equal(events[0]!.room_id, "!dm:x");
  assert.deepEqual(invites, [["!inv:x", "@me:x"]]);
  assert.equal(client.rooms.get("!enc:x")?.encrypted, true);
  assert.equal(client.rooms.get("!dm:x")?.members.get("@me:x"), "join");

  assert.equal(await client.sendEvent("!dm:x", "m.call.answer", { call_id: "c" }), "$sent");
  const puts = requests.filter((r) => r.method === "PUT");
  assert.equal(puts.length, 2, "retried once after 429");
  assert.match(puts[1]!.path, /^\/_matrix\/client\/v3\/rooms\/!dm%3Ax\/send\/m\.call\.answer\/dmv-/);
  assert.deepEqual(JSON.parse(puts[1]!.body), { call_id: "c" });

  client.stop();
  await running;
  server.closeAllConnections();
  server.close();
});
