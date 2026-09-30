const POLL_MS = 4000;
const MAX_BACKOFF_MS = 30000;
const FREE_INDEX = 12;
const CARD_SIZE = 24;
const VICTORY_IMAGES = 10;

const $ = (id) => document.getElementById(id);

// Same line layout as src/game.ts: 5 rows, 5 columns, 2 diagonals on a 5x5 grid.
const gridToPos = (g) => (g < FREE_INDEX ? g : g - 1);
const GRID_LINES = [
  ...[0, 1, 2, 3, 4].map((r) => [0, 1, 2, 3, 4].map((c) => r * 5 + c)),
  ...[0, 1, 2, 3, 4].map((c) => [0, 1, 2, 3, 4].map((r) => r * 5 + c)),
  [0, 6, 12, 18, 24],
  [4, 8, 12, 16, 20],
];

let estado = null;
let jugando = false;
let version = 0;
let tabActual = "bingo";
let modoAuth = "entrar";
let pollTimer = null;
let pollEnCurso = null;
let fallosSeguidos = 0;
let frasesEditadas = false;
let anterior = null; // { lines, bingo } from the previous render, to celebrate transitions
// Control tab: player list, selected player id, and that player's { player, card } once loaded.
const control = { jugadores: [], seleccionado: null, detalle: null, filtro: "" };

// ---------------------------------------------------------------- API

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Sin conexión con el servidor.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || "Ocurrió un error inesperado.");
  return data;
}

// ---------------------------------------------------------------- UI helpers

function toast(mensaje, tipo = "info") {
  const colores = {
    info: "bg-slate-800 border-slate-600 text-slate-100",
    ok: "bg-green-700 border-green-500 text-white",
    error: "bg-red-700 border-red-500 text-white",
    linea: "bg-sky-600 border-sky-400 text-white font-pixel text-[10px]",
  };
  const el = document.createElement("div");
  el.className = `pointer-events-auto max-w-sm w-full sm:w-auto border rounded-xl px-4 py-2.5 text-xs font-semibold shadow-2xl text-center transition-opacity duration-300 ${colores[tipo]}`;
  el.textContent = mensaje;
  $("toasts").appendChild(el);
  setTimeout(() => el.classList.add("opacity-0"), 3200);
  setTimeout(() => el.remove(), 3600);
}

function mostrar(id, visible) {
  $(id).classList.toggle("hidden", !visible);
}

// Loaded on the first celebration so it never slows down the initial page load.
let confetiListo = null;
function lanzarConfeti(opciones) {
  confetiListo ??= import("/vendor/confetti.mjs").then(({ create }) => create(null, { resize: true, useWorker: false }));
  confetiListo.then((disparar) => disparar(opciones)).catch(() => {});
}

// Remembers (per browser) that this player was logged in, so a returning player sees
// "Cargando..." while the session is checked and a new visitor gets the login form at once.
const CLAVE_SESION = "bingo_sesion";
function recordarSesion(activa) {
  try {
    if (activa) localStorage.setItem(CLAVE_SESION, "1");
    else localStorage.removeItem(CLAVE_SESION);
  } catch {}
}
function teniaSesion() {
  try {
    return localStorage.getItem(CLAVE_SESION) === "1";
  } catch {
    return false;
  }
}

function confirmar({ titulo, texto, si = "Aceptar", peligro = false, soloInfo = false }) {
  $("confirmarTitulo").textContent = titulo;
  $("confirmarTexto").textContent = texto;
  const btnSi = $("confirmarSi");
  btnSi.textContent = si;
  btnSi.className = peligro
    ? "flex-1 bg-red-600 hover:bg-red-500 text-white font-bold py-2 rounded-xl text-xs"
    : "flex-1 bg-yellow-500 hover:bg-yellow-400 text-slate-950 font-bold py-2 rounded-xl text-xs";
  mostrar("confirmarNo", !soloInfo);
  mostrar("modalConfirmar", true);
  return new Promise((resolve) => {
    const cerrar = (valor) => {
      mostrar("modalConfirmar", false);
      btnSi.onclick = null;
      $("confirmarNo").onclick = null;
      resolve(valor);
    };
    btnSi.onclick = () => cerrar(true);
    $("confirmarNo").onclick = () => cerrar(false);
  });
}

async function accion(fn, { exito } = {}) {
  try {
    await fn();
    if (exito) toast(exito, "ok");
  } catch (err) {
    if (err.status === 401) return sesionExpirada();
    toast(err.message, "error");
  }
  await refrescar(true);
}

// ---------------------------------------------------------------- Auth

function setModoAuth(modo) {
  modoAuth = modo;
  const registro = modo === "registro";
  const activo = "py-2 rounded-lg transition bg-red-600 text-white shadow";
  const inactivo = "py-2 rounded-lg transition text-slate-400 hover:text-white";
  $("authTabEntrar").className = registro ? inactivo : activo;
  $("authTabRegistro").className = registro ? activo : inactivo;
  document.querySelectorAll("[data-solo-registro]").forEach((el) => el.classList.toggle("hidden", !registro));
  $("authPass").autocomplete = registro ? "new-password" : "current-password";
  $("btnAuth").textContent = registro ? "✨ Crear cuenta y jugar" : "🎮 Entrar al Juego";
  $("authSubtitulo").textContent = registro
    ? "Crea tu Entrenador con una contraseña. Necesitas el código de invitación."
    : "Entra con tu Entrenador y Contraseña para continuar tu partida.";
  errorAuth("");
}

function errorAuth(mensaje) {
  $("authError").textContent = mensaje;
  mostrar("authError", Boolean(mensaje));
}

async function enviarAuth(event) {
  event.preventDefault();
  const username = $("authUsuario").value.trim();
  const password = $("authPass").value;
  const registro = modoAuth === "registro";

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return errorAuth(registro ? "El usuario debe tener de 3 a 20 caracteres: letras, números o _." : "Escribe tu usuario.");
  }
  if (password.length < (registro ? 6 : 1)) {
    return errorAuth(registro ? "La contraseña debe tener al menos 6 caracteres." : "Escribe tu contraseña.");
  }
  if (registro && password !== $("authPass2").value) return errorAuth("Las contraseñas no coinciden.");
  if (registro && !$("authInvitacion").value.trim()) return errorAuth("Escribe el código de invitación.");

  const btn = $("btnAuth");
  btn.disabled = true;
  try {
    if (registro) {
      await api("/api/auth/register", {
        method: "POST",
        body: { username, password, inviteCode: $("authInvitacion").value.trim() },
      });
    } else {
      await api("/api/auth/login", { method: "POST", body: { username, password } });
    }
    $("formAuth").reset();
    await entrarAlJuego();
  } catch (err) {
    errorAuth(err.message);
  } finally {
    btn.disabled = false;
  }
}

function mostrarAuth(mensaje = "") {
  jugando = false;
  recordarSesion(false);
  detenerPoll();
  estado = null;
  version = 0;
  anterior = null;
  mostrar("vistaCargando", false);
  mostrar("vistaJuego", false);
  mostrar("infoEntrenador", false);
  mostrar("vistaAuth", true);
  setModoAuth(modoAuth);
  errorAuth(mensaje);
}

function sesionExpirada() {
  mostrarAuth("Tu sesión expiró. Vuelve a entrar.");
}

async function entrarAlJuego() {
  jugando = true;
  recordarSesion(true);
  mostrar("vistaCargando", false);
  mostrar("vistaAuth", false);
  mostrar("vistaJuego", true);
  mostrar("infoEntrenador", true);
  cambiarTab("bingo");
  await refrescar(true);
}

async function salir() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  mostrarAuth();
}

async function cambiarPassword(event) {
  event.preventDefault();
  const actual = $("passActual").value;
  const nueva = $("passNueva").value;
  const mostrarError = (m) => {
    $("passError").textContent = m;
    mostrar("passError", Boolean(m));
  };
  if (nueva.length < 6) return mostrarError("La nueva contraseña debe tener al menos 6 caracteres.");
  if (nueva !== $("passNueva2").value) return mostrarError("Las contraseñas no coinciden.");
  try {
    await api("/api/auth/password", { method: "POST", body: { currentPassword: actual, newPassword: nueva } });
    $("formPass").reset();
    mostrarError("");
    mostrar("modalPass", false);
    toast("Contraseña actualizada.", "ok");
  } catch (err) {
    if (err.status === 401 && err.message.includes("sesión")) return sesionExpirada();
    mostrarError(err.message);
  }
}

// ---------------------------------------------------------------- Polling

function detenerPoll() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function programarPoll() {
  detenerPoll();
  if (document.hidden || !jugando) return;
  const espera = Math.min(POLL_MS * 2 ** fallosSeguidos, MAX_BACKOFF_MS);
  pollTimer = setTimeout(() => refrescar(), espera);
}

async function refrescar(forzar = false) {
  if (pollEnCurso) {
    await pollEnCurso;
    if (!forzar) return;
  }
  pollEnCurso = (async () => {
    try {
      const data = await api(`/api/state?v=${forzar ? 0 : version}`);
      if (data.changed) aplicarEstado(data);
      version = data.v;
      if (fallosSeguidos > 0) toast("Conexión recuperada.", "ok");
      fallosSeguidos = 0;
    } catch (err) {
      if (err.status === 401) return sesionExpirada();
      if (fallosSeguidos === 0) toast(err.message, "error");
      fallosSeguidos++;
    }
  })();
  try {
    await pollEnCurso;
  } finally {
    pollEnCurso = null;
    programarPoll();
  }
}

document.addEventListener("visibilitychange", () => {
  if (!jugando) return;
  if (document.hidden) detenerPoll();
  else refrescar();
});

// ---------------------------------------------------------------- Render

function aplicarEstado(data) {
  estado = data;
  const me = data.me;
  $("nombreEntrenador").textContent = me.username;
  mostrar("insigniaModerador", me.isAdmin);
  mostrar("tabAdmin", me.isAdmin);
  mostrar("tabControl", me.isAdmin);
  if (!me.isAdmin && (tabActual === "admin" || tabActual === "control")) cambiarTab("bingo");

  renderCarton();
  renderLeaderboard();
  if (me.isAdmin && data.admin) renderAdmin();
  if (me.isAdmin && tabActual === "control") cargarControl();

  if (anterior) {
    if (me.bingo && !anterior.bingo) mostrarVictoriaBingo();
    else if (me.lines > anterior.lines) {
      toast(me.lines === 1 ? "¡LÍNEA!" : `¡LÍNEA! (${me.lines})`, "linea");
      lanzarConfeti({ particleCount: 120, spread: 70, origin: { y: 0.7 } });
    }
  }
  anterior = { lines: me.lines, bingo: me.bingo };
}

const TITULOS_JUGADOR = {
  approved: "Aprobada",
  pending: "Toca para cancelar la solicitud",
  none: "Toca para pedir validación",
};

// Builds the 25 grid buttons for a card; used by the player's own card and the Control panel.
function crearCasillas(card, { alTocar, titulos, aprobadaTocable = false, compacto = false }) {
  const aprobado = (g) => g === FREE_INDEX || card[gridToPos(g)]?.state === "approved";
  const enLinea = new Set(GRID_LINES.filter((line) => line.every(aprobado)).flat());

  let pendientes = 0;
  const casillas = [];
  for (let g = 0; g < 25; g++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      (compacto ? "p-1 text-[9px] rounded-lg " : "p-1.5 text-[10px] rounded-xl ") +
      "aspect-square sm:p-2 sm:text-xs font-semibold transition-all duration-200 flex flex-col items-center justify-center text-center border break-words hyphens-auto leading-tight overflow-hidden ";

    if (g === FREE_INDEX) {
      btn.className += "bg-yellow-500/20 border-yellow-500 text-yellow-300 font-pixel text-[9px] cursor-default";
      btn.disabled = true;
      btn.append(span("⭐"), span("LIBRE"));
      casillas.push(btn);
      continue;
    }

    const casilla = card[gridToPos(g)];
    if (!casilla) {
      casillas.push(btn);
      continue;
    }
    const linea = enLinea.has(g) ? " ring-2 ring-sky-400" : "";

    if (casilla.state === "approved") {
      btn.className += "bg-green-600 border-green-400 text-white shadow-lg" + (aprobadaTocable ? " hover:border-white" : " cursor-default") + linea;
      btn.append(span(casilla.text, "line-through opacity-80"), span("✅", "text-[10px] mt-0.5 sm:mt-1"));
    } else if (casilla.state === "pending") {
      pendientes++;
      btn.className += "bg-yellow-600/40 border-yellow-500 text-yellow-200 animate-pulse";
      const etiqueta = span("⏳", "text-[10px] mt-0.5 sm:mt-1");
      etiqueta.append(span(" Pendiente", "hidden sm:inline"));
      btn.append(span(casilla.text), etiqueta);
    } else {
      btn.className += "bg-slate-800 border-slate-700 text-slate-200 hover:border-slate-500";
      btn.textContent = casilla.text;
    }
    btn.title = titulos[casilla.state];
    btn.addEventListener("click", () => alTocar(casilla));
    casillas.push(btn);
  }
  return { casillas, pendientes };
}

function renderCarton() {
  const me = estado.me;
  const tieneCarton = me.card.length === CARD_SIZE;
  mostrar("gridBingo", tieneCarton);
  mostrar("sinCarton", !tieneCarton);

  const { casillas, pendientes } = crearCasillas(me.card, { alTocar: marcarCasilla, titulos: TITULOS_JUGADOR });
  $("gridBingo").replaceChildren(...casillas);

  $("lineasTexto").textContent = me.lines;
  $("puntosTexto").textContent = me.points;
  $("pendientesTexto").textContent = pendientes;
  $("rerollsTexto").textContent = `${me.rerolls}/${me.maxRerolls}`;
  $("btnReroll").disabled = me.rerolls <= 0 || !tieneCarton;
}

function span(texto, clases = "") {
  const el = document.createElement("span");
  el.textContent = texto;
  if (clases) el.className = clases;
  return el;
}

function renderLeaderboard() {
  const tabla = $("tablaLeaderboard");
  const lista = estado.leaderboard;
  if (lista.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "py-4 text-center text-slate-500";
    td.textContent = "No hay jugadores registrados.";
    tr.append(td);
    tabla.replaceChildren(tr);
    return;
  }

  tabla.replaceChildren(
    ...lista.map((j, index) => {
      const tr = document.createElement("tr");
      tr.className = j.id === estado.me.id ? "bg-yellow-500/5" : "hover:bg-slate-800/50";
      const celda = (contenido, clases) => {
        const td = document.createElement("td");
        td.className = clases;
        if (contenido instanceof Node) td.append(contenido);
        else td.textContent = contenido;
        return td;
      };
      const [etiqueta, color] = j.bingoAt
        ? ["¡BINGO!", "bg-green-500/20 text-green-400"]
        : j.lines > 0
          ? [j.lines === 1 ? "LÍNEA" : `LÍNEA ×${j.lines}`, "bg-sky-500/20 text-sky-400"]
          : ["En Juego", "bg-yellow-500/20 text-yellow-400"];
      tr.append(
        celda(`#${index + 1}`, `py-3 pr-2 font-bold ${index === 0 ? "text-yellow-400" : "text-slate-400"}`),
        celda(j.id === estado.me.id ? `${j.username} (tú)` : j.username, "py-3 pr-2 font-semibold text-white"),
        celda(`${j.lines}`, "py-3 pr-2 text-sky-400 font-bold"),
        celda(`${j.points}/24`, "py-3 pr-2 text-green-400 font-bold"),
        celda(span(etiqueta, `px-2 py-1 rounded-full text-[10px] font-bold whitespace-nowrap ${color}`), "py-3"),
      );
      return tr;
    }),
  );
}

function renderAdmin() {
  const { pending, phrases } = estado.admin;

  const badge = $("badgePendientes");
  badge.textContent = pending.length;
  mostrar("badgePendientes", pending.length > 0);

  const cont = $("listaSolicitudesFrases");
  if (pending.length === 0) {
    cont.replaceChildren(span("No hay frases pendientes por revisar.", "block text-xs text-slate-400"));
  } else {
    cont.replaceChildren(
      ...pending.map((sol) => {
        const div = document.createElement("div");
        div.className =
          "bg-slate-900 border border-slate-700 p-4 rounded-xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 text-xs";
        const info = document.createElement("div");
        info.className = "space-y-1 min-w-0";
        const frase = document.createElement("p");
        frase.className = "text-sm font-semibold text-white italic break-words";
        frase.textContent = `"${sol.text}"`;
        const quien = document.createElement("p");
        quien.className = "text-[11px] text-slate-400";
        quien.append(`Solicitado por (${sol.players.length}): `, span(sol.players.join(", "), "font-bold text-slate-200"));
        info.append(span("Frase Solicitada:", "text-xs font-bold text-yellow-400"), frase, quien);

        const botones = document.createElement("div");
        botones.className = "flex gap-2 w-full sm:w-auto shrink-0";
        const rechazar = document.createElement("button");
        rechazar.className = "flex-1 sm:flex-none bg-red-600 hover:bg-red-500 text-white px-3 py-2 rounded-lg font-bold";
        rechazar.textContent = "❌ Rechazar";
        rechazar.addEventListener("click", () =>
          accion(() => api(`/api/admin/phrases/${sol.phraseId}/reject`, { method: "POST" })),
        );
        const aprobar = document.createElement("button");
        aprobar.className = "flex-1 sm:flex-none bg-green-600 hover:bg-green-500 text-white px-3 py-2 rounded-lg font-bold";
        aprobar.textContent = "🟢 Aprobar para todos";
        aprobar.addEventListener("click", () =>
          accion(() => api(`/api/admin/phrases/${sol.phraseId}/approve`, { method: "POST" }), {
            exito: `Frase aprobada para ${sol.players.length} entrenador(es).`,
          }),
        );
        botones.append(rechazar, aprobar);
        div.append(info, botones);
        return div;
      }),
    );
  }

  const txt = $("txtFrasesAdmin");
  if (!frasesEditadas && document.activeElement !== txt) {
    txt.value = phrases.map((p) => p.text).join("\n");
    actualizarContadorFrases();
  }
}

function frasesDelTexto() {
  return $("txtFrasesAdmin")
    .value.split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

function actualizarContadorFrases() {
  const n = frasesDelTexto().length;
  const contador = $("contadorFrases");
  contador.textContent = n;
  contador.className = n === CARD_SIZE ? "text-green-400" : "text-red-400";
  $("btnGuardarFrases").disabled = n !== CARD_SIZE;
}

function cambiarTab(tab) {
  tabActual = tab;
  document.querySelectorAll("[data-vista]").forEach((el) => el.classList.toggle("hidden", el.dataset.vista !== tab));
  document.querySelectorAll(".tab").forEach((btn) => {
    const activo = btn.dataset.tab === tab;
    const colorActivo = btn.dataset.tab === "bingo" ? "border-red-500 text-red-500" : "border-yellow-500 text-yellow-400";
    btn.classList.remove("border-red-500", "text-red-500", "border-yellow-500", "text-yellow-400", "border-transparent", "text-slate-400", "hover:text-white");
    btn.classList.add(...(activo ? colorActivo : "border-transparent text-slate-400 hover:text-white").split(" "));
  });
  if (tab === "control") cargarControl();
}

// ---------------------------------------------------------------- Game actions

async function marcarCasilla(casilla) {
  if (casilla.state === "approved") return;
  // Optimistic update; the refresh inside accion() reconciles with the server.
  casilla.state = casilla.state === "pending" ? "none" : "pending";
  renderCarton();
  await accion(() => api(`/api/cells/${casilla.pos}/toggle`, { method: "POST" }));
}

async function ejecutarReroll() {
  const me = estado.me;
  if (me.rerolls <= 0) return toast(`Ya usaste tus ${me.maxRerolls} rerolls.`, "error");
  const ok = await confirmar({
    titulo: "¿Nuevo cartón?",
    texto: `Se reparten las frases en otro orden y pierdes el progreso de este cartón.\nTe quedarán ${me.rerolls - 1} rerolls.`,
    si: "🔀 Reroll",
  });
  if (!ok) return;
  $("btnReroll").disabled = true;
  await accion(() => api("/api/reroll", { method: "POST" }), { exito: "¡Cartón nuevo!" });
}

function mostrarVictoriaBingo() {
  const img = $("imgVictoria");
  mostrar("marcoVictoria", false);
  img.onload = () => mostrar("marcoVictoria", true);
  img.onerror = () => mostrar("marcoVictoria", false);
  img.src = `/img/${Math.floor(Math.random() * VICTORY_IMAGES) + 1}.jpg`;
  mostrar("modalBingo", true);
  lanzarConfeti({ particleCount: 300, spread: 120, origin: { y: 0.5 } });
}

// ---------------------------------------------------------------- Moderator actions

async function guardarFrases() {
  const frases = frasesDelTexto();
  const ok = await confirmar({
    titulo: "¿Guardar banco de frases?",
    texto: "Se repartirán cartones nuevos y se reiniciará el progreso de TODOS los entrenadores.",
    si: "💾 Guardar",
    peligro: true,
  });
  if (!ok) return;
  await accion(
    async () => {
      await api("/api/admin/phrases", { method: "PUT", body: { phrases: frases } });
      frasesEditadas = false;
    },
    { exito: `¡Se guardaron ${frases.length} frases!` },
  );
}

async function vaciarLeaderboard() {
  const ok = await confirmar({
    titulo: "¿Vaciar Leaderboard?",
    texto: "Todos reciben un cartón nuevo y vuelven a cero. Las cuentas se conservan.",
    si: "🗑 Vaciar",
    peligro: true,
  });
  if (ok) await accion(() => api("/api/admin/reset", { method: "POST" }), { exito: "¡Leaderboard vaciado!" });
}

async function resetearClave(jugador) {
  const ok = await confirmar({
    titulo: "¿Resetear contraseña?",
    texto: `Se generará una contraseña temporal para ${jugador.username} y se cerrarán sus sesiones.`,
    si: "🔑 Resetear",
  });
  if (!ok) return;
  try {
    const res = await api(`/api/admin/players/${jugador.id}/reset-password`, { method: "POST" });
    await confirmar({
      titulo: "Contraseña temporal",
      texto: `Entrenador: ${res.username}\nContraseña: ${res.password}\n\nCompártela en privado; podrá cambiarla con 🔑 al entrar.`,
      si: "Listo",
      soloInfo: true,
    });
    if (jugador.id === estado.me.id) sesionExpirada();
  } catch (err) {
    if (err.status === 401) return sesionExpirada();
    toast(err.message, "error");
  }
}

async function eliminarJugador(jugador) {
  const ok = await confirmar({
    titulo: "¿Eliminar entrenador?",
    texto: `Se borrará la cuenta de ${jugador.username} y su cartón. No se puede deshacer.`,
    si: "Eliminar",
    peligro: true,
  });
  if (ok) {
    await accion(
      async () => {
        await api(`/api/admin/players/${jugador.id}`, { method: "DELETE" });
        if (control.seleccionado === jugador.id) seleccionarJugador(null);
      },
      { exito: `${jugador.username} fue eliminado.` },
    );
  }
}

// ---------------------------------------------------------------- Control panel

const TITULOS_CONTROL = {
  approved: "Toca para quitar la aprobación",
  pending: "Toca para aprobar o rechazar",
  none: "Toca para aprobar directamente",
};

// Loads the player list and the selected card. Runs when the tab opens and whenever the
// polled version changes while it is open, so it only costs requests for the moderator.
let controlSeq = 0;
async function cargarControl() {
  const seq = ++controlSeq;
  try {
    const id = control.seleccionado;
    const [lista, detalle] = await Promise.all([
      api("/api/admin/players"),
      id === null
        ? null
        : api(`/api/admin/players/${id}/card`).catch((err) => {
            if (err.status === 404) return null;
            throw err;
          }),
    ]);
    if (seq !== controlSeq) return; // a newer load started meanwhile
    control.jugadores = lista.players;
    if (control.seleccionado === id) {
      control.detalle = detalle;
      if (!detalle) control.seleccionado = null;
    }
    renderControl();
  } catch (err) {
    if (err.status === 401) return sesionExpirada();
    if (err.status !== 403) toast(err.message, "error");
  }
}

function seleccionarJugador(id) {
  control.seleccionado = id;
  control.detalle = null;
  renderControl();
  if (id !== null) cargarControl();
}

function insignias(j) {
  return [j.isAdmin ? "👑" : "", j.locked ? "🔒" : ""].filter(Boolean).join(" ");
}

function renderControl() {
  const filtro = control.filtro.toLowerCase();
  const visibles = control.jugadores.filter((j) => j.username.toLowerCase().includes(filtro));
  $("controlTotal").textContent = control.jugadores.length;

  $("controlLista").replaceChildren(
    ...(visibles.length === 0
      ? [span("Ningún entrenador coincide.", "block text-xs text-slate-500 text-center py-4")]
      : visibles.map((j) => {
          const li = document.createElement("li");
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className =
            "w-full text-left px-3 py-2 rounded-xl border transition flex items-center justify-between gap-2 " +
            (j.id === control.seleccionado
              ? "bg-yellow-500/10 border-yellow-500/60"
              : "border-transparent hover:bg-slate-700/40");
          const info = document.createElement("div");
          info.className = "min-w-0";
          const nombre = j.id === estado.me.id ? `${j.username} (tú)` : j.username;
          info.append(
            span(`${nombre} ${insignias(j)}`.trim(), "block text-sm font-semibold text-slate-100 truncate"),
            span(`L${j.lines} · ${j.points}/24 · 🔀${j.rerolls}`, "block text-[11px] text-slate-400"),
          );
          const chips = document.createElement("div");
          chips.className = "flex gap-1 shrink-0";
          if (j.bingo) chips.append(span("BINGO", "px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-500/20 text-green-400"));
          if (j.pending > 0) chips.append(span(`⏳ ${j.pending}`, "px-2 py-0.5 rounded-full text-[10px] font-bold bg-yellow-500/20 text-yellow-400"));
          btn.append(info, chips);
          btn.addEventListener("click", () => seleccionarJugador(j.id));
          li.append(btn);
          return li;
        })),
  );

  const detalle = control.detalle;
  mostrar("controlDetalle", Boolean(detalle));
  mostrar("controlVacio", !detalle);
  if (!detalle) {
    $("controlVacio").textContent =
      control.seleccionado === null ? "Selecciona un entrenador para ver su cartón." : "Cargando cartón...";
    return;
  }

  const j = detalle.player;
  const esYo = j.id === estado.me.id;
  $("controlNombre").textContent = esYo ? `${j.username} (tú)` : j.username;
  $("controlInsignias").textContent = insignias(j);
  const [etiqueta, color] = j.bingo
    ? ["¡BINGO!", "bg-green-500/20 text-green-400"]
    : j.lines > 0
      ? [j.lines === 1 ? "LÍNEA" : `LÍNEA ×${j.lines}`, "bg-sky-500/20 text-sky-400"]
      : ["En Juego", "bg-yellow-500/20 text-yellow-400"];
  $("controlEstado").textContent = etiqueta;
  $("controlEstado").className = `px-2 py-1 rounded-full text-[10px] font-bold ${color}`;
  $("controlLineas").textContent = j.lines;
  $("controlPuntos").textContent = `${j.points}/24`;
  $("controlPendientes").textContent = j.pending;
  $("controlRerolls").textContent = `${j.rerolls}/${j.maxRerolls}`;

  const { casillas } = crearCasillas(detalle.card, {
    alTocar: (casilla) => accionCasilla(j, casilla),
    titulos: TITULOS_CONTROL,
    aprobadaTocable: true,
    compacto: true,
  });
  $("gridControl").replaceChildren(...casillas);

  $("ctlModerador").textContent = j.isAdmin ? "👑 Quitar moderador" : "👑 Hacer moderador";
  mostrar("ctlModerador", !esYo);
  $("ctlDesbloquear").disabled = !j.locked;
  $("ctlReroll").disabled = j.rerolls >= j.maxRerolls;
  $("ctlRerollMax").disabled = j.rerolls >= j.maxRerolls;
  mostrar("ctlEliminar", !esYo);
}

function elegir({ titulo, texto, detalle, opciones }) {
  $("elegirTitulo").textContent = titulo;
  $("elegirTexto").textContent = texto;
  $("elegirDetalle").textContent = detalle;
  mostrar("modalElegir", true);
  return new Promise((resolve) => {
    const cerrar = (valor) => {
      mostrar("modalElegir", false);
      resolve(valor);
    };
    $("elegirOpciones").replaceChildren(
      ...[...opciones, { valor: null, texto: "Cancelar", clase: "bg-slate-700 text-slate-300" }].map((o) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `w-full font-bold py-2 rounded-xl text-xs transition ${o.clase}`;
        btn.textContent = o.texto;
        btn.addEventListener("click", () => cerrar(o.valor));
        return btn;
      }),
    );
  });
}

async function accionCasilla(jugador, casilla) {
  const aprobar = { valor: "approve", texto: "✅ Aprobar", clase: "bg-green-600 hover:bg-green-500 text-white" };
  const opciones = {
    pending: [aprobar, { valor: "reject", texto: "❌ Rechazar", clase: "bg-red-600 hover:bg-red-500 text-white" }],
    none: [{ ...aprobar, texto: "✅ Aprobar directamente" }],
    approved: [{ valor: "revoke", texto: "↩ Quitar aprobación", clase: "bg-yellow-500 hover:bg-yellow-400 text-slate-950" }],
  }[casilla.state];
  const estados = { pending: "⏳ Pendiente de validar", none: "Sin marcar", approved: "✅ Aprobada" };
  const accionElegida = await elegir({
    titulo: `Cartón de ${jugador.username}`,
    texto: `"${casilla.text}"`,
    detalle: estados[casilla.state],
    opciones,
  });
  if (!accionElegida) return;
  const mensajes = { approve: "Casilla aprobada.", reject: "Solicitud rechazada.", revoke: "Aprobación quitada." };
  await accion(
    () => api(`/api/admin/players/${jugador.id}/cells/${casilla.pos}`, { method: "POST", body: { action: accionElegida } }),
    { exito: mensajes[accionElegida] },
  );
}

async function actualizarJugador(cambios, exito) {
  const j = control.detalle?.player;
  if (!j) return;
  await accion(() => api(`/api/admin/players/${j.id}`, { method: "PATCH", body: cambios }), { exito });
}

async function cambiarModerador() {
  const j = control.detalle?.player;
  if (!j) return;
  const ok = await confirmar({
    titulo: j.isAdmin ? "¿Quitar moderador?" : "¿Hacer moderador?",
    texto: j.isAdmin
      ? `${j.username} dejará de ver los paneles de moderación.`
      : `${j.username} podrá aprobar frases y gestionar a todos los entrenadores.`,
    si: "👑 Confirmar",
    peligro: j.isAdmin,
  });
  if (ok) await actualizarJugador({ isAdmin: !j.isAdmin }, j.isAdmin ? "Ya no es moderador." : "¡Nuevo moderador!");
}

async function repartirCarton() {
  const j = control.detalle?.player;
  if (!j) return;
  const ok = await confirmar({
    titulo: "¿Cartón nuevo?",
    texto: `${j.username} recibirá las frases en otro orden y perderá su progreso. Sus rerolls no cambian.`,
    si: "♻️ Repartir",
    peligro: true,
  });
  if (ok) {
    await accion(() => api(`/api/admin/players/${j.id}/reset-card`, { method: "POST" }), {
      exito: `Cartón nuevo para ${j.username}.`,
    });
  }
}

// ---------------------------------------------------------------- Wiring

document.addEventListener("DOMContentLoaded", async () => {
  $("authTabEntrar").addEventListener("click", () => setModoAuth("entrar"));
  $("authTabRegistro").addEventListener("click", () => setModoAuth("registro"));
  $("formAuth").addEventListener("submit", enviarAuth);
  $("btnSalir").addEventListener("click", salir);
  $("btnCambiarPass").addEventListener("click", () => {
    $("formPass").reset();
    mostrar("passError", false);
    mostrar("modalPass", true);
    $("passActual").focus();
  });
  $("formPass").addEventListener("submit", cambiarPassword);
  document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => cambiarTab(btn.dataset.tab)));
  document.querySelectorAll("[data-cerrar]").forEach((btn) =>
    btn.addEventListener("click", () => mostrar(btn.dataset.cerrar, false)),
  );
  $("btnReroll").addEventListener("click", ejecutarReroll);
  $("btnGuardarFrases").addEventListener("click", guardarFrases);
  $("btnVaciar").addEventListener("click", vaciarLeaderboard);
  $("controlBuscar").addEventListener("input", (e) => {
    control.filtro = e.target.value;
    renderControl();
  });
  $("ctlModerador").addEventListener("click", cambiarModerador);
  $("ctlDesbloquear").addEventListener("click", () => actualizarJugador({ unlock: true }, "Cuenta desbloqueada."));
  $("ctlReroll").addEventListener("click", () => {
    const j = control.detalle?.player;
    if (j) actualizarJugador({ rerolls: Math.min(j.rerolls + 1, j.maxRerolls) }, "+1 reroll.");
  });
  $("ctlRerollMax").addEventListener("click", () => {
    const j = control.detalle?.player;
    if (j) actualizarJugador({ rerolls: j.maxRerolls }, `Rerolls a ${j.maxRerolls}.`);
  });
  $("ctlCarton").addEventListener("click", repartirCarton);
  $("ctlClave").addEventListener("click", () => control.detalle && resetearClave(control.detalle.player));
  $("ctlEliminar").addEventListener("click", () => control.detalle && eliminarJugador(control.detalle.player));
  $("txtFrasesAdmin").addEventListener("input", () => {
    frasesEditadas = true;
    actualizarContadorFrases();
  });

  setModoAuth("entrar");
  if (!teniaSesion()) mostrarAuth();
  try {
    const { user } = await api("/api/auth/me");
    if (user) await entrarAlJuego();
    else if ($("vistaAuth").classList.contains("hidden")) mostrarAuth();
  } catch (err) {
    mostrarAuth(err.message);
  }
});
