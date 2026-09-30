export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export async function readJson<T extends Record<string, unknown>>(request: Request): Promise<Partial<T>> {
  try {
    const body = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Partial<T>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "Solicitud inválida.");
}

// Browsers always send Origin on cross-site and same-origin POST/PUT/DELETE fetches.
// Together with SameSite=Strict cookies this blocks CSRF.
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new HttpError(403, "Origen no permitido.");
  }
}

type Handler = (request: Request, env: Env, params: Record<string, string>) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" +
        path.replace(/:(\w+)/g, (_, key: string) => {
          keys.push(key);
          return "([^/]+)";
        }) +
        "$",
    );
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  async handle(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    let pathMatched = false;
    for (const route of this.routes) {
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== request.method) continue;
      const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
      try {
        if (request.method !== "GET") assertSameOrigin(request);
        return await route.handler(request, env, params);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, { status: err.status });
        console.error(err);
        return json({ error: "Error interno del servidor." }, { status: 500 });
      }
    }
    return json({ error: pathMatched ? "Método no permitido." : "No encontrado." }, { status: pathMatched ? 405 : 404 });
  }
}
