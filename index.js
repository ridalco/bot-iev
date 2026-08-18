// ╔══════════════════════════════════════════════════════════════╗
// ║          BOT MENTOR — IES N°6 / IES N°11                    ║
// ║          Prof. Ing. Corimayo Ricardo Daniel                  ║
// ║          Versión 4.0 — Producción en Render.com              ║
// ╚══════════════════════════════════════════════════════════════╝
'use strict';
require('dotenv').config();

const fs     = require('fs');
const http   = require('http');
const crypto = require('crypto');
const {
  Client, GatewayIntentBits, Events,
  SlashCommandBuilder, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  AttachmentBuilder
} = require('discord.js');
const Anthropic  = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

// Generación de imágenes para /tarjeta — opcional: si el paquete no está
// instalado, el bot sigue funcionando igual, solo /tarjeta avisa que no está disponible.
let canvasLib = null;
try { canvasLib = require('@napi-rs/canvas'); }
catch { console.warn('[Mentor] @napi-rs/canvas no instalado — /tarjeta no va a estar disponible hasta agregarlo.'); }

// ════════════════════════════════════════════════════════════════
// LOGGING PROFESIONAL
// ════════════════════════════════════════════════════════════════
const LOG = {
  info:  (msg) => console.log (`[${horaAR()}] ✅ ${msg}`),
  warn:  (msg) => console.warn(`[${horaAR()}] ⚠️  ${msg}`),
  error: (msg, err) => console.error(`[${horaAR()}] ❌ ${msg}`, err || ''),
  cmd:   (msg) => console.log (`[${horaAR()}] 💬 ${msg}`),
};

// ════════════════════════════════════════════════════════════════
// HORA ARGENTINA — siempre UTC-3
// ════════════════════════════════════════════════════════════════
const TZ = 'America/Argentina/Buenos_Aires';
function horaAR()  { return new Date().toLocaleTimeString ('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function fechaAR() { return new Date().toLocaleDateString ('es-AR', { timeZone: TZ }); }
function ahoraAR() { return new Date().toLocaleString    ('es-AR', { timeZone: TZ }); }
function fechaHoraAR() {
  const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  return { dia: ahora.getDay(), hora: ahora.getHours(), min: ahora.getMinutes() };
}

// ════════════════════════════════════════════════════════════════
// VALIDACIÓN ESTRICTA DE VARIABLES DE ENTORNO
// ════════════════════════════════════════════════════════════════
const VARS_REQUERIDAS = ['DISCORD_TOKEN', 'ANTHROPIC_API_KEY', 'SPREADSHEET_ID', 'GOOGLE_CREDENTIALS'];
const faltantes = VARS_REQUERIDAS.filter(v => !process.env[v]);
if (faltantes.length) {
  console.error(`\n❌ VARIABLES FALTANTES EN RENDER: ${faltantes.join(', ')}\n`);
  process.exit(1);
}

let GOOGLE_CREDENTIALS;
try {
  GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
} catch {
  console.error('❌ GOOGLE_CREDENTIALS no es JSON válido. Revisá la variable en Render.');
  process.exit(1);
}

// Constantes de configuración
const DISCORD_TOKEN      = process.env.DISCORD_TOKEN;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const SPREADSHEET_ID     = process.env.SPREADSHEET_ID;
const PROFESOR_ID        = process.env.PROFESOR_ID   || null;
const MOODLE_TOKEN_IES6  = process.env.MOODLE_TOKEN_IES6  || null;
const MOODLE_TOKEN_IES11 = process.env.MOODLE_TOKEN_IES11 || null;
const MOODLE_URL_IES6    = 'https://ies6.aulasvirtuales.name';
const MOODLE_URL_IES11   = 'https://ies11.aulasvirtuales.name';
const PORT               = process.env.PORT || 3000;
const CANAL_NOTICIAS     = 'noticias-tech';
const COOLDOWN_SEG       = 30;
const FORMULARIO_MS      = 10 * 60 * 1000; // 10 minutos

// Seguridad y geocercas de asistencia. En Render conviene definir
// PRESENCIA_SECRET con una cadena larga y aleatoria. Si falta, se usa
// DISCORD_TOKEN como respaldo para no dejar enlaces sin firma.
const PRESENCIA_SECRET = process.env.PRESENCIA_SECRET || DISCORD_TOKEN;
const PRESENCIA_URL    = process.env.PRESENCIA_URL || 'https://aulasvirtuales.name/presencia.html';
const VENTANA_ASISTENCIA_MS = 20 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;

const INSTITUTOS_GPS = {
  ies6: {
    nombre: 'IES N°6 — Sede Perico',
    lat: Number(process.env.IES6_LAT || -24.3794182),
    lng: Number(process.env.IES6_LNG || -65.1246575),
    radio: Number(process.env.IES6_RADIO || 150)
  },
  ies11: {
    nombre: 'IES N°11 — San Salvador de Jujuy',
    lat: Number(process.env.IES11_LAT || -24.1892),
    lng: Number(process.env.IES11_LNG || -65.2987),
    radio: Number(process.env.IES11_RADIO || 150)
  },
  ucse: {
    // ⚠️ SIN VERIFICAR — coordenada aproximada del centro de San Salvador de Jujuy,
    // NO la dirección real (Lavalle 333). Corregir con UCSE_LAT / UCSE_LNG en Render
    // apenas se tenga la ubicación exacta del aula, tomada desde Google Maps.
    nombre: 'UCSE — Departamento Académico San Salvador',
    lat: Number(process.env.UCSE_LAT || -24.1892),
    lng: Number(process.env.UCSE_LNG || -65.2987),
    radio: Number(process.env.UCSE_RADIO || 150)
  }
};

function calcularDistanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function institutoParaGuild(guildId) {
  const nombre = (client?.guilds?.cache?.get(guildId)?.name || '').toLowerCase();
  if (nombre.includes('ucse')) return INSTITUTOS_GPS.ucse;
  return (nombre.includes('11') || nombre.includes('alvear')) ? INSTITUTOS_GPS.ies11 : INSTITUTOS_GPS.ies6;
}

function firmarPresencia({ uid, guildId, exp, nonce }) {
  return crypto.createHmac('sha256', PRESENCIA_SECRET)
    .update(`${uid}.${guildId}.${exp}.${nonce}`)
    .digest('hex');
}

function firmaValida({ uid, guildId, exp, nonce, sig }) {
  if (!uid || !guildId || !exp || !nonce || !sig) return false;
  const esperada = firmarPresencia({ uid, guildId, exp, nonce });
  const a = Buffer.from(esperada, 'hex');
  const b = Buffer.from(String(sig), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function responderJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

// ════════════════════════════════════════════════════════════════
// ESTADO DE ARRANQUE — hasta que sea true, el bot todavía no terminó
// de conectarse a Discord ni de registrar comandos. El health check
// /health informa que Node.js está vivo y /ready indica si Discord ya está conectado.
//
// TOPE DE ESPERA: si la conexión a Discord se cuelga (pasó varias veces
// el 03/08/2026), /ready NO debe esperar para siempre — eso deja a
// Render trabado en "Deploying..." sin límite. Pasados 2 minutos desde
// que arrancó el proceso, /ready responde 200 igual, aunque Discord
// todavía no haya conectado, para que el deploy no quede colgado.
// ════════════════════════════════════════════════════════════════
let botReady = false;
const BOOT_TIME = Date.now();
const READY_GRACE_MS = 2 * 60 * 1000; // 2 minutos de margen
function estaListoOVencioElMargen() {
  return botReady || (Date.now() - BOOT_TIME > READY_GRACE_MS);
}

// ════════════════════════════════════════════════════════════════
// KEEP-ALIVE HTTP — necesario para Render plan gratuito
// ════════════════════════════════════════════════════════════════
http.createServer(async (req, res) => {
  // CORS para que la página presencia.html pueda conectarse
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Endpoint GPS seguro: valida enlace firmado y recalcula la distancia en servidor.
  if (req.method === 'POST' && req.url === '/presencia/verificar') {
    let body = '';
    let excedido = false;

    req.on('data', chunk => {
      if (excedido) return;
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        excedido = true;
        responderJson(res, 413, { ok: false, error: 'Solicitud demasiado grande.' });
        req.destroy();
      }
    });

    req.on('end', async () => {
      if (excedido) return;
      try {
        const data = JSON.parse(body || '{}');
        const uid = String(data.uid || '').trim();
        const guildId = String(data.guildId || '').trim();
        const exp = Number(data.exp || 0);
        const nonce = String(data.nonce || '');
        const sig = String(data.sig || '');
        const lat = Number(data.lat);
        const lng = Number(data.lng);
        const precision = Number(data.precision);

        if (!firmaValida({ uid, guildId, exp, nonce, sig })) {
          responderJson(res, 401, { ok: false, error: 'El enlace no es válido o fue modificado. Volvé a Discord.' });
          return;
        }
        if (!Number.isFinite(exp) || Date.now() > exp) {
          responderJson(res, 410, { ok: false, error: 'El enlace de asistencia expiró. Volvé a solicitarlo en Discord.' });
          return;
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          responderJson(res, 400, { ok: false, error: 'La ubicación recibida no es válida.' });
          return;
        }
        if (!Number.isFinite(precision) || precision <= 0 || precision > 100) {
          responderJson(res, 422, { ok: false, error: 'La precisión GPS es insuficiente. Acercate a una ventana y reintentá.' });
          return;
        }

        const sesion = sesiones.get(guildId);
        if (!sesion || !sesion.activa) {
          responderJson(res, 400, { ok: false, error: 'No hay una clase activa en este momento.' });
          return;
        }
        if (!sesion.tokenTs || Date.now() - sesion.tokenTs > VENTANA_ASISTENCIA_MS) {
          responderJson(res, 410, { ok: false, error: 'La ventana de asistencia de 20 minutos ya cerró.' });
          return;
        }

        const guildObj = client.guilds.cache.get(guildId);
        if (!guildObj) {
          responderJson(res, 404, { ok: false, error: 'No se encontró el servidor de la clase.' });
          return;
        }
        const miembro = await guildObj.members.fetch(uid).catch(() => null);
        if (!miembro) {
          responderJson(res, 403, { ok: false, error: 'El usuario no pertenece al servidor de esta clase.' });
          return;
        }

        if (sesion.asistentes.has(uid)) {
          responderJson(res, 200, { ok: true, yaRegistrado: true, mensaje: 'Tu presencia ya estaba registrada.' });
          return;
        }

        const instituto = institutoParaGuild(guildId);
        const distanciaReal = calcularDistanciaMetros(lat, lng, instituto.lat, instituto.lng);
        const margenPrecision = Math.min(precision, 20);
        const radioEfectivo = instituto.radio + margenPrecision;

        if (distanciaReal > radioEfectivo) {
          LOG.warn(`GPS rechazado: uid=${uid}, guild=${guildId}, distancia=${Math.round(distanciaReal)}m, precisión=±${Math.round(precision)}m`);
          responderJson(res, 403, {
            ok: false,
            fueraDeRadio: true,
            error: `Estás a ${Math.round(distanciaReal)} m del instituto. El límite permitido es ${instituto.radio} m.`,
            distancia: Math.round(distanciaReal),
            radio: instituto.radio,
            precision: Math.round(precision)
          });
          return;
        }

        const nombreReal = getNombreReal(uid, miembro.displayName || miembro.user.username);
        const hora = horaAR();
        const distancia = Math.round(distanciaReal);
        sesion.asistentes.set(uid, { nombre: nombreReal, hora, metodo: 'gps', distancia, precision: Math.round(precision) });

        // Se responde primero para que la página no quede esperando.
        responderJson(res, 200, {
          ok: true,
          registrado: true,
          nombre: nombreReal,
          distancia,
          precision: Math.round(precision),
          instituto: instituto.nombre,
          mensaje: 'Presencia registrada automáticamente.'
        });

        try {
          const mat = detectarMateria(guildId, sesion.canalNombre || '');
          await guardarAsistencia(nombreReal, sesion.fecha, hora, mat, guildObj.name || '');
          const p = darPuntos(uid, nombreReal, 'asistencia');
          const MNOM = { iev:'IEV', bd:'Base de Datos', informatica:'Informatica', practica:'PP3', pybd:'PyBD', annum:'Analisis Numerico' };
          if (!registros.has(uid)) registros.set(uid, { nombreReal, discordUser: miembro.user.username, materia: MNOM[mat] || mat, guildId, registradoEn: ahoraAR() });
          else if (!registros.get(uid).materia) {
            const r = registros.get(uid); r.materia = MNOM[mat] || mat; r.guildId = guildId; registros.set(uid, r);
          }
          const nuevosLogros = verificarLogros(uid, nombreReal, p, sesion.canalNombre || '');
          guardarDatos();
          const canalObj = sesion.canalId ? await client.channels.fetch(sesion.canalId).catch(() => null) : null;
          await actualizarRol(miembro, p.pts, canalObj).catch(() => {});

          const logroMsg = nuevosLogros.length ? nuevosLogros.map(id => {
            const l = LOGROS.find(x => x.id === id);
            return l ? `🏅 ${l.emoji} ${l.nombre}` : '';
          }).filter(Boolean).join('\n') : null;

          const prog = progresoProximoNivel(p.pts);
          const campos = [
            { name: '🕐 Hora', value: hora, inline: true },
            { name: '📍 Ubicación', value: `${distancia} m del instituto (±${Math.round(precision)} m)`, inline: true },
            { name: '🔥 Racha', value: `${p.streak || 0} clases`, inline: true },
          ];
          if (prog) campos.push({ name: `Próximo nivel — faltan ${prog.faltan} pts`, value: `\`${barraProgreso(prog.pct)}\` ${prog.pct}%`, inline: false });
          if (logroMsg) campos.push({ name: '🏅 ¡Nuevo logro!', value: logroMsg, inline: false });

          await miembro.send({ embeds: [{
            title: `${getRol(p.pts).emoji} Presencia registrada`,
            color: colorRol(p.pts),
            description: `**${sesion.titulo}**\n+10 pts → **${p.pts} pts** totales`,
            fields: campos,
          }] }).catch(() => {});

          if (canalObj) await canalObj.send(`✅ **${nombreReal}** registró su presencia · 🕐 ${hora} · 📍 ${distancia} m`).catch(() => {});
          LOG.info(`Presencia GPS segura: ${nombreReal}, ${distancia}m, precisión ±${Math.round(precision)}m`);
        } catch (e) {
          LOG.error('La presencia se registró, pero falló una tarea posterior', e);
        }
      } catch (e) {
        LOG.error('Error procesando /presencia/verificar', e);
        if (!res.headersSent) responderJson(res, 400, { ok: false, error: 'Solicitud inválida.' });
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      processRunning: true,
      discordReady: botReady,
      time: ahoraAR()
    }));
    return;
  }

  // Readiness: indica si Discord ya está conectado, o si ya pasó el
  // margen de 2 minutos (para que Render nunca se quede esperando para siempre).
  if (req.method === 'GET' && req.url === '/ready') {
    const listo = estaListoOVencioElMargen();
    if (!botReady && listo) {
      LOG.warn('/ready devolvió 200 por vencimiento del margen — Discord todavía no confirmó conexión.');
    }
    res.writeHead(listo ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready: listo, discordConectado: botReady, time: ahoraAR() }));
    return;
  }

  // Página raíz: siempre responde 200 para que Render mantenga el servicio.
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(botReady
    ? `Mentor bot activo — ${ahoraAR()}`
    : `Mentor iniciando, todavía no está listo — ${ahoraAR()}`);
}).listen(PORT, () => LOG.info(`Keep-alive y endpoint GPS en puerto ${PORT}`));

// ════════════════════════════════════════════════════════════════
// PERSISTENCIA DE DATOS EN DISCO
// Sobrevive reinicios en Render (si tiene disco persistente)
// Sin disco, se recarga vacío al reiniciar — comportamiento esperado
// ════════════════════════════════════════════════════════════════
const DATA_FILE   = '/var/data/data.json'; // disco persistente Render
const puntos      = new Map(); // userId  → { nombre, pts, entregas, asistencias, preguntas }
const registros   = new Map(); // userId  → { nombreReal, dni, carrera, registradoEn }
const tareas      = new Map(); // id      → { titulo, descripcion, fecha, canal, completados: Set }
const eventos     = new Map(); // id      → { titulo, fecha, tipo, descripcion, avisados }
const rubricas    = new Map(); // clave   → { materia, actividad, criterios: [{nombre, descripcion, peso}] }
const historial   = new Map(); // userId  → [{ actividad, fecha, link, explicacion, evaluacion, pts }]
const cacheIA     = new Map(); // hash    → { respuesta, expira }
let tareaCounter  = 1;
let eventoCounter = 1;
let torneoActivo  = null; // { pregunta, opciones, correcta, respuestas: Map, cierra: timestamp }
const encuestas   = new Map(); // guildId → { pregunta, opciones, votos: Map, cierra, msgId, canal }

function cargarDatos() {
  try {
    if (!fs.existsSync(DATA_FILE)) { LOG.warn('data.json no encontrado, arrancando vacío.'); return; }
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (raw.puntos)  for (const [k, v] of Object.entries(raw.puntos))  puntos.set(k, v);
    if (raw.eventos) for (const [k, v] of Object.entries(raw.eventos)) eventos.set(parseInt(k), v);
    if (raw.tareas)  for (const [k, v] of Object.entries(raw.tareas))
      tareas.set(parseInt(k), { ...v, completados: new Set(v.completados || []) });
    if (raw.registros) for (const [k, v] of Object.entries(raw.registros)) registros.set(k, v);
    if (raw.historial)  for (const [k, v] of Object.entries(raw.historial))  historial.set(k, v);
    if (raw.rubricas)   for (const [k, v] of Object.entries(raw.rubricas))   rubricas.set(k, v);
    if (raw.tareaCounter)    tareaCounter    = raw.tareaCounter;
    if (raw.eventoCounter)   eventoCounter   = raw.eventoCounter;
    if (raw.clasesTotales)   for (const [k, v] of Object.entries(raw.clasesTotales)) clasesTotales.set(k, v);
    if (raw.notas)           for (const [k, v] of Object.entries(raw.notas))          notas.set(k, v);
    if (raw.anunciosActivos) for (const [k, v] of Object.entries(raw.anunciosActivos)) anunciosActivos.set(k, v);
    if (raw.anuncioCounter)  anuncioCounter = raw.anuncioCounter;
    if (raw.entregasPorActiv) for (const [k, v] of Object.entries(raw.entregasPorActiv)) entregasPorActiv.set(k, v);
    if (raw.sesionActiva) {
      for (const [gid, s] of Object.entries(raw.sesionActiva)) {
        // Cerrar sesiones que quedaron activas de días anteriores (fantasma)
        const esVieja = s.tokenTs && (Date.now() - s.tokenTs) > 4 * 60 * 60 * 1000;
        sesiones.set(gid, {
          activa:               esVieja ? false : (s.activa || false),
          asistentes:           new Map(Object.entries(s.asistentes || {})),
          fecha:                s.fecha || '',
          titulo:               s.titulo || 'Clase',
          preguntas:            s.preguntas || [],
          codigoClase:          s.codigoClase || '',
          tokenTs:              s.tokenTs || 0,
          canalId:              s.canalId || '',
          canalNombre:          s.canalNombre || '',
          presentesUltimaClase: s.presentesUltimaClase || [],
          fechaUltimaClase:     s.fechaUltimaClase || '',
        });
      }
      LOG.info('Sesiones restauradas desde disco.');
    }
    LOG.info(`Datos cargados: ${puntos.size} alumnos, ${tareas.size} tareas, ${eventos.size} eventos`);
  } catch (e) { LOG.error('Error cargando datos', e); }
}

// Debounce: agrupa escrituras para no golpear el disco en cada interacción
let _saveTimer = null;
function guardarDatos() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify({
        puntos:       Object.fromEntries(puntos),
        registros:    Object.fromEntries(registros),
        clasesTotales: Object.fromEntries(clasesTotales),
        notas:         Object.fromEntries(notas),
        anunciosActivos: Object.fromEntries(anunciosActivos),
        anuncioCounter: anuncioCounter,
        entregasPorActiv: Object.fromEntries(entregasPorActiv),
        sesionActiva:  Object.fromEntries([...sesiones.entries()].map(([gid, s]) => [gid, {
          activa:               s.activa,
          asistentes:           s.asistentes ? Object.fromEntries(s.asistentes) : {},
          fecha:                s.fecha || '',
          titulo:               s.titulo || '',
          preguntas:            s.preguntas || [],
          codigoClase:          s.codigoClase || '',
          tokenTs:              s.tokenTs || 0,
          presentesUltimaClase: s.presentesUltimaClase || [],
          fechaUltimaClase:     s.fechaUltimaClase || '',
        }])),
        historial:    Object.fromEntries(historial),
        rubricas:     Object.fromEntries(rubricas),
        eventos:      Object.fromEntries(eventos),
        tareas:       Object.fromEntries([...tareas.entries()].map(([k, v]) => [k, { ...v, completados: [...v.completados] }])),
        tareaCounter,
        eventoCounter,
      }, null, 2));
    } catch (e) { LOG.error('Error guardando datos', e); }
  }, 3000);
}

// ════════════════════════════════════════════════════════════════
// ESTADO EN MEMORIA (no persiste entre reinicios — es esperado)
// ════════════════════════════════════════════════════════════════
const sesiones          = new Map(); // guildId → { activa, asistentes, fecha, preguntas }
const clasesTotales     = new Map(); // guildId → número de clases dictadas
const notas             = new Map(); // userId → [{ materia, actividad, nota, fecha, guildId, observacion }]
const anunciosActivos   = new Map(); // id → { materia, mensaje, fechaLimite, guildId, recordatorioEnviado, destinatarios: [] }
let anuncioCounter      = 1;
const formularioActivo  = new Map(); // userId  → { paso, nombre, actividad, link, comentario, expira }
const cooldowns         = new Map(); // userId  → timestamp
const quizActivo        = new Map(); // userId  → { pregunta, opciones, correcta, explicacion, unidad, respondido }
const desafios          = new Map(); // id      → { enunciado, materia, soluciones }
const entregasPorActiv  = new Map(); // clave   → [{ nombre, userId, contenido, hora }]
let desafioActivo       = null;
let desafioCounter      = 1;
const HORARIOS_CLASE    = [{ dia: 2, hora: 8, min: 0 }, { dia: 4, hora: 8, min: 0 }];

// ════════════════════════════════════════════════════════════════
// HELPERS GENERALES
// ════════════════════════════════════════════════════════════════

/** Trunca texto al límite de Discord (2000 chars) */
function safe(texto, max = 1900) {
  if (!texto) return '—';
  return texto.length > max ? texto.substring(0, max) + '\n…*(respuesta truncada)*' : texto;
}

// Enviar respuesta larga dividida en varios mensajes de Discord (límite 2000)
async function enviarLargo(interaction, texto, encabezado = '') {
  const MAX = 1900;
  if (texto.length <= MAX) { await interaction.editReply(encabezado + texto); return; }
  const lineas = texto.split('\n');
  const bloques = [];
  let actual = '';
  for (const linea of lineas) {
    if ((actual + linea + '\n').length > MAX) { bloques.push(actual); actual = ''; }
    actual += linea + '\n';
  }
  if (actual) bloques.push(actual);
  // Primer bloque con editReply, el resto con followUp
  await interaction.editReply(encabezado + bloques[0]);
  for (let i = 1; i < bloques.length; i++) {
    await interaction.followUp(bloques[i]);
    await new Promise(r => setTimeout(r, 300));
  }
}

/** Verifica cooldown — retorna segundos restantes (0 = puede usar) */
function checkCooldown(userId) {
  const ahora = Date.now(), ultimo = cooldowns.get(userId) || 0;
  const resta = COOLDOWN_SEG * 1000 - (ahora - ultimo);
  if (resta > 0) return Math.ceil(resta / 1000);
  cooldowns.set(userId, ahora);
  return 0;
}

/** Devuelve o crea la sesión de clase de un servidor */
function getSesion(guildId) {
  if (!sesiones.has(guildId))
    sesiones.set(guildId, { activa: false, asistentes: new Map(), fecha: '', preguntas: [] });
  return sesiones.get(guildId);
}

/** Limpia formularios de entrega expirados */
function limpiarFormularios() {
  const ahora = Date.now();
  for (const [uid, f] of formularioActivo.entries())
    if (ahora > f.expira) { formularioActivo.delete(uid); }
}

/** Verifica si el usuario es el profesor */
function esProfesor(userId) { return !PROFESOR_ID || userId === PROFESOR_ID; }

// Comandos restringidos al profesor
const SOLO_PROFESOR = new Set([
  'iniciar-clase','cerrar-clase','noticias','evento','borrar-evento',
  'desafio','soluciones','cerrar-desafio','tarea','similitudes','backup','reporte','alumnos',
  'rubrica','generar-parcial','riesgo','torneo','qr-clase','encuesta','ver-codigo',
  'nota','notas-alumno','boletin-notas','anuncio','asignar-materia','exportar','cierre',
  'asistencia-general','ajustar-asistencia'
]);

// ════════════════════════════════════════════════════════════════
// DETECCIÓN DE MATERIA — CASCADA: canal → servidor → default
// ════════════════════════════════════════════════════════════════
function detectarMateria(guildId, channelName = '') {
  const c = channelName.toLowerCase();
  if (c.includes('pybd')  || c.includes('progbd')  || c.includes('prog-bd') || c.includes('pybases') || c.includes('consultas-pybd')) return 'pybd';
  if (c.includes('practica') || c.includes('pract') || c.includes('pp3'))                                                              return 'practica';
  if (c.includes('bd')    || c.includes('base')    || c.includes('datos'))                                                            return 'bd';
  if (c.includes('info')  || c.includes('informatica'))                                                                               return 'informatica';
  if (c.includes('iev')   || c.includes('internet') || c.includes('entornos'))                                                       return 'iev';
  if (c.includes('analisis') || c.includes('numeric') || c.includes('annum') || c.includes('ucse'))                                   return 'annum';
  const guild = client.guilds.cache.get(guildId);
  if (guild) {
    const s = guild.name.toLowerCase();
    if (s.includes('ucse')) return 'annum';
    if (s.includes('11')) return 'bd';
    if (s.includes('6'))  return 'iev';
  }
  return 'iev';
}

// ════════════════════════════════════════════════════════════════
// CONTEXTOS DE IA POR MATERIA
// ════════════════════════════════════════════════════════════════
const CONTEXTOS = {
  iev: `Sos el asistente de "Internet y Entornos Virtuales" del Profesorado en Informática del IES N°6.
Prof. Ing. Corimayo Ricardo Daniel. Respondé en español, claro y pedagógico.
Unidades: 1-Introducción a Internet (TCP/IP, HTTP, CMD), 2-Correo y netiqueta (SMTP/POP3/IMAP), 3-Criterio CRAAP, 4-Comunicación sincrónica/asincrónica, 5-Entornos virtuales Chamilo/Moodle.`,

  bd: `Sos el asistente de "Base de Datos" de la Tecnicatura en Desarrollo de Software del IES N°11.
Prof. Ing. Corimayo Ricardo Daniel. Respondé en español, claro y pedagógico.
Unidades: 1-Introducción SGBD (DDL/DML), 2-Modelo de datos, 3-Diseño E-R (entidades, relaciones, cardinalidad), 4-Modelo Relacional (claves, vistas), 5-Normalización (1FN-5FN, BCNF), 6-Álgebra Relacional, 7-SQL (DDL/DML completo).`,

  informatica: `Sos el asistente de "Informática" de la Tecnicatura en Desarrollo de Software del IES N°11, 1er año.
Prof. Ing. Corimayo Ricardo Daniel. Respondé en español, claro y pedagógico.
Unidades: 1-Introducción (HW, SW, SO), 2-Ofimática, 3-Redes y Computación Distribuida, 4-Computación Paralela, 5-Inteligencia Artificial (ML, redes neuronales, PLN).`,

  practica: `Sos el asistente de "Práctica Profesionalizante III" de la Tecnicatura en Ciencias de Datos e IA del IES N°6.
Prof. Ing. Corimayo Ricardo Daniel. Respondé con enfoque laboral y pedagógico.
Unidades: 1-Introducción profesional (ética, marcos legales), 2-Metodologías (SCRUM, Kanban, GitHub), 3-Proyecto de Ciencia de Datos (pandas, EDA, visualización), 4-Aplicación de IA (scikit-learn, métricas, despliegue), 5-Defensa del proyecto.
Usá Python, pandas, scikit-learn y matplotlib en los ejemplos.`,

  pybd: `Sos el asistente de "Programación y Base de Datos" del Profesorado de Informática, 2do año, IES N°6.
Prof. Ing. Corimayo Ricardo Daniel. Respondé en español, claro y pedagógico.
Unidades BD: 1-Introducción BD/SGBD, 2-Diseño E-R, 3-Modelo Relacional/Normalización, 4-SQL (DDL/DML/DCL/TCL/ACID).
Unidades Programación: 5-Java (tipos, POO, clases, colecciones), 6-Spring Boot y MVC (framework, controladores, Bootstrap, Thymeleaf), 7-Git y Maven (versionamiento, dependencias), 8-JPA y persistencia (CrudRepository, JpaRepository).
Usá Java y Spring Boot en los ejemplos de código.`,

  annum: `Sos el asistente de "Análisis Numérico" de Ingeniería en Informática (3° año), UCSE — Departamento Académico San Salvador. Cátedra a cargo del Ing. Víctor Marcial Aizama, JTP Prof. Ing. Corimayo Ricardo Daniel.
Respondé en español, claro y pedagógico.
Temas (12): 1-Preliminares matemáticos y computadoras personales, 2-La programación en PC, 3-Aproximaciones y errores (cifras significativas, error relativo/verdadero, redondeo, truncamiento, Serie de Taylor), 4-Raíces de ecuaciones (bisección, regla falsa, punto fijo, Newton-Raphson, secante), 5-Casos prácticos de raíces, 6-Sistemas de ecuaciones lineales (matrices, eliminación gaussiana), 7-Métodos para sistemas lineales (Gauss-Jordan, Gauss-Seidel, Gauss-Doolittle, Cholesky), 8-Casos prácticos de sistemas lineales, 9-Ajuste de curvas (regresión lineal, interpolación de Lagrange y Legendre), 10-Casos prácticos de ajuste de curvas, 11-Diferenciación e integración numérica (Richardson, Romberg), 12-Ecuaciones diferenciales ordinarias (Euler, Taylor de orden superior, Runge-Kutta).
Evaluación: regulariza con 2 parciales prácticos aprobados con 70% mínimo; examen final requiere 50%. Promociona con 70% de guías de TP resueltas y parciales aprobados.
Usá Python (numpy/scipy) u Octave/MATLAB en los ejemplos de código, según lo que pida el alumno.`,
};

function getContexto(guildId, ch) { return CONTEXTOS[detectarMateria(guildId, ch)] || CONTEXTOS.iev; }

// ════════════════════════════════════════════════════════════════
// CONTENIDO DE UNIDADES POR MATERIA
// ════════════════════════════════════════════════════════════════
const UNIDADES = {
  iev: {
    1: '🌐 **IEV U1: Introducción a Internet**\nTCP/IP, HTTP, HTTPS, FTP. CMD: ping, tracert, ipconfig, nslookup.',
    2: '📧 **IEV U2: Correo y Netiqueta**\nSMTP, POP3, IMAP. Netiqueta digital. CC vs CCO.',
    3: '🔍 **IEV U3: Búsqueda y Evaluación**\nCriterio CRAAP. Fake news. Probá: /craap [url]',
    4: '💬 **IEV U4: Comunicación**\nSincrónica vs Asincrónica. Discord, Meet, Zoom, Foros.',
    5: '🖥️ **IEV U5: Entornos Virtuales**\nChamilo y Moodle. Roles. Proyecto final: Aula virtual.',
  },
  bd: {
    1: '🗄️ **BD U1: Introducción y Arquitectura SGBD**\nConcepto BD/SGBD, abstracción (físico/conceptual/externo), DDL y DML.',
    2: '📊 **BD U2: Modelo de Datos**\nModelos conceptuales vs lógicos. Restricciones de integridad.',
    3: '🔗 **BD U3: Diseño E-R**\nEntidades, atributos, relaciones, cardinalidad, herencia.',
    4: '📋 **BD U4: Modelo Relacional**\nClaves primarias/foráneas, restricciones, vistas, consultas.',
    5: '📐 **BD U5: Normalización**\nDependencias funcionales. 1FN, 2FN, 3FN, BCNF, 4FN, 5FN.',
    6: '🔢 **BD U6: Álgebra y Cálculo Relacional**\nOperadores primitivos y derivados. Cálculo de tuplas y dominios.',
    7: '💻 **BD U7: SQL Completo**\nDDL: CREATE/ALTER/DROP. DML: SELECT/INSERT/UPDATE/DELETE. Vistas, subconsultas.',
  },
  informatica: {
    1: '💻 **Informática U1: Introducción**\nHardware, software, sistemas operativos. Evolución histórica.',
    2: '📝 **Informática U2: Ofimática**\nProcesadores de texto, hojas de cálculo, presentaciones.',
    3: '🌐 **Informática U3: Redes y Computación Distribuida**\nProtocolos, cliente/servidor, peer-to-peer, computación móvil.',
    4: '⚡ **Informática U4: Computación Paralela**\nProcesadores multinúcleo, paralelismo, concurrencia.',
    5: '🤖 **Informática U5: Inteligencia Artificial**\nMachine learning, redes neuronales, PLN. Tendencias.',
  },
  practica: {
    1: '🎯 **PP3 U1: Introducción Profesionalizante**\nRol profesional, ética en datos, marcos legales (GDPR), mercado laboral en IA.',
    2: '🔄 **PP3 U2: Metodologías de Trabajo**\nSCRUM, Kanban, sprints, backlogs. Trabajo colaborativo con GitHub.',
    3: '📊 **PP3 U3: Proyecto de Ciencia de Datos**\nDatasets, limpieza con pandas, EDA, visualización con matplotlib/seaborn.',
    4: '🤖 **PP3 U4: Aplicación de IA**\nModelos ML con scikit-learn. Métricas (accuracy, F1, ROC). Despliegue con Flask/Streamlit.',
    5: '🎓 **PP3 U5: Presentación y Defensa**\nDocumentación técnica, README en GitHub, exposición oral, portfolio profesional.',
  },
  pybd: {
    1: '🗄️ **PyBD U1: Introducción a BD**\nConcepto BD/SGBD, modelos de datos, tipos de usuarios, DDL/DML, arquitectura.',
    2: '🔗 **PyBD U2: Diseño Conceptual — Modelo E-R**\nCaracterísticas de datos, entidades, atributos, relaciones, clave primaria, cardinalidad.',
    3: '📋 **PyBD U3: Modelo Relacional — Modelo Lógico**\nEstructura relacional, reglas de integridad, normalización, vistas, procedimientos almacenados.',
    4: '💻 **PyBD U4: SQL — Modelo Físico**\nDML/DDL/DCL/TCL. SELECT, INSERT, UPDATE, DELETE. Transacciones y propiedades ACID.',
    5: '☕ **PyBD U5: Lenguaje Java**\nTipos de datos, POO, clases, objetos, Strings, Arreglos, Colecciones.',
    6: '🌱 **PyBD U6: Spring Boot y MVC**\nFramework Spring, controladores, RequestMapping, Thymeleaf, Bootstrap.',
    7: '🐙 **PyBD U7: Git y Maven**\nControl de versiones, integración con IDE, gestión de dependencias, arquetipos.',
    8: '🔌 **PyBD U8: Clases y Persistencia con JPA**\nInyección de dependencias, JPA/Spring Boot, CrudRepository, JpaRepository, Query Methods.',
  },
  annum: {
    1: '💻 **Análisis Numérico Tema 1: Preliminares Matemáticos y las Computadoras Personales**\nEl uso del análisis numérico antes de la computadora. Los métodos numéricos y la práctica de la ingeniería. Fundamentos matemáticos. Alcance, contenido, metas y objetivos.',
    2: '🖥️ **Análisis Numérico Tema 2: La Programación en PC**\nAntecedentes históricos. Desarrollo de programas y diseño de algoritmos. Comparación de lenguajes. Almacenamiento y mantenimiento. Estrategias de programación.',
    3: '📏 **Análisis Numérico Tema 3: Aproximaciones y Errores**\nCifras significativas, exactitud y precisión. Error relativo y verdadero. Estimación de error en métodos iterativos. Errores de redondeo y truncamiento. Serie de Taylor y análisis del residuo. Error numérico total.',
    4: '🎯 **Análisis Numérico Tema 4: Raíces de Ecuaciones**\nMétodos gráficos que usan intervalos. Bisección (criterios de paro, estimación de errores) y Regla Falsa. Métodos abiertos: Punto Fijo, Newton-Raphson, Secante, raíces múltiples. Comparación entre métodos.',
    5: '🧩 **Análisis Numérico Tema 5: Casos Prácticos a Raíces de Ecuaciones**\nDiscusión y análisis de casos reales que requieren resolución numérica de raíces.',
    6: '🔢 **Análisis Numérico Tema 6: Sistemas de Ecuaciones Algebraicas Lineales**\nRepresentación con matrices. Método gráfico y eliminación gaussiana. Sistemas mal condicionados. Técnicas de mejoramiento y corrección de errores.',
    7: '📐 **Análisis Numérico Tema 7: Métodos para Resolución de Sistemas de Ecuaciones Lineales**\nGauss-Jordan, Gauss-Seidel, Gauss-Doolittle, inversión de matrices, Cholesky. Mejoramiento iterativo, convergencia y error de redondeo.',
    8: '🧩 **Análisis Numérico Tema 8: Casos Prácticos a Sistemas de Ecuaciones Lineales**\nResolución de problemas prácticos con distintos algoritmos, comparando ventajas y desventajas.',
    9: '📈 **Análisis Numérico Tema 9: Ajuste de Curvas**\nRegresión lineal y sus implicancias estadísticas. Interpolación: diferencias divididas, polinomios de Lagrange y Legendre.',
    10:'🧩 **Análisis Numérico Tema 10: Casos Prácticos de Ajuste de Curvas**\nResolución de problemas de regresión e interpolación, con justificación estadística del modelo elegido.',
    11:'∫ **Análisis Numérico Tema 11: Diferenciación e Integración Numérica**\nDiferenciación numérica. Extrapolación de Richardson. Integración de Romberg. Aplicaciones especiales.',
    12:'🌀 **Análisis Numérico Tema 12: Ecuaciones Diferenciales Ordinarias**\nProblemas de valor inicial. Método de Euler, Método de Taylor de orden superior, Método de Runge-Kutta. Ecuaciones de orden superior.',
  },
};

function getUnidades(gid, ch) { return UNIDADES[detectarMateria(gid, ch)] || UNIDADES.iev; }

// ════════════════════════════════════════════════════════════════
// HERRAMIENTAS CONTEXTUALES POR MATERIA
// ════════════════════════════════════════════════════════════════
const HERRAMIENTAS = {
  iev:        '🛠️ **Herramientas IEV:**\n📘 Chamilo → aulasvirtuales.name/chamilo\n📗 Moodle IES6 → ies6.aulasvirtuales.name\n🔍 /craap [url] para evaluar fuentes',
  bd:         '🛠️ **Herramientas Base de Datos:**\n📗 Moodle IES11 → ies11.aulasvirtuales.name\n🐘 DB Fiddle → dbfiddle.uk\n📊 Diagramas E-R → diagrams.net\n🐙 GitHub → github.com',
  informatica:'🛠️ **Herramientas Informática:**\n📗 Moodle IES11 → ies11.aulasvirtuales.name\n📂 Google Drive → drive.google.com\n🎨 Google Slides → slides.google.com\n🐙 GitHub → github.com',
  practica:   '🛠️ **Herramientas PP3 — Ciencias de Datos:**\n📗 Moodle IES6 → ies6.aulasvirtuales.name\n🐍 Google Colab → colab.research.google.com\n📊 Kaggle → kaggle.com\n🤗 HuggingFace → huggingface.co\n🐙 GitHub → github.com\n📋 Trello → trello.com',
  pybd:       '🛠️ **Herramientas PyBD — Programación y BD:**\n📗 Moodle IES6 → ies6.aulasvirtuales.name\n🐘 DB Fiddle → dbfiddle.uk\n📊 draw.io → diagrams.net\n☕ IntelliJ IDEA → jetbrains.com/idea\n🌱 Spring Initializr → start.spring.io\n📦 Maven Repo → mvnrepository.com\n🐙 GitHub → github.com',
  annum:      '🛠️ **Herramientas Análisis Numérico — UCSE:**\n🎓 Campus Virtual UCSE → elearning.ucse.edu.ar\n🐍 Python (numpy/scipy) → colab.research.google.com\n📐 Octave (gratuito, tipo MATLAB) → octave.org\n📊 GeoGebra → geogebra.org',
};

// ════════════════════════════════════════════════════════════════
// SISTEMA DE PUNTOS Y ROLES
// ════════════════════════════════════════════════════════════════
function darPuntos(userId, nombre, tipo) {
  if (!puntos.has(userId)) puntos.set(userId, { nombre, pts: 0, entregas: 0, asistencias: 0, preguntas: 0, streak: 0, ultimaClase: '', logros: [] });
  const p = puntos.get(userId);
  p.nombre = nombre;
  if (!p.logros)      p.logros  = [];
  if (!p.streak)      p.streak  = 0;
  if (!p.ultimaClase) p.ultimaClase = '';
  const delta = { asistencia: 10, entrega: 20, pregunta: 5, quiz: 15, desafio: 40 }[tipo] || 0;
  p.pts += delta;
  if (tipo === 'asistencia') {
    p.asistencias++;
    const hoy = fechaAR();
    // Streak: si la última clase fue ayer o hoy (en la misma clase) mantiene racha
    if (p.ultimaClase !== hoy) { p.streak = (p.streak||0) + 1; p.ultimaClase = hoy; }
  }
  if (tipo === 'entrega')  p.entregas++;
  if (tipo === 'pregunta') p.preguntas++;
  puntos.set(userId, p);
  guardarDatos();
  return p;
}

function getRankingCompleto() { return [...puntos.entries()].sort((a, b) => b[1].pts - a[1].pts); }
function getRanking()          { return getRankingCompleto().slice(0, 10); }
function getPosicion(uid)      { const i = getRankingCompleto().findIndex(([id]) => id === uid); return i === -1 ? '—' : i + 1; }
function notaConceptual(n) {
  if (n >= 9)  return 'Sobresaliente';
  if (n >= 8)  return 'Muy bueno';
  if (n >= 7)  return 'Bueno';
  if (n >= 6)  return 'Satisfactorio';
  if (n >= 4)  return 'Regular';
  return 'Insuficiente';
}
function notaEmoji(n) {
  if (n >= 8) return '🟢';
  if (n >= 6) return '🟡';
  return '🔴';
}

function getRol(pts) {
  if (pts >= 200) return { nombre: 'Experto Digital',    emoji: '🏆' };
  if (pts >= 100) return { nombre: 'Colaborador Activo', emoji: '⭐' };
  if (pts >= 50)  return { nombre: 'Aprendiz',           emoji: '📚' };
  return              { nombre: 'Novato',              emoji: '🌱' };
}

/** Color decimal para embeds, según el rol actual del alumno */
function colorRol(pts) {
  if (pts >= 200) return 0xFFD700; // dorado — Experto Digital
  if (pts >= 100) return 0xC0C0C0; // plateado — Colaborador Activo
  if (pts >= 50)  return 0x4FC3F7; // celeste — Aprendiz
  return              0x90A4AE; // gris — Novato
}

/** Barra de progreso visual tipo ████░░░░ para porcentajes */
function barraProgreso(pct, largo = 14) {
  const llenos = Math.max(0, Math.min(largo, Math.round((pct / 100) * largo)));
  return '█'.repeat(llenos) + '░'.repeat(largo - llenos);
}

/** Detecta el nivel de evaluación de la IA en el texto de corrección, para colorear el embed */
function colorEvaluacion(texto) {
  const t = (texto || '').toLowerCase();
  if (t.includes('excelente'))    return { color: 0xFFD700, emoji: '🌟', nivel: 'Excelente' };
  if (t.includes('muy bueno'))    return { color: 0x4CAF50, emoji: '🟢', nivel: 'Muy bueno' };
  if (t.includes('bueno'))        return { color: 0x8BC34A, emoji: '🟢', nivel: 'Bueno' };
  if (t.includes('regular'))      return { color: 0xFFC107, emoji: '🟡', nivel: 'Regular' };
  if (t.includes('insuficiente')) return { color: 0xF44336, emoji: '🔴', nivel: 'Insuficiente' };
  return { color: 0x4FC3F7, emoji: '🤖', nivel: null };
}

/** Progreso hacia el próximo nivel — null si ya está en el máximo */
function progresoProximoNivel(pts) {
  const umbrales = [0, 50, 100, 200];
  if (pts >= 200) return null;
  let actual = 0, siguiente = 50;
  for (const u of umbrales) { if (pts >= u) actual = u; else { siguiente = u; break; } }
  const pct = Math.round(((pts - actual) / (siguiente - actual)) * 100);
  return { pct, faltan: siguiente - pts };
}

// ════════════════════════════════════════════════════════════════
// TARJETA DE RANGO — imagen generada con avatar, rol y progreso
// ════════════════════════════════════════════════════════════════
async function generarTarjetaRango(member, nombreMostrar, p, pos, tot) {
  if (!canvasLib) return null;
  const { createCanvas, loadImage } = canvasLib;
  const rol      = getRol(p.pts);
  const colorHex = '#' + colorRol(p.pts).toString(16).padStart(6, '0');
  const prog     = progresoProximoNivel(p.pts);

  const W = 900, H = 300;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // Fondo degradé
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#0b1220');
  grad.addColorStop(1, '#0d2440');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Franja de color según el rol, a la izquierda
  ctx.fillStyle = colorHex;
  ctx.fillRect(0, 0, 10, H);

  // Avatar circular con borde del color del rol
  const cx = 150, cy = 150, r = 90;
  try {
    const avatarUrl = member.displayAvatarURL({ extension: 'png', size: 256 });
    const res = await fetch(avatarUrl);
    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());
      const img = await loadImage(buffer);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
      ctx.restore();
    }
  } catch {} // sin avatar, sigue con el fondo nomás
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = colorHex;
  ctx.stroke();

  // Nombre
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 42px sans-serif';
  ctx.fillText(nombreMostrar.substring(0, 22), 290, 95);

  // Rol y posición
  ctx.font = '28px sans-serif';
  ctx.fillStyle = colorHex;
  ctx.fillText(`${rol.nombre} · #${pos} de ${tot}`, 290, 138);

  // Puntos y racha
  ctx.font = '22px sans-serif';
  ctx.fillStyle = '#c7d3e0';
  ctx.fillText(`${p.pts} pts totales · racha ${p.streak || 0} clases`, 290, 172);

  // Barra de progreso
  const barX = 290, barY = 200, barW = 540, barH = 30;
  ctx.fillStyle = '#1c2b3f';
  ctx.fillRect(barX, barY, barW, barH);
  if (prog) {
    ctx.fillStyle = colorHex;
    ctx.fillRect(barX, barY, barW * (prog.pct / 100), barH);
  } else {
    ctx.fillStyle = colorHex;
    ctx.fillRect(barX, barY, barW, barH);
  }
  ctx.strokeStyle = '#ffffff33';
  ctx.strokeRect(barX, barY, barW, barH);

  ctx.font = '20px sans-serif';
  ctx.fillStyle = '#c7d3e0';
  ctx.fillText(prog ? `Faltan ${prog.faltan} pts para el próximo nivel` : 'Nivel máximo alcanzado', barX, barY + barH + 30);

  return canvas.toBuffer('image/png');
}

// ════════════════════════════════════════════════════════════════
// GRÁFICO DE BOLETÍN — barras horizontales coloreadas por promedio
// ════════════════════════════════════════════════════════════════
function generarGraficoBoletin(alumnos, titulo) {
  if (!canvasLib) return null;
  const { createCanvas } = canvasLib;
  const ordenados = [...alumnos].sort((a, b) => b.promedio - a.promedio);

  const W = 900;
  const filaAlto = 44;
  const H = 110 + ordenados.length * filaAlto;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 30px sans-serif';
  ctx.fillText(titulo, 30, 50);
  ctx.font = '18px sans-serif';
  ctx.fillStyle = '#8fa3bd';
  ctx.fillText(`${ordenados.length} alumno${ordenados.length !== 1 ? 's' : ''}`, 30, 78);

  const labelW = 220, barX = 250, barMaxW = 560, barH = 26;
  let y = 110;
  for (const al of ordenados) {
    const color = al.promedio >= 8 ? '#4CAF50' : al.promedio >= 6 ? '#FFC107' : '#F44336';
    ctx.fillStyle = '#ffffff';
    ctx.font = '20px sans-serif';
    ctx.fillText(al.nombre.substring(0, 24), 30, y + barH - 6, labelW);

    ctx.fillStyle = '#1c2b3f';
    ctx.fillRect(barX, y, barMaxW, barH);
    ctx.fillStyle = color;
    ctx.fillRect(barX, y, barMaxW * (al.promedio / 10), barH);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(al.promedio.toFixed(1), barX + barMaxW + 15, y + barH - 6);

    y += filaAlto;
  }

  return canvas.toBuffer('image/png');
}

// ════════════════════════════════════════════════════════════════
// GRÁFICO DE ASISTENCIA — barras horizontales por % (80/60 de corte)
// ════════════════════════════════════════════════════════════════
function generarGraficoAsistencia(alumnos, titulo) {
  if (!canvasLib) return null;
  const { createCanvas } = canvasLib;
  const ordenados = [...alumnos].sort((a, b) => b.pct - a.pct);

  const W = 900;
  const filaAlto = 44;
  const H = 110 + ordenados.length * filaAlto;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 30px sans-serif';
  ctx.fillText(titulo, 30, 50);
  ctx.font = '18px sans-serif';
  ctx.fillStyle = '#8fa3bd';
  ctx.fillText(`${ordenados.length} alumno${ordenados.length !== 1 ? 's' : ''}`, 30, 78);

  const barX = 250, barMaxW = 560, barH = 26;
  let y = 110;
  for (const al of ordenados) {
    const color = al.pct >= 80 ? '#4CAF50' : al.pct >= 60 ? '#FFC107' : '#F44336';
    ctx.fillStyle = '#ffffff';
    ctx.font = '20px sans-serif';
    ctx.fillText(al.nombre.substring(0, 24), 30, y + barH - 6);

    ctx.fillStyle = '#1c2b3f';
    ctx.fillRect(barX, y, barMaxW, barH);
    ctx.fillStyle = color;
    ctx.fillRect(barX, y, barMaxW * (al.pct / 100), barH);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(`${al.pct}%`, barX + barMaxW + 15, y + barH - 6);

    y += filaAlto;
  }

  return canvas.toBuffer('image/png');
}

const ROLES_DISCORD = [
  { nombre: 'Experto Digital',    minPts: 200, color: '#FFD700' },
  { nombre: 'Colaborador Activo', minPts: 100, color: '#C0C0C0' },
  { nombre: 'Aprendiz',           minPts: 50,  color: '#4FC3F7' },
  { nombre: 'Novato',             minPts: 0,   color: '#90A4AE' },
];

async function actualizarRol(member, pts, channel = null) {
  // Verificar permisos antes de intentar — evita el error 50013 en logs
  try {
    const g    = member.guild;
    const me   = g.members.cache.get(client.user.id);
    if (!me || !me.permissions.has('ManageRoles')) return; // sin permisos, salir silenciosamente
    for (const rd of ROLES_DISCORD) {
      if (!g.roles.cache.find(r => r.name === rd.nombre)) {
        try { await g.roles.create({ name: rd.nombre, color: rd.color, reason: 'Mentor' }); }
        catch {} // ignorar si falla la creación
      }
    }
    // Detectar el rol que tenía ANTES de tocar nada (para saber si subió de nivel)
    const rolAntes = ROLES_DISCORD.find(rd => {
      const r = g.roles.cache.find(r => r.name === rd.nombre);
      return r && member.roles.cache.has(r.id);
    });
    for (const rd of ROLES_DISCORD) {
      const r = g.roles.cache.find(r => r.name === rd.nombre);
      if (r && member.roles.cache.has(r.id)) { try { await member.roles.remove(r); } catch {} }
    }
    const rd = ROLES_DISCORD.find(r => pts >= r.minPts);
    if (rd) {
      const r = g.roles.cache.find(r => r.name === rd.nombre);
      if (r) { try { await member.roles.add(r); } catch {} }
    }
    // Si subió de nivel (no bajó) y tenemos un canal donde avisar, festejamos
    if (channel && rd && (!rolAntes || rd.minPts > rolAntes.minPts)) {
      const nombreEmoji = getRol(pts).emoji;
      try {
        const mensaje = {
          embeds: [{
            color: colorRol(pts),
            description: `🎉 **${member.displayName}** subió de nivel — ahora es **${nombreEmoji} ${rd.nombre}**`,
          }]
        };
        // Adjuntamos la tarjeta visual si la generación de imágenes está disponible
        if (canvasLib) {
          try {
            const pData = puntos.get(member.id);
            if (pData) {
              const pos = getPosicion(member.id);
              const tot = getRankingCompleto().length;
              const nombreMostrar = getNombreReal(member.id, member.displayName);
              const buffer = await generarTarjetaRango(member, nombreMostrar, pData, pos, tot);
              if (buffer) mensaje.files = [new AttachmentBuilder(buffer, { name: 'tarjeta.png' })];
            }
          } catch {} // si falla la imagen, igual mandamos el aviso de texto
        }
        await channel.send(mensaje);
      } catch {}
    }
  } catch {} // silenciar completamente
}

// ════════════════════════════════════════════════════════════════
// DETECCIÓN DE SIMILITUD EN ENTREGAS (anti-plagio)
// ════════════════════════════════════════════════════════════════
function similitudJaccard(t1, t2) {
  const words = t => new Set(t.toLowerCase().replace(/[^a-záéíóúñ0-9\s]/gi,'').split(/\s+/).filter(w => w.length > 3));
  const s1 = words(t1), s2 = words(t2);
  if (!s1.size || !s2.size) return 0;
  const inter = [...s1].filter(w => s2.has(w)).length;
  return Math.round(inter / new Set([...s1,...s2]).size * 100);
}

async function analizarPlagioIA(actividad, n1, c1, n2, c2, sim) {
  try {
    const r = await llamarIA({
      model: 'claude-sonnet-4-6', max_tokens: 350,
      messages: [{ role: 'user', content:
        `Analizá si hay copia entre estas entregas de "${actividad}".\n${n1}: ${c1.substring(0,600)}\n${n2}: ${c2.substring(0,600)}\nJSON: {"similitud_real":0-100,"veredicto":"Copia evidente|Muy similar|Colaboración|Coincidencia","detalle":"1 oración"}`
      }]
    });
    return JSON.parse(r.content[0].text.replace(/```json|```/g,'').trim());
  } catch { return { similitud_real: sim, veredicto: 'Muy similar', detalle: 'Análisis por palabras clave.' }; }
}

async function avisarPlagio(guild, actividad, n1, n2, sim, analisis) {
  if (!PROFESOR_ID) return;
  try {
    const prof  = await guild.client.users.fetch(PROFESOR_ID);
    const nivel = sim >= 90 ? '🔴 COPIA MUY PROBABLE' : sim >= 75 ? '🟠 SIMILITUD ALTA' : '🟡 SIMILITUD MODERADA';
    await prof.send(`⚠️ **Alerta anti-plagio**\n\n${nivel}\n📚 **${actividad}**\n👤 ${n1} y ${n2}\n📊 Similitud: ${sim}%\n🤖 ${analisis.veredicto}: ${analisis.detalle}`);
  } catch (e) { LOG.error('Error enviando alerta plagio', e); }
}

async function compararEntregas(guild, actividad, nombreNuevo, uidNuevo, contenido) {
  const key = actividad.toLowerCase().trim();
  if (!entregasPorActiv.has(key)) entregasPorActiv.set(key, []);
  const lista = entregasPorActiv.get(key);
  for (const prev of lista) {
    if (prev.userId === uidNuevo) continue;
    const sim = similitudJaccard(contenido, prev.contenido);
    if (sim >= 50) {
      const a = await analizarPlagioIA(actividad, nombreNuevo, contenido, prev.nombre, prev.contenido, sim);
      if (a.similitud_real >= 70) await avisarPlagio(guild, actividad, nombreNuevo, prev.nombre, a.similitud_real, a);
    }
  }
  lista.push({ nombre: nombreNuevo, userId: uidNuevo, contenido, hora: horaAR() });
  guardarDatos();
}

// ════════════════════════════════════════════════════════════════
// CLIENTE DISCORD Y ANTHROPIC
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
// AGENTE HTTP PERSONALIZADO — evita el bug conocido de undici donde
// conexiones reutilizadas ("keep-alive") quedan muertas en el pool
// sin que nadie se entere, y el próximo pedido se cuelga esperando
// respuesta de una conexión que ya no existe del otro lado.
// Bajando el keepAliveTimeout, las conexiones se descartan mucho más
// rápido en vez de quedar "colgadas" horas en el pool.
// ════════════════════════════════════════════════════════════════
let discordRestAgent;
try {
  const { Agent } = require('undici');
  discordRestAgent = new Agent({ keepAliveTimeout: 1000, keepAliveMaxTimeout: 2000 });
  LOG.info('Agente HTTP personalizado configurado (keepAlive corto).');
} catch (e) {
  LOG.warn('No se pudo configurar el agente HTTP personalizado, se usa el default de discord.js.');
}

const client    = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
  ...(discordRestAgent ? { rest: { agent: discordRestAgent } } : {}),
});
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ════════════════════════════════════════════════════════════════
// GOOGLE SHEETS
// ════════════════════════════════════════════════════════════════
async function getSheets() {
  const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDENTIALS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

// ════════════════════════════════════════════════════════════════
// REGISTRO DE ALUMNOS — nombre real
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
// DEFINICIÓN DE LOGROS
// ════════════════════════════════════════════════════════════════
const LOGROS = [
  { id: 'primera_clase',    emoji: '🎉', nombre: 'Primera clase',       desc: 'Asististe a tu primera clase',              pts: 5  },
  { id: 'streak_5',         emoji: '🔥', nombre: 'Racha de 5',          desc: '5 clases consecutivas sin faltar',          pts: 15 },
  { id: 'streak_10',        emoji: '⚡', nombre: 'Racha de 10',         desc: '10 clases consecutivas sin faltar',         pts: 30 },
  { id: 'primera_entrega',  emoji: '📤', nombre: 'Primera entrega',     desc: 'Entregaste tu primer trabajo',              pts: 10 },
  { id: 'cinco_entregas',   emoji: '📚', nombre: 'Entregador',          desc: '5 trabajos entregados',                    pts: 20 },
  { id: 'quiz_master',      emoji: '🧠', nombre: 'Quiz Master',         desc: '3 quizzes correctos seguidos',              pts: 25 },
  { id: 'curioso',          emoji: '🔍', nombre: 'Curioso',             desc: '10 preguntas a la IA',                     pts: 10 },
  { id: 'puntual',          emoji: '⏰', nombre: 'Puntual',             desc: 'Llegaste en los primeros 5 min 3 veces',   pts: 15 },
  { id: 'registrado',       emoji: '✅', nombre: 'Identificado',        desc: 'Te registraste con tu nombre real',         pts: 5  },
  { id: 'desafiante',       emoji: '🏆', nombre: 'Desafiante',          desc: 'Resolviste tu primer desafio semanal',      pts: 20 },
];

function verificarLogros(userId, nombre, puntoData, canal) {
  const logrosUsuario = puntoData.logros || [];
  const nuevos = [];
  const p = puntoData;

  const check = (id) => !logrosUsuario.includes(id);
  if (check('primera_clase')   && p.asistencias >= 1)  nuevos.push('primera_clase');
  if (check('streak_5')        && (p.streak||0) >= 5)  nuevos.push('streak_5');
  if (check('streak_10')       && (p.streak||0) >= 10) nuevos.push('streak_10');
  if (check('primera_entrega') && p.entregas >= 1)     nuevos.push('primera_entrega');
  if (check('cinco_entregas')  && p.entregas >= 5)     nuevos.push('cinco_entregas');
  if (check('curioso')         && p.preguntas >= 10)   nuevos.push('curioso');
  if (check('registrado')      && registros.has(userId)) nuevos.push('registrado');

  if (nuevos.length) {
    puntoData.logros = [...logrosUsuario, ...nuevos];
    nuevos.forEach(id => {
      const logro = LOGROS.find(l => l.id === id);
      if (logro) { puntoData.pts += logro.pts; }
    });
    puntos.set(userId, puntoData);
    guardarDatos();
  }
  return nuevos;
}

// ════════════════════════════════════════════════════════════════
// CACHÉ DE RESPUESTAS DE IA (24 horas)
// ════════════════════════════════════════════════════════════════
const CACHE_TTL = 24 * 60 * 60 * 1000;
function hashPregunta(texto) {
  let h = 0;
  for (let i = 0; i < Math.min(texto.length, 100); i++) h = (h * 31 + texto.charCodeAt(i)) & 0xffffffff;
  return h.toString(36);
}
function getCache(texto) {
  const k = hashPregunta(texto.toLowerCase().trim());
  const v = cacheIA.get(k);
  if (v && Date.now() < v.expira) return v.respuesta;
  if (v) cacheIA.delete(k);
  return null;
}
function setCache(texto, respuesta) {
  cacheIA.set(hashPregunta(texto.toLowerCase().trim()), { respuesta, expira: Date.now() + CACHE_TTL });
}

// ════════════════════════════════════════════════════════════════
// COLA DE MENSAJES PARA IA (máx 3 simultáneos)
// ════════════════════════════════════════════════════════════════
let iaActivas = 0;
const IA_MAX  = 3;
async function llamarIA(params) {
  while (iaActivas >= IA_MAX) await new Promise(r => setTimeout(r, 500));
  iaActivas++;
  try {
    // Reintentar hasta 3 veces si hay error de red (Premature close, 404/529 temporal)
    for (let intento = 1; intento <= 3; intento++) {
      try {
        return await anthropic.messages.create(params);
      } catch (e) {
        const recuperable = e.status === 404 || e.status === 429 || e.status === 500 || e.status === 502 || e.status === 503 || e.status === 529 || (e.message && e.message.includes('Premature close'));
        if (intento < 3 && recuperable) {
          LOG.warn(`API falló (intento ${intento}/3), reintentando...`);
          await new Promise(r => setTimeout(r, 1500 * intento));
          continue;
        }
        throw e;
      }
    }
  } finally { iaActivas--; }
}

// ════════════════════════════════════════════════════════════════
// LOGGING DE ERRORES A GOOGLE SHEETS
// ════════════════════════════════════════════════════════════════
async function logErrorSheets(comando, error, guild) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'Errores!A:E', valueInputOption: 'USER_ENTERED',
      resource: { values: [[ahoraAR(), guild||'—', comando||'—', (error?.message||String(error)).substring(0,200), error?.stack?.split('\n')[1]||'']] }
    });
  } catch {} // no recursión si falla el logging
}

function getNombreReal(userId, fallback) {
  const reg = registros.get(userId);
  return reg ? reg.nombreReal : fallback;
}

async function actualizarNombreSheets(nombreViejo, nombreNuevo, fecha) {
  // Reemplaza el nombre en las filas de asistencia de HOY (columna C)
  try {
    const sheets = await getSheets();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Asistencia!A:F' });
    const filas = resp.data.values || [];
    const updates = [];
    for (let i = 0; i < filas.length; i++) {
      // fila: [fecha, hora, nombre, estado, materia, servidor]
      if (filas[i][0] === fecha && filas[i][2] === nombreViejo) {
        updates.push({ range: `Asistencia!C${i+1}`, values: [[nombreNuevo]] });
      }
    }
    if (updates.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { valueInputOption: 'USER_ENTERED', data: updates }
      });
    }
    return updates.length;
  } catch (e) { LOG.error('Error actualizando nombre en Sheets', e); return 0; }
}

async function guardarAsistencia(nombre, fecha, hora, materia, servidor) {
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const sheets = await getSheets();
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Asistencia!A:F', valueInputOption: 'USER_ENTERED',
        resource: { values: [[fecha, hora, nombre, 'Presente', materia || '', servidor || '']] }
      });
      return true; // éxito
    } catch (e) {
      LOG.error(`Error guardando asistencia en Sheets (intento ${intento}/3)`, e);
      if (intento < 3) await new Promise(r => setTimeout(r, 1000 * intento));
    }
  }
  return false; // falló las 3 veces — pero la asistencia ya está en memoria (sesion.asistentes)
}

async function guardarNotaSheets(nombreAlumno, materia, actividad, nota, observacion, servidor) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'Notas!A:G', valueInputOption: 'USER_ENTERED',
      resource: { values: [[fechaAR(), nombreAlumno, materia||'', actividad, nota, observacion||'', servidor||'']] }
    });
  } catch (e) { LOG.error('Error guardando nota en Sheets', e); }
}

async function backupPuntos() {
  try {
    const sheets = await getSheets();
    const filas  = [...puntos.entries()].map(([id, p]) => [id, p.nombre, p.pts, p.asistencias, p.entregas, p.preguntas, fechaAR()]);
    await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: 'Puntos!A:G' });
    if (filas.length)
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID, range: 'Puntos!A1', valueInputOption: 'USER_ENTERED',
        resource: { values: [['userId','Nombre','Puntos','Asistencias','Entregas','Preguntas','Actualizado'], ...filas] }
      });
    LOG.info(`Backup Sheets completado: ${filas.length} alumnos`);
  } catch (e) { LOG.error('Error en backup Sheets', e); }
}

// ════════════════════════════════════════════════════════════════
// MOODLE API
// ════════════════════════════════════════════════════════════════
async function moodleAPI(url, token, func, params = {}) {
  try {
    const qs = new URLSearchParams({ wstoken: token, wsfunction: func, moodlewsrestformat: 'json', ...params });
    const r  = await fetch(`${url}/webservice/rest/server.php?${qs}`);
    const d  = await r.json();
    return (d && d.exception) ? { _error: d.message } : d;
  } catch { return null; }
}

function getMC(guildName) {
  const es11 = guildName?.toLowerCase().includes('11');
  return { url: es11 ? MOODLE_URL_IES11 : MOODLE_URL_IES6, token: es11 ? MOODLE_TOKEN_IES11 : MOODLE_TOKEN_IES6, nombre: es11 ? 'IES N°11' : 'IES N°6' };
}

const getCursos       = (u, t)          => moodleAPI(u, t, 'core_course_get_courses');
const getActividadesMoodle = (u, t, id) => moodleAPI(u, t, 'core_course_get_contents', { courseid: id });
const getUserByName   = async (u, t, n) => { const d = await moodleAPI(u, t, 'core_user_get_users', { 'criteria[0][key]': 'fullname', 'criteria[0][value]': n }); return d?.users?.[0] || null; };
const getNotas        = (u, t, uid, cid)=> moodleAPI(u, t, 'gradereport_user_get_grade_items', { userid: uid, courseid: cid });

// ════════════════════════════════════════════════════════════════
// CALENDARIO
// ════════════════════════════════════════════════════════════════
function parseFecha(str) {
  if (!str) return null;
  const p = str.split('/');
  if (p.length !== 3) return null;
  const d = new Date(+p[2], +p[1]-1, +p[0]);
  return isNaN(d) ? null : d;
}
function diasHasta(f) {
  const h = new Date(); h.setHours(0,0,0,0); f.setHours(0,0,0,0);
  return Math.round((f-h)/86400000);
}
const emojiTipo = t => ({ parcial:'📝', entrega:'📤', proyecto:'🎓', clase:'📚', recuperatorio:'🔄' }[t] || '📅');
function fmtEventos(lista) {
  if (!lista.length) return 'No hay eventos.';
  return lista.map(([id, ev]) => {
    const d = diasHasta(parseFecha(ev.fecha));
    const e = d < 0 ? '✅ Pasado' : d === 0 ? '🔴 HOY' : d === 1 ? '🟠 Mañana' : d <= 3 ? `🟡 En ${d} días` : `🟢 En ${d} días`;
    return `${emojiTipo(ev.tipo)} **#${id} — ${ev.titulo}**\n📅 ${ev.fecha} · ${e}${ev.descripcion ? '\n📋 ' + ev.descripcion : ''}`;
  }).join('\n\n');
}

// ════════════════════════════════════════════════════════════════
// NOTICIAS TECH AUTOMÁTICAS
// ════════════════════════════════════════════════════════════════
async function publicarNoticias(guild) {
  const canal = guild.channels.cache.find(c => c.name === CANAL_NOTICIAS);
  if (!canal) return;
  // Reintentar hasta 2 veces si la API falla (Premature close, 404 temporal)
  for (let intento = 1; intento <= 2; intento++) {
    try {
      const r = await llamarIA({
        model: 'claude-sonnet-4-6', max_tokens: 1000,
        messages: [{ role: 'user', content:
          `Generá 3 noticias tech para estudiantes de Informática en Argentina. Temas: IA, redes, ciberseguridad, educación virtual.\nFormato:\n**🔹 [Título]**\nResumen 2-3 oraciones.\n💡 *Por qué importa para tu carrera: [explicación]*\n\nSeparalas con una línea. Hoy: ${fechaAR()}.`
        }]
      });
      await canal.send(safe(`📰 **NOTICIAS TECH — ${fechaAR()}**\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n${r.content[0].text}\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n*Mentor 🎓*`));
      return; // éxito
    } catch (e) {
      LOG.error(`Error publicando noticias (intento ${intento}/2)`, e);
      if (intento < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ════════════════════════════════════════════════════════════════
// CORRECCIÓN DE ENTREGAS CON IA (usa contexto de materia correcto)
// ════════════════════════════════════════════════════════════════
async function corregirEntrega(texto, gid, ch) {
  if (!texto || texto.length < 20) return null;
  // Verificar si hay rúbrica para esta actividad
  const mat     = detectarMateria(gid, ch);
  const rubrica = [...rubricas.values()].find(r => texto.toLowerCase().includes(r.actividad.toLowerCase()) && r.materia === mat);
  const rubricaInstruccion = rubrica
    ? `\n\nEVALUÁ SEGÚN ESTA RÚBRICA (mencioná cada criterio explícitamente):\n${rubrica.criterios.map((c,i)=>`${i+1}. ${c}`).join('\n')}`
    : '';
  const r = await llamarIA({
    model: 'claude-sonnet-4-6', max_tokens: 1200,
    messages: [{ role: 'user', content:
      `${getContexto(gid, ch)}${rubricaInstruccion}\n\nCorregí pedagógicamente este trabajo:\n\n✅ **Aspectos positivos:**\n[puntos fuertes]\n\n🔧 **Aspectos a mejorar:**\n[lo incompleto]\n\n📊 **Evaluación orientativa:** [Excelente/Muy bueno/Bueno/Regular/Insuficiente]\n\n💡 **Sugerencia:**\n[consejo personal]\n\nTRABAJO:\n${texto.substring(0, 3000)}`
    }]
  });
  return r.content[0].text;
}

// ════════════════════════════════════════════════════════════════
// INICIAR CLASE
// ════════════════════════════════════════════════════════════════
async function iniciarClase(channel, titulo, guildId) {
  const s = getSesion(guildId);
  if (s.activa) { await channel.send('⚠️ Ya hay una clase activa. Cerrá con `/cerrar-clase`'); return false; }
  s.activa    = true;
  s.asistentes = new Map();
  s.preguntas  = [];
  s.fecha      = fechaAR();
  s.titulo     = titulo || 'Clase de hoy';
  // Código secreto de 4 dígitos para presencia sin GPS
  s.codigoClase = Math.floor(1000 + Math.random() * 9000).toString();

  const guild = client.guilds.cache.get(guildId);
  const guildName = guild?.name || guildId;

  s.tokenTs    = Date.now();
  s.canalId    = channel.id;
  s.canalNombre = channel.name;

  // Mensaje visual de asistencia en el canal.
  const mensajeAsistencia = await channel.send({
    embeds: [{
      title: `Asistencia habilitada · ${s.titulo}`,
      description:
        `La ventana de registro está abierta durante **20 minutos**.

` +
        `**Registro por ubicación**
` +
        `Pulsá **Registrar asistencia**, permití la ubicación precisa y esperá la confirmación.

` +
        `**Registro mediante código**
` +
        `Solicitá al profesor el código del pizarrón y usá \`/codigo valor:XXXX\`.`,
      color: 0x2563eb,
      fields: [
        { name: '📅 Fecha', value: s.fecha, inline: true },
        { name: '🕐 Inicio', value: horaAR(), inline: true },
        { name: '⏳ Cierre', value: '20 minutos', inline: true }
      ],
      footer: { text: 'Mentor 🎓 · Validación institucional' }
    }],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gps_link').setLabel('Registrar asistencia').setEmoji('📍').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('presente').setLabel('Ingresar código').setEmoji('🔑').setStyle(ButtonStyle.Secondary)
    )]
  });
  s.mensajeAsistenciaUrl = mensajeAsistencia.url;

  // DM PRIVADO al profesor con el código — nunca se publica en el canal
  // ⚠️ FIX (03/08/2026): este bloque y el setTimeout de abajo estaban después de un
  // `return true;` prematuro y NUNCA se ejecutaban. Se movió el return al final de la función.
  if (PROFESOR_ID) {
    try {
      const prof = await client.users.fetch(PROFESOR_ID);
      await prof.send(
        `🔑 **Código de clase — ${s.titulo}**\n` +
        `📅 ${s.fecha} | 🏫 ${guildName}\n\n` +
        `Escribí este código en el pizarrón para alumnos sin GPS:\n\n` +
        `> **${s.codigoClase}**\n\n` +
        `_Este código es solo para vos. Expira cuando cerrés la clase._`
      );
    } catch (e) { LOG.warn('No se pudo enviar DM con código al profesor: ' + e.message); }
  }

  // Auto-cerrar link a los 20 minutos
  setTimeout(async () => {
    const sesActual = getSesion(guildId);
    if (sesActual.activa && sesActual.tokenTs === s.tokenTs) {
      await channel.send('⏰ **El link de asistencia expiró.** El profesor puede usar `/cerrar-clase` para ver el resumen.').catch(()=>{});
    }
  }, VENTANA_ASISTENCIA_MS);

  return true;
}

// ════════════════════════════════════════════════════════════════
// DEFINICIÓN DE COMANDOS SLASH
// ════════════════════════════════════════════════════════════════
const commands = [
  // Profesor
  new SlashCommandBuilder().setName('iniciar-clase').setDescription('👨‍🏫 Iniciar toma de asistencia').addStringOption(o => o.setName('titulo').setDescription('Tema de la clase').setRequired(false)),
  new SlashCommandBuilder().setName('cerrar-clase').setDescription('👨‍🏫 Cerrar asistencia y ver resumen'),
  new SlashCommandBuilder().setName('noticias').setDescription('👨‍🏫 Publicar noticias tech ahora'),
  new SlashCommandBuilder().setName('tarea').setDescription('👨‍🏫 Publicar una nueva tarea')
    .addStringOption(o => o.setName('titulo').setDescription('Título').setRequired(true))
    .addStringOption(o => o.setName('descripcion').setDescription('Descripción').setRequired(true))
    .addStringOption(o => o.setName('fecha').setDescription('Fecha límite dd/mm/yyyy').setRequired(true)),
  new SlashCommandBuilder().setName('evento').setDescription('👨‍🏫 Agregar evento al calendario')
    .addStringOption(o => o.setName('titulo').setDescription('Nombre').setRequired(true))
    .addStringOption(o => o.setName('fecha').setDescription('Fecha dd/mm/yyyy').setRequired(true))
    .addStringOption(o => o.setName('tipo').setDescription('Tipo').setRequired(true).addChoices(
      { name: 'Parcial', value: 'parcial' }, { name: 'Entrega', value: 'entrega' },
      { name: 'Proyecto final', value: 'proyecto' }, { name: 'Clase especial', value: 'clase' },
      { name: 'Recuperatorio', value: 'recuperatorio' }))
    .addStringOption(o => o.setName('descripcion').setDescription('Descripción opcional').setRequired(false)),
  new SlashCommandBuilder().setName('borrar-evento').setDescription('👨‍🏫 Borrar un evento').addIntegerOption(o => o.setName('id').setDescription('ID del evento').setRequired(true)),
  new SlashCommandBuilder().setName('desafio').setDescription('👨‍🏫 Publicar desafio semanal').addStringOption(o => o.setName('materia').setDescription('iev, bd, informatica, practica, pybd o annum').setRequired(true)),
  new SlashCommandBuilder().setName('soluciones').setDescription('👨‍🏫 Ver soluciones del desafio'),
  new SlashCommandBuilder().setName('cerrar-desafio').setDescription('👨‍🏫 Cerrar desafio y anunciar ganador'),
  new SlashCommandBuilder().setName('similitudes').setDescription('👨‍🏫 Ver estadísticas de entregas'),
  new SlashCommandBuilder().setName('backup').setDescription('👨‍🏫 Guardar puntos en Google Sheets'),
  new SlashCommandBuilder().setName('reporte').setDescription('👨‍🏫 Ver reporte rápido del servidor'),
  new SlashCommandBuilder().setName('corregir').setDescription('👨‍🏫 Corregir un trabajo con IA').addStringOption(o => o.setName('texto').setDescription('Texto del trabajo').setRequired(true)),
  // Alumnos
  new SlashCommandBuilder().setName('asistencia').setDescription('Ver asistencia del día'),
  new SlashCommandBuilder().setName('preguntar').setDescription('Preguntá a la IA sobre la materia').addStringOption(o => o.setName('pregunta').setDescription('Tu pregunta').setRequired(true)),
  new SlashCommandBuilder().setName('unidad').setDescription('Ver contenido de una unidad').addIntegerOption(o => o.setName('numero').setDescription('Número de unidad/tema (1-12)').setRequired(true).setMinValue(1).setMaxValue(12)),
  new SlashCommandBuilder().setName('craap').setDescription('Evaluar una fuente con criterio CRAAP').addStringOption(o => o.setName('url').setDescription('URL a evaluar').setRequired(true)),
  new SlashCommandBuilder().setName('ranking').setDescription('Ver el ranking de participación'),
  new SlashCommandBuilder().setName('mispuntos').setDescription('Ver tus puntos y posición'),
  new SlashCommandBuilder().setName('tarjeta').setDescription('🖼️ Ver tu tarjeta de rango como imagen'),
  new SlashCommandBuilder().setName('entrega').setDescription('Ver instrucciones para entregar trabajos'),
  new SlashCommandBuilder().setName('herramientas').setDescription('Links y herramientas del curso'),
  new SlashCommandBuilder().setName('tareas').setDescription('Ver todas las tareas activas'),
  new SlashCommandBuilder().setName('completar').setDescription('Marcar una tarea como completada').addIntegerOption(o => o.setName('id').setDescription('ID de la tarea').setRequired(true)),
  new SlashCommandBuilder().setName('calendario').setDescription('Ver todos los eventos del cuatrimestre'),
  new SlashCommandBuilder().setName('proximo').setDescription('Ver el próximo evento importante'),
  new SlashCommandBuilder().setName('quiz').setDescription('Quiz interactivo (+15 pts si aprobás)').addIntegerOption(o => o.setName('unidad').setDescription('Número de unidad/tema').setRequired(true).setMinValue(1).setMaxValue(12)),
  new SlashCommandBuilder().setName('solucionar').setDescription('Enviar solución al desafio activo').addStringOption(o => o.setName('codigo').setDescription('Tu solución').setRequired(true)),
  new SlashCommandBuilder().setName('moodle').setDescription('Ver estado de conexión con Moodle'),
  new SlashCommandBuilder().setName('miscursos').setDescription('Ver tus cursos activos en Moodle'),
  new SlashCommandBuilder().setName('misnota').setDescription('Consultar tus notas en Moodle').addStringOption(o => o.setName('nombre').setDescription('Tu nombre completo en Moodle').setRequired(true)),
  new SlashCommandBuilder().setName('actividades').setDescription('Ver actividades de un curso Moodle').addIntegerOption(o => o.setName('curso').setDescription('ID del curso (usá /miscursos)').setRequired(true)),
  new SlashCommandBuilder().setName('materia').setDescription('Ver qué materia detecta el bot en este canal'),
  new SlashCommandBuilder().setName('codigo')
    .setDescription('Registrar presencia con el código del pizarrón (alternativa al GPS)')
    .addStringOption(o => o.setName('valor').setDescription('Código de 4 dígitos del pizarrón').setRequired(true).setMinLength(4).setMaxLength(4)),
  new SlashCommandBuilder().setName('ver-codigo').setDescription('👨‍🏫 Ver o regenerar el código del pizarrón de la clase actual'),
  new SlashCommandBuilder().setName('anuncio')
    .setDescription('👨‍🏫 Enviar anuncio o tarea por DM a alumnos de una materia')
    .addStringOption(o => o.setName('materia').setDescription('Materia destino').setRequired(true)
      .addChoices(
        { name: 'Base de Datos - IES 11',   value: 'bd' },
        { name: 'Informatica - IES 11',      value: 'informatica' },
        { name: 'IEV - IES 6',              value: 'iev' },
        { name: 'PP3 - IES 6',              value: 'practica' },
        { name: 'PyBD - IES 6',             value: 'pybd' },
        { name: 'Análisis Numérico - UCSE', value: 'annum' },
        { name: 'Todos',                    value: 'todos' }
      ))
    .addStringOption(o => o.setName('mensaje').setDescription('Texto del anuncio o consigna').setRequired(true))
    .addIntegerOption(o => o.setName('dias').setDescription('Dias para la entrega (opcional)').setRequired(false).setMinValue(1).setMaxValue(30)),
  new SlashCommandBuilder().setName('nota')
    .setDescription('Cargar una nota a un alumno')
    .addStringOption(o => o.setName('actividad').setDescription('Nombre del trabajo o parcial').setRequired(true))
    .addNumberOption(o => o.setName('calificacion').setDescription('Nota del 1 al 10').setRequired(true).setMinValue(1).setMaxValue(10))
    .addStringOption(o => o.setName('nombre').setDescription('Nombre real del alumno (ej: Dominguez)').setRequired(false))
    .addUserOption(o => o.setName('alumno').setDescription('O selecciona por usuario Discord').setRequired(false))
    .addStringOption(o => o.setName('observacion').setDescription('Observacion opcional').setRequired(false)),
  new SlashCommandBuilder().setName('misnotas').setDescription('Ver todas tus notas del cuatrimestre'),
  new SlashCommandBuilder().setName('notas-alumno')
    .setDescription('👨‍🏫 Ver todas las notas de un alumno')
    .addUserOption(o => o.setName('alumno').setDescription('Alumno a consultar').setRequired(true)),
  new SlashCommandBuilder().setName('boletin-notas').setDescription('👨‍🏫 Ver boletín completo de todos los alumnos'),
  new SlashCommandBuilder().setName('asignar-materia').setDescription('👨‍🏫 Asignar la materia de este servidor a los alumnos presentes/registrados'),
  new SlashCommandBuilder().setName('exportar').setDescription('👨‍🏫 Exportar planilla de asistencia y notas para copiar'),
  new SlashCommandBuilder().setName('cierre').setDescription('👨‍🏫 Informe final de cuatrimestre por alumno (asistencia, notas, condición)'),
  new SlashCommandBuilder().setName('registrarme')
    .setDescription('Registrá tu nombre real para que aparezca en la asistencia')
    .addStringOption(o => o.setName('nombre').setDescription('Tu nombre y apellido completo').setRequired(true))
    .addStringOption(o => o.setName('carrera').setDescription('Tu carrera (ej: Tecnicatura en Desarrollo de Software)').setRequired(false)),
  new SlashCommandBuilder().setName('misregistro').setDescription('Ver tu registro actual'),
  new SlashCommandBuilder().setName('alumnos').setDescription('👨‍🏫 Ver listado de alumnos registrados (profesor)'),
  new SlashCommandBuilder().setName('ayuda').setDescription('Ver todos los comandos disponibles'),
  new SlashCommandBuilder().setName('mislogros').setDescription('Ver tus logros desbloqueados'),
  new SlashCommandBuilder().setName('historial').setDescription('Ver historial de entregas de un alumno')
    .addUserOption(o => o.setName('alumno').setDescription('Alumno (solo profesor) o dejá vacío para el tuyo').setRequired(false)),
  new SlashCommandBuilder().setName('rubrica')
    .setDescription('👨‍🏫 Gestionar rúbricas de evaluación')
    .addStringOption(o => o.setName('accion').setDescription('crear o ver').setRequired(true).addChoices(
      { name: 'Crear', value: 'crear' }, { name: 'Ver', value: 'ver' }, { name: 'Listar', value: 'listar' }))
    .addStringOption(o => o.setName('actividad').setDescription('Nombre de la actividad').setRequired(false))
    .addStringOption(o => o.setName('criterios').setDescription('Criterios separados por | (ej: "E-R correcto|Cardinalidad|SQL válido")').setRequired(false)),
  new SlashCommandBuilder().setName('generar-parcial')
    .setDescription('👨‍🏫 Generar un examen parcial con IA')
    .addIntegerOption(o => o.setName('unidad_desde').setDescription('Unidad desde (ej: 1)').setRequired(true).setMinValue(1).setMaxValue(8))
    .addIntegerOption(o => o.setName('unidad_hasta').setDescription('Unidad hasta (ej: 4)').setRequired(true).setMinValue(1).setMaxValue(8)),
  new SlashCommandBuilder().setName('riesgo').setDescription('👨‍🏫 Ver alumnos con baja asistencia'),
  new SlashCommandBuilder().setName('asistencia-general').setDescription('👨‍🏫 Ver % de asistencia de todos los alumnos, con gráfico'),
  new SlashCommandBuilder().setName('ajustar-asistencia')
    .setDescription('👨‍🏫 Corregir a mano la cantidad de presencias de un alumno')
    .addUserOption(o => o.setName('alumno').setDescription('Alumno a corregir').setRequired(true))
    .addIntegerOption(o => o.setName('cantidad').setDescription('+1 para sumar una presencia, -1 para restar').setRequired(true).addChoices(
      { name: '+1 (sumar una presencia)', value: 1 }, { name: '-1 (restar una presencia)', value: -1 }))
    .addStringOption(o => o.setName('motivo').setDescription('Por qué se corrige (queda registrado)').setRequired(true)),
  new SlashCommandBuilder().setName('torneo').setDescription('👨‍🏫 Iniciar torneo de quizzes entre todos'),
  new SlashCommandBuilder().setName('logros').setDescription('👨‍🏫 Ver todos los logros disponibles'),
  new SlashCommandBuilder().setName('qr-clase').setDescription('👨‍🏫 Generar QR de asistencia para proyectar'),
  new SlashCommandBuilder().setName('encuesta')
    .setDescription('👨‍🏫 Lanzar encuesta en vivo durante la clase')
    .addStringOption(o => o.setName('pregunta').setDescription('¿Qué querés preguntar?').setRequired(true))
    .addStringOption(o => o.setName('opciones').setDescription('Opciones separadas por | (ej: Sí la entendí|Más o menos|No entendí)').setRequired(true))
    .addIntegerOption(o => o.setName('minutos').setDescription('Minutos para votar (default: 2)').setRequired(false).setMinValue(1).setMaxValue(10)),
  new SlashCommandBuilder().setName('perfil')
    .setDescription('Ver perfil académico completo')
    .addUserOption(o => o.setName('alumno').setDescription('Alumno a consultar (solo profesor). Dejá vacío para el tuyo.').setRequired(false)),
];

async function registrarComandos(guildId, applicationId) {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(applicationId, guildId),
    { body: commands.map(command => command.toJSON()) }
  );
  LOG.info(`Comandos registrados en guild ${guildId} para aplicación ${applicationId}`);
}

// ════════════════════════════════════════════════════════════════
// DIAGNÓSTICO DE CONEXIÓN — sin esto, un problema de Gateway (rate
// limit de IDENTIFY, intents rechazados, red) queda en silencio total
// y parece que el proceso "no hace nada".
// ════════════════════════════════════════════════════════════════
client.on(Events.Error, (e) => LOG.error('Error del cliente Discord', e));
client.on(Events.Warn, (msg) => LOG.warn(`Aviso de discord.js: ${msg}`));
client.on(Events.ShardReconnecting, (id) => LOG.warn(`Shard ${id} reconectando al Gateway...`));
client.on(Events.ShardResume, (id) => LOG.info(`Shard ${id} resumió la sesión con Discord.`));
client.on(Events.ShardDisconnect, (event, id) => LOG.warn(`Shard ${id} se desconectó (código ${event?.code})`));

// ════════════════════════════════════════════════════════════════
// EVENTO: BOT LISTO
// ════════════════════════════════════════════════════════════════
client.once(Events.ClientReady, async (c) => {
  LOG.info(`Mentor conectado como ${c.user.tag}`);
  LOG.info(`Hora Argentina: ${ahoraAR()}`);
  cargarDatos();

  // No usar un CLIENT_ID escrito a mano. Se toma el ID de la aplicación
  // correspondiente al token que realmente inició sesión.
  const applicationId = c.application?.id || c.user.id;
  LOG.info(`Application ID conectado: ${applicationId}`);

  try {
    for (const guild of c.guilds.cache.values()) {
      await registrarComandos(guild.id, applicationId);
    }
  } catch (e) {
    LOG.error('No se pudieron registrar los comandos slash', e);
    botReady = false;
    return;
  }

  // Recién ACÁ el bot está genuinamente listo: datos cargados, comandos
  // registrados en Discord, conexión al Gateway activa.
  botReady = true;
  LOG.info('Bot listo — comandos ya se pueden usar.');
  if (PROFESOR_ID) {
    try {
      const prof = await c.users.fetch(PROFESOR_ID);
      await prof.send(`✅ **Mentor está en línea y listo.** Ya podés usar los comandos.\n🕐 ${ahoraAR()}`);
    } catch (e) { LOG.warn('No se pudo enviar DM de arranque: ' + e.message); }
  }

  // Guardar datos forzado cada 5 minutos
  setInterval(guardarDatos, 5 * 60 * 1000);
  // Limpiar formularios expirados cada 5 minutos
  setInterval(limpiarFormularios, 5 * 60 * 1000);
  // Cerrar la VENTANA DE ASISTENCIA pasados 20 min — revisa cada minuto
  // (la clase sigue, pero ya nadie puede marcar presencia)
  setInterval(async () => {
    let cambios = false;
    for (const [gid, s] of sesiones.entries()) {
      if (!s.activa) continue;
      if (!s.fecha || !s.tokenTs) continue;

      const transcurrido = Date.now() - s.tokenTs;

      // Pasados 20 min, cerrar la ventana de asistencia automáticamente
      if (transcurrido > VENTANA_ASISTENCIA_MS) {
        s.activa = false;
        s.presentesUltimaClase = [...s.asistentes.entries()].map(([uid, a]) => ({ uid, nombre: a.nombre, hora: a.hora, metodo: a.metodo||'gps' }));
        s.fechaUltimaClase = s.fecha;
        clasesTotales.set(gid, (clasesTotales.get(gid) || 0) + 1);
        cambios = true;
        // Avisar al profesor y publicar resumen en el canal
        if (PROFESOR_ID) {
          try {
            const prof = await client.users.fetch(PROFESOR_ID);
            await prof.send('🔔 La asistencia de **' + (s.titulo||'Clase') + '** se cerró (pasaron los 20 min).\n👥 ' + s.asistentes.size + ' presentes registrados.\nUsá /alumnos para ver la lista.');
          } catch {}
        }
        try {
          if (s.canalId) {
            const canalObj = await client.channels.fetch(s.canalId).catch(() => null);
            if (canalObj) await canalObj.send('⏰ **Asistencia cerrada** — ' + (s.titulo||'Clase') + '\n👥 ' + s.asistentes.size + ' presentes. La ventana de 20 minutos finalizó.');
          }
        } catch {}
      }
    }
    if (cambios) guardarDatos();
  }, 60 * 1000);

  // Recordatorio de entregas próximas a vencer (cada hora)
  setInterval(async () => {
    const ahora = Date.now();
    for (const [id, anuncio] of anunciosActivos.entries()) {
      if (anuncio.recordatorioEnviado) continue;
      if (!anuncio.fechaLimiteTs) continue;
      const horasRestantes = (anuncio.fechaLimiteTs - ahora) / (1000 * 60 * 60);
      if (horasRestantes <= 24 && horasRestantes > 0) {
        // Enviar recordatorio a destinatarios
        for (const uid of (anuncio.destinatarios || [])) {
          try {
            const u = await client.users.fetch(uid);
            await u.send('🔔 **Recordatorio de entrega**\n\nMañana vence:\n📚 ' + anuncio.mensaje.substring(0,120) + '\n\n📤 Entregalo en el canal #entregas de tu materia.\n_Si ya lo entregaste, ignorá este mensaje._');
            await new Promise(r => setTimeout(r, 300));
          } catch {}
        }
        anuncio.recordatorioEnviado = true;
        anunciosActivos.set(id, anuncio);
        guardarDatos();
      }
      // Limpiar anuncios vencidos hace más de 2 días
      if (horasRestantes < -48) anunciosActivos.delete(id);
    }
  }, 60 * 60 * 1000);
  // Backup Sheets domingos 22hs
  setInterval(async () => {
    const { dia, hora, min } = fechaHoraAR();
    if (dia === 0 && hora === 22 && min === 0) await backupPuntos();
  }, 60000);

  // Tareas automáticas cada minuto
  setInterval(async () => {
    const { dia, hora, min } = fechaHoraAR();

    // Recordatorios Moodle cada hora
    if (min === 0) {
      for (const g of client.guilds.cache.values()) {
        const mc = getMC(g.name);
        if (!mc.token) continue;
        const canal = g.channels.cache.find(c => c.name === 'aviso' || c.name === 'anuncios');
        if (!canal) continue;
        const cursos = await getCursos(mc.url, mc.token);
        if (!Array.isArray(cursos)) continue;
        for (const curso of cursos.filter(c => c.visible === 1 && c.id > 1).slice(0,3)) {
          const secs = await getActividadesMoodle(mc.url, mc.token, curso.id);
          if (!Array.isArray(secs)) continue;
          for (const sec of secs) for (const mod of (sec.modules||[])) {
            if (mod.modname === 'assign' && mod.dates) for (const d of mod.dates) {
              if (d.timestamp*1000 > Date.now()-3600000 && d.dataid === 'duedate')
                await canal.send(`📌 **Recordatorio Moodle ${mc.nombre}**\n📚 ${mod.name} — ${curso.shortname}\n📅 Vence: ${new Date(d.timestamp*1000).toLocaleDateString('es-AR',{timeZone:TZ})}`);
            }
          }
        }
      }
    }

    // Recordatorios de calendario
    for (const [, ev] of eventos.entries()) {
      const fe = parseFecha(ev.fecha); if (!fe) continue;
      const d  = diasHasta(fe);
      const av = async (msg) => { for (const g of client.guilds.cache.values()) { const c = g.channels.cache.find(c => c.name==='aviso'||c.name==='anuncios'); if (c) await c.send(msg); } };
      if (d === 3 && !ev.av3) { ev.av3 = true; guardarDatos(); await av(`⏰ **Faltan 3 días** — ${emojiTipo(ev.tipo)} **${ev.titulo}** — ${ev.fecha}`); }
      if (d === 1 && !ev.av1) { ev.av1 = true; guardarDatos(); await av(`🚨 **Mañana** — **${ev.titulo}**`); }
      if (d === 0 && !ev.av0) { ev.av0 = true; guardarDatos(); await av(`🔴 **HOY — ${ev.titulo}**`); }
    }

    // Asistencia automática DESACTIVADA
    // El profesor inicia manualmente con /iniciar-clase
    // Si querés reactivarla editá HORARIOS_CLASE arriba

    // Noticias automáticas 8:00 AM
    if (hora === 8 && min === 0)
      for (const g of client.guilds.cache.values()) await publicarNoticias(g);

    // Alumnos en riesgo — lunes 8:30hs
    if (dia === 1 && hora === 8 && min === 30) {
      for (const g of client.guilds.cache.values()) {
        if (!PROFESOR_ID) continue;
        const riesgo = detectarAlumnosEnRiesgo(g.id);
        if (!riesgo.length) continue;
        try {
          const prof = await g.client.users.fetch(PROFESOR_ID);
          const lista = riesgo.map((r,i) => `${i+1}. **${r.nombre}** — ${r.asistencias} asistencia${r.asistencias!==1?'s':''}, ${r.entregas} entrega${r.entregas!==1?'s':''}`).join('\n');
          await prof.send(`⚠️ **Alumnos en riesgo — ${g.name}**\n📅 ${fechaAR()}\n\n${lista}\n\nEstos alumnos tienen baja actividad. Considerá contactarlos antes de que sea tarde.`);
        } catch(e) { LOG.error('Error DM riesgo', e); }
      }
    }

    // Reporte semanal — viernes 18hs
    if (dia === 5 && hora === 18 && min === 0) {
      for (const g of client.guilds.cache.values()) {
        if (!PROFESOR_ID) continue;
        try {
          const prof = await g.client.users.fetch(PROFESOR_ID);
          await prof.send(await generarReporteSemanal(g));
        } catch(e) { LOG.error('Error reporte semanal', e); }
      }
    }

    // Torneo — cerrar pregunta activa
    if (torneoActivo && Date.now() > torneoActivo.cierra) {
      await cerrarPreguntaTorneo();
    }

  }, 60000);
});

// Registrar comandos automáticamente cuando el bot entra a un servidor nuevo.
client.on(Events.GuildCreate, async (guild) => {
  try {
    const applicationId = client.application?.id || client.user?.id;
    if (!applicationId) throw new Error('Application ID no disponible');
    await registrarComandos(guild.id, applicationId);
  } catch (e) {
    LOG.error(`Error registrando comandos en servidor nuevo ${guild.id}`, e);
  }
});

// ════════════════════════════════════════════════════════════════
// EVENTO: MENSAJES — formulario de entregas y menciones
// ════════════════════════════════════════════════════════════════
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;

  // ── FORMULARIO DE ENTREGAS (4 pasos con explicación) ──
  if (msg.channel.name.includes('entrega')) {
    const uid    = msg.author.id;
    const nombre = getNombreReal(uid, msg.member?.displayName || msg.author.username);

    if (formularioActivo.has(uid)) {
      const form = formularioActivo.get(uid);
      if (Date.now() > form.expira) {
        formularioActivo.delete(uid);
        await msg.reply('Se venció el tiempo del formulario. Escribí de nuevo para arrancar.');
        return;
      }
      form.expira = Date.now() + FORMULARIO_MS;

      if (form.paso === 1) {
        form.actividad = msg.content; form.paso = 2; formularioActivo.set(uid, form);
        await msg.reply('📎 **Paso 2 de 4** — ¿Dónde está el trabajo?\n\nPegá el link (GitHub, Drive...) o adjuntá el archivo acá.\nSi no tenés link, escribí `sin link`.');
        return;
      }

      if (form.paso === 2) {
        const adj = msg.attachments.first();
        if (adj) { form.link = adj.url; form.archivo = adj.name; form.fileSize = Math.round(adj.size/1024) + ' KB'; }
        else { form.link = msg.content.toLowerCase() === 'sin link' ? 'Sin link' : msg.content; form.archivo = null; }
        form.paso = 3; formularioActivo.set(uid, form);
        await msg.reply('✍️ **Paso 3 de 4** — Contame qué hiciste\n\nUnas líneas alcanza: qué desarrollaste, qué herramientas usaste, qué parte te costó.');
        return;
      }

      if (form.paso === 3) {
        form.explicacion = msg.content; form.paso = 4; formularioActivo.set(uid, form);
        await msg.reply('💬 **Paso 4 de 4** — ¿Alguna duda o comentario? (opcional)\n\nEscribí lo que quieras o `listo` para terminar.');
        return;
      }

      if (form.paso === 4) {
        form.comentario = msg.content.toLowerCase() === 'listo' ? '' : msg.content;
        formularioActivo.delete(uid);
        const archInfo = form.archivo
          ? `📁 **Archivo:** ${form.archivo} (${form.fileSize})\n🔗 **Link:** ${form.link}`
          : `🔗 **Link:** ${form.link}`;
        await msg.channel.send(
          `📋 **ENTREGA REGISTRADA**\n━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `👤 **Alumno:** ${nombre}\n📚 **Actividad:** ${form.actividad}\n${archInfo}\n` +
          `✍️ **Explicación:** ${form.explicacion.substring(0,200)}${form.explicacion.length>200?'…':''}\n` +
          `${form.comentario ? `💬 **Comentario:** ${form.comentario}\n` : ''}` +
          `━━━━━━━━━━━━━━━━━━━━━━━━`
        );
        // Guardar en historial — verificar si ya entregó ESTA actividad antes
        if (!historial.has(uid)) historial.set(uid, []);
        const histAlumno = historial.get(uid);
        const yaEntrego = histAlumno.some(h => h.actividad.trim().toLowerCase() === form.actividad.trim().toLowerCase());
        histAlumno.push({ actividad: form.actividad, fecha: fechaAR(), link: form.link, explicacion: form.explicacion.substring(0,500), comentario: form.comentario, reentrega: yaEntrego });
        guardarDatos();
        compararEntregas(msg.guild, form.actividad, nombre, uid, `${form.actividad} ${form.explicacion} ${form.comentario}`).catch(e => LOG.error('Error comparando entregas', e));
        // Solo sumar puntos si es la PRIMERA vez que entrega esta actividad — evita farmear puntos reenviando
        const p = yaEntrego ? (puntos.get(uid) || darPuntos(uid, nombre, 'entrega_sin_puntos')) : darPuntos(uid, nombre, 'entrega');
        if (yaEntrego) LOG.info(`${nombre} reentregó "${form.actividad}" — no se sumaron puntos de nuevo`);
        await actualizarRol(msg.member, p.pts, msg.channel);
        try {
          await msg.channel.sendTyping();
          const textoCorr = `Actividad: ${form.actividad}\nExplicación del alumno: ${form.explicacion}\n${form.comentario ? `Consulta del alumno: ${form.comentario}` : ''}\n${form.link !== 'Sin link' ? `Link: ${form.link}` : ''}`;
          const cor = await corregirEntrega(textoCorr, msg.guildId, msg.channel?.name);
          if (cor) {
            const evalInfo = colorEvaluacion(cor);
            await msg.reply({ embeds: [{
              title: `${evalInfo.emoji} Corrección de Mentor${evalInfo.nivel ? ' — ' + evalInfo.nivel : ''}`,
              color: evalInfo.color,
              description: safe(cor, 3800),
              footer: { text: `⚠️ Orientativa — la nota final la define el profesor · +20 pts · Total: ${p.pts} pts` },
            }] });
          }
        } catch (e) { LOG.error('Error en corrección', e); }
        return;
      }
    }
    if (!formularioActivo.has(uid) && msg.content.length > 2) {
      formularioActivo.set(uid, { paso:1, nombre, actividad:'', link:'', archivo:null, fileSize:null, explicacion:'', comentario:'', expira: Date.now() + FORMULARIO_MS });
      await msg.reply(
        `📝 Hola **${nombre}**\n\n**Paso 1 de 4** — ¿Cómo se llama la actividad o trabajo?` +
        `${!registros.has(uid) ? '\n\n💡 Con /registrarme podés poner tu nombre real en el registro.' : ''}`
      );
    }
  }

  // ── MENCIÓN AL BOT ──
  if (msg.mentions.has(client.user)) {
    const pregunta = msg.content.replace(/<@\d+>/g,'').trim();
    if (!pregunta) return;
    try {
      await msg.channel.sendTyping();
      const r = await llamarIA({ model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: `${getContexto(msg.guildId, msg.channel?.name)}\n\nPregunta: ${pregunta}` }] });
      await msg.reply(safe(`🤖 ${r.content[0].text}`));
      const s = getSesion(msg.guildId);
      if (s.activa) s.preguntas.push({ pregunta: pregunta.substring(0,100), autor: msg.member?.displayName||msg.author.username });
    } catch (e) { LOG.error('Error en mención', e); await msg.reply('❌ Error al procesar tu pregunta. Intentá de nuevo.'); }
  }
});

// ════════════════════════════════════════════════════════════════
// EVENTO: INTERACCIONES (botones y comandos slash)
// ════════════════════════════════════════════════════════════════
client.on(Events.InteractionCreate, async (interaction) => {
  const identificador = interaction.isChatInputCommand()
    ? `/${interaction.commandName}`
    : (interaction.customId || `tipo=${interaction.type}`);
  LOG.info(`Interacción recibida: ${identificador} | usuario=${interaction.user?.tag || interaction.user?.id || 'desconocido'}`);

  // ── BOTÓN: Encuesta ──
  if (interaction.isButton() && interaction.customId.startsWith('enc_')) {
    const idx     = parseInt(interaction.customId.split('_')[1]);
    const uid     = interaction.user.id;
    const nombre  = interaction.member?.displayName || interaction.user.username;
    const enc     = encuestas.get(interaction.guildId);
    if (!enc) { await interaction.reply({ content: 'Esta encuesta ya terminó.', ephemeral: true }); return; }
    if (Date.now() > enc.cierra) { await interaction.reply({ content: 'Ya no se puede votar, la encuesta terminó.', ephemeral: true }); return; }
    const yaVoto  = enc.votos.has(uid);
    enc.votos.set(uid, idx);
    const total   = enc.votos.size;
    const conteo  = {};
    for (const v of enc.votos.values()) conteo[v] = (conteo[v]||0)+1;
    const emojis  = ['🔵','🟢','🟡','🟠','🔴'];
    const resumen = enc.opciones.map((op,i) => {
      const cnt = conteo[i]||0;
      const pct = total > 0 ? Math.round(cnt/total*100) : 0;
      return `${emojis[i]} ${op}: **${cnt}** (${pct}%)`;
    }).join(' · ');
    await interaction.reply({ content: `${yaVoto ? '🔄 Voto actualizado' : '✅ Voto registrado'}: **${enc.opciones[idx]}**

${resumen} · Total: **${total}**`, ephemeral: true });
    return;
  }

  // ── BOTÓN: Torneo ──
  if (interaction.isButton() && interaction.customId.startsWith('torneo_')) {
    const resp   = interaction.customId.split('_')[1];
    const uid    = interaction.user.id;
    const nombre = interaction.member?.displayName || interaction.user.username;
    if (!torneoActivo) { await interaction.reply({ content: 'Esta pregunta ya cerró.', ephemeral: true }); return; }
    if (torneoActivo.respuestas.has(uid)) { await interaction.reply({ content: `Ya enviaste tu respuesta.`, ephemeral: true }); return; }
    torneoActivo.respuestas.set(uid, { resp, nombre, tiempo: Date.now() });
    const esCorrecta = resp === torneoActivo.correcta;
    await interaction.reply({ content: esCorrecta ? `✅ **Correcto!** Registrado — esperá el resultado.` : `❌ Incorrecto. Esperá el resultado.`, ephemeral: true });
    return;
  }

  // ── BOTÓN: Quiz ──
  if (interaction.isButton() && interaction.customId.startsWith('quiz_')) {
    const [, resp, tuid] = interaction.customId.split('_');
    const uid = interaction.user.id;
    if (uid !== tuid)  { await interaction.reply({ content: 'Este quiz es de otro alumno. Usá /quiz para el tuyo.', ephemeral: true }); return; }
    const quiz = quizActivo.get(uid);
    if (!quiz)          { await interaction.reply({ content: 'Usá /quiz para generar una pregunta.', ephemeral: true }); return; }
    if (quiz.respondido){ await interaction.reply({ content: 'Ya respondiste esta pregunta. Usá /quiz para una nueva.', ephemeral: true }); return; }
    quiz.respondido = true; quizActivo.set(uid, quiz);
    const nombre = interaction.member?.displayName || interaction.user.username;
    let msg;
    if (resp === quiz.correcta) {
      const p3 = darPuntos(uid, nombre, 'quiz');
      await actualizarRol(interaction.member, p3.pts, interaction.channel);
      msg = `✅ **¡Correcto ${nombre}!** ${quiz.explicacion}\n\n+15 pts | Total: **${p3.pts} pts**`;
    } else {
      msg = `❌ **Incorrecto ${nombre}.** La correcta era: ${quiz.correcta}\n${quiz.explicacion}`;
    }
    await interaction.update({ content: safe(msg), components: [] });
    return;
  }

  // ── BOTÓN: Completar tarea ──
  if (interaction.isButton() && interaction.customId.startsWith('completar_')) {
    const id    = parseInt(interaction.customId.split('_')[1]);
    const tarea = tareas.get(id);
    if (!tarea) { await interaction.reply({ content: '❌ Tarea no encontrada.', ephemeral: true }); return; }
    const uid    = interaction.user.id;
    const nombre = interaction.member?.displayName || interaction.user.username;
    if (tarea.completados.has(uid)) { await interaction.reply({ content: `✅ **${nombre}**, ya marcaste esta tarea.`, ephemeral: true }); return; }
    tarea.completados.add(uid); guardarDatos();
    const p = darPuntos(uid, nombre, 'entrega');
    await actualizarRol(interaction.member, p.pts, interaction.channel);
    const nlT = verificarLogros(uid, nombre, p, '');
    const lgT = nlT.length ? '\n' + nlT.map(id => { const l = LOGROS.find(x=>x.id===id); return l ? `🏅 ${l.emoji} **${l.nombre}**` : ''; }).join('\n') : '';
    await interaction.reply({ content: `✅ **${nombre}** completó **"${tarea.titulo}"**\n📤 +20 pts | Total: **${p.pts} pts** ${getRol(p.pts).emoji}${lgT}` });
    return;
  }

  // ── BOTÓN: Ver completados ──
  if (interaction.isButton() && interaction.customId.startsWith('vercompletados_')) {
    const id    = parseInt(interaction.customId.split('_')[1]);
    const tarea = tareas.get(id);
    if (!tarea) { await interaction.reply({ content: '❌ Tarea no encontrada.', ephemeral: true }); return; }
    const lista = [...tarea.completados].map(uid => puntos.get(uid)?.nombre || uid).map((n, i) => `${i+1}. ${n}`).join('\n') || 'Nadie completó esta tarea todavía.';
    await interaction.reply({ content: `👥 **Completaron "${tarea.titulo}"** (${tarea.completados.size}):\n\n${lista}`, ephemeral: true });
    return;
  }

  // ── BOTÓN: Presente ──
  // ── BOTÓN: Registrar presencia GPS — genera link personalizado con UID real ──
  if (interaction.isButton() && interaction.customId === 'gps_link') {
    const sesion = getSesion(interaction.guildId);
    if (!sesion.activa) { await interaction.reply({ content: 'La clase ya terminó.', ephemeral: true }); return; }
    const uid    = interaction.user.id;
    const nombre = getNombreReal(uid, interaction.member?.displayName || interaction.user.username);
    if (sesion.asistentes.has(uid)) { await interaction.reply({ content: nombre + ', ya marcaste presente.', ephemeral: true }); return; }

    // Link individual, firmado y con vencimiento. El servidor ignora nombre y distancia enviados por el navegador.
    const exp = Math.min(Date.now() + VENTANA_ASISTENCIA_MS, (sesion.tokenTs || Date.now()) + VENTANA_ASISTENCIA_MS);
    const nonce = crypto.randomBytes(12).toString('hex');
    const sig = firmarPresencia({ uid, guildId: interaction.guildId, exp, nonce });
    const qp = new URLSearchParams({
      uid,
      guildId: interaction.guildId,
      guild: interaction.guild?.name || '',
      clase: sesion.titulo || 'Clase',
      exp: String(exp),
      nonce,
      sig
    });
    const link = `${PRESENCIA_URL}?${qp.toString()}`;

    await interaction.reply({
      embeds: [{
        title: '📍 Registro personal de asistencia',
        description:
          `Este enlace fue generado exclusivamente para **${nombre}**.\n\n` +
          `1. Abrilo desde tu celular.\n` +
          `2. Permití **ubicación precisa**.\n` +
          `3. Esperá el mensaje **Presencia registrada**.`,
        color: 0x2563eb,
        footer: { text: 'No compartas este enlace: está firmado para tu usuario de Discord.' }
      }],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Abrir verificación GPS').setEmoji('🛰️').setStyle(ButtonStyle.Link).setURL(link)
      )],
      ephemeral: true
    });
    return;
  }

  if (interaction.isButton() && interaction.customId === 'presente') {
    const sesion = getSesion(interaction.guildId);
    if (!sesion.activa) { await interaction.reply({ content: 'La clase ya terminó, no se puede registrar presencia.', ephemeral: true }); return; }
    const uid    = interaction.user.id;
    const nombre = getNombreReal(uid, interaction.member?.displayName || interaction.user.username);
    if (sesion.asistentes.has(uid)) { await interaction.reply({ content: nombre + ', ya marcaste presente.', ephemeral: true }); return; }
    // NO registra presencia — pide el código del pizarrón
    await interaction.reply({
      content: '🔑 **Código requerido**\n\nPara registrar tu presencia necesitás el código de 4 dígitos que el profesor escribió en el pizarrón.\n\nEscribí el comando:\n`/codigo valor:XXXX`\n\n_Reemplazá XXXX por el código del pizarrón. Si no lo ves, pediselo al profesor._',
      ephemeral: true
    });
    return;
  }

  // ── COMANDOS SLASH ──
  if (!interaction.isChatInputCommand()) return;

  // Confirmar la interacción inmediatamente. Discord exige una respuesta
  // inicial en pocos segundos; luego el comando puede continuar trabajando.
  // Si la llamada REST se cuelga sin resolver ni fallar (pasó el 09/08),
  // este timeout de 8s corta la espera y lo deja loggeado con claridad.
  try {
    await Promise.race([
      interaction.deferReply(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout: deferReply no resolvió en 8s')), 8000)),
    ]);
    LOG.info(`Interacción confirmada: /${interaction.commandName}`);
  } catch (e) {
    LOG.error(`No se pudo confirmar /${interaction.commandName}; la interacción venció, se colgó, o la conexión está duplicada`, e);
    return;
  }

  // Verificar permisos de profesor
  if (SOLO_PROFESOR.has(interaction.commandName) && !esProfesor(interaction.user.id)) {
    await interaction.editReply('Este comando es solo para el profesor.'); return;
  }

  LOG.cmd(`${interaction.user.username} usó /${interaction.commandName} en ${interaction.guild?.name}`);

  try {
    switch (interaction.commandName) {

      // ── DIAGNÓSTICO ──
      case 'materia': {
        const mat = detectarMateria(interaction.guildId, interaction.channel?.name);
        const NOM = { iev:'Internet y Entornos Virtuales (IEV)', bd:'Base de Datos', informatica:'Informática', practica:'Práctica Profesionalizante III', pybd:'Programación y Base de Datos (PyBD)', annum:'Análisis Numérico' };
        await interaction.editReply(`🔍 **Detección de materia**\nCanal: **#${interaction.channel?.name}** | Servidor: **${interaction.guild?.name}**\n✅ Materia: **${NOM[mat]}**\n\nPalabras clave:\n• PyBD → \`pybd\`, \`progbd\`, \`prog-bd\`\n• PP3 → \`practica\`, \`pract\`, \`pp3\`\n• BD → \`bd\`, \`base\`, \`datos\`\n• Informática → \`info\`, \`informatica\`\n• IEV → \`iev\`, \`internet\`, \`entornos\``);
        break;
      }

      case 'ayuda': {
        const mat = detectarMateria(interaction.guildId, interaction.channel?.name);
        const NOM = { iev:'📡 IEV', bd:'🗄️ BD', informatica:'💻 Informática', practica:'🎯 PP3', pybd:'☕ PyBD', annum:'📐 Análisis Numérico' };
        await interaction.editReply(safe(
          `📖 **Comandos — ${NOM[mat]}**\n\n` +
          `**Consultas:** /preguntar · /unidad [1-8] · /craap [url]\n` +
          `**Entregas:** #entregas (formulario) · /tareas · /completar [id]\n` +
          `**Puntos:** /mispuntos · /ranking · /quiz [unidad] · /solucionar\n` +
          `**Moodle:** /miscursos · /misnota [nombre] · /actividades [id]\n` +
          `**Eventos:** /calendario · /proximo\n` +
          `**Otros:** /herramientas · /materia · /ayuda`
        ));
        break;
      }

      case 'reporte': {
        const s        = getSesion(interaction.guildId);
        // Filtrar SOLO alumnos de este servidor (registros guarda el guildId real)
        const alumnosGuild = [...puntos.entries()].filter(([uid]) => registros.get(uid)?.guildId === interaction.guildId);
        const rank     = alumnosGuild.sort((a,b) => b[1].pts - a[1].pts);
        const prom     = rank.length ? Math.round(rank.reduce((a,[,p]) => a+p.pts, 0)/rank.length) : 0;
        const riesgoR  = detectarAlumnosEnRiesgo(interaction.guildId);
        const totalCls = clasesTotales.get(interaction.guildId) || 0;
        const pAsist   = alumnosGuild.length>0&&totalCls>0 ? Math.round(alumnosGuild.reduce((sum,[,p])=>sum+(p.asistencias||0),0)/alumnosGuild.length/totalCls*100) : 0;
        await interaction.editReply(safe(
          `📊 **Reporte — ${interaction.guild?.name}**\n📅 ${ahoraAR()}\n\n` +
          `👥 Alumnos: ${alumnosGuild.length} | 📈 Promedio: ${prom} pts | 🏆 Líder: ${rank[0]?.[1]?.nombre||'—'} (${rank[0]?.[1]?.pts||0} pts)\n` +
          `📊 Asistencia promedio: **${pAsist}%** de ${totalCls} clases dictadas\n` +
          `⚠️ En riesgo: ${riesgoR.length} alumno${riesgoR.length!==1?'s':''}\n\n` +
          `🎓 Clase: ${s.activa ? `🟢 Activa — ${s.asistentes.size} presentes` : '⚪ Inactiva'}\n` +
          `📚 Tareas activas: ${tareas.size} | 📅 Eventos próximos: ${[...eventos.values()].filter(ev=>{const f=parseFecha(ev.fecha);return f&&diasHasta(f)>=0;}).length}\n` +
          `🔍 Actividades con entregas: ${entregasPorActiv.size}`
        ));
        break;
      }

      case 'iniciar-clase': {
        const iniciada = await iniciarClase(interaction.channel, interaction.options.getString('titulo')||'Clase de hoy', interaction.guildId);
        if (iniciada) await interaction.editReply('Clase iniciada. Los alumnos ya pueden marcar presencia.');
        else await interaction.editReply('Ya había una clase activa — no se inició una nueva. Usá /cerrar-clase primero si querés reiniciarla.');
        break;
      }

      case 'cerrar-clase': {
        const s = getSesion(interaction.guildId);
        if (!s.activa) { await interaction.editReply('No hay ninguna clase activa en este momento.'); break; }
        s.activa = false;

        // Incrementar contador de clases totales
        const guildId = interaction.guildId;
        clasesTotales.set(guildId, (clasesTotales.get(guildId) || 0) + 1);

        // Guardar presentes de hoy en sesión para /alumnos post-clase
        s.presentesUltimaClase = [...s.asistentes.entries()].map(([uid, a]) => ({ uid, nombre: a.nombre, hora: a.hora, metodo: a.metodo||'gps' }));
        s.fechaUltimaClase = s.fecha;
        const totalClases = clasesTotales.get(guildId);
        guardarDatos();

        const lista   = [...s.asistentes.values()];
        const metodoStr = a => a.metodo === 'codigo' ? ' 🔑' : a.metodo === 'gps' ? ` 📍${a.distancia ? ' '+a.distancia+'m' : ''}` : '';
        const resumen = lista.length ? lista.map((a,i) => `${i+1}. **${a.nombre}** — ${a.hora}${metodoStr(a)}`).join('\n') : 'Sin presentes.';
        await interaction.editReply(safe(`📋 **Clase cerrada — ${s.fecha}**\n👥 **${lista.length} presentes** · Clase #${totalClases} del cuatrimestre\n\n${resumen}\n\n📊 Guardado en Google Sheets.\n⏳ Generando resumen con IA...`));

        // DM a alumnos ausentes — solo del mismo servidor y que hayan asistido antes
        const presentesIds = new Set(s.asistentes.keys());
        for (const [uid, reg] of registros.entries()) {
          if (reg.guildId !== interaction.guildId) continue; // otro servidor
          if (presentesIds.has(uid)) continue;               // ya estaban presentes
          const pDatos = puntos.get(uid);
          if (!pDatos || !pDatos.asistencias) continue;      // nunca asistieron = no avisar
          try {
            const user = await client.users.fetch(uid);
            const pct  = Math.round((pDatos.asistencias / totalClases) * 100);
            await user.send(
              '📌 **Faltaste a la clase de hoy** — ' + s.fecha + '\n' +
              '📚 ' + (s.titulo||'Clase') + ' · ' + (interaction.guild?.name||'') + '\n\n' +
              'Tu asistencia: **' + pDatos.asistencias + '/' + totalClases + '** clases (' + pct + '%)\n' +
              '_Si tenés una justificación, avisale al profesor._'
            );
          } catch {}
        }

        // Generar resumen automático con IA si hubo preguntas
        try {
          const pregsTexto = s.preguntas.length
            ? s.preguntas.map(p => `- ${p.autor}: "${p.pregunta}"`).join('\n')
            : null;
          const mat = detectarMateria(interaction.guildId, interaction.channel?.name);
          if (pregsTexto) {
            const r = await llamarIA({
              model: 'claude-sonnet-4-6', max_tokens: 800,
              messages: [{ role: 'user', content:
                `${CONTEXTOS[mat]||CONTEXTOS.iev}\n\nAnalizá las preguntas que hicieron los alumnos durante la clase de hoy y generá un resumen pedagógico para el profesor.\n\nPREGUNTAS DE LOS ALUMNOS:\n${pregsTexto}\n\nGenerá:\n📌 **Temas más consultados:** [lista de temas con mayor interés]\n💡 **Conceptos a reforzar:** [donde hubo más dudas]\n✅ **Lo que quedó claro:** [temas bien comprendidos]\n📚 **Recomendación para próxima clase:** [qué repasar o profundizar]\n\nSé concreto y pedagógico.`
              }]
            });
            const resumenIA = r.content[0].text;

            // Publicar en el canal
            await interaction.channel.send(safe(`🤖 **RESUMEN DE LA CLASE — ${s.fecha}**\n${interaction.guild?.name}\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n${resumenIA}\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n👥 Presentes: ${lista.length} | 💬 Preguntas: ${s.preguntas.length}\n*Mentor 🎓 — Resumen automático*`));

            // DM al profesor
            if (PROFESOR_ID) {
              try {
                const prof = await interaction.client.users.fetch(PROFESOR_ID);
                await prof.send(safe(`📊 **Resumen de clase — ${s.titulo || 'Clase'}**\n${interaction.guild?.name} · ${s.fecha}\n\n${resumenIA}\n\n👥 ${lista.length} presentes · 💬 ${s.preguntas.length} preguntas`));
              } catch {}
            }
          } else {
            await interaction.channel.send(`📋 **Clase cerrada** — ${s.fecha}\n👥 ${lista.length} presentes | Sin preguntas registradas hoy.`);
          }
        } catch (e) { LOG.error('Error resumen IA', e); }
        break;
      }

      case 'asistencia': {
        const s = getSesion(interaction.guildId);
        if (!s.asistentes.size) { await interaction.editReply('No hay asistencia registrada hoy.'); break; }
        const lista = [...s.asistentes.values()];
        await interaction.editReply(safe(`📋 **Asistencia ${s.fecha}** — ${lista.length} presentes\n\n${lista.map((a,i)=>`${i+1}. **${a.nombre}** — ${a.hora}`).join('\n')}`));
        break;
      }

      case 'noticias':
        await interaction.editReply('Generando noticias, ya vuelvo...');
        publicarNoticias(interaction.guild).then(()=>interaction.editReply('📰 ¡Publicadas en #noticias-tech!')).catch(()=>interaction.editReply('❌ Error.'));
        break;

      case 'corregir': {
        const c = await corregirEntrega(interaction.options.getString('texto'), interaction.guildId, interaction.channel?.name);
        await interaction.editReply(safe(`🤖 **Corrección:**\n\n${c}\n\n*⚠️ Orientativa.*`));
        break;
      }

      case 'unidad': {
        const num = interaction.options.getInteger('numero');
        const u   = getUnidades(interaction.guildId, interaction.channel?.name);
        await interaction.editReply(u[num] || `❌ Esta materia no tiene unidad ${num}.`);
        break;
      }

      case 'preguntar': {
        const uid    = interaction.user.id;
        const espera = checkCooldown(uid);
        if (espera > 0) { await interaction.editReply(`Esperá ${espera} segundo${espera!==1?'s':''} antes de hacer otra pregunta.`); break; }
        const pregunta = interaction.options.getString('pregunta');
        // Verificar caché primero
        const cacheKey = getContexto(interaction.guildId, interaction.channel?.name).substring(0,30) + pregunta;
        let respText = getCache(cacheKey);
        if (!respText) {
          const r = await llamarIA({ model: 'claude-sonnet-4-6', max_tokens: 800, messages: [{ role: 'user', content: `${getContexto(interaction.guildId, interaction.channel?.name)}\n\nPregunta: ${pregunta}` }] });
          respText = r.content[0].text;
          setCache(cacheKey, respText);
        }
        const nombre   = interaction.member?.displayName || interaction.user.username;
        const pData    = darPuntos(uid, nombre, 'pregunta');
        const nuevosL  = verificarLogros(uid, nombre, pData, interaction.channel?.name);
        const s = getSesion(interaction.guildId);
        if (s.activa) s.preguntas.push({ pregunta: pregunta.substring(0,100), autor: nombre });
        const logroMsg = nuevosL.length ? '\n\n' + nuevosL.map(id => { const l = LOGROS.find(x=>x.id===id); return l ? `🏅 **¡Logro desbloqueado! ${l.emoji} ${l.nombre}** (+${l.pts} pts)` : ''; }).join('\n') : '';
        await interaction.editReply(safe(`${respText}\n\n+5 pts${logroMsg}`));
        break;
      }

      case 'ranking': {
        const top = getRanking();
        if (!top.length) { await interaction.editReply('No hay puntos todavía.'); break; }
        const M = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
        await interaction.editReply({ embeds: [{
          title: '🏆 Ranking 2026',
          color: colorRol(top[0][1].pts),
          description: top.map(([,p],i)=>`${M[i]} **${p.nombre}** — ${p.pts} pts ${getRol(p.pts).emoji}`).join('\n'),
          footer: { text: 'Asistencia +10 · Entrega +20 · Pregunta +5' },
        }] });
        break;
      }

      case 'mispuntos': {
        const uid    = interaction.user.id;
        const nombre = interaction.member?.displayName || interaction.user.username;
        if (!puntos.has(uid)) { await interaction.editReply('Todavía no tenés puntos. Marcá presencia o hacé una pregunta para empezar.'); break; }
        const p    = puntos.get(uid);
        const rol  = getRol(p.pts);
        const pos  = getPosicion(uid);
        const tot  = getRankingCompleto().length;
        const prox = p.pts >= 200 ? '' : p.pts >= 100 ? ` · Faltan ${200-p.pts} pts para Experto Digital 🏆` : p.pts >= 50 ? ` · Faltan ${100-p.pts} pts para Colaborador ⭐` : ` · Faltan ${50-p.pts} pts para Aprendiz 📚`;
        const logrosObtenidos  = (p.logros||[]).map(id=>{ const l=LOGROS.find(x=>x.id===id); return l?l.emoji:''; }).join(' ') || '—';
        const totalCls  = clasesTotales.get(interaction.guildId) || 0;
        const pctAsist  = totalCls > 0 ? Math.round((p.asistencias / totalCls) * 100) : 0;
        const semaforo  = pctAsist >= 80 ? '🟢' : pctAsist >= 60 ? '🟡' : '🔴';
        const asistStr  = totalCls > 0
          ? `\`${barraProgreso(pctAsist)}\` ${semaforo} **${pctAsist}%** — ${p.asistencias}/${totalCls} clases (necesitás 80% para regularizar)`
          : `Todavía no hay clases dictadas — ${p.asistencias} asistencia${p.asistencias!==1?'s':''} registrada${p.asistencias!==1?'s':''}`;
        await interaction.editReply({ embeds: [{
          title: `${rol.emoji} ${nombre} — ${rol.nombre}`,
          color: colorRol(p.pts),
          description: prox ? `_${prox.replace(' · ','')}_` : '_Nivel máximo alcanzado_',
          fields: [
            { name: '📊 Puntos', value: `**${p.pts} pts** · Posición #${pos} de ${tot} · 🔥 Racha ${p.streak||0}`, inline: false },
            { name: '✅ Asistencia', value: asistStr, inline: false },
            { name: '📤 Entregas', value: `${p.entregas} (+${p.entregas*20} pts)`, inline: true },
            { name: '💬 Preguntas', value: `${p.preguntas} (+${p.preguntas*5} pts)`, inline: true },
            { name: '🏅 Logros', value: `${logrosObtenidos}\nUsá /mislogros para el detalle`, inline: false },
          ],
        }] });
        break;
      }

      case 'tarjeta': {
        if (!canvasLib) { await interaction.editReply('❌ La generación de imágenes no está disponible todavía en este servidor.'); break; }
        const uid    = interaction.user.id;
        const nombre = getNombreReal(uid, interaction.member?.displayName || interaction.user.username);
        if (!puntos.has(uid)) { await interaction.editReply('Todavía no tenés puntos. Marcá presencia o hacé una pregunta para empezar.'); break; }
        const p   = puntos.get(uid);
        const pos = getPosicion(uid);
        const tot = getRankingCompleto().length;
        try {
          const buffer = await generarTarjetaRango(interaction.member, nombre, p, pos, tot);
          const archivo = new AttachmentBuilder(buffer, { name: 'tarjeta.png' });
          await interaction.editReply({ files: [archivo] });
        } catch (e) {
          LOG.error('Error generando tarjeta de rango', e);
          await interaction.editReply('❌ No se pudo generar la tarjeta. Probá de nuevo en un rato.');
        }
        break;
      }

      case 'entrega':
        await interaction.editReply('Para entregar un trabajo:\n\n1. Andá al canal **#entregas** de tu materia\n2. Escribí cualquier mensaje para abrir el formulario\n3. Seguí los 4 pasos\n4. Recibirás una corrección automática como orientación\n\nNo se aceptan entregas por WhatsApp o mensajes privados.');
        break;

      case 'herramientas':
        await interaction.editReply(HERRAMIENTAS[detectarMateria(interaction.guildId, interaction.channel?.name)] || HERRAMIENTAS.iev);
        break;

      case 'craap': {
        const url = interaction.options.getString('url');
        const r   = await llamarIA({ model: 'claude-sonnet-4-6', max_tokens: 800, messages: [{ role: 'user', content: `${getContexto(interaction.guildId, interaction.channel?.name)}\n\nEvaluá "${url}" con criterio CRAAP. Puntuá 1-5 cada dimensión y dá conclusión final.` }] });
        await interaction.editReply(safe(`🔍 **CRAAP: \`${url}\`**\n\n${r.content[0].text}`));
        break;
      }

      case 'moodle': {
        const mc = getMC(interaction.guild?.name);
        if (!mc.token) { await interaction.editReply(`❌ Token no configurado para ${mc.nombre}`); break; }
        const c = await getCursos(mc.url, mc.token);
        if (!c)        { await interaction.editReply(`No se pudo conectar con Moodle ${mc.nombre}. Intentá más tarde.`); break; }
        if (c._error)  { await interaction.editReply(`❌ Error Moodle: ${c._error}`); break; }
        await interaction.editReply(`✅ Moodle **${mc.nombre}** conectado — ${Array.isArray(c)?c.length:0} cursos`);
        break;
      }

      case 'miscursos': {
        const mc = getMC(interaction.guild?.name);
        const c  = await getCursos(mc.url, mc.token);
        if (!Array.isArray(c)) { await interaction.editReply('❌ No se pudo obtener los cursos.'); break; }
        const act = c.filter(x => x.visible===1 && x.id>1);
        if (!act.length) { await interaction.editReply('No hay cursos activos en este momento.'); break; }
        await interaction.editReply(`📚 **Cursos Moodle ${mc.nombre}:**\n\n${act.slice(0,15).map(x=>`#${x.id} — ${x.fullname}`).join('\n')}\n\nUsá /actividades curso:[id]`);
        break;
      }

      case 'actividades': {
        const mc   = getMC(interaction.guild?.name);
        const cid  = interaction.options.getInteger('curso');
        const secs = await getActividadesMoodle(mc.url, mc.token, cid);
        if (!Array.isArray(secs)) { await interaction.editReply('❌ No se pudo obtener las actividades.'); break; }
        let msg = `📋 **Actividades #${cid}:**\n`; let tot = 0;
        for (const s of secs.slice(0,5)) {
          if (!s.modules?.length) continue;
          msg += `\n**${s.name}:**\n`;
          for (const m of s.modules.slice(0,5)) { msg += `  • ${m.name} (${m.modname})\n`; tot++; }
        }
        await interaction.editReply(tot ? safe(msg) : 'No se encontraron actividades en este curso.');
        break;
      }

      case 'misnota': {
        const mc  = getMC(interaction.guild?.name);
        const nb  = interaction.options.getString('nombre');
        const usr = await getUserByName(mc.url, mc.token, nb);
        if (!usr) { await interaction.editReply(`❌ No encontré **${nb}** en Moodle ${mc.nombre}.`); break; }
        const cs  = await getCursos(mc.url, mc.token);
        if (!Array.isArray(cs)) { await interaction.editReply('No se pudo obtener los cursos.'); break; }
        let msg = `📊 **Notas de ${usr.fullname}:**\n`;
        for (const c of cs.filter(x=>x.visible===1&&x.id>1).slice(0,3)) {
          const n = await getNotas(mc.url, mc.token, usr.id, c.id);
          if (!n?.usergrades?.length) continue;
          msg += `\n**${c.shortname}:**\n`;
          for (const item of (n.usergrades[0]?.gradeitems||[]).slice(0,5))
            msg += `  • ${item.itemname}: **${item.gradeformatted||'Sin calificar'}**\n`;
        }
        await interaction.editReply(safe(msg||'No se encontraron notas.'));
        break;
      }

      case 'evento': {
        const titulo = interaction.options.getString('titulo');
        const fecha  = interaction.options.getString('fecha');
        const tipo   = interaction.options.getString('tipo');
        const desc   = interaction.options.getString('descripcion') || '';
        if (!parseFecha(fecha)) { await interaction.editReply('❌ Fecha inválida. Formato: dd/mm/yyyy'); break; }
        const id = eventoCounter++;
        eventos.set(id, { titulo, fecha, tipo, descripcion: desc, av3: false, av1: false, av0: false });
        guardarDatos();
        const d = diasHasta(parseFecha(fecha));
        await interaction.editReply(`${emojiTipo(tipo)} **#${id} — ${titulo}**\n📅 ${fecha} (${d<0?'ya pasó':d===0?'HOY':'en '+d+' días'})\n\nAvisaré 3 días antes, 1 día antes y el mismo día en #aviso.`);
        break;
      }

      case 'calendario': {
        const lista   = [...eventos.entries()].sort((a,b) => parseFecha(a[1].fecha) - parseFecha(b[1].fecha));
        const futuros = lista.filter(([,ev]) => diasHasta(parseFecha(ev.fecha)) >= 0);
        const pasados = lista.filter(([,ev]) => diasHasta(parseFecha(ev.fecha)) < 0);
        let msg = '📅 **CALENDARIO DEL CUATRIMESTRE**\n\n';
        if (futuros.length) msg += '**Próximos:**\n\n' + fmtEventos(futuros);
        if (pasados.length) msg += '\n\n**Pasados:**\n\n' + fmtEventos(pasados);
        if (!lista.length)  msg += 'No hay eventos. El profesor puede agregar con /evento';
        await enviarLargo(interaction, msg);
        break;
      }

      case 'proximo': {
        const f = [...eventos.entries()].filter(([,ev])=>diasHasta(parseFecha(ev.fecha))>=0).sort((a,b)=>parseFecha(a[1].fecha)-parseFecha(b[1].fecha));
        if (!f.length) { await interaction.editReply('No hay eventos próximos.'); break; }
        const [,ev] = f[0]; const d = diasHasta(parseFecha(ev.fecha));
        await interaction.editReply(`${emojiTipo(ev.tipo)} **${ev.titulo}**\n📅 **${ev.fecha}** — ${d===0?'**HOY**':d===1?'mañana':'en **'+d+' días**'}${ev.descripcion?'\n📋 '+ev.descripcion:''}`);
        break;
      }

      case 'borrar-evento': {
        const id = interaction.options.getInteger('id');
        if (!eventos.has(id)) { await interaction.editReply(`❌ No existe el evento #${id}`); break; }
        const ev = eventos.get(id); eventos.delete(id); guardarDatos();
        await interaction.editReply(`✅ Evento **${ev.titulo}** eliminado.`);
        break;
      }

      case 'quiz': {
        const unum = interaction.options.getInteger('unidad');
        const uid  = interaction.user.id;
        await interaction.editReply('🧠 Generando pregunta...');
        const r = await llamarIA({
          model: 'claude-sonnet-4-6', max_tokens: 500,
          messages: [{ role: 'user', content: `${getContexto(interaction.guildId, interaction.channel?.name)}\n\nGenerá UNA pregunta de opción múltiple sobre la Unidad ${unum}. SOLO JSON sin markdown: {"pregunta":"...","opciones":["A) ...","B) ...","C) ...","D) ..."],"correcta":"A","explicacion":"..."}` }]
        });
        let qd;
        try { qd = JSON.parse(r.content[0].text.replace(/```json|```/g,'').trim()); }
        catch { await interaction.editReply('❌ Error generando pregunta. Intentá de nuevo.'); break; }
        quizActivo.set(uid, { ...qd, unidad: unum, respondido: false });
        await interaction.editReply({ content: safe(`🧠 **Quiz U${unum}**\n\n${qd.pregunta}\n\n${qd.opciones.join('\n')}\n\nSeleccioná:`), components: [
          new ActionRowBuilder().addComponents(
            ...'ABCD'.split('').map(l => new ButtonBuilder().setCustomId(`quiz_${l}_${uid}`).setLabel(l).setStyle(ButtonStyle.Secondary))
          )
        ]});
        break;
      }

      case 'desafio': {
        const mat = interaction.options.getString('materia').toLowerCase();
        await interaction.editReply('⏳ Generando desafio...');
        const r  = await llamarIA({ model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: `${CONTEXTOS[mat]||CONTEXTOS.iev}\n\nGenerá un desafio semanal. Formato: DESAFIO: [título] ENUNCIADO: [3-5 líneas] PISTA: [sin solución] DIFICULTAD: [Básico/Intermedio/Avanzado]` }] });
        const id = desafioCounter++;
        desafioActivo = id;
        desafios.set(id, { enunciado: r.content[0].text, materia: mat, soluciones: new Map() });
        await interaction.editReply('✅ Desafio publicado.');
        await interaction.channel.send(safe(`🏆 **DESAFIO SEMANAL #${id}**\n\n${r.content[0].text}\n\n+25 pts. Usá /solucionar para enviar tu respuesta.`));
        break;
      }

      case 'solucionar': {
        if (!desafioActivo || !desafios.has(desafioActivo)) { await interaction.editReply('❌ No hay desafio activo.'); break; }
        const des    = desafios.get(desafioActivo);
        const uid    = interaction.user.id;
        const nombre = interaction.member?.displayName || interaction.user.username;
        const codigo = interaction.options.getString('codigo');
        if (des.soluciones.has(uid)) { await interaction.editReply('✅ Ya enviaste una solución.'); break; }
        des.soluciones.set(uid, { nombre, codigo, hora: horaAR() });
        const p  = darPuntos(uid, nombre, 'entrega');
        const p2 = darPuntos(uid, nombre, 'pregunta');
        await actualizarRol(interaction.member, p2.pts, interaction.channel);
        const ev = await llamarIA({ model: 'claude-sonnet-4-6', max_tokens: 400, messages: [{ role: 'user', content: `${CONTEXTOS[des.materia]||CONTEXTOS.iev}\nDesafio: ${des.enunciado}\nSolución de ${nombre}: ${codigo}\nEvaluá brevemente. Sé pedagógico y alentador.` }] });
        await interaction.editReply(safe(`✅ **${nombre}** — solución registrada.\n\n🤖 ${ev.content[0].text}\n\n📤 +25 pts | Total: **${p2.pts} pts**`));
        break;
      }

      case 'soluciones': {
        if (!desafioActivo || !desafios.has(desafioActivo)) { await interaction.editReply('No hay desafio activo.'); break; }
        const des = desafios.get(desafioActivo);
        if (!des.soluciones.size) { await interaction.editReply('Ningún alumno envió solución todavía.'); break; }
        const lista = [...des.soluciones.values()].map((s,i) => `${i+1}. **${s.nombre}** (${s.hora}): ${s.codigo.substring(0,80)}`).join('\n');
        await interaction.editReply(safe(`📋 **Soluciones (${des.soluciones.size}):**\n\n${lista}`));
        break;
      }

      case 'cerrar-desafio': {
        if (!desafioActivo || !desafios.has(desafioActivo)) { await interaction.editReply('No hay desafio activo.'); break; }
        const des = desafios.get(desafioActivo);
        if (!des.soluciones.size) { desafioActivo = null; await interaction.editReply('Cerrado sin participantes.'); break; }
        const [gid, gd] = [...des.soluciones.entries()][0];
        const gm = await interaction.guild.members.fetch(gid).catch(()=>null);
        const pG = darPuntos(gid, gd.nombre, 'desafio');
        if (gm) await actualizarRol(gm, pG.pts, interaction.channel);
        desafioActivo = null;
        await interaction.editReply('✅ Desafio cerrado.');
        await interaction.channel.send(`🏆 **DESAFIO CERRADO** — ${des.soluciones.size} participantes\n🥇 **${gd.nombre}** — primera solución (${gd.hora})\n\n¡Felicitaciones a todos! Usá /ranking.`);
        break;
      }

      case 'tarea': {
        const titulo = interaction.options.getString('titulo');
        const desc   = interaction.options.getString('descripcion');
        const fecha  = interaction.options.getString('fecha');
        if (!parseFecha(fecha)) { await interaction.editReply('❌ Fecha inválida. Formato: dd/mm/yyyy'); break; }
        const id = tareaCounter++;
        tareas.set(id, { titulo, descripcion: desc, fecha, canal: interaction.channelId, completados: new Set() });
        guardarDatos();
        const botones = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`completar_${id}`).setLabel('✅  Marcar como completada').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`vercompletados_${id}`).setLabel('👥  Ver quién completó').setStyle(ButtonStyle.Secondary)
        );
        await interaction.editReply('✅ Tarea publicada.');
        await interaction.channel.send({ content: `📚 **NUEVA TAREA #${id}**\n\n📌 **${titulo}**\n\n${desc}\n\n⏰ **Fecha límite:** ${fecha}`, components: [botones] });
        const rem = parseFecha(fecha).getTime() - Date.now() - 86400000;
        if (rem > 0) setTimeout(async () => {
          const t = tareas.get(id);
          if (t) { const c = interaction.guild.channels.cache.get(t.canal); if (c) await c.send(`⚠️ **Recordatorio:** **"${t.titulo}"** vence mañana **${t.fecha}** — ${t.completados.size} completaron.`); }
        }, rem);
        break;
      }

      case 'tareas': {
        if (!tareas.size) { await interaction.editReply('No hay tareas activas.'); break; }
        const lista = [...tareas.entries()].map(([id,t]) => `**#${id} — ${t.titulo}**\n⏰ ${t.fecha} | ✅ ${t.completados.size} completaron`).join('\n\n');
        await interaction.editReply(safe(`📚 **Tareas activas:**\n\n${lista}`));
        break;
      }

      case 'completar': {
        const id    = interaction.options.getInteger('id');
        const tarea = tareas.get(id);
        if (!tarea) { await interaction.editReply(`❌ No existe la tarea #${id}.`); break; }
        const uid    = interaction.user.id;
        const nombre = interaction.member?.displayName || interaction.user.username;
        if (tarea.completados.has(uid)) { await interaction.editReply(`✅ **${nombre}**, ya marcaste esta tarea.`); break; }
        tarea.completados.add(uid); guardarDatos();
        const p = darPuntos(uid, nombre, 'entrega');
        await actualizarRol(interaction.member, p.pts, interaction.channel);
        await interaction.editReply(`✅ **${nombre}** completó **"${tarea.titulo}"**\n📤 +20 pts | Total: **${p.pts} pts** ${getRol(p.pts).emoji}`);
        break;
      }

      case 'similitudes': {
        if (!entregasPorActiv.size) { await interaction.editReply('No hay entregas registradas aún.'); break; }
        let msg = '🔍 **Entregas por actividad:**\n\n';
        for (const [act, lista] of entregasPorActiv.entries())
          msg += `📚 **${act}** — ${lista.length} entrega${lista.length!==1?'s':''}\n${lista.map(e=>`  · ${e.nombre} (${e.hora})`).join('\n')}\n\n`;
        await enviarLargo(interaction, msg);
        break;
      }

      // ── CONFIRMAR PRESENCIA GPS ──
      case 'codigo': {
        const sesion  = getSesion(interaction.guildId);
        if (!sesion.activa) { await interaction.editReply('No hay ninguna clase activa en este momento.'); break; }
        if (sesion.tokenTs && (Date.now() - sesion.tokenTs) > VENTANA_ASISTENCIA_MS) {
          sesion.activa = false;
          await interaction.editReply('La ventana de asistencia (20 min) ya cerró. Avisale al profesor si llegaste tarde.');
          break;
        }
        const uid     = interaction.user.id;
        const nombre  = getNombreReal(uid, interaction.member?.displayName || interaction.user.username);
        if (sesion.asistentes.has(uid)) { await interaction.editReply(`${nombre}, ya marcaste presente.`); break; }
        const valorIngresado = interaction.options.getString('valor');
        if (valorIngresado !== sesion.codigoClase) {
          await interaction.editReply(`Código incorrecto. Fijate en el pizarrón e intentá de nuevo.`);
          break;
        }
        // Código correcto — registrar presencia
        const hora = horaAR();
        sesion.asistentes.set(uid, { nombre, hora, metodo: 'codigo' });
        const mat = detectarMateria(interaction.guildId, interaction.channel?.name);
        await guardarAsistencia(nombre, sesion.fecha, hora, mat, interaction.guild?.name || '');
        // Guardar materia en el perfil del alumno
        if (!registros.has(uid)) registros.set(uid, { nombreReal: nombre, discordUser: interaction.user.username, materia: mat, guildId: interaction.guildId, registradoEn: ahoraAR() });
        else if (!registros.get(uid).materia) { const r = registros.get(uid); r.materia = mat; r.guildId = interaction.guildId; registros.set(uid, r); }
        const p   = darPuntos(uid, nombre, 'asistencia');
        const rol = getRol(p.pts);
        await actualizarRol(interaction.member, p.pts, interaction.channel);
        const nuevosLogros = verificarLogros(uid, nombre, p, interaction.channel?.name);
        const logroTxt = nuevosLogros.length ? nuevosLogros.map(id => { const l = LOGROS.find(x=>x.id===id); return l ? `🏅 ${l.emoji} ${l.nombre}` : ''; }).join('\n') : null;
        const prog = progresoProximoNivel(p.pts);
        const campos = [
          { name: '🕐 Hora', value: hora, inline: true },
          { name: '🔥 Racha', value: `${p.streak || 0} clases`, inline: true },
          { name: '📍 Ubicación', value: 'Sin verificar — código del pizarrón', inline: true },
        ];
        if (prog) campos.push({ name: `Próximo nivel — faltan ${prog.faltan} pts`, value: `\`${barraProgreso(prog.pct)}\` ${prog.pct}%`, inline: false });
        if (logroTxt) campos.push({ name: '🏅 ¡Nuevo logro!', value: logroTxt, inline: false });
        await interaction.editReply({ embeds: [{
          title: `${rol.emoji} ${nombre} — presencia registrada`,
          color: colorRol(p.pts),
          description: `+10 pts → **${p.pts} pts** totales`,
          fields: campos,
        }] });
        break;
      }

      // ── QR DE ASISTENCIA ──
      case 'qr-clase': {
        const s = getSesion(interaction.guildId);
        if (!s.activa) { await interaction.editReply('Primero iniciá la clase con `/iniciar-clase`.'); break; }
        if (!s.mensajeAsistenciaUrl) { await interaction.editReply('No encontré el mensaje de asistencia. Cerrá la clase e iniciála nuevamente.'); break; }

        // El QR abre el mensaje original de Discord. Allí cada alumno pulsa el botón,
        // y Discord genera un enlace GPS individual y firmado para su propia cuenta.
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(s.mensajeAsistenciaUrl)}&size=500x500&margin=24&bgcolor=ffffff&color=1e40af`;
        await interaction.editReply({
          embeds: [{
            title: `Código QR de asistencia · ${s.titulo || 'Clase'}`,
            description:
              `Proyectá este QR. Al escanearlo, el alumno abre el mensaje de asistencia en Discord y pulsa **Registrar asistencia**.

` +
              `Así cada enlace queda asociado y firmado para la cuenta correcta.

` +
              `⏳ Vigencia restante: **${Math.max(0, Math.ceil((VENTANA_ASISTENCIA_MS - (Date.now() - s.tokenTs)) / 60000))} minutos**`,
            color: 0x2563eb,
            image: { url: qrUrl },
            footer: { text: `Mentor 🎓 · ${interaction.guild?.name || ''}` }
          }]
        });
        break;
      }

      // ── ENCUESTA EN VIVO ──
      case 'encuesta': {
        const pregunta = interaction.options.getString('pregunta');
        const optsRaw  = interaction.options.getString('opciones');
        const minutos  = interaction.options.getInteger('minutos') || 2;
        const opciones = optsRaw.split('|').map(o => o.trim()).filter(Boolean).slice(0, 5);
        if (opciones.length < 2) { await interaction.editReply('❌ Necesitás al menos 2 opciones separadas por |'); break; }
        const guildId  = interaction.guildId;
        const cierra   = Date.now() + minutos * 60000;
        encuestas.set(guildId, { pregunta, opciones, votos: new Map(), cierra, msgId: null, canal: interaction.channelId });
        const emojis   = ['🔵','🟢','🟡','🟠','🔴'];
        const botones  = new ActionRowBuilder().addComponents(
          ...opciones.map((op, i) => new ButtonBuilder().setCustomId(`enc_${i}`).setLabel(`${emojis[i]} ${op.substring(0,60)}`).setStyle(ButtonStyle.Secondary))
        );
        await interaction.editReply({
          content: safe(
            `🗳️ **ENCUESTA EN VIVO**\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `**${pregunta}**\n\n` +
            `${opciones.map((op, i) => `${emojis[i]} ${op}`).join('\n')}\n\n` +
            `⏰ Cerrá en ${minutos} minuto${minutos > 1 ? 's' : ''} · Votá haciendo clic:`
          ),
          components: [botones]
        });
        const msg = await interaction.fetchReply();
        const enc = encuestas.get(guildId);
        if (enc) enc.msgId = msg.id;

        // Auto-cerrar y mostrar resultados
        setTimeout(async () => {
          const enc = encuestas.get(guildId);
          if (!enc) return;
          encuestas.delete(guildId);
          const total = enc.votos.size;
          const conteo = {};
          for (const v of enc.votos.values()) conteo[v] = (conteo[v]||0) + 1;
          const barras = enc.opciones.map((op, i) => {
            const cnt  = conteo[i] || 0;
            const pct  = total > 0 ? Math.round(cnt/total*100) : 0;
            const bar  = '█'.repeat(Math.round(pct/5)) + '░'.repeat(20-Math.round(pct/5));
            return `${emojis[i]} **${op}**\n\`${bar}\` ${pct}% (${cnt} voto${cnt!==1?'s':''})`;
          }).join('\n\n');
          const canal = interaction.guild?.channels.cache.get(enc.canal);
          if (canal) await canal.send(safe(`📊 **RESULTADOS — ${enc.pregunta}**\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n${barras}\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n👥 Total de votos: **${total}**`)).catch(()=>{});
        }, minutos * 60000);
        break;
      }

      // ── PERFIL ACADÉMICO COMPLETO ──
      case 'perfil': {
        const targetUser = interaction.options.getUser('alumno');
        const uid   = targetUser ? targetUser.id : interaction.user.id;
        if (targetUser && !esProfesor(interaction.user.id)) { await interaction.editReply('❌ Solo el profesor puede ver perfiles de otros alumnos.'); break; }
        const nombreRealP = getNombreReal(uid, targetUser?.username || interaction.member?.displayName || interaction.user.username);
        const p     = puntos.get(uid);
        const reg   = registros.get(uid);
        const hist  = historial.get(uid) || [];
        const rol   = p ? getRol(p.pts) : { nombre: 'Sin actividad', emoji: '⚪' };
        const pos   = p ? getPosicion(uid) : '—';
        const logrosObj = (p?.logros||[]).map(id => { const l = LOGROS.find(x=>x.id===id); return l ? `${l.emoji}` : ''; }).join(' ') || '—';
        const totalCls = clasesTotales.get(interaction.guildId) || 0;
        const pctAsist = totalCls > 0 && p ? Math.round((p.asistencias / totalCls) * 100) : null;

        // Predicción IA
        let prediccion = '';
        if (p && p.asistencias >= 2) {
          const pctPred = Math.round((p.asistencias / Math.max(p.asistencias + 2, 5)) * 100);
          if (pctPred >= 80 && p.entregas >= 2) prediccion = '🟢 Alta probabilidad de regularizar';
          else if (pctPred >= 60 || p.entregas >= 1) prediccion = '🟡 Probabilidad media — necesita más entregas';
          else prediccion = '🔴 En riesgo — baja actividad';
        } else { prediccion = '⚪ Sin datos suficientes'; }

        const asistLinea = pctAsist === null
          ? `${p?.asistencias || 0} asistencia${(p?.asistencias||0)!==1?'s':''}`
          : `\`${barraProgreso(pctAsist)}\` ${pctAsist}% (${p.asistencias}/${totalCls})`;

        await interaction.editReply({ embeds: [{
          title: `${rol.emoji} ${nombreRealP}`,
          color: colorRol(p?.pts || 0),
          thumbnail: targetUser ? { url: targetUser.displayAvatarURL() } : { url: interaction.user.displayAvatarURL() },
          fields: [
            { name: '🎓 Carrera', value: reg?.carrera || 'No especificada', inline: true },
            { name: '💬 Discord', value: `@${reg?.discordUser || interaction.user.username}`, inline: true },
            { name: '📅 Registrado', value: reg?.registradoEn || 'Sin registro', inline: true },
            { name: '📊 Puntos y posición', value: `**${p?.pts || 0} pts** · #${pos} del ranking · 🔥 Racha ${p?.streak || 0}`, inline: false },
            { name: '✅ Asistencia', value: asistLinea, inline: false },
            { name: '📤 Entregas', value: `${p?.entregas || 0} trabajos`, inline: true },
            { name: '💬 Preguntas a la IA', value: `${p?.preguntas || 0}`, inline: true },
            { name: '🏅 Logros', value: `${logrosObj} (${(p?.logros||[]).length}/${LOGROS.length})`, inline: false },
            { name: '📋 Últimas entregas', value: hist.length ? hist.slice(-5).reverse().map((h,i) => `${i+1}. **${h.actividad}** — ${h.fecha}`).join('\n') : 'Sin entregas registradas', inline: false },
            { name: '🔮 Predicción', value: prediccion, inline: false },
          ],
          footer: { text: `Mentor 🎓 · ${fechaAR()}` },
        }] });
        break;
      }

      case 'nota': {
        const targetUser   = interaction.options.getUser('alumno');
        const nombreBuscar = interaction.options.getString('nombre');
        const actividad    = interaction.options.getString('actividad');
        const calificacion = interaction.options.getNumber('calificacion');
        const observacion  = interaction.options.getString('observacion') || '';
        if (!targetUser && !nombreBuscar) {
          await interaction.editReply('Indicá el alumno — escribí el nombre en el campo nombre o seleccioná con @alumno.');
          break;
        }
        let uid, nombreReal;
        if (targetUser) {
          uid = targetUser.id;
          nombreReal = getNombreReal(uid, targetUser.username);
        } else {
          const busq = nombreBuscar.toLowerCase().trim();
          const enc  = [...registros.entries()].find(([,r]) => r.nombreReal && r.nombreReal.toLowerCase().includes(busq));
          if (!enc) {
            const sug = [...registros.entries()].filter(([,r]) => r.nombreReal && r.nombreReal.toLowerCase().includes(busq.split(' ')[0])).slice(0,5).map(([,r]) => '• '+r.nombreReal+' (@'+(r.discordUser||'?')+')').join('\n');
            await interaction.editReply('No encontré "'+nombreBuscar+'".'+(sug ? '\n\nSimilares:\n'+sug+'\n\nProbá con más letras.' : '\nEse alumno no usó /registrarme todavía.'));
            break;
          }
          uid = enc[0]; nombreReal = enc[1].nombreReal;
        }
        const mat = detectarMateria(interaction.guildId, interaction.channel?.name);
        const MNOMS = { iev:'IEV', bd:'Base de Datos', informatica:'Informática', practica:'PP3', pybd:'PyBD', annum:'Análisis Numérico' };
        const matN = MNOMS[mat] || mat;
        const notaObj = { materia: matN, actividad, nota: calificacion, observacion, fecha: fechaAR(), guildId: interaction.guildId };
        if (!notas.has(uid)) notas.set(uid, []);
        const listaN = notas.get(uid);
        const idxN   = listaN.findIndex(n => n.actividad === actividad && n.materia === matN);
        if (idxN >= 0) listaN[idxN] = notaObj; else listaN.push(notaObj);
        notas.set(uid, listaN);
        guardarDatos();
        await guardarNotaSheets(nombreReal, matN, actividad, calificacion, observacion, interaction.guild?.name);
        const concepto = notaConceptual(calificacion);
        const emoji    = notaEmoji(calificacion);
        try { const u = await interaction.client.users.fetch(uid); await u.send('📝 **Nueva nota**\n\n📚 **'+actividad+'** — '+matN+'\n'+emoji+' **'+calificacion+'/10** — '+concepto+'\n'+(observacion?'💬 '+observacion+'\n':'')+'📅 '+fechaAR()+'\n\nUsá /misnotas para ver todas tus notas.'); } catch {}
        await interaction.editReply(emoji+' **Nota registrada** — '+nombreReal+'\n\n📚 **'+actividad+'** · '+matN+'\n**'+calificacion+'/10** — '+concepto+'\n'+(observacion?'💬 '+observacion+'\n':'')+'\n📧 El alumno fue notificado por DM.');
        break;
      }

      case 'misnotas': {
        const uid2 = interaction.user.id;
        const nom2 = getNombreReal(uid2, interaction.member?.displayName || interaction.user.username);
        const lst2 = notas.get(uid2);
        if (!lst2?.length) { await interaction.editReply('Todavía no tenés notas registradas.'); break; }
        const pm2 = {};
        for (const n of lst2) { if (!pm2[n.materia]) pm2[n.materia]=[]; pm2[n.materia].push(n); }
        let msg2 = '📝 **Notas de '+nom2+'**\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        let s2=0,c2=0;
        for (const [mat, ns] of Object.entries(pm2)) {
          const pr = Math.round(ns.reduce((a,n)=>a+n.nota,0)/ns.length*10)/10;
          msg2 += '**'+mat+'** — prom: '+notaEmoji(pr)+' '+pr+'/10\n';
          for (const n of ns) msg2 += '  • '+n.actividad+': **'+n.nota+'/10** ('+notaConceptual(n.nota)+')'+(n.observacion?' — '+n.observacion:'')+'\n';
          msg2 += '\n'; s2+=ns.reduce((a,n)=>a+n.nota,0); c2+=ns.length;
        }
        const pf2 = c2>0?Math.round(s2/c2*10)/10:0;
        msg2 += '━━━━━━━━━━━━━━━━━━━━━━━━\n'+notaEmoji(pf2)+' **Promedio general: '+pf2+'/10** — '+notaConceptual(pf2);
        await enviarLargo(interaction, msg2);
        break;
      }

      case 'notas-alumno': {
        const tU = interaction.options.getUser('alumno');
        const un = tU.id;
        const nn = getNombreReal(un, tU.username);
        const ln = notas.get(un);
        if (!ln?.length) { await interaction.editReply(nn+' todavía no tiene notas registradas.'); break; }
        const pm3 = {};
        for (const n of ln) { if (!pm3[n.materia]) pm3[n.materia]=[]; pm3[n.materia].push(n); }
        let msg3 = '📝 **Notas de '+nn+'**\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        let s3=0,c3=0;
        for (const [mat, ns] of Object.entries(pm3)) {
          const pr = Math.round(ns.reduce((a,n)=>a+n.nota,0)/ns.length*10)/10;
          msg3 += '**'+mat+'** — prom: '+notaEmoji(pr)+' '+pr+'/10\n';
          for (const n of ns) msg3 += '  • '+n.actividad+': **'+n.nota+'/10** ('+notaConceptual(n.nota)+') · '+n.fecha+(n.observacion?'\n    _'+n.observacion+'_':'')+'\n';
          msg3 += '\n'; s3+=ns.reduce((a,n)=>a+n.nota,0); c3+=ns.length;
        }
        const pf3 = c3>0?Math.round(s3/c3*10)/10:0;
        msg3 += '━━━━━━━━━━━━━━━━━━━━━━━━\n'+notaEmoji(pf3)+' **Promedio: '+pf3+'/10**';
        await enviarLargo(interaction, msg3);
        break;
      }

      case 'boletin-notas': {
        if (!notas.size) { await interaction.editReply('No hay notas registradas todavía.'); break; }
        let msgB = '📋 **Boletín — '+interaction.guild?.name+'**\n📅 '+fechaAR()+'\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        const alumnosGrafico = [];
        for (const [uid, lista] of notas.entries()) {
          if (!lista.length) continue;
          const nom = getNombreReal(uid, puntos.get(uid)?.nombre || uid);
          const pr  = Math.round(lista.reduce((a,n)=>a+n.nota,0)/lista.length*10)/10;
          msgB += notaEmoji(pr)+' **'+nom+'** — '+pr+'/10 ('+lista.length+' actividad'+(lista.length!==1?'es':'')+')'+'\n';
          alumnosGrafico.push({ nombre: nom, promedio: pr });
        }
        msgB += '\n━━━━━━━━━━━━━━━━━━━━━━━━\nUsá /notas-alumno para el detalle.';

        if (canvasLib && alumnosGrafico.length) {
          try {
            const buffer = generarGraficoBoletin(alumnosGrafico, `Boletín — ${interaction.guild?.name || ''}`);
            if (buffer) {
              const archivo = new AttachmentBuilder(buffer, { name: 'boletin.png' });
              await interaction.editReply({ content: safe(msgB, 1900), files: [archivo] });
              break;
            }
          } catch (e) { LOG.error('Error generando gráfico de boletín', e); }
        }
        await enviarLargo(interaction, msgB);
        break;
      }

      case 'anuncio': {
        const matSel  = interaction.options.getString('materia');
        const mensaje = interaction.options.getString('mensaje');
        const dias    = interaction.options.getInteger('dias');
        const MNOMS   = { bd:'Base de Datos', informatica:'Informatica', iev:'IEV', practica:'PP3', pybd:'PyBD', annum:'Analisis Numerico', todos:'Todos' };
        const matNom  = MNOMS[matSel] || matSel;

        const fechaLimite = dias ? (() => {
          const f = new Date(); f.setDate(f.getDate() + dias);
          return f.toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' });
        })() : null;

        const esEntrega = mensaje.toLowerCase().includes('entrega') || mensaje.toLowerCase().includes('practico') || mensaje.toLowerCase().includes('tp') || mensaje.toLowerCase().includes('docker');

        const msgDM = [
          '📢 **Anuncio — ' + (interaction.guild?.name||'IES') + '**',
          '📚 **' + matNom + '**',
          '━━━━━━━━━━━━━━━━━━━━━━━━',
          '',
          mensaje,
          '',
          fechaLimite ? ('⏰ **Fecha limite: ' + fechaLimite + '** (' + dias + ' dia' + (dias!==1?'s':'') + ')') : '',
          esEntrega ? '📤 Entrega por el canal #entregas de tu materia en Discord.' : '',
          '_Para consultas usa /preguntar o el canal de dudas._'
        ].filter(Boolean).join('\n');

        const MMAP = { bd:'Base de Datos', informatica:'Informatica', iev:'IEV', practica:'PP3', pybd:'PyBD', annum:'Analisis Numerico' };

        // Buscar en registros por materia
        let destinatarios = [...registros.entries()].filter(([uid, r]) => {
          if (matSel === 'todos') return r.guildId === interaction.guildId;
          return (r.materia === MMAP[matSel] || (r.materia||'').toLowerCase().includes(matSel)) && r.guildId === interaction.guildId;
        });

        // Si no encontró por materia, usar TODOS los registrados del servidor
        // (pasa cuando los alumnos se registraron antes de que se guardara la materia)
        if (!destinatarios.length && matSel !== 'todos') {
          destinatarios = [...registros.entries()].filter(([uid, r]) => r.guildId === interaction.guildId);
          if (destinatarios.length) {
            await interaction.editReply('No encontré alumnos con materia "' + matNom + '" asignada. Enviando a todos los registrados del servidor (' + destinatarios.length + ')...');
          }
        }

        // Si sigue sin haber, buscar en puntos (alumnos que asistieron pero no se registraron)
        if (!destinatarios.length) {
          const idsRegistrados = new Set(registros.keys());
          const desPuntos = [...puntos.entries()].filter(([uid]) => !idsRegistrados.has(uid));
          if (desPuntos.length) {
            await interaction.editReply('No hay alumnos con /registrarme. Enviando a ' + desPuntos.length + ' alumnos que asistieron a clase...');
            let env2 = 0, fall2 = 0;
            for (const [uid, p] of desPuntos) {
              try { const u = await client.users.fetch(uid); await u.send(msgDM); env2++; }
              catch { fall2++; }
              await new Promise(r => setTimeout(r, 300));
            }
            await interaction.editReply('Anuncio enviado a ' + env2 + ' alumnos.' + (fall2 > 0 ? ' No se pudo enviar a ' + fall2 + ' (DMs bloqueados).' : ''));
            break;
          }
          await interaction.editReply('No hay alumnos registrados todavía. Pediles que usen /registrarme.');
          break;
        }


        await interaction.editReply('Enviando a ' + destinatarios.length + ' alumno' + (destinatarios.length!==1?'s':'') + ' de ' + matNom + '...');

        let enviados = 0, fallidos = 0;
        for (const [uid] of destinatarios) {
          try { const u = await client.users.fetch(uid); await u.send(msgDM); enviados++; }
          catch { fallidos++; }
          await new Promise(r => setTimeout(r, 300));
        }

        // Guardar anuncio para recordatorio automático
        if (dias) {
          const fts = new Date(); fts.setDate(fts.getDate() + dias);
          anunciosActivos.set(String(anuncioCounter++), {
            materia: matNom, mensaje, fechaLimite, fechaLimiteTs: fts.getTime(),
            guildId: interaction.guildId, recordatorioEnviado: false,
            destinatarios: destinatarios.map(([uid]) => uid)
          });
          guardarDatos();
        }

        await interaction.editReply(
          'Anuncio enviado\n\nMateria: ' + matNom + '\nEnviado a: ' + enviados + ' alumno' + (enviados!==1?'s':'') +
          (fallidos > 0 ? '\nNo se pudo enviar a ' + fallidos + ' (DMs bloqueados)' : '') +
          (fechaLimite ? '\nFecha limite: ' + fechaLimite + '\n📌 Les voy a recordar 24h antes de vencer.' : '')
        );
        break;
      }

      case 'ver-codigo': {
        const s = getSesion(interaction.guildId);
        if (!s.activa) { await interaction.editReply('No hay ninguna clase activa. Iniciá una con /iniciar-clase.'); break; }
        if (!s.codigoClase) s.codigoClase = Math.floor(1000 + Math.random() * 9000).toString();
        try {
          const prof = await interaction.client.users.fetch(interaction.user.id);
          await prof.send('🔑 **Código de clase — ' + (s.titulo||'Clase activa') + '**\n📅 ' + s.fecha + ' | 🏫 ' + (interaction.guild?.name||'') + '\n\nCódigo del pizarrón:\n\n> **' + s.codigoClase + '**\n\n_Solo para vos. Expira cuando cerrés la clase._');
          await interaction.editReply('✅ Te envié el código por DM. Revisá tus mensajes privados.');
        } catch {
          await interaction.editReply('🔑 Código del pizarrón: **' + s.codigoClase + '**\n\n_No pude enviarte el DM, pero solo vos ves este mensaje._');
        }
        break;
      }

      case 'asignar-materia': {
        const mat   = detectarMateria(interaction.guildId, interaction.channel?.name);
        const MNOM  = { iev:'IEV', bd:'Base de Datos', informatica:'Informatica', practica:'PP3', pybd:'PyBD', annum:'Analisis Numerico' };
        const matN  = MNOM[mat] || mat;
        let asignados = 0;

        // Asignar a presentes de la última clase
        const s = getSesion(interaction.guildId);
        const presentes = s.presentesUltimaClase || [];
        for (const a of presentes) {
          if (!registros.has(a.uid)) {
            registros.set(a.uid, { nombreReal: a.nombre, discordUser: a.nombre, materia: matN, guildId: interaction.guildId, registradoEn: ahoraAR() });
          } else {
            const r = registros.get(a.uid); r.materia = matN; r.guildId = interaction.guildId; registros.set(a.uid, r);
          }
          asignados++;
        }

        // También asignar a todos los registrados de ese servidor sin materia
        for (const [uid, r] of registros.entries()) {
          if (r.guildId === interaction.guildId && !r.materia) {
            r.materia = matN; registros.set(uid, r); asignados++;
          }
        }

        guardarDatos();
        await interaction.editReply('✅ Materia **' + matN + '** asignada a ' + asignados + ' alumno' + (asignados!==1?'s':'') + '.\n\nAhora /anuncio y /alumnos van a filtrar correctamente por esta materia.');
        break;
      }

      case 'exportar': {
        const mat  = detectarMateria(interaction.guildId, interaction.channel?.name);
        const MNOM = { iev:'IEV', bd:'Base de Datos', informatica:'Informatica', practica:'PP3', pybd:'PyBD', annum:'Analisis Numerico' };
        const matN = MNOM[mat] || mat;
        const totalCl = clasesTotales.get(interaction.guildId) || 0;

        const alumnos = [...registros.entries()].filter(([,r]) => r.guildId === interaction.guildId && (r.materia === matN || !r.materia));
        if (!alumnos.length) { await interaction.editReply('No hay alumnos en ' + matN + '. Usá /asignar-materia primero.'); break; }

        let tabla = 'PLANILLA — ' + matN + ' (' + interaction.guild?.name + ')\n';
        tabla += 'Generado: ' + fechaAR() + ' | Clases dictadas: ' + totalCl + '\n';
        tabla += '────────────────────────────────────\n';
        tabla += 'N°  ALUMNO | ASIST | % | NOTA PROM\n';
        tabla += '────────────────────────────────────\n';

        alumnos.forEach(([uid, r], i) => {
          const p   = puntos.get(uid);
          const nAl = notas.get(uid) || [];
          const asi = p?.asistencias || 0;
          const pct = totalCl > 0 ? Math.round(asi/totalCl*100) : 0;
          const np  = nAl.length ? (Math.round(nAl.reduce((s,n)=>s+n.nota,0)/nAl.length*10)/10) : '-';
          tabla += (i+1) + '. ' + r.nombreReal + ' | ' + asi + '/' + totalCl + ' | ' + pct + '% | ' + np + '\n';
        });

        tabla += '────────────────────────────────────\nTotal: ' + alumnos.length + ' alumnos';
        const tablaFinal = tabla.length > 1850 ? tabla.substring(0, 1850) + '\n... (ver lista completa en el dashboard)' : tabla;
        await interaction.editReply('📋 **Planilla lista para copiar:**\n```\n' + tablaFinal + '\n```');
        break;
      }

      case 'cierre': {
        const mat  = detectarMateria(interaction.guildId, interaction.channel?.name);
        const MNOM = { iev:'IEV', bd:'Base de Datos', informatica:'Informatica', practica:'PP3', pybd:'PyBD', annum:'Analisis Numerico' };
        const matN = MNOM[mat] || mat;
        const totalCl = clasesTotales.get(interaction.guildId) || 0;
        if (totalCl === 0) { await interaction.editReply('Todavía no hay clases dictadas para generar el cierre.'); break; }

        const alumnos = [...registros.entries()].filter(([,r]) => r.guildId === interaction.guildId && (r.materia === matN || !r.materia));
        if (!alumnos.length) { await interaction.editReply('No hay alumnos en ' + matN + '. Usá /asignar-materia primero.'); break; }

        let msg = '🎓 **CIERRE DE CUATRIMESTRE — ' + matN + '**\n' + interaction.guild?.name + ' · ' + fechaAR() + '\n';
        msg += 'Clases dictadas: ' + totalCl + '\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

        let reg=0, lib=0, prom=0;
        for (const [uid, r] of alumnos) {
          const p    = puntos.get(uid);
          const nAl  = notas.get(uid) || [];
          const asi  = p?.asistencias || 0;
          const pct  = totalCl > 0 ? Math.round(asi/totalCl*100) : 0;
          const np   = nAl.length ? (Math.round(nAl.reduce((s,n)=>s+n.nota,0)/nAl.length*10)/10) : 0;
          // Condición: Promociona 8+ y 80% asist | Regular 6+ y 60% | Libre resto
          let cond, emoji;
          if (np >= 8 && pct >= 80) { cond='Promociona'; emoji='🟢'; prom++; }
          else if (np >= 6 && pct >= 60) { cond='Regular'; emoji='🟡'; reg++; }
          else { cond='Libre'; emoji='🔴'; lib++; }
          msg += emoji + ' **' + r.nombreReal + '** — ' + pct + '% asist · ' + (np||'s/n') + '/10 · **' + cond + '**\n';
        }

        msg += '\n━━━━━━━━━━━━━━━━━━━━━━━━\n🟢 Promocionan: ' + prom + ' · 🟡 Regulares: ' + reg + ' · 🔴 Libres: ' + lib;
        msg += '\n\n_Criterios: Promociona (8+ y 80% asist) · Regular (6+ y 60%) · Libre (resto)_';
        await enviarLargo(interaction, msg);
        break;
      }

      case 'backup':
        await interaction.editReply('Guardando en Google Sheets...');
        await backupPuntos();
        await interaction.editReply(`✅ Backup completado — ${puntos.size} alumnos guardados.`);
        break;

      case 'mislogros': {
        const uid    = interaction.user.id;
        const nombre = interaction.member?.displayName || interaction.user.username;
        const p      = puntos.get(uid);
        const obtenidos = p?.logros || [];
        const lista = LOGROS.map(l => {
          const tiene = obtenidos.includes(l.id);
          return `${tiene ? l.emoji : '🔒'} **${l.nombre}** — ${l.desc} (+${l.pts} pts)${tiene ? ' ✅' : ''}`;
        }).join('\n');
        await interaction.editReply(safe(`🏅 **Logros de ${nombre}** (${obtenidos.length}/${LOGROS.length} obtenidos)\n\n${lista}`));
        break;
      }

      case 'logros': {
        const lista = LOGROS.map(l => `${l.emoji} **${l.nombre}** — ${l.desc} · +${l.pts} pts`).join('\n');
        await interaction.editReply(safe(`🏅 **Todos los logros disponibles (${LOGROS.length}):**\n\n${lista}`));
        break;
      }

      case 'historial': {
        const targetUser = interaction.options.getUser('alumno');
        const uid   = targetUser ? targetUser.id : interaction.user.id;
        const nombre = targetUser ? targetUser.username : (interaction.member?.displayName || interaction.user.username);
        if (targetUser && !esProfesor(interaction.user.id)) { await interaction.editReply('❌ Solo el profesor puede ver el historial de otros alumnos.'); break; }
        const hist  = historial.get(uid);
        if (!hist || !hist.length) { await interaction.editReply(`${nombre} todavía no tiene entregas registradas.`); break; }
        const lista = hist.slice(-10).reverse().map((h, i) =>
          `**${i+1}. ${h.actividad}** · ${h.fecha}\n🔗 ${h.link}\n✍️ ${h.explicacion.substring(0,100)}${h.explicacion.length>100?'…':''}`
        ).join('\n\n');
        await interaction.editReply(safe(`📋 **Historial de ${getNombreReal(uid, nombre)}** (${hist.length} entregas):\n\n${lista}`));
        break;
      }

      case 'rubrica': {
        const accion    = interaction.options.getString('accion');
        const actividad = interaction.options.getString('actividad') || '';
        const crit      = interaction.options.getString('criterios') || '';

        if (accion === 'crear') {
          if (!actividad || !crit) { await interaction.editReply('❌ Necesitás especificar actividad y criterios.'); break; }
          const criterios = crit.split('|').map(c => c.trim()).filter(Boolean);
          const clave     = `${detectarMateria(interaction.guildId, interaction.channel?.name)}_${actividad.toLowerCase().replace(/\s+/g,'_')}`;
          rubricas.set(clave, { materia: detectarMateria(interaction.guildId, interaction.channel?.name), actividad, criterios, creadaEn: fechaAR() });
          guardarDatos();
          await interaction.editReply(`✅ **Rúbrica creada para "${actividad}"**\n\nCriterios (${criterios.length}):\n${criterios.map((c,i)=>`${i+1}. ${c}`).join('\n')}\n\nCuando un alumno entregue "${actividad}" la corrección usará estos criterios.`);
        } else if (accion === 'ver') {
          const clave = [...rubricas.keys()].find(k => k.toLowerCase().includes((actividad||'').toLowerCase()));
          if (!clave) { await interaction.editReply('❌ No encontré una rúbrica para esa actividad.'); break; }
          const r = rubricas.get(clave);
          await interaction.editReply(`📋 **Rúbrica: ${r.actividad}**\n\nCriterios:\n${r.criterios.map((c,i)=>`${i+1}. ${c}`).join('\n')}\n\nCreada: ${r.creadaEn}`);
        } else {
          if (!rubricas.size) { await interaction.editReply('No hay rúbricas creadas todavía.'); break; }
          const lista = [...rubricas.values()].map(r => `• **${r.actividad}** (${r.criterios.length} criterios)`).join('\n');
          await interaction.editReply(safe(`📋 **Rúbricas activas (${rubricas.size}):**\n\n${lista}\n\nUsá /rubrica accion:ver actividad:[nombre] para ver los criterios.`));
        }
        break;
      }

      case 'generar-parcial': {
        const desde = interaction.options.getInteger('unidad_desde');
        const hasta = interaction.options.getInteger('unidad_hasta');
        if (desde > hasta) { await interaction.editReply('❌ La unidad desde no puede ser mayor que hasta.'); break; }
        await interaction.editReply(`⏳ Generando parcial de Unidades ${desde} a ${hasta}...`);
        const ctx    = getContexto(interaction.guildId, interaction.channel?.name);
        const unids  = getUnidades(interaction.guildId, interaction.channel?.name);
        const temas  = Object.entries(unids).filter(([n])=>+n>=desde&&+n<=hasta).map(([n,v])=>`U${n}: ${v.split('\n')[0]}`).join('\n');
        const r = await llamarIA({
          model: 'claude-sonnet-4-6', max_tokens: 2000,
          messages: [{ role: 'user', content:
            `${ctx}\n\nGenerá un examen parcial profesional que cubra estas unidades:\n${temas}\n\n` +
            `Incluí exactamente:\n` +
            `**SECCIÓN A — Múltiple opción (5 preguntas, 2 pts c/u)**\n[5 preguntas con opciones A/B/C/D]\n\n` +
            `**SECCIÓN B — Desarrollo (2 ejercicios, 10 pts c/u)**\n[2 ejercicios prácticos apropiados para la materia]\n\n` +
            `**SECCIÓN C — Integradora (1 pregunta, 10 pts)**\n[1 pregunta que integre todos los temas]\n\n` +
            `**HOJA DE CORRECCIÓN**\n[Respuestas esperadas para cada sección]\n\n` +
            `Total: 40 puntos. Aprobado: 28 pts (70%).`
          }]
        });
        await interaction.editReply(safe(`📝 **PARCIAL — Unidades ${desde} a ${hasta}**\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n${r.content[0].text}`));
        break;
      }

      case 'asistencia-general': {
        const totalCl = clasesTotales.get(interaction.guildId) || 0;
        if (totalCl === 0) { await interaction.editReply('Todavía no hay clases dictadas para calcular asistencia.'); break; }
        const alumnos = [...registros.entries()].filter(([, r]) => r.guildId === interaction.guildId);
        if (!alumnos.length) { await interaction.editReply('No hay alumnos registrados todavía. Pediles que usen /registrarme.'); break; }

        const filas = alumnos.map(([uid, r]) => {
          const p = puntos.get(uid);
          const presentes = p?.asistencias || 0;
          const ausentes  = Math.max(0, totalCl - presentes);
          const pct = Math.round((presentes / totalCl) * 100);
          return { nombre: r.nombreReal, presentes, ausentes, pct };
        }).sort((a, b) => b.pct - a.pct);

        const promedioGeneral = Math.round(filas.reduce((s, f) => s + f.pct, 0) / filas.length);
        const lista = filas.map((f, i) => {
          const sem = f.pct >= 80 ? '🟢' : f.pct >= 60 ? '🟡' : '🔴';
          return `${i+1}. ${sem} **${f.nombre}** — ${f.pct}% (${f.presentes} presente${f.presentes!==1?'s':''} · ${f.ausentes} ausente${f.ausentes!==1?'s':''})`;
        }).join('\n');

        const msgAsist = safe(
          `📊 **Asistencia general — ${interaction.guild?.name}**\n` +
          `📅 ${totalCl} clase${totalCl!==1?'s':''} dictada${totalCl!==1?'s':''} · Promedio del curso: **${promedioGeneral}%**\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━\n\n${lista}`, 1900
        );

        if (canvasLib) {
          try {
            const buffer = generarGraficoAsistencia(filas.map(f => ({ nombre: f.nombre, pct: f.pct })), `Asistencia — ${interaction.guild?.name || ''}`);
            if (buffer) {
              const archivo = new AttachmentBuilder(buffer, { name: 'asistencia.png' });
              await interaction.editReply({ content: msgAsist, files: [archivo] });
              break;
            }
          } catch (e) { LOG.error('Error generando gráfico de asistencia', e); }
        }
        await enviarLargo(interaction, msgAsist);
        break;
      }

      case 'ajustar-asistencia': {
        const alumnoObj = interaction.options.getUser('alumno');
        const cantidad  = interaction.options.getInteger('cantidad');
        const motivo    = interaction.options.getString('motivo');
        const uid       = alumnoObj.id;
        const nombre    = getNombreReal(uid, alumnoObj.username);

        if (cantidad > 0) {
          const p = darPuntos(uid, nombre, 'asistencia');
          const miembroObjetivo = await interaction.guild.members.fetch(uid).catch(() => null);
          if (miembroObjetivo) await actualizarRol(miembroObjetivo, p.pts, interaction.channel);
          LOG.info(`Ajuste manual +1 asistencia: ${nombre} por ${interaction.user.username} — motivo: ${motivo}`);
          await interaction.editReply(`✅ Ajustado: **${nombre}** +1 presencia (ahora ${p.asistencias} en total).\n📋 Motivo: ${motivo}`);
        } else {
          if (!puntos.has(uid) || !puntos.get(uid).asistencias) {
            await interaction.editReply(`${nombre} no tiene presencias registradas para restar.`);
            break;
          }
          const p = puntos.get(uid);
          p.asistencias = Math.max(0, (p.asistencias || 0) - 1);
          p.pts = Math.max(0, p.pts - 10);
          puntos.set(uid, p);
          guardarDatos();
          LOG.info(`Ajuste manual -1 asistencia: ${nombre} por ${interaction.user.username} — motivo: ${motivo}`);
          await interaction.editReply(`✅ Ajustado: **${nombre}** -1 presencia (ahora ${p.asistencias} en total).\n📋 Motivo: ${motivo}`);
        }
        break;
      }

      case 'riesgo': {
        const riesgo = detectarAlumnosEnRiesgo(interaction.guildId);
        if (!riesgo.length) { await interaction.editReply('Por ahora todos tienen buena actividad, nadie está en riesgo.'); break; }
        const lista = riesgo.map((r,i) =>
          `${i+1}. **${r.nombre}** — ${r.asistencias} asistencia${r.asistencias!==1?'s':''} · ${r.entregas} entrega${r.entregas!==1?'s':''} · ${r.pts} pts`
        ).join('\n');
        await interaction.editReply(safe(
          `⚠️ **Alumnos en riesgo (${riesgo.length})**\n` +
          `_Criterio: menos de 3 asistencias o 0 entregas_\n\n` +
          `${lista}\n\n` +
          `💡 Podés contactarlos directamente o publicar una tarea de recuperación con /tarea.`
        ));
        break;
      }

      case 'torneo': {
        if (torneoActivo) { await interaction.editReply('Ya hay una pregunta activa. Esperá que cierre antes de lanzar otra.'); break; }
        await interaction.editReply('🏆 Iniciando torneo... Generando primera pregunta.');
        const mat  = detectarMateria(interaction.guildId, interaction.channel?.name);
        const ctx  = CONTEXTOS[mat] || CONTEXTOS.iev;
        const unum = Math.ceil(Math.random() * Object.keys(UNIDADES[mat]||UNIDADES.iev).length);
        const r = await llamarIA({
          model: 'claude-sonnet-4-6', max_tokens: 400,
          messages: [{ role: 'user', content: `${ctx}\n\nGenerá UNA pregunta de torneo sobre la Unidad ${unum}. SOLO JSON: {"pregunta":"...","opciones":["A) ...","B) ...","C) ...","D) ..."],"correcta":"A","explicacion":"..."}` }]
        });
        let qd;
        try { qd = JSON.parse(r.content[0].text.replace(/\`\`\`json|\`\`\`/g,'').trim()); } catch { await interaction.editReply('❌ Error generando pregunta.'); break; }
        torneoActivo = { ...qd, respuestas: new Map(), cierra: Date.now() + 30000, canal: interaction.channelId };
        setTimeout(() => { if (torneoActivo && Date.now() >= torneoActivo.cierra) cerrarPreguntaTorneo(); }, 30500);
        const botonesT = new ActionRowBuilder().addComponents(
          ...'ABCD'.split('').map(l => new ButtonBuilder().setCustomId(`torneo_${l}`).setLabel(l).setStyle(ButtonStyle.Secondary))
        );
        await interaction.editReply({
          content: safe(`🏆 **TORNEO — Unidad ${unum}**\n⏱️ Tenés **30 segundos**\n\n${qd.pregunta}\n\n${qd.opciones.join('\n')}\n\nEl más rápido en responder correctamente gana más puntos.`),
          components: [botonesT]
        });
        break;
      }

      case 'registrarme': {
        const uid         = interaction.user.id;
        const nombreReal  = interaction.options.getString('nombre').trim();
        const carrera     = interaction.options.getString('carrera') || '';
        // Validar nombre completo: al menos 2 palabras (apellido + nombre)
        if (nombreReal.length < 5 || nombreReal.split(/\s+/).length < 2) {
          await interaction.editReply('❌ Necesito tu **nombre completo** (apellido y nombre).\n\nEjemplo: `/registrarme nombre:Dominguez Dante Raul`\n\nEscribilo de nuevo con apellido y nombre.');
          break;
        }
        const yaExistia   = registros.has(uid);
        const matReg = detectarMateria(interaction.guildId, interaction.channel?.name);
        const MNOMS  = { iev:'IEV', bd:'Base de Datos', informatica:'Informática', practica:'PP3', pybd:'PyBD', annum:'Análisis Numérico' };
        // Nombre viejo (apodo) con el que pudo haber marcado antes de registrarse
        const regPrevio = registros.get(uid);
        const nombreViejo = regPrevio?.nombreReal || interaction.member?.displayName || interaction.user.username;
        registros.set(uid, {
          nombreReal,
          carrera,
          materia:     MNOMS[matReg] || matReg,
          guildId:     interaction.guildId,
          discordUser: interaction.user.username,
          registradoEn: ahoraAR(),
          nombreRealConfirmado: true,
        });

        // Actualizar el nombre en la asistencia de HOY si ya marcó con el apodo
        let asistenciaActualizada = false;
        for (const [gid, s] of sesiones.entries()) {
          if (s.asistentes && s.asistentes.has(uid)) {
            const datos = s.asistentes.get(uid);
            if (datos.nombre !== nombreReal) { datos.nombre = nombreReal; s.asistentes.set(uid, datos); asistenciaActualizada = true; }
          }
          if (s.presentesUltimaClase) {
            const idx = s.presentesUltimaClase.findIndex(a => a.uid === uid);
            if (idx >= 0 && s.presentesUltimaClase[idx].nombre !== nombreReal) {
              s.presentesUltimaClase[idx].nombre = nombreReal; asistenciaActualizada = true;
            }
          }
        }
        // Actualizar el nombre guardado en puntos (para rankings y listas)
        if (puntos.has(uid)) { const pp = puntos.get(uid); pp.nombre = nombreReal; puntos.set(uid, pp); }

        // Corregir el nombre en Google Sheets (asistencias de hoy)
        if (nombreViejo && nombreViejo !== nombreReal) {
          actualizarNombreSheets(nombreViejo, nombreReal, fechaAR()).catch(()=>{});
        }

        guardarDatos();
        await interaction.editReply(
          `${yaExistia ? '✏️ **Registro actualizado**' : '✅ **Registro exitoso**'}

` +
          `👤 **Nombre real:** ${nombreReal}
` +
          `🎓 **Carrera:** ${carrera || 'No especificada'}
` +
          `💬 **Discord:** @${interaction.user.username}

` +
          `A partir de ahora tu nombre real aparecerá en la asistencia y el dashboard.` +
          (asistenciaActualizada ? `\n\n✅ Tu asistencia de hoy ya fue actualizada con tu nombre real.` : '')
        );
        break;
      }

      case 'misregistro': {
        const uid = interaction.user.id;
        const reg = registros.get(uid);
        if (!reg) {
          await interaction.editReply('❌ No estás registrado todavía. Usá `/registrarme nombre:[tu nombre completo]` para registrarte.');
          break;
        }
        await interaction.editReply(
          `📋 **Tu registro actual:**

` +
          `👤 **Nombre real:** ${reg.nombreReal}
` +
          `🎓 **Carrera:** ${reg.carrera || 'No especificada'}
` +
          `💬 **Discord:** @${reg.discordUser || interaction.user.username}
` +
          `📅 **Registrado:** ${reg.registradoEn}

` +
          `Para actualizar usá \`/registrarme\` de nuevo.`
        );
        break;
      }

      case 'alumnos': {
        const s       = getSesion(interaction.guildId);
        const totalCl = clasesTotales.get(interaction.guildId) || 0;

        // Prioridad 1: clase activa ahora
        // Prioridad 2: última clase cerrada (guardada en disco)
        // Prioridad 3: todos los registrados del servidor
        const tieneActiva = s.activa && s.asistentes && s.asistentes.size > 0;
        const tieneUltima = s.presentesUltimaClase && s.presentesUltimaClase.length > 0;

        if (tieneActiva || tieneUltima) {
          const presentes = tieneActiva
            ? [...s.asistentes.entries()].map(([uid, a]) => ({ uid, nombre: a.nombre, hora: a.hora }))
            : s.presentesUltimaClase;
          const tituloC = s.fechaUltimaClase || s.fecha || 'Última clase';
          const lineas = presentes.map((a, i) => {
            const reg     = registros.get(a.uid);
            const p       = puntos.get(a.uid);
            const nAl     = notas.get(a.uid) || [];
            const nProm   = nAl.length ? (Math.round(nAl.reduce((sum,n) => sum+n.nota,0)/nAl.length*10)/10)+'/10' : 'sin notas';
            const discord = reg?.discordUser || p?.nombre || a.uid;
            return (i+1) + '. **' + a.nombre + '** (@' + discord + ') — Notas: ' + nProm + ' · Pts: ' + (p?.pts||0);
          });
          const msg = '👥 **Clase ' + tituloC + '** — ' + presentes.length + ' presentes\nUsá el @apodo para /nota\n\n' + lineas.join('\n');
          await enviarLargo(interaction, msg);
        } else {
          // Sin clase reciente — todos los del servidor
          const todos = [...registros.entries()].filter(([,r]) => r.guildId === interaction.guildId);
          if (!todos.length) { await interaction.editReply('No hay alumnos registrados todavía. Pediles que usen /registrarme.'); break; }
          const lineas = todos.map(([uid, r], i) => {
            const p     = puntos.get(uid);
            const nAl   = notas.get(uid) || [];
            const pctA  = totalCl > 0 && p ? Math.round((p.asistencias||0)/totalCl*100) : null;
            const sem   = pctA === null ? '' : pctA >= 80 ? ' 🟢' : pctA >= 60 ? ' 🟡' : ' 🔴';
            const nProm = nAl.length ? (Math.round(nAl.reduce((sum,n) => sum+n.nota,0)/nAl.length*10)/10)+'/10' : '—';
            return (i+1) + '. **' + r.nombreReal + '** (@' + (r.discordUser||'?') + ')' + sem + ' — Notas: ' + nProm;
          });
          const msg = '👥 **Todos los alumnos (' + todos.length + ')**\nIniciá una clase para ver solo los de hoy\n\n' + lineas.join('\n');
          await enviarLargo(interaction, msg);
        }
        break;
      }
    }
  } catch (e) {
    LOG.error(`Error en /${interaction.commandName}`, e);
    try { await interaction.editReply('Algo salió mal. Podés intentar de nuevo o avisarle al profesor.'); } catch {}
  }
});

// ════════════════════════════════════════════════════════════════
// BIENVENIDA A NUEVOS MIEMBROS
// ════════════════════════════════════════════════════════════════
client.on(Events.GuildMemberAdd, async (member) => {
  const canal   = member.guild.channels.cache.find(c => c.name==='aviso'||c.name==='bienvenida');
  const es11    = member.guild.name.toLowerCase().includes('11');
  if (!canal) return;
  await canal.send(es11
    ? `Bienvenido/a **${member.displayName}** al IES N°11 👋\n\n📚 Tecnicatura en Desarrollo de Software\n\nComandos para arrancar:\n• /preguntar — preguntale algo a la IA sobre BD o Informática\n• /quiz — practicá con preguntas interactivas\n• #entregas — entregá un trabajo y recibís corrección\n• /ayuda — todos los comandos disponibles`
    : `Bienvenido/a **${member.displayName}** al IES N°6 👋\n\n📚 Materias:\n• 🌐 IEV → #iev\n• 🎯 PP3 → #practica\n• ☕ PyBD → #pybd\n\nComandos para arrancar:\n• /ayuda — todos los comandos disponibles\n• #entregas — entregá un trabajo y recibís corrección automática\n• #noticias-tech — noticias de tecnología todos los días`
  );
});

// ════════════════════════════════════════════════════════════════
// ANTI-CRASH — captura errores no manejados
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
// FUNCIONES AUXILIARES — NUEVAS MEJORAS
// ════════════════════════════════════════════════════════════════

function detectarAlumnosEnRiesgo(guildId) {
  const totalCl = guildId ? (clasesTotales.get(guildId) || 0) : 0;
  const riesgo = [];
  for (const [uid, p] of puntos.entries()) {
    // Filtrar solo alumnos de ESTE servidor (si se pasó guildId)
    if (guildId) {
      const reg = registros.get(uid);
      if (!reg || reg.guildId !== guildId) continue;
    }
    // Con pocas clases dictadas, el umbral fijo "< 3 asistencias" marca a todos como riesgo sin razón.
    // Se usa porcentaje una vez que hay al menos 3 clases; antes de eso, solo marca por 0 entregas.
    let enRiesgo = false;
    if (totalCl >= 3) {
      const pct = Math.round((p.asistencias||0) / totalCl * 100);
      enRiesgo = pct < 60 || (p.entregas||0) === 0;
    } else {
      enRiesgo = (p.entregas||0) === 0 && totalCl > 0; // solo por entregas si el cuatrimestre recién arranca
    }
    if (enRiesgo) riesgo.push({ uid, nombre: p.nombre, asistencias: p.asistencias||0, entregas: p.entregas||0, pts: p.pts||0 });
  }
  return riesgo.sort((a,b) => a.asistencias - b.asistencias);
}

async function generarReporteSemanal(guild) {
  const rank   = getRankingCompleto();
  const prom   = rank.length ? Math.round(rank.reduce((s,[,p])=>s+p.pts,0)/rank.length) : 0;
  const riesgo = detectarAlumnosEnRiesgo();
  const sesion = getSesion(guild.id);
  const topPreguntas = sesion.preguntas.slice(-5).map(q => `• ${q.autor}: "${q.pregunta.substring(0,60)}"`).join('\n') || '• Sin preguntas registradas';
  return (
    `📊 **Reporte Semanal — ${guild.name}**\n` +
    `📅 Semana del ${fechaAR()}\n\n` +
    `👥 Alumnos activos: ${puntos.size} | Promedio: ${prom} pts\n` +
    `🏆 Líder: ${rank[0]?.[1]?.nombre||'—'} (${rank[0]?.[1]?.pts||0} pts)\n` +
    `⚠️ En riesgo: ${riesgo.length} alumno${riesgo.length!==1?'s':''}\n\n` +
    `💬 **Últimas preguntas a la IA:**\n${topPreguntas}\n\n` +
    `📤 Entregas esta semana: ${entregasPorActiv.size} actividades\n` +
    `🎯 Desafios activos: ${desafioActivo ? '1' : '0'}\n\n` +
    `_Reporte automático de Mentor 🎓_`
  );
}

async function cerrarPreguntaTorneo() {
  if (!torneoActivo) return;
  const t = torneoActivo;
  torneoActivo = null;
  let msg = `⏱️ **Tiempo!** Respuesta correcta: **${t.correcta}**\n\n`;
  const ganadores = [...t.respuestas.entries()].filter(([,r])=>r.resp===t.correcta).sort((a,b)=>a[1].tiempo-b[1].tiempo);
  if (ganadores.length) {
    msg += `🏆 **Top respuestas correctas:**\n`;
    ganadores.slice(0,3).forEach(([uid,r],i) => {
      const medals = ['🥇','🥈','🥉'];
      const pts = [15,10,5][i]||3;
      const p = puntos.get(uid);
      if (p) { p.pts += pts; puntos.set(uid, p); guardarDatos(); }
      msg += `${medals[i]} ${r.nombre} — +${pts} pts\n`;
    });
  } else { msg += 'Nadie respondió correctamente.'; }
  for (const g of client.guilds.cache.values()) {
    const canal = g.channels.cache.find(c => c.name.includes('dudas') || c.name.includes('aviso'));
    if (canal) await canal.send(msg).catch(()=>{});
  }
}

process.on('unhandledRejection', (reason) => LOG.error('unhandledRejection', reason));
process.on('uncaughtException',  (err)    => LOG.error('uncaughtException',  err));

// ════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN — limpieza ordenada al apagar
// ════════════════════════════════════════════════════════════════
async function shutdown(signal) {
  LOG.warn(`Señal ${signal} recibida — guardando datos antes de apagar...`);
  guardarDatos();
  await new Promise(r => setTimeout(r, 3500)); // espera el debounce
  LOG.info('Datos guardados. Cerrando bot.');
  client.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ════════════════════════════════════════════════════════════════
// LOGIN
// ════════════════════════════════════════════════════════════════
client.login(DISCORD_TOKEN).catch(e => {
  LOG.error('Error al hacer login en Discord', e);
  process.exit(1);
});
