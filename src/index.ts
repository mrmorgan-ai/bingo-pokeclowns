import {
  LOCKOUT_MS,
  MAX_FAILED_LOGINS,
  clearSessionCookie,
  createSessionCookie,
  hashPassword,
  randomPassword,
  readSession,
  secretsEqual,
  validatePassword,
  validateUsername,
  verifyPassword,
  type Session,
} from "./auth";
import {
  CARD_SIZE,
  MAX_REROLLS,
  RESET_STATS_SQL,
  buildState,
  bumpVersion,
  cardStatement,
  dealCards,
  getVersion,
  recomputeStats,
  toCard,
  type PlayerRow,
} from "./game";
import { HttpError, Router, json, readJson } from "./http";

// Used when the username does not exist so a failed login takes the same time either way.
const DUMMY_HASH = "pbkdf2_sha256$30000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MAX_PHRASE_LENGTH = 120;

async function requireSession(request: Request, env: Env): Promise<Session> {
  const session = await readSession(request, env);
  if (!session) throw new HttpError(401, "Inicia sesión para continuar.");
  return session;
}

async function requirePlayer(request: Request, env: Env): Promise<PlayerRow> {
  const session = await requireSession(request, env);
  const player = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(session.pid).first<PlayerRow>();
  if (!player || player.session_gen !== session.gen) throw new HttpError(401, "Tu sesión expiró. Vuelve a entrar.");
  return player;
}

async function requireAdmin(request: Request, env: Env): Promise<PlayerRow> {
  const player = await requirePlayer(request, env);
  if (!player.is_admin) throw new HttpError(403, "Solo los moderadores pueden hacer esto.");
  return player;
}

function parseId(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 0) throw new HttpError(400, "Identificador inválido.");
  return id;
}

interface AdminPlayerRow {
  id: number;
  username: string;
  is_admin: number;
  rerolls: number;
  points: number;
  lines: number;
  bingo_at: number | null;
  locked_until: number;
}

const ADMIN_PLAYER_COLUMNS = "id, username, is_admin, rerolls, points, lines, bingo_at, locked_until";

function toAdminPlayer(row: AdminPlayerRow, pending: number) {
  return {
    id: row.id,
    username: row.username,
    isAdmin: Boolean(row.is_admin),
    rerolls: row.rerolls,
    maxRerolls: MAX_REROLLS,
    points: row.points,
    lines: row.lines,
    bingo: row.bingo_at !== null,
    locked: row.locked_until > Date.now(),
    pending,
  };
}

async function requireTarget(env: Env, id: number): Promise<AdminPlayerRow> {
  const row = await env.DB.prepare(`SELECT ${ADMIN_PLAYER_COLUMNS} FROM players WHERE id = ?`)
    .bind(id)
    .first<AdminPlayerRow>();
  if (!row) throw new HttpError(404, "Ese entrenador no existe.");
  return row;
}

// Moderator actions on a single square of one player's card.
const CELL_ACTIONS = {
  approve: { sql: "state = 'approved' WHERE state != 'approved'", error: "Esa casilla ya está aprobada." },
  reject: { sql: "state = 'none' WHERE state = 'pending'", error: "Esa casilla no está pendiente." },
  revoke: { sql: "state = 'none' WHERE state = 'approved'", error: "Esa casilla no está aprobada." },
} as const;

async function withSession(env: Env, player: { id: number; session_gen: number }, body: unknown): Promise<Response> {
  return json(body, { headers: { "set-cookie": await createSessionCookie(env, player.id, player.session_gen) } });
}

const router = new Router()
  // ---------- Auth ----------
  .on("POST", "/api/auth/register", async (request, env) => {
    const body = await readJson<{ username: string; password: string; inviteCode: string }>(request);
    const username = validateUsername(body.username);
    const password = validatePassword(body.password);
    if (!env.INVITE_CODE) throw new HttpError(403, "El registro está deshabilitado.");
    if (!(await secretsEqual(String(body.inviteCode ?? "").trim(), env.INVITE_CODE))) {
      throw new HttpError(403, "Código de invitación incorrecto.");
    }

    const usernameLc = username.toLowerCase();
    const passHash = await hashPassword(password);
    try {
      const [inserted] = await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO players (username, username_lc, pass_hash, rerolls, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id, session_gen",
        ).bind(username, usernameLc, passHash, MAX_REROLLS, Date.now()),
        dealCards(env.DB, "p.username_lc = ?", usernameLc),
        bumpVersion(env.DB),
      ]);
      const player = inserted.results[0] as { id: number; session_gen: number };
      return withSession(env, player, { ok: true });
    } catch (err) {
      if (String(err).includes("UNIQUE")) throw new HttpError(409, "Ese entrenador ya existe. Elige otro nombre.");
      throw err;
    }
  })

  .on("POST", "/api/auth/login", async (request, env) => {
    const body = await readJson<{ username: string; password: string }>(request);
    const usernameLc = String(body.username ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const player = await env.DB.prepare("SELECT * FROM players WHERE username_lc = ?")
      .bind(usernameLc)
      .first<PlayerRow>();
    const now = Date.now();

    if (player && player.locked_until > now) {
      const minutes = Math.ceil((player.locked_until - now) / 60_000);
      throw new HttpError(429, `Demasiados intentos. Intenta de nuevo en ${minutes} min.`);
    }

    const ok = await verifyPassword(password, player?.pass_hash ?? DUMMY_HASH);
    if (!player || !ok) {
      if (player) {
        const failed = player.failed_logins + 1;
        const locked = failed >= MAX_FAILED_LOGINS;
        await env.DB.prepare("UPDATE players SET failed_logins = ?, locked_until = ? WHERE id = ?")
          .bind(locked ? 0 : failed, locked ? now + LOCKOUT_MS : 0, player.id)
          .run();
      }
      throw new HttpError(401, "Usuario o contraseña incorrectos.");
    }

    if (player.failed_logins > 0) {
      await env.DB.prepare("UPDATE players SET failed_logins = 0 WHERE id = ?").bind(player.id).run();
    }
    return withSession(env, player, { ok: true });
  })

  .on("POST", "/api/auth/logout", async () => {
    return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
  })

  .on("GET", "/api/auth/me", async (request, env) => {
    try {
      const player = await requirePlayer(request, env);
      return json({ user: { id: player.id, username: player.username, isAdmin: Boolean(player.is_admin) } });
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) return json({ user: null });
      throw err;
    }
  })

  .on("POST", "/api/auth/password", async (request, env) => {
    const player = await requirePlayer(request, env);
    const body = await readJson<{ currentPassword: string; newPassword: string }>(request);
    if (!(await verifyPassword(String(body.currentPassword ?? ""), player.pass_hash))) {
      throw new HttpError(401, "La contraseña actual no es correcta.");
    }
    const passHash = await hashPassword(validatePassword(body.newPassword));
    const updated = await env.DB.prepare(
      "UPDATE players SET pass_hash = ?, session_gen = session_gen + 1 WHERE id = ? RETURNING id, session_gen",
    )
      .bind(passHash, player.id)
      .first<{ id: number; session_gen: number }>();
    return withSession(env, updated!, { ok: true });
  })

  // ---------- Game ----------
  .on("GET", "/api/state", async (request, env) => {
    // Cheap path: a valid cookie plus one row read. Most polls end here.
    await requireSession(request, env);
    const since = Number(new URL(request.url).searchParams.get("v"));
    const version = await getVersion(env.DB);
    if (since === version) return json({ changed: false, v: version });

    const player = await requirePlayer(request, env);
    return json(await buildState(env.DB, player));
  })

  .on("POST", "/api/cells/:pos/toggle", async (request, env, params) => {
    const player = await requirePlayer(request, env);
    const pos = parseId(params.pos);
    if (pos >= CARD_SIZE) throw new HttpError(400, "Casilla inválida.");
    const [toggled] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE cells SET state = CASE state WHEN 'none' THEN 'pending' ELSE 'none' END
         WHERE player_id = ? AND pos = ? AND state != 'approved'`,
      ).bind(player.id, pos),
      bumpVersion(env.DB),
    ]);
    if (toggled.meta.changes === 0) throw new HttpError(409, "Esa casilla ya fue aprobada.");
    return json({ ok: true });
  })

  .on("POST", "/api/reroll", async (request, env) => {
    const player = await requirePlayer(request, env);
    if (player.rerolls <= 0) throw new HttpError(409, `Ya usaste tus ${MAX_REROLLS} rerolls.`);
    await env.DB.batch([
      env.DB.prepare(`UPDATE players SET rerolls = rerolls - 1, ${RESET_STATS_SQL} WHERE id = ? AND rerolls = ?`).bind(
        player.id,
        player.rerolls,
      ),
      env.DB.prepare("DELETE FROM cells WHERE player_id = ?").bind(player.id),
      dealCards(env.DB, "p.id = ?", player.id),
      bumpVersion(env.DB),
    ]);
    return json({ ok: true });
  })

  // ---------- Moderator ----------
  .on("PUT", "/api/admin/phrases", async (request, env) => {
    await requireAdmin(request, env);
    const body = await readJson<{ phrases: unknown[] }>(request);
    const raw = Array.isArray(body.phrases) ? body.phrases : [];
    const phrases = raw.map((p) => String(p ?? "").trim()).filter((p) => p.length > 0);
    if (phrases.length !== CARD_SIZE) {
      throw new HttpError(400, `Se necesitan exactamente ${CARD_SIZE} frases (recibidas: ${phrases.length}).`);
    }
    if (phrases.some((p) => p.length > MAX_PHRASE_LENGTH)) {
      throw new HttpError(400, `Cada frase debe tener como máximo ${MAX_PHRASE_LENGTH} caracteres.`);
    }
    if (new Set(phrases.map((p) => p.toLowerCase())).size !== phrases.length) {
      throw new HttpError(400, "Hay frases repetidas.");
    }
    // A new phrase bank starts a new round: every card is re-dealt and progress is reset.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM cells"),
      env.DB.prepare("DELETE FROM phrases"),
      env.DB.prepare(`INSERT INTO phrases (text) VALUES ${phrases.map(() => "(?)").join(", ")}`).bind(...phrases),
      dealCards(env.DB),
      env.DB.prepare(`UPDATE players SET rerolls = ?, ${RESET_STATS_SQL}`).bind(MAX_REROLLS),
      bumpVersion(env.DB),
    ]);
    return json({ ok: true });
  })

  .on("POST", "/api/admin/phrases/:id/approve", async (request, env, params) => {
    await requireAdmin(request, env);
    const phraseId = parseId(params.id);
    const affected = "id IN (SELECT player_id FROM cells WHERE state = 'approved' AND phrase_id = ?)";
    await env.DB.batch([
      env.DB.prepare("UPDATE cells SET state = 'approved' WHERE state = 'pending' AND phrase_id = ?").bind(phraseId),
      ...recomputeStats(env.DB, affected, phraseId),
      bumpVersion(env.DB),
    ]);
    return json({ ok: true });
  })

  .on("POST", "/api/admin/phrases/:id/reject", async (request, env, params) => {
    await requireAdmin(request, env);
    const phraseId = parseId(params.id);
    await env.DB.batch([
      env.DB.prepare("UPDATE cells SET state = 'none' WHERE state = 'pending' AND phrase_id = ?").bind(phraseId),
      bumpVersion(env.DB),
    ]);
    return json({ ok: true });
  })

  // "Vaciar Leaderboard": new cards and zero progress for everyone; accounts are kept.
  .on("POST", "/api/admin/reset", async (request, env) => {
    await requireAdmin(request, env);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM cells"),
      dealCards(env.DB),
      env.DB.prepare(`UPDATE players SET rerolls = ?, ${RESET_STATS_SQL}`).bind(MAX_REROLLS),
      bumpVersion(env.DB),
    ]);
    return json({ ok: true });
  })

  .on("POST", "/api/admin/players/:id/reset-password", async (request, env, params) => {
    await requireAdmin(request, env);
    const id = parseId(params.id);
    const password = randomPassword();
    const updated = await env.DB.prepare(
      `UPDATE players SET pass_hash = ?, session_gen = session_gen + 1, failed_logins = 0, locked_until = 0
       WHERE id = ? RETURNING username`,
    )
      .bind(await hashPassword(password), id)
      .first<{ username: string }>();
    if (!updated) throw new HttpError(404, "Ese entrenador no existe.");
    return json({ username: updated.username, password });
  })

  // ---------- Control panel: per-player management ----------
  .on("GET", "/api/admin/players", async (request, env) => {
    await requireAdmin(request, env);
    const [players, pending] = await env.DB.batch([
      env.DB.prepare(`SELECT ${ADMIN_PLAYER_COLUMNS} FROM players ORDER BY username_lc`),
      env.DB.prepare("SELECT player_id, COUNT(*) AS n FROM cells WHERE state = 'pending' GROUP BY player_id"),
    ]);
    const pendingBy = new Map(
      (pending.results as unknown as { player_id: number; n: number }[]).map((r) => [r.player_id, r.n]),
    );
    return json({
      players: (players.results as unknown as AdminPlayerRow[]).map((r) => toAdminPlayer(r, pendingBy.get(r.id) ?? 0)),
    });
  })

  .on("GET", "/api/admin/players/:id/card", async (request, env, params) => {
    await requireAdmin(request, env);
    const target = await requireTarget(env, parseId(params.id));
    const card = toCard(await cardStatement(env.DB, target.id).run());
    const pending = card.filter((c) => c.state === "pending").length;
    return json({ player: toAdminPlayer(target, pending), card });
  })

  .on("POST", "/api/admin/players/:id/cells/:pos", async (request, env, params) => {
    await requireAdmin(request, env);
    const target = await requireTarget(env, parseId(params.id));
    const pos = parseId(params.pos);
    if (pos >= CARD_SIZE) throw new HttpError(400, "Casilla inválida.");
    const { action } = await readJson<{ action: string }>(request);
    const cellAction = CELL_ACTIONS[action as keyof typeof CELL_ACTIONS];
    if (!cellAction) throw new HttpError(400, "Acción inválida.");

    const [updated] = await env.DB.batch([
      env.DB.prepare(`UPDATE cells SET ${cellAction.sql} AND player_id = ? AND pos = ?`).bind(target.id, pos),
      ...recomputeStats(env.DB, "id = ?", target.id),
      bumpVersion(env.DB),
    ]);
    if (updated.meta.changes === 0) throw new HttpError(409, cellAction.error);
    return json({ ok: true });
  })

  .on("PATCH", "/api/admin/players/:id", async (request, env, params) => {
    const admin = await requireAdmin(request, env);
    const target = await requireTarget(env, parseId(params.id));
    const body = await readJson<{ isAdmin: boolean; unlock: boolean; rerolls: number }>(request);

    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.isAdmin !== undefined) {
      if (typeof body.isAdmin !== "boolean") throw new HttpError(400, "Valor de moderador inválido.");
      if (!body.isAdmin && target.id === admin.id) {
        throw new HttpError(400, "No puedes quitarte el rol de moderador.");
      }
      sets.push("is_admin = ?");
      binds.push(body.isAdmin ? 1 : 0);
    }
    if (body.unlock === true) sets.push("failed_logins = 0", "locked_until = 0");
    if (body.rerolls !== undefined) {
      if (!Number.isInteger(body.rerolls) || body.rerolls < 0 || body.rerolls > MAX_REROLLS) {
        throw new HttpError(400, `Los rerolls deben estar entre 0 y ${MAX_REROLLS}.`);
      }
      sets.push("rerolls = ?");
      binds.push(body.rerolls);
    }
    if (sets.length === 0) throw new HttpError(400, "No hay cambios que aplicar.");

    await env.DB.batch([
      env.DB.prepare(`UPDATE players SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, target.id),
      bumpVersion(env.DB),
    ]);
    return json({ ok: true });
  })

  .on("POST", "/api/admin/players/:id/reset-card", async (request, env, params) => {
    await requireAdmin(request, env);
    const target = await requireTarget(env, parseId(params.id));
    await env.DB.batch([
      env.DB.prepare(`UPDATE players SET ${RESET_STATS_SQL} WHERE id = ?`).bind(target.id),
      env.DB.prepare("DELETE FROM cells WHERE player_id = ?").bind(target.id),
      dealCards(env.DB, "p.id = ?", target.id),
      bumpVersion(env.DB),
    ]);
    return json({ ok: true });
  })

  .on("DELETE", "/api/admin/players/:id", async (request, env, params) => {
    const admin = await requireAdmin(request, env);
    const id = parseId(params.id);
    if (id === admin.id) throw new HttpError(400, "No puedes eliminar tu propia cuenta.");
    const [, removed] = await env.DB.batch([
      env.DB.prepare("DELETE FROM cells WHERE player_id = ?").bind(id),
      env.DB.prepare("DELETE FROM players WHERE id = ?").bind(id),
      bumpVersion(env.DB),
    ]);
    if (removed.meta.changes === 0) throw new HttpError(404, "Ese entrenador no existe.");
    return json({ ok: true });
  });

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) return router.handle(request, env);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
