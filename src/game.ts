export const CARD_SIZE = 24;
export const MAX_REROLLS = 5;
const FREE_INDEX = 12;

// The card has 24 positions laid out on a 5x5 grid with the FREE square in the centre.
export function gridToPos(gridIndex: number): number {
  return gridIndex < FREE_INDEX ? gridIndex : gridIndex - 1;
}

const GRID_LINES: number[][] = [
  ...[0, 1, 2, 3, 4].map((r) => [0, 1, 2, 3, 4].map((c) => r * 5 + c)), // rows
  ...[0, 1, 2, 3, 4].map((c) => [0, 1, 2, 3, 4].map((r) => r * 5 + c)), // columns
  [0, 6, 12, 18, 24],
  [4, 8, 12, 16, 20],
];

// Bitmask of card positions per line; the FREE square always counts as marked.
export const LINE_MASKS = GRID_LINES.map((line) =>
  line.filter((g) => g !== FREE_INDEX).reduce((mask, g) => mask | (1 << gridToPos(g)), 0),
);

export function countLines(approvedMask: number): number {
  return LINE_MASKS.filter((m) => (approvedMask & m) === m).length;
}

const LINES_SQL = LINE_MASKS.map((m) => `((approved_mask & ${m}) = ${m})`).join(" + ");

export function bumpVersion(db: D1Database): D1PreparedStatement {
  return db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'version'");
}

// Deals every phrase onto each matching player's card in a uniformly random order.
// `where` filters players (alias p) and must be static SQL; values go in `binds`.
export function dealCards(db: D1Database, where = "1 = 1", ...binds: unknown[]): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO cells (player_id, pos, phrase_id)
       SELECT p.id, ROW_NUMBER() OVER (PARTITION BY p.id ORDER BY random()) - 1, ph.id
       FROM players p CROSS JOIN phrases ph
       WHERE (SELECT COUNT(*) FROM phrases) = ${CARD_SIZE} AND ${where}`,
    )
    .bind(...binds);
}

export const RESET_STATS_SQL = "approved_mask = 0, points = 0, lines = 0, line_at = NULL, bingo_at = NULL";

// Recomputes the leaderboard columns from cells in SQL, so the result is always consistent
// with the committed card state even when several writes race. Run both statements in order.
export function recomputeStats(db: D1Database, where: string, ...binds: unknown[]): D1PreparedStatement[] {
  const now = Date.now();
  return [
    db
      .prepare(
        `UPDATE players SET
           approved_mask = (SELECT COALESCE(SUM(1 << pos), 0) FROM cells WHERE player_id = players.id AND state = 'approved'),
           points = (SELECT COUNT(*) FROM cells WHERE player_id = players.id AND state = 'approved')
         WHERE ${where}`,
      )
      .bind(...binds),
    db
      .prepare(
        `UPDATE players SET
           lines = ${LINES_SQL},
           line_at = CASE WHEN (${LINES_SQL}) > 0 THEN COALESCE(line_at, ?) ELSE NULL END,
           bingo_at = CASE WHEN points = ${CARD_SIZE} THEN COALESCE(bingo_at, ?) ELSE NULL END
         WHERE ${where}`,
      )
      .bind(now, now, ...binds),
  ];
}

export interface PlayerRow {
  id: number;
  username: string;
  pass_hash: string;
  is_admin: number;
  session_gen: number;
  failed_logins: number;
  locked_until: number;
  rerolls: number;
  points: number;
  lines: number;
  line_at: number | null;
  bingo_at: number | null;
}

export async function getVersion(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'version'").first<{ value: number }>();
  return row?.value ?? 0;
}

interface CardRow {
  pos: number;
  state: "none" | "pending" | "approved";
  phrase_id: number;
  text: string;
}

interface LeaderRow {
  id: number;
  username: string;
  points: number;
  lines: number;
  line_at: number | null;
  bingo_at: number | null;
}

interface PendingRow {
  phrase_id: number;
  text: string;
  username: string;
}

export function cardStatement(db: D1Database, playerId: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT c.pos, c.state, c.phrase_id, p.text
       FROM cells c JOIN phrases p ON p.id = c.phrase_id
       WHERE c.player_id = ? ORDER BY c.pos`,
    )
    .bind(playerId);
}

export function toCard(result: D1Result) {
  return (result.results as unknown as CardRow[]).map((c) => ({
    pos: c.pos,
    phraseId: c.phrase_id,
    text: c.text,
    state: c.state,
  }));
}

// Everything the client renders, fetched in one D1 round trip.
export async function buildState(db: D1Database, player: PlayerRow) {
  const statements = [
    db.prepare("SELECT value FROM meta WHERE key = 'version'"),
    cardStatement(db, player.id),
    db.prepare(
      `SELECT id, username, points, lines, line_at, bingo_at FROM players
       ORDER BY bingo_at IS NULL, bingo_at, lines DESC, points DESC, line_at IS NULL, line_at, username_lc`,
    ),
    db.prepare("SELECT COUNT(*) AS n FROM phrases"),
  ];
  if (player.is_admin) {
    statements.push(
      db.prepare(
        `SELECT c.phrase_id, p.text, pl.username
         FROM cells c JOIN phrases p ON p.id = c.phrase_id JOIN players pl ON pl.id = c.player_id
         WHERE c.state = 'pending' ORDER BY c.phrase_id, pl.username_lc`,
      ),
      db.prepare("SELECT id, text FROM phrases ORDER BY id"),
    );
  }
  const [version, card, leaderboard, phraseCount, pending, phrases] = await db.batch(statements);

  const result = {
    changed: true,
    v: (version.results[0] as { value: number }).value,
    me: {
      id: player.id,
      username: player.username,
      isAdmin: Boolean(player.is_admin),
      rerolls: player.rerolls,
      maxRerolls: MAX_REROLLS,
      points: player.points,
      lines: player.lines,
      bingo: player.bingo_at !== null,
      card: toCard(card),
    },
    phraseCount: (phraseCount.results[0] as { n: number }).n,
    leaderboard: (leaderboard.results as unknown as LeaderRow[]).map((r) => ({
      id: r.id,
      username: r.username,
      points: r.points,
      lines: r.lines,
      lineAt: r.line_at,
      bingoAt: r.bingo_at,
    })),
    admin: null as null | {
      pending: { phraseId: number; text: string; players: string[] }[];
      phrases: { id: number; text: string }[];
    },
  };

  if (pending && phrases) {
    const grouped = new Map<number, { phraseId: number; text: string; players: string[] }>();
    for (const row of pending.results as unknown as PendingRow[]) {
      const entry = grouped.get(row.phrase_id) ?? { phraseId: row.phrase_id, text: row.text, players: [] };
      entry.players.push(row.username);
      grouped.set(row.phrase_id, entry);
    }
    result.admin = {
      pending: [...grouped.values()],
      phrases: phrases.results as unknown as { id: number; text: string }[],
    };
  }
  return result;
}
