import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { LINE_MASKS, countLines, gridToPos } from "../src/game";

const ORIGIN = "https://bingo.test";

interface Client {
  cookie: string;
  call(path: string, init?: { method?: string; body?: unknown; origin?: string | null }): Promise<Response>;
  json<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
}

function client(): Client {
  const c: Client = {
    cookie: "",
    async call(path, { method = "GET", body, origin = ORIGIN } = {}) {
      const headers = new Headers();
      if (origin) headers.set("origin", origin);
      if (c.cookie) headers.set("cookie", c.cookie);
      if (body !== undefined) headers.set("content-type", "application/json");
      const res = await exports.default.fetch(
        new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      );
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) c.cookie = setCookie.split(";")[0];
      return res;
    },
    async json(path, init) {
      const res = await c.call(path, init);
      return res.json();
    },
  };
  return c;
}

async function register(username: string, password = "secreto123", inviteCode = "pikachu") {
  const c = client();
  const res = await c.call("/api/auth/register", { method: "POST", body: { username, password, inviteCode } });
  expect(res.status).toBe(200);
  return c;
}

async function makeAdmin(username: string) {
  await env.DB.prepare("UPDATE players SET is_admin = 1 WHERE username_lc = ?").bind(username.toLowerCase()).run();
}

async function state(c: Client) {
  return c.json("/api/state?v=0");
}

// D1 storage is shared by every test in the file, so start each one without players.
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM cells"), env.DB.prepare("DELETE FROM players")]);
});

describe("line masks", () => {
  it("has 12 lines, 4 squares on lines through FREE and 5 elsewhere", () => {
    expect(LINE_MASKS).toHaveLength(12);
    const sizes = LINE_MASKS.map((m) => m.toString(2).replace(/0/g, "").length).sort();
    expect(sizes.filter((s) => s === 4)).toHaveLength(4); // middle row, middle column, both diagonals
    expect(countLines(0)).toBe(0);
    expect(countLines(2 ** 24 - 1)).toBe(12);
  });
});

describe("auth", () => {
  it("requires the invite code to register", async () => {
    const res = await client().call("/api/auth/register", {
      method: "POST",
      body: { username: "Ash", password: "secreto123", inviteCode: "nope" },
    });
    expect(res.status).toBe(403);
  });

  it("validates username and password", async () => {
    const bad = await client().call("/api/auth/register", {
      method: "POST",
      body: { username: "a b", password: "secreto123", inviteCode: "pikachu" },
    });
    expect(bad.status).toBe(400);
    const short = await client().call("/api/auth/register", {
      method: "POST",
      body: { username: "Ash", password: "123", inviteCode: "pikachu" },
    });
    expect(short.status).toBe(400);
  });

  it("rejects duplicate usernames case-insensitively", async () => {
    await register("Ash");
    const res = await client().call("/api/auth/register", {
      method: "POST",
      body: { username: "ASH", password: "secreto123", inviteCode: "pikachu" },
    });
    expect(res.status).toBe(409);
  });

  it("logs in, never exposes the password hash, and logs out", async () => {
    await register("Misty");
    const c = client();
    const res = await c.call("/api/auth/login", { method: "POST", body: { username: "misty", password: "secreto123" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const me = await c.json("/api/auth/me");
    expect(me.user).toMatchObject({ username: "Misty", isAdmin: false });
    expect(JSON.stringify(await state(c))).not.toContain("pbkdf2");

    await c.call("/api/auth/logout", { method: "POST" });
    expect((await c.json("/api/auth/me")).user).toBeNull();
  });

  it("gives the same error for unknown users and wrong passwords", async () => {
    await register("Brock");
    const wrong = await client().json("/api/auth/login", { method: "POST", body: { username: "Brock", password: "x" } });
    const unknown = await client().json("/api/auth/login", { method: "POST", body: { username: "Nadie", password: "x" } });
    expect(wrong.error).toBe(unknown.error);
  });

  it("locks the account after 5 failed logins", async () => {
    await register("Gary");
    for (let i = 0; i < 5; i++) {
      const res = await client().call("/api/auth/login", { method: "POST", body: { username: "Gary", password: "mal" } });
      expect(res.status).toBe(401);
    }
    const locked = await client().call("/api/auth/login", {
      method: "POST",
      body: { username: "Gary", password: "secreto123" },
    });
    expect(locked.status).toBe(429);
  });

  it("revokes old sessions when the password changes", async () => {
    const c = await register("Dawn");
    const other = client();
    await other.call("/api/auth/login", { method: "POST", body: { username: "Dawn", password: "secreto123" } });

    const res = await c.call("/api/auth/password", {
      method: "POST",
      body: { currentPassword: "secreto123", newPassword: "nuevo456" },
    });
    expect(res.status).toBe(200);
    expect((await c.json("/api/auth/me")).user?.username).toBe("Dawn");
    expect((await other.json("/api/auth/me")).user).toBeNull();
  });

  it("blocks writes from other origins", async () => {
    const res = await client().call("/api/auth/login", {
      method: "POST",
      body: { username: "x", password: "y" },
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });
});

describe("game", () => {
  it("deals each player all 24 phrases in their own order", async () => {
    const a = await state(await register("Red"));
    const b = await state(await register("Blue"));
    expect(a.me.card).toHaveLength(24);
    expect(new Set(a.me.card.map((c: any) => c.phraseId)).size).toBe(24);
    const setA = [...a.me.card.map((c: any) => c.phraseId)].sort().join();
    const setB = [...b.me.card.map((c: any) => c.phraseId)].sort().join();
    expect(setA).toBe(setB);
  });

  it("answers unchanged polls without the full state", async () => {
    const c = await register("Poller");
    const { v } = await state(c);
    const poll = await c.json(`/api/state?v=${v}`);
    expect(poll).toEqual({ changed: false, v });
  });

  it("requires a session to poll", async () => {
    expect((await client().call("/api/state?v=0")).status).toBe(401);
  });

  it("moves squares pending -> approved via the moderator and counts lines", async () => {
    const admin = await register("Oak");
    await makeAdmin("Oak");
    const player = await register("Ash");
    const card = (await state(player)).me.card as { pos: number; phraseId: number }[];

    // Middle row crosses FREE: grid 10, 11, 13, 14.
    const middleRow = [10, 11, 13, 14].map((g) => card[gridToPos(g)]);
    for (const cell of middleRow) {
      expect((await player.call(`/api/cells/${cell.pos}/toggle`, { method: "POST" })).status).toBe(200);
    }

    const pending = (await state(admin)).admin.pending;
    expect(pending).toHaveLength(4);
    expect(pending[0].players).toEqual(["Ash"]);

    for (const cell of middleRow.slice(0, 3)) {
      await admin.call(`/api/admin/phrases/${cell.phraseId}/approve`, { method: "POST" });
    }
    let me = (await state(player)).me;
    expect(me.points).toBe(3);
    expect(me.lines).toBe(0);

    await admin.call(`/api/admin/phrases/${middleRow[3].phraseId}/approve`, { method: "POST" });
    const s = await state(player);
    me = s.me;
    expect(me.points).toBe(4);
    expect(me.lines).toBe(1);
    expect(s.leaderboard[0]).toMatchObject({ username: "Ash", lines: 1, points: 4 });
    expect(s.leaderboard[0].lineAt).toBeTypeOf("number");

    // Approved squares can no longer be toggled.
    expect((await player.call(`/api/cells/${middleRow[0].pos}/toggle`, { method: "POST" })).status).toBe(409);
  });

  it("only approves players who marked the phrase, and reject clears pending", async () => {
    const admin = await register("Elm");
    await makeAdmin("Elm");
    const marker = await register("Marker");
    const idle = await register("Idle");
    const cell = (await state(marker)).me.card[0];

    await marker.call(`/api/cells/${cell.pos}/toggle`, { method: "POST" });
    await admin.call(`/api/admin/phrases/${cell.phraseId}/approve`, { method: "POST" });
    expect((await state(marker)).me.points).toBe(1);
    expect((await state(idle)).me.points).toBe(0);

    const other = (await state(marker)).me.card[1];
    await marker.call(`/api/cells/${other.pos}/toggle`, { method: "POST" });
    await admin.call(`/api/admin/phrases/${other.phraseId}/reject`, { method: "POST" });
    const me = (await state(marker)).me;
    expect(me.card[1].state).toBe("none");
    expect(me.points).toBe(1);
  });

  it("detects a full-card bingo", async () => {
    const admin = await register("Birch");
    await makeAdmin("Birch");
    const player = await register("Winner");
    const card = (await state(player)).me.card as { pos: number; phraseId: number }[];
    for (const cell of card) await player.call(`/api/cells/${cell.pos}/toggle`, { method: "POST" });
    for (const cell of card) await admin.call(`/api/admin/phrases/${cell.phraseId}/approve`, { method: "POST" });
    const s = await state(player);
    expect(s.me).toMatchObject({ points: 24, lines: 12, bingo: true });
    expect(s.leaderboard[0].username).toBe("Winner");
  });

  it("limits rerolls and resets progress", async () => {
    const c = await register("Roller");
    for (let i = 0; i < 5; i++) {
      expect((await c.call("/api/reroll", { method: "POST" })).status).toBe(200);
    }
    const me = (await state(c)).me;
    expect(me.rerolls).toBe(0);
    expect(me.card).toHaveLength(24);
    expect((await c.call("/api/reroll", { method: "POST" })).status).toBe(409);
  });
});

describe("moderator", () => {
  it("forbids moderator endpoints to regular players", async () => {
    const c = await register("Normal");
    expect((await c.call("/api/admin/reset", { method: "POST" })).status).toBe(403);
    expect((await c.call("/api/admin/phrases/1/approve", { method: "POST" })).status).toBe(403);
  });

  it("replaces the phrase bank only with exactly 24 unique phrases and re-deals cards", async () => {
    const admin = await register("Juniper");
    await makeAdmin("Juniper");
    const tooFew = await admin.call("/api/admin/phrases", { method: "PUT", body: { phrases: ["a", "b"] } });
    expect(tooFew.status).toBe(400);
    const dupes = Array.from({ length: 24 }, () => "igual");
    expect((await admin.call("/api/admin/phrases", { method: "PUT", body: { phrases: dupes } })).status).toBe(400);

    const phrases = Array.from({ length: 24 }, (_, i) => `Frase <b>${i}</b>`);
    expect((await admin.call("/api/admin/phrases", { method: "PUT", body: { phrases } })).status).toBe(200);
    const s = await state(admin);
    expect(s.me.card.map((c: any) => c.text).sort()).toEqual([...phrases].sort());
    expect(s.me.rerolls).toBe(5);
  });

  it("resets a password with a temporary one", async () => {
    const admin = await register("Rowan");
    await makeAdmin("Rowan");
    await register("Olvidadizo");
    const target = (await state(admin)).leaderboard.find((p: any) => p.username === "Olvidadizo");
    const { password } = await admin.json(`/api/admin/players/${target.id}/reset-password`, { method: "POST" });
    const res = await client().call("/api/auth/login", { method: "POST", body: { username: "Olvidadizo", password } });
    expect(res.status).toBe(200);
  });

  it("deletes a player but not themselves", async () => {
    const admin = await register("Sycamore");
    await makeAdmin("Sycamore");
    await register("Borrado");
    const s = await state(admin);
    const self = s.leaderboard.find((p: any) => p.username === "Sycamore");
    const target = s.leaderboard.find((p: any) => p.username === "Borrado");
    expect((await admin.call(`/api/admin/players/${self.id}`, { method: "DELETE" })).status).toBe(400);
    expect((await admin.call(`/api/admin/players/${target.id}`, { method: "DELETE" })).status).toBe(200);
    const after = await state(admin);
    expect(after.leaderboard.map((p: any) => p.username)).toEqual(["Sycamore"]);
  });
});

describe("control panel", () => {
  async function setup() {
    const admin = await register("Lance");
    await makeAdmin("Lance");
    const player = await register("Trainee");
    const players = (await admin.json("/api/admin/players")).players as any[];
    const target = players.find((p) => p.username === "Trainee");
    const self = players.find((p) => p.username === "Lance");
    return { admin, player, target, self };
  }

  const cellAction = (c: Client, id: number, pos: number, action: string) =>
    c.call(`/api/admin/players/${id}/cells/${pos}`, { method: "POST", body: { action } });

  it("forbids every control endpoint to regular players", async () => {
    const { player, target } = await setup();
    expect((await player.call("/api/admin/players")).status).toBe(403);
    expect((await player.call(`/api/admin/players/${target.id}/card`)).status).toBe(403);
    expect((await cellAction(player, target.id, 0, "approve")).status).toBe(403);
    expect((await player.call(`/api/admin/players/${target.id}`, { method: "PATCH", body: { rerolls: 5 } })).status).toBe(403);
    expect((await player.call(`/api/admin/players/${target.id}/reset-card`, { method: "POST" })).status).toBe(403);
  });

  it("lists players with pending counts and shows one player's card", async () => {
    const { admin, player, target } = await setup();
    await player.call("/api/cells/3/toggle", { method: "POST" });
    await player.call("/api/cells/7/toggle", { method: "POST" });

    const listed = ((await admin.json("/api/admin/players")).players as any[]).find((p) => p.id === target.id);
    expect(listed).toMatchObject({ username: "Trainee", pending: 2, isAdmin: false, locked: false, rerolls: 5 });

    const detail = await admin.json(`/api/admin/players/${target.id}/card`);
    expect(detail.player).toMatchObject({ id: target.id, pending: 2 });
    expect(detail.card).toHaveLength(24);
    expect(detail.card.filter((c: any) => c.state === "pending").map((c: any) => c.pos)).toEqual([3, 7]);
    expect((await admin.call("/api/admin/players/99999/card")).status).toBe(404);
  });

  it("approves, rejects, revokes and directly approves single squares", async () => {
    const { admin, player, target } = await setup();
    await player.call("/api/cells/0/toggle", { method: "POST" });
    await player.call("/api/cells/1/toggle", { method: "POST" });

    expect((await cellAction(admin, target.id, 0, "approve")).status).toBe(200); // pending -> approved
    expect((await cellAction(admin, target.id, 1, "reject")).status).toBe(200); // pending -> none
    expect((await cellAction(admin, target.id, 2, "approve")).status).toBe(200); // none -> approved (direct)
    let card = (await state(player)).me.card;
    expect([card[0].state, card[1].state, card[2].state]).toEqual(["approved", "none", "approved"]);
    expect((await state(player)).me.points).toBe(2);

    expect((await cellAction(admin, target.id, 0, "revoke")).status).toBe(200); // approved -> none
    card = (await state(player)).me.card;
    expect(card[0].state).toBe("none");
    expect((await state(player)).me.points).toBe(1);

    // Only affects this player, not others holding the same phrase.
    const other = await register("Bystander");
    await other.call("/api/cells/0/toggle", { method: "POST" });
    await cellAction(admin, target.id, 5, "approve");
    expect((await state(other)).me.points).toBe(0);
  });

  it("rejects invalid square transitions and actions", async () => {
    const { admin, target } = await setup();
    expect((await cellAction(admin, target.id, 0, "reject")).status).toBe(409); // not pending
    expect((await cellAction(admin, target.id, 0, "revoke")).status).toBe(409); // not approved
    await cellAction(admin, target.id, 0, "approve");
    expect((await cellAction(admin, target.id, 0, "approve")).status).toBe(409); // already approved
    expect((await cellAction(admin, target.id, 0, "explode")).status).toBe(400);
    expect((await cellAction(admin, target.id, 24, "approve")).status).toBe(400);
    expect((await cellAction(admin, 99999, 0, "approve")).status).toBe(404);
  });

  it("recomputes lines and bingo when an approval is revoked", async () => {
    const { admin, player, target } = await setup();
    for (let pos = 0; pos < 24; pos++) await cellAction(admin, target.id, pos, "approve");
    expect((await state(player)).me).toMatchObject({ points: 24, lines: 12, bingo: true });

    await cellAction(admin, target.id, 0, "revoke"); // top-left: row 0, column 0 and one diagonal
    const s = await state(player);
    expect(s.me).toMatchObject({ points: 23, lines: 9, bingo: false });
    expect(s.leaderboard.find((p: any) => p.username === "Trainee").bingoAt).toBeNull();
  });

  it("promotes and demotes moderators but never the caller", async () => {
    const { admin, player, target, self } = await setup();
    expect((await admin.call(`/api/admin/players/${target.id}`, { method: "PATCH", body: { isAdmin: true } })).status).toBe(200);
    expect((await player.call("/api/admin/players")).status).toBe(200);
    expect((await admin.call(`/api/admin/players/${target.id}`, { method: "PATCH", body: { isAdmin: false } })).status).toBe(200);
    expect((await player.call("/api/admin/players")).status).toBe(403);

    const selfDemote = await admin.call(`/api/admin/players/${self.id}`, { method: "PATCH", body: { isAdmin: false } });
    expect(selfDemote.status).toBe(400);
  });

  it("unlocks accounts and adjusts rerolls within limits", async () => {
    const { admin, target } = await setup();
    for (let i = 0; i < 5; i++) {
      await client().call("/api/auth/login", { method: "POST", body: { username: "Trainee", password: "mal" } });
    }
    let listed = ((await admin.json("/api/admin/players")).players as any[]).find((p) => p.id === target.id);
    expect(listed.locked).toBe(true);

    await admin.call(`/api/admin/players/${target.id}`, { method: "PATCH", body: { unlock: true, rerolls: 2 } });
    listed = ((await admin.json("/api/admin/players")).players as any[]).find((p) => p.id === target.id);
    expect(listed).toMatchObject({ locked: false, rerolls: 2 });
    const login = await client().call("/api/auth/login", { method: "POST", body: { username: "Trainee", password: "secreto123" } });
    expect(login.status).toBe(200);

    expect((await admin.call(`/api/admin/players/${target.id}`, { method: "PATCH", body: { rerolls: 6 } })).status).toBe(400);
    expect((await admin.call(`/api/admin/players/${target.id}`, { method: "PATCH", body: {} })).status).toBe(400);
  });

  it("re-deals one player's card and resets only their progress", async () => {
    const { admin, player, target } = await setup();
    const other = await register("Keeper");
    const otherId = ((await admin.json("/api/admin/players")).players as any[]).find((p) => p.username === "Keeper").id;
    await cellAction(admin, target.id, 0, "approve");
    await cellAction(admin, otherId, 0, "approve");
    await admin.call(`/api/admin/players/${target.id}`, { method: "PATCH", body: { rerolls: 3 } });

    expect((await admin.call(`/api/admin/players/${target.id}/reset-card`, { method: "POST" })).status).toBe(200);
    const me = (await state(player)).me;
    expect(me).toMatchObject({ points: 0, lines: 0, rerolls: 3 });
    expect(me.card).toHaveLength(24);
    expect(me.card.every((c: any) => c.state === "none")).toBe(true);
    expect((await state(other)).me.points).toBe(1);
  });
});
