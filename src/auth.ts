import { HttpError } from "./http";

// ~5 ms of CPU; the Workers free plan allows 10 ms per request. The count is stored in each
// hash, so it can be raised later without invalidating existing passwords.
const PBKDF2_ITERATIONS = 30_000;
const SESSION_COOKIE = "session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 5 * 60 * 1000;

const encoder = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2_sha256" || !iter || !salt || !hash) return false;
  const actual = await pbkdf2(password, fromBase64Url(salt), Number(iter));
  return timingSafeEqual(new Uint8Array(actual), fromBase64Url(hash));
}

// Comparing SHA-256 digests keeps the comparison constant-time regardless of input length.
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return timingSafeEqual(new Uint8Array(da), new Uint8Array(db));
}

export function randomPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function validateUsername(value: unknown): string {
  const username = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    throw new HttpError(400, "El usuario debe tener de 3 a 20 caracteres: letras, números o _.");
  }
  return username;
}

export function validatePassword(value: unknown): string {
  const password = typeof value === "string" ? value : "";
  if (password.length < 6 || password.length > 128) {
    throw new HttpError(400, "La contraseña debe tener al menos 6 caracteres.");
  }
  return password;
}

// Session = stateless signed cookie "<payload>.<hmac>". Checking it costs no D1 reads;
// `gen` must match players.session_gen, which lets password changes revoke old sessions.
export interface Session {
  pid: number;
  gen: number;
  exp: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 16) throw new Error("SESSION_SECRET must be set (16+ characters).");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function createSessionCookie(env: Env, pid: number, gen: number): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify({ pid, gen, exp: Date.now() + SESSION_TTL_MS })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET), encoder.encode(payload));
  const maxAge = SESSION_TTL_MS / 1000;
  return `${SESSION_COOKIE}=${payload}.${toBase64Url(sig)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function readSession(request: Request, env: Env): Promise<Session | null> {
  const cookie = request.headers.get("cookie") ?? "";
  const raw = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(env.SESSION_SECRET),
      fromBase64Url(sig),
      encoder.encode(payload),
    );
    if (!valid) return null;
    const session = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Session;
    return session.exp > Date.now() ? session : null;
  } catch {
    return null;
  }
}
