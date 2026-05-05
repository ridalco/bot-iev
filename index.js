require('dotenv').config();
const fs = require('fs');
const {
  Client, GatewayIntentBits, Events,
  SlashCommandBuilder, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

// =============================================
// CONFIGURACIÓN
// =============================================
const DISCORD_TOKEN      = process.env.DISCORD_TOKEN;
const CLIENT_ID          = '1497945827874967733';
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const SPREADSHEET_ID     = process.env.SPREADSHEET_ID;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const PROFESOR_ID        = process.env.PROFESOR_ID;

const MOODLE_TOKEN_IES6  = process.env.MOODLE_TOKEN_IES6;
const MOODLE_TOKEN_IES11 = process.env.MOODLE_TOKEN_IES11;
const MOODLE_URL_IES6    = 'https://ies6.aulasvirtuales.name';
const MOODLE_URL_IES11   = 'https://ies11.aulasvirtuales.name';

const CANAL_NOTICIAS = 'noticias-tech';

// =============================================
// MEJORA 1 — PERSISTENCIA DE DATOS EN ARCHIVO
// Los datos se guardan en data.json y se cargan
// al iniciar el bot, sobreviviendo reinicios.
// =============================================
const DATA_FILE = './data.json';

const puntos  = new Map(); // userId -> { nombre, pts, entregas, asistencias, preguntas }
const tareas  = new Map(); // id     -> { titulo, descripcion, fecha, canal, completados: Set<userId> }
const eventos = new Map(); // id     -> { titulo, fecha, tipo, descripcion, avisado3d, avisado1d, avisadoHoy }
let tareaCounter  = 1;
let eventoCounter = 1;

function cargarDatos() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (raw.puntos)       for (const [k, v] of Object.entries(raw.puntos))  puntos.set(k, v);
    if (raw.eventos)      for (const [k, v] of Object.entries(raw.eventos)) eventos.set(parseInt(k), v);
    if (raw.tareas) {
      for (const [k, v] of Object.entries(raw.tareas)) {
        tareas.set(parseInt(k), { ...v, completados: new Set(v.completados || []) });
      }
    }
    if (raw.tareaCounter)  tareaCounter  = raw.tareaCounter;
    if (raw.eventoCounter) eventoCounter = raw.eventoCounter;
    console.log(`✅ Datos cargados: ${puntos.size} alumnos, ${tareas.size} tareas, ${eventos.size} eventos`);
  } catch (e) { console.error('Error cargando datos:', e); }
}

function guardarDatos() {
  try {
    const data = {
      puntos:       Object.fromEntries(puntos),
      eventos:      Object.fromEntries(eventos),
      tareas:       Object.fromEntries([...tareas.entries()].map(([k, v]) => [k, { ...v, completados: [...v.completados] }])),
      tareaCounter,
      eventoCounter,
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('Error guardando datos:', e); }
}

// =============================================
// MEJORA 2 — SESIÓN POR SERVIDOR (no global)
// Cada servidor tiene su propio estado de clase
// para evitar mezcla de asistencia entre IES 6 e IES 11.
// =============================================
const sesiones = new Map(); // guildId -> { activa, asistentes, fecha }

function getSesion(guildId) {
  if (!sesiones.has(guildId)) {
    sesiones.set(guildId, { activa: false, asistentes: new Map(), fecha: '' });
  }
  return sesiones.get(guildId);
}

// =============================================
// MEJORA 3 — PROTECCIÓN DE COMANDOS DEL PROFESOR
// =============================================
function esProfesor(userId) {
  if (!PROFESOR_ID) return true; // si no está configurado, permite todo (modo desarrollo)
  return userId === PROFESOR_ID;
}

const SOLO_PROFESOR = ['iniciar-clase', 'cerrar-clase', 'noticias', 'evento', 'borrar-evento', 'desafio', 'soluciones', 'cerrar-desafio', 'tarea', 'similitudes'];

// =============================================
// DETECCIÓN DE MATERIA — CASCADA
// =============================================
function detectarMateria(guildId, channelName) {
  const canal = (channelName || '').toLowerCase();
  if (canal.includes('bd') || canal.includes('base') || canal.includes('datos')) return 'bd';
  if (canal.includes('info') || canal.includes('informatica'))                   return 'informatica';
  if (canal.includes('iev') || canal.includes('internet') || canal.includes('entornos')) return 'iev';
  const guild = client.guilds.cache.get(guildId);
  if (guild) {
    const s = guild.name.toLowerCase();
    if (s.includes('11')) return 'bd';
    if (s.includes('6'))  return 'iev';
  }
  return 'iev';
}

// =============================================
// CONTEXTOS POR MATERIA
// =============================================
const CONTEXTOS = {
  iev: `Sos el asistente de "Internet y Entornos Virtuales" del Profesorado en Informática del IES N°6, Prof. Ing. Corimayo Ricardo Daniel.
Respondé en español, claro y pedagógico.
Unidades: 1-Introducción a Internet (TCP/IP, HTTP, comandos CMD), 2-Correo y netiqueta (SMTP, POP3, IMAP), 3-Criterio CRAAP, 4-Comunicación sincrónica/asincrónica, 5-Entornos virtuales Chamilo/Moodle.
Si no sabés algo decí que consulte al profesor.`,
  bd: `Sos el asistente de "Base de Datos" de la Tecnicatura Superior en Desarrollo de Software del IES N°11, Prof. Ing. Corimayo Ricardo Daniel.
Respondé en español, claro y pedagógico.
Unidades: 1-Introducción SGBD (DDL/DML, abstracción), 2-Modelo de datos, 3-Diseño E-R (entidades, relaciones, cardinalidad), 4-Modelo Relacional (claves, vistas), 5-Normalización (1FN-5FN, BCNF), 6-Álgebra Relacional, 7-SQL (CREATE/ALTER/DROP, SELECT/INSERT/UPDATE/DELETE).
Si no sabés algo decí que consulte al profesor.`,
  informatica: `Sos el asistente de "Informática" de la Tecnicatura Superior en Desarrollo de Software del IES N°11, 1er año, Prof. Ing. Corimayo Ricardo Daniel.
Respondé en español, claro y pedagógico.
Unidades: 1-Introducción (hardware, software, SO), 2-Ofimática, 3-Redes y Computación Distribuida, 4-Computación Paralela y Concurrente, 5-Inteligencia Artificial (ML, redes neuronales, PLN).
Si no sabés algo decí que consulte al profesor.`,
};

function getContexto(guildId, channelName) {
  return CONTEXTOS[detectarMateria(guildId, channelName)];
}

// =============================================
// UNIDADES POR MATERIA
// =============================================
const UNIDADES = {
  iev: {
    1: '🌐 **IEV — Unidad 1: Introducción a Internet**\n\nProtocolos TCP/IP, HTTP, HTTPS, FTP. Comandos CMD: ping, tracert, ipconfig, nslookup.',
    2: '📧 **IEV — Unidad 2: Correo y Netiqueta**\n\nSMTP, POP3, IMAP. Netiqueta digital. CC vs CCO.',
    3: '🔍 **IEV — Unidad 3: Búsqueda y Evaluación**\n\nCriterio CRAAP. Fake news. Probá: /craap [url]',
    4: '💬 **IEV — Unidad 4: Comunicación**\n\nSincrónica vs Asincrónica. Discord, Meet, Zoom. Foros.',
    5: '🖥️ **IEV — Unidad 5: Entornos Virtuales**\n\nChamilo y Moodle. Roles. Proyecto final: Aula virtual.',
  },
  bd: {
    1: '🗄️ **BD — Unidad 1: Introducción y Arquitectura SGBD**\n\nDefinición de BD y SGBD, niveles de abstracción (físico, conceptual, externo), DDL y DML.',
    2: '📊 **BD — Unidad 2: Modelo de Datos**\n\nModelos conceptuales vs lógicos. Restricciones de integridad.',
    3: '🔗 **BD — Unidad 3: Diseño y Diagrama E-R**\n\nEntidades, atributos, relaciones, cardinalidad, herencia.',
    4: '📋 **BD — Unidad 4: Modelo Relacional**\n\nClaves primarias y foráneas, vistas, consultas relacionales.',
    5: '📐 **BD — Unidad 5: Normalización**\n\nDependencias funcionales. 1FN, 2FN, 3FN, BCNF, 4FN, 5FN.',
    6: '🔢 **BD — Unidad 6: Álgebra y Cálculo Relacional**\n\nOperadores primitivos y derivados. Cálculo de tuplas y dominios.',
    7: '💻 **BD — Unidad 7: SQL**\n\nDDL: CREATE, ALTER, DROP. DML: SELECT, INSERT, UPDATE, DELETE. Vistas, subconsultas.',
  },
  informatica: {
    1: '💻 **Informática — Unidad 1: Introducción**\n\nHardware, software, sistemas operativos. Evolución histórica.',
    2: '📝 **Informática — Unidad 2: Ofimática**\n\nProcesadores de texto, hojas de cálculo, presentaciones.',
    3: '🌐 **Informática — Unidad 3: Redes y Computación Distribuida**\n\nTipos de redes, protocolos. Cliente/servidor vs peer-to-peer.',
    4: '⚡ **Informática — Unidad 4: Computación Paralela**\n\nProcesadores multinúcleo, paralelismo, concurrencia.',
    5: '🤖 **Informática — Unidad 5: Inteligencia Artificial**\n\nMachine learning, redes neuronales, PLN. Tendencias futuras.',
  }
};

function getUnidades(guildId, channelName) {
  return UNIDADES[detectarMateria(guildId, channelName)] || UNIDADES.iev;
}

// =============================================
// SISTEMA DE PUNTOS
// =============================================
function darPuntos(userId, nombre, tipo) {
  if (!puntos.has(userId)) puntos.set(userId, { nombre, pts: 0, entregas: 0, asistencias: 0, preguntas: 0 });
  const p = puntos.get(userId);
  p.nombre = nombre;
  if (tipo === 'asistencia') { p.pts += 10; p.asistencias++; }
  if (tipo === 'entrega')    { p.pts += 20; p.entregas++;    }
  if (tipo === 'pregunta')   { p.pts += 5;  p.preguntas++;   }
  puntos.set(userId, p);
  guardarDatos();
  return p;
}

// MEJORA 5 — getRanking retorna todos para calcular posición real
function getRankingCompleto() {
  return [...puntos.entries()].sort((a, b) => b[1].pts - a[1].pts);
}

function getRanking() {
  return getRankingCompleto().slice(0, 10);
}

// MEJORA 5 — posición real aunque no esté en top 10
function getPosicion(userId) {
  const pos = getRankingCompleto().findIndex(([id]) => id === userId);
  return pos === -1 ? '—' : pos + 1;
}

function getRol(pts) {
  if (pts >= 200) return { nombre: 'Experto Digital',    emoji: '🏆' };
  if (pts >= 100) return { nombre: 'Colaborador Activo', emoji: '⭐' };
  if (pts >= 50)  return { nombre: 'Aprendiz',           emoji: '📚' };
  return              { nombre: 'Novato',              emoji: '🌱' };
}

// =============================================
// ROLES DISCORD AUTOMÁTICOS
// =============================================
const ROLES_PUNTOS = [
  { nombre: 'Experto Digital',    minPts: 200, color: '#FFD700' },
  { nombre: 'Colaborador Activo', minPts: 100, color: '#C0C0C0' },
  { nombre: 'Aprendiz',           minPts: 50,  color: '#4FC3F7' },
  { nombre: 'Novato',             minPts: 0,   color: '#90A4AE' },
];

async function actualizarRolDiscord(member, pts) {
  try {
    const guild = member.guild;
    for (const rolDef of ROLES_PUNTOS) {
      let rol = guild.roles.cache.find(r => r.name === rolDef.nombre);
      if (!rol) rol = await guild.roles.create({ name: rolDef.nombre, color: rolDef.color, reason: 'Bot IEV' });
    }
    for (const rolDef of ROLES_PUNTOS) {
      const rol = guild.roles.cache.find(r => r.name === rolDef.nombre);
      if (rol && member.roles.cache.has(rol.id)) await member.roles.remove(rol);
    }
    const rolCorrespondiente = ROLES_PUNTOS.find(r => pts >= r.minPts);
    if (rolCorrespondiente) {
      const rol = guild.roles.cache.find(r => r.name === rolCorrespondiente.nombre);
      if (rol) await member.roles.add(rol);
    }
  } catch (e) { console.error('Error asignando rol:', e); }
}

// =============================================
// SISTEMA DE DETECCIÓN DE SIMILITUD EN ENTREGAS
// =============================================
const entregasPorActividad = new Map();

function calcularSimilitud(texto1, texto2) {
  const palabras = t => new Set(t.toLowerCase().replace(/[^a-záéíóúñ0-9\s]/gi, '').split(/\s+/).filter(p => p.length > 3));
  const set1 = palabras(texto1);
  const set2 = palabras(texto2);
  if (set1.size === 0 || set2.size === 0) return 0;
  const interseccion = [...set1].filter(p => set2.has(p)).length;
  return Math.round((interseccion / new Set([...set1, ...set2]).size) * 100);
}

async function verificarPlagioConIA(actividad, nombre1, contenido1, nombre2, contenido2, similitudBasica) {
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 400,
      messages: [{ role: 'user', content: `Analizá estas dos entregas de "${actividad}" y determiná si hay copia.\n\nEntrega de ${nombre1}: ${contenido1.substring(0, 800)}\n\nEntrega de ${nombre2}: ${contenido2.substring(0, 800)}\n\nRespondé SOLO en JSON: {"similitud_real": número 0-100, "veredicto": "Copia evidente" o "Muy similar" o "Colaboración" o "Coincidencia", "detalle": "1 oración"}` }]
    });
    return JSON.parse(resp.content[0].text.replace(/```json|```/g, '').trim());
  } catch (e) {
    return { similitud_real: similitudBasica, veredicto: 'Muy similar', detalle: 'Análisis por similitud de palabras.' };
  }
}

async function avisarPlagio(guild, actividad, nombre1, nombre2, similitud, analisis) {
  try {
    if (!PROFESOR_ID) return;
    const profesor = await guild.client.users.fetch(PROFESOR_ID);
    const nivel = similitud >= 90 ? '🔴 COPIA MUY PROBABLE' : similitud >= 75 ? '🟠 SIMILITUD ALTA' : '🟡 SIMILITUD MODERADA';
    await profesor.send(`⚠️ **Alerta de similitud**\n\n${nivel}\n📚 **Actividad:** ${actividad}\n👤 **Alumnos:** ${nombre1} y ${nombre2}\n📊 **Similitud:** ${similitud}%\n🤖 **Veredicto:** ${analisis.veredicto}\n💬 ${analisis.detalle}\n\n_Revisá #entregas para confirmar._`);
  } catch (e) { console.error('Error DM profesor:', e.message); }
}

async function compararEntregas(guild, actividad, nombreNuevo, userIdNuevo, contenidoNuevo) {
  const clave = actividad.toLowerCase().trim();
  if (!entregasPorActividad.has(clave)) entregasPorActividad.set(clave, []);
  const entregas = entregasPorActividad.get(clave);
  for (const prev of entregas) {
    if (prev.userId === userIdNuevo) continue;
    const sim = calcularSimilitud(contenidoNuevo, prev.contenido);
    if (sim >= 50) {
      const analisis = await verificarPlagioConIA(actividad, nombreNuevo, contenidoNuevo, prev.nombre, prev.contenido, sim);
      if (analisis.similitud_real >= 70) await avisarPlagio(guild, actividad, nombreNuevo, prev.nombre, analisis.similitud_real, analisis);
    }
  }
  entregas.push({ nombre: nombreNuevo, userId: userIdNuevo, contenido: contenidoNuevo, hora: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) });
}

// =============================================
// ESTADO EN MEMORIA (no persiste)
// =============================================
const formularioActivo = new Map();
const quizActivo       = new Map();
const desafios         = new Map(); let desafioCounter = 1;
let desafioActivo      = null;
const HORARIOS_CLASE   = [{ dia: 2, hora: 8, minuto: 0 }, { dia: 4, hora: 8, minuto: 0 }];
const HORA_NOTICIAS    = { hora: 8, minuto: 0 };

// =============================================
// CLIENTE
// =============================================
const client    = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// =============================================
// GOOGLE SHEETS
// =============================================
async function getSheets() {
  const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDENTIALS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

async function guardarAsistencia(nombre, fecha, hora) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Asistencia!A:D', valueInputOption: 'USER_ENTERED', resource: { values: [[fecha, hora, nombre, 'Presente']] } });
  } catch (e) { console.error('Error Sheets:', e); }
}

// Backup semanal de puntos a Google Sheets
async function backupPuntosSheets() {
  try {
    const sheets = await getSheets();
    const filas  = [...puntos.entries()].map(([id, p]) => [id, p.nombre, p.pts, p.asistencias, p.entregas, p.preguntas, new Date().toLocaleDateString('es-AR')]);
    await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: 'Puntos!A:G' });
    if (filas.length > 0) {
      await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: 'Puntos!A1', valueInputOption: 'USER_ENTERED', resource: { values: [['userId', 'Nombre', 'Puntos', 'Asistencias', 'Entregas', 'Preguntas', 'Actualizado'], ...filas] } });
    }
    console.log('✅ Backup de puntos guardado en Sheets');
  } catch (e) { console.error('Error backup Sheets:', e); }
}

// =============================================
// MOODLE
// =============================================
async function moodleAPI(url, token, func, params = {}) {
  try {
    const qs   = new URLSearchParams({ wstoken: token, wsfunction: func, moodlewsrestformat: 'json', ...params });
    const resp = await fetch(url + '/webservice/rest/server.php?' + qs.toString());
    const data = await resp.json();
    if (data && data.exception) return { _error: data.message, _code: data.errorcode };
    return data;
  } catch (e) { return null; }
}

function getMoodleConfig(guildName) {
  const esIES11 = guildName && guildName.toLowerCase().includes('11');
  return { url: esIES11 ? MOODLE_URL_IES11 : MOODLE_URL_IES6, token: esIES11 ? MOODLE_TOKEN_IES11 : MOODLE_TOKEN_IES6, nombre: esIES11 ? 'IES N°11' : 'IES N°6' };
}

async function getCursos(url, token)                       { return await moodleAPI(url, token, 'core_course_get_courses'); }
async function getActividades(url, token, courseId)        { return await moodleAPI(url, token, 'core_course_get_contents', { courseid: courseId }); }
async function getUsuarioPorNombre(url, token, nombre) {
  const data = await moodleAPI(url, token, 'core_user_get_users', { 'criteria[0][key]': 'fullname', 'criteria[0][value]': nombre });
  return data?.users?.[0] || null;
}
async function getNotasUsuario(url, token, userId, courseId) { return await moodleAPI(url, token, 'gradereport_user_get_grade_items', { userid: userId, courseid: courseId }); }

// =============================================
// CALENDARIO
// =============================================
function parseFecha(str) {
  const p = str.split('/');
  return p.length !== 3 ? null : new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0]));
}
function diasRestantes(fecha) {
  const hoy = new Date(); hoy.setHours(0,0,0,0); fecha.setHours(0,0,0,0);
  return Math.round((fecha - hoy) / 86400000);
}
function emojiTipo(tipo) { return { parcial:'📝', entrega:'📤', proyecto:'🎓', clase:'📚', recuperatorio:'🔄' }[tipo] || '📅'; }
function formatEventos(lista) {
  if (!lista.length) return 'No hay eventos registrados.';
  return lista.map(([id, ev]) => {
    const dias   = diasRestantes(parseFecha(ev.fecha));
    const estado = dias < 0 ? '✅ Pasado' : dias === 0 ? '🔴 HOY' : dias === 1 ? '🟠 Mañana' : dias <= 3 ? `🟡 En ${dias} días` : `🟢 En ${dias} días`;
    return `${emojiTipo(ev.tipo)} **#${id} — ${ev.titulo}**\n📅 ${ev.fecha} · ${estado}${ev.descripcion ? '\n📋 ' + ev.descripcion : ''}`;
  }).join('\n\n');
}

// =============================================
// NOTICIAS
// =============================================
async function publicarNoticias(guild) {
  const canal = guild.channels.cache.find(c => c.name === CANAL_NOTICIAS);
  if (!canal) return;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 1000,
      messages: [{ role: 'user', content: `Generá 3 noticias tecnológicas para estudiantes de Informática en Argentina. Temas: Internet, IA, educación virtual, redes, ciberseguridad.\nFormato: **🔹 [Título]**\nResumen 2-3 oraciones.\n💡 *Por qué importa: [explicación]*\n\nSeparalas con una línea. Hoy es ${new Date().toLocaleDateString('es-AR')}.` }]
    });
    await canal.send(`📰 **NOTICIAS TECH — ${new Date().toLocaleDateString('es-AR')}**\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n${resp.content[0].text}\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n*Bot IEV 🤖*`);
  } catch (e) { console.error('Error noticias:', e); }
}

// =============================================
// CORRECCIÓN CON IA
// =============================================
async function corregirEntrega(texto) {
  if (!texto || texto.length < 20) return null;
  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 1200,
    messages: [{ role: 'user', content: `Sos el asistente del Prof. Ing. Corimayo Ricardo Daniel. Corregí este trabajo:\n\n✅ **Aspectos positivos:**\n[puntos fuertes]\n\n🔧 **Aspectos a mejorar:**\n[lo incompleto]\n\n📊 **Evaluación orientativa:** [Excelente / Muy bueno / Bueno / Regular / Insuficiente]\n\n💡 **Sugerencia:**\n[consejo personalizado]\n\nSé pedagógico.\n\nTRABAJO:\n${texto.substring(0, 3000)}` }]
  });
  return resp.content[0].text;
}

// =============================================
// INICIAR CLASE (por servidor)
// =============================================
async function iniciarClase(channel, titulo, guildId) {
  const sesion = getSesion(guildId);
  if (sesion.activa) { await channel.send('⚠️ Ya hay una clase activa. Cerrá con `/cerrar-clase`'); return; }
  sesion.activa    = true;
  sesion.asistentes = new Map();
  const ahora      = new Date();
  sesion.fecha     = ahora.toLocaleDateString('es-AR');
  const boton      = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('presente').setLabel('✅  Marcar presencia').setStyle(ButtonStyle.Success));
  await channel.send({ content: `📋 **ASISTENCIA — ${titulo || 'Clase de hoy'}**\n📅 Fecha: **${sesion.fecha}** | 🕐 Inicio: **${ahora.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}**\n\nHacé clic para registrar tu presencia.`, components: [boton] });
}

// =============================================
// COMANDOS SLASH
// =============================================
const commands = [
  new SlashCommandBuilder().setName('iniciar-clase').setDescription('👨‍🏫 Iniciar toma de asistencia (profesor)').addStringOption(o => o.setName('titulo').setDescription('Tema de la clase').setRequired(false)),
  new SlashCommandBuilder().setName('cerrar-clase').setDescription('👨‍🏫 Cerrar asistencia y ver resumen (profesor)'),
  new SlashCommandBuilder().setName('asistencia').setDescription('Ver asistencia del día'),
  new SlashCommandBuilder().setName('noticias').setDescription('👨‍🏫 Publicar noticias tech ahora (profesor)'),
  new SlashCommandBuilder().setName('corregir').setDescription('Corregir un trabajo con IA').addStringOption(o => o.setName('texto').setDescription('Pegá el texto del trabajo').setRequired(true)),
  new SlashCommandBuilder().setName('unidad').setDescription('Info de una unidad de la materia').addIntegerOption(o => o.setName('numero').setDescription('Número de unidad').setRequired(true).setMinValue(1).setMaxValue(7)),
  new SlashCommandBuilder().setName('preguntar').setDescription('Preguntá a la IA sobre la materia').addStringOption(o => o.setName('pregunta').setDescription('Tu pregunta').setRequired(true)),
  new SlashCommandBuilder().setName('entrega').setDescription('Ver instrucciones para entregar trabajos'),
  new SlashCommandBuilder().setName('herramientas').setDescription('Links de las herramientas del curso'),
  new SlashCommandBuilder().setName('craap').setDescription('Evaluar una fuente con criterio CRAAP').addStringOption(o => o.setName('url').setDescription('URL a evaluar').setRequired(true)),
  new SlashCommandBuilder().setName('ranking').setDescription('Ver el ranking de participación'),
  new SlashCommandBuilder().setName('mispuntos').setDescription('Ver tus puntos y posición actual'),
  new SlashCommandBuilder().setName('miscursos').setDescription('Ver tus cursos activos en Moodle'),
  new SlashCommandBuilder().setName('misnota').setDescription('Consultar tus notas en Moodle').addStringOption(o => o.setName('nombre').setDescription('Tu nombre completo en Moodle').setRequired(true)),
  new SlashCommandBuilder().setName('actividades').setDescription('Ver actividades de un curso Moodle').addIntegerOption(o => o.setName('curso').setDescription('ID del curso').setRequired(true)),
  new SlashCommandBuilder().setName('moodle').setDescription('Ver estado de conexión con Moodle'),
  new SlashCommandBuilder().setName('evento')
    .setDescription('👨‍🏫 Agregar evento al calendario (profesor)')
    .addStringOption(o => o.setName('titulo').setDescription('Nombre del evento').setRequired(true))
    .addStringOption(o => o.setName('fecha').setDescription('Fecha (dd/mm/yyyy)').setRequired(true))
    .addStringOption(o => o.setName('tipo').setDescription('Tipo').setRequired(true).addChoices(
      { name: 'Parcial', value: 'parcial' }, { name: 'Entrega', value: 'entrega' },
      { name: 'Proyecto final', value: 'proyecto' }, { name: 'Clase especial', value: 'clase' },
      { name: 'Recuperatorio', value: 'recuperatorio' }))
    .addStringOption(o => o.setName('descripcion').setDescription('Descripción opcional').setRequired(false)),
  new SlashCommandBuilder().setName('calendario').setDescription('Ver todos los eventos del cuatrimestre'),
  new SlashCommandBuilder().setName('proximo').setDescription('Ver el próximo evento importante'),
  new SlashCommandBuilder().setName('borrar-evento').setDescription('👨‍🏫 Borrar un evento (profesor)').addIntegerOption(o => o.setName('id').setDescription('ID del evento').setRequired(true)),
  new SlashCommandBuilder().setName('quiz').setDescription('Quiz de opción múltiple (+15 pts si aprobás)').addIntegerOption(o => o.setName('unidad').setDescription('Número de unidad').setRequired(true).setMinValue(1).setMaxValue(7)),
  new SlashCommandBuilder().setName('desafio').setDescription('👨‍🏫 Publicar desafio semanal (profesor)').addStringOption(o => o.setName('materia').setDescription('iev, bd o informatica').setRequired(true)),
  new SlashCommandBuilder().setName('solucionar').setDescription('Enviar tu solución al desafio activo').addStringOption(o => o.setName('codigo').setDescription('Tu solución').setRequired(true)),
  new SlashCommandBuilder().setName('soluciones').setDescription('👨‍🏫 Ver soluciones del desafio (profesor)'),
  new SlashCommandBuilder().setName('cerrar-desafio').setDescription('👨‍🏫 Cerrar desafio y anunciar ganador (profesor)'),
  new SlashCommandBuilder().setName('tarea')
    .setDescription('👨‍🏫 Publicar una nueva tarea (profesor)')
    .addStringOption(o => o.setName('titulo').setDescription('Título').setRequired(true))
    .addStringOption(o => o.setName('descripcion').setDescription('Descripción').setRequired(true))
    .addStringOption(o => o.setName('fecha').setDescription('Fecha límite ej: 30/05/2026').setRequired(true)),
  new SlashCommandBuilder().setName('tareas').setDescription('Ver todas las tareas activas'),
  new SlashCommandBuilder().setName('completar').setDescription('Marcar una tarea como completada').addIntegerOption(o => o.setName('id').setDescription('ID de la tarea').setRequired(true)),
  new SlashCommandBuilder().setName('similitudes').setDescription('👨‍🏫 Ver estadísticas de entregas (profesor)'),
  new SlashCommandBuilder().setName('materia').setDescription('Ver qué materia detecta el bot en este canal'),
  new SlashCommandBuilder().setName('backup').setDescription('👨‍🏫 Guardar puntos en Google Sheets (profesor)'),
];

async function registrarComandos(guildId) {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commands.map(c => c.toJSON()) });
  console.log(`✅ Comandos registrados en guild ${guildId}`);
}

// =============================================
// BOT LISTO
// =============================================
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot conectado como ${c.user.tag}`);
  cargarDatos();
  for (const guild of c.guilds.cache.values()) await registrarComandos(guild.id);

  // Guardar datos cada 5 minutos
  setInterval(guardarDatos, 5 * 60 * 1000);

  // Backup a Sheets todos los domingos a las 22hs
  setInterval(async () => {
    const ahora = new Date();
    if (ahora.getDay() === 0 && ahora.getHours() === 22 && ahora.getMinutes() === 0) {
      await backupPuntosSheets();
    }
  }, 60000);

  setInterval(async () => {
    const ahora = new Date();
    const dia   = ahora.getDay();
    const hora  = ahora.getHours();
    const min   = ahora.getMinutes();

    // Verificar Moodle cada hora
    if (min === 0) {
      for (const guild of client.guilds.cache.values()) {
        const mc = getMoodleConfig(guild.name);
        if (!mc.token) continue;
        const canal = guild.channels.cache.find(c => c.name === 'aviso' || c.name === 'anuncios');
        if (!canal) continue;
        const cursos = await getCursos(mc.url, mc.token);
        if (!cursos || !Array.isArray(cursos)) continue;
        for (const curso of cursos.filter(c => c.visible === 1 && c.id > 1).slice(0, 3)) {
          const secciones = await getActividades(mc.url, mc.token, curso.id);
          if (!secciones || !Array.isArray(secciones)) continue;
          const haceUnaHora = Date.now() - 3600000;
          for (const sec of secciones) {
            for (const mod of (sec.modules || [])) {
              if (mod.modname === 'assign' && mod.dates) {
                for (const date of mod.dates) {
                  if (date.timestamp * 1000 > haceUnaHora && date.dataid === 'duedate') {
                    await canal.send(`📌 **Recordatorio Moodle ${mc.nombre}**\n📚 ${mod.name} — ${curso.shortname}\n📅 Vence: ${new Date(date.timestamp * 1000).toLocaleDateString('es-AR')}`);
                  }
                }
              }
            }
          }
        }
      }
    }

    // Recordatorios de calendario
    for (const [, ev] of eventos.entries()) {
      const fechaEv = parseFecha(ev.fecha);
      if (!fechaEv) continue;
      const dias = diasRestantes(fechaEv);
      const avisar = async (msg) => {
        for (const guild of client.guilds.cache.values()) {
          const canal = guild.channels.cache.find(c => c.name === 'aviso' || c.name === 'anuncios');
          if (canal) await canal.send(msg);
        }
      };
      if (dias === 3 && !ev.avisado3d)  { ev.avisado3d  = true; guardarDatos(); await avisar(`⏰ **Faltan 3 días**\n\n${emojiTipo(ev.tipo)} **${ev.titulo}** — ${ev.fecha}`); }
      if (dias === 1 && !ev.avisado1d)  { ev.avisado1d  = true; guardarDatos(); await avisar(`🚨 **Mañana** es **${ev.titulo}**`); }
      if (dias === 0 && !ev.avisadoHoy) { ev.avisadoHoy = true; guardarDatos(); await avisar(`🔴 **HOY — ${ev.titulo}**`); }
    }

    // Asistencia automática
    for (const h of HORARIOS_CLASE) {
      if (h.dia === dia && h.hora === hora && min === h.minuto) {
        for (const guild of client.guilds.cache.values()) {
          const canal = guild.channels.cache.find(c => c.name === 'dudas');
          if (canal) await iniciarClase(canal, 'Clase programada', guild.id);
        }
      }
    }

    // Noticias automáticas
    if (hora === HORA_NOTICIAS.hora && min === HORA_NOTICIAS.minuto) {
      for (const guild of client.guilds.cache.values()) await publicarNoticias(guild);
    }
  }, 60000);
});

// =============================================
// MENSAJES — FORMULARIO DE ENTREGAS
// MEJORA 4: detecta cualquier canal que contenga "entrega"
// =============================================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // MEJORA 4 — detecta #entregas, #entrega-bd, #entrega-info, etc.
  if (message.channel.name.includes('entrega')) {
    const userId = message.author.id;
    const nombre = message.member?.displayName || message.author.username;

    if (formularioActivo.has(userId)) {
      const form = formularioActivo.get(userId);
      if (form.paso === 1) {
        form.actividad = message.content; form.paso = 2; formularioActivo.set(userId, form);
        await message.reply('📎 **Paso 2/3:** Pegá el link de tu trabajo (GitHub, Drive) o adjuntá el archivo.');
        return;
      }
      if (form.paso === 2) {
        form.link = message.content || (message.attachments.first()?.url || 'Sin link'); form.paso = 3; formularioActivo.set(userId, form);
        await message.reply('💬 **Paso 3/3:** ¿Algún comentario? (o escribí "listo")');
        return;
      }
      if (form.paso === 3) {
        form.comentario = message.content === 'listo' ? '' : message.content;
        formularioActivo.delete(userId);
        await message.channel.send(`📋 **ENTREGA REGISTRADA**\n👤 **${form.nombre}**\n📚 ${form.actividad}\n🔗 ${form.link}\n💬 ${form.comentario || 'Sin comentario'}`);
        const contenidoCompleto = `${form.actividad} ${form.link} ${form.comentario}`;
        compararEntregas(message.guild, form.actividad, nombre, userId, contenidoCompleto).catch(console.error);
        const p   = darPuntos(userId, nombre, 'entrega');
        const rol = getRol(p.pts);
        await actualizarRolDiscord(message.member, p.pts);
        try {
          await message.channel.sendTyping();
          const correccion = await corregirEntrega(`Actividad: ${form.actividad}. Link: ${form.link}. Comentario: ${form.comentario}`);
          if (correccion) await message.reply(`🤖 **Corrección automática:**\n\n${correccion}\n\n*⚠️ Orientativa. La nota final la define el profesor.*\n\n📤 +20 pts | Total: **${p.pts} pts** ${rol.emoji}`);
        } catch (e) { console.error('Error corrección:', e); }
        return;
      }
    }

    if (!formularioActivo.has(userId) && message.content.length > 2) {
      formularioActivo.set(userId, { paso: 1, nombre, actividad: '', link: '', comentario: '' });
      await message.reply(`📝 **Formulario de entrega**\n\nHola **${nombre}**!\n\n**Paso 1/3:** ¿Cuál es el nombre de la actividad?`);
    }
  }

  // Mención al bot
  if (message.mentions.has(client.user)) {
    const pregunta = message.content.replace(/<@\d+>/g, '').trim();
    if (!pregunta) return;
    try {
      await message.channel.sendTyping();
      const ctx  = getContexto(message.guildId, message.channel?.name);
      const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 600, messages: [{ role: 'user', content: `${ctx}\n\nPregunta: ${pregunta}` }] });
      await message.reply(`🤖 ${resp.content[0].text}`);
    } catch (e) { await message.reply('❌ No pude procesar tu pregunta.'); }
  }
});

// =============================================
// INTERACCIONES
// =============================================
client.on(Events.InteractionCreate, async (interaction) => {

  // Botón Quiz
  if (interaction.isButton() && interaction.customId.startsWith('quiz_')) {
    const [, respuesta, targetUserId] = interaction.customId.split('_');
    const userId = interaction.user.id;
    if (userId !== targetUserId) { await interaction.reply({ content: '⚠️ Este quiz es de otro alumno.', ephemeral: true }); return; }
    const quiz = quizActivo.get(userId);
    if (!quiz)           { await interaction.reply({ content: '⚠️ Usá /quiz para empezar.', ephemeral: true }); return; }
    if (quiz.respondido) { await interaction.reply({ content: '✅ Ya respondiste. Usá /quiz para otra pregunta.', ephemeral: true }); return; }
    quiz.respondido = true; quizActivo.set(userId, quiz);
    const nombre     = interaction.member?.displayName || interaction.user.username;
    const esCorrecta = respuesta === quiz.correcta;
    let msg;
    if (esCorrecta) {
      const p = darPuntos(userId, nombre, 'pregunta'); darPuntos(userId, nombre, 'pregunta'); const p3 = darPuntos(userId, nombre, 'pregunta');
      await actualizarRolDiscord(interaction.member, p3.pts);
      msg = `✅ **¡Correcto ${nombre}!** ${quiz.explicacion}\n\n+15 pts | Total: **${p3.pts} pts**`;
    } else {
      msg = `❌ **Incorrecto ${nombre}.** Correcta: ${quiz.correcta}\n${quiz.explicacion}`;
    }
    await interaction.update({ content: msg, components: [] });
    return;
  }

  // Botón Completar tarea — MEJORA 6: usa userId para evitar duplicados
  if (interaction.isButton() && interaction.customId.startsWith('completar_')) {
    const id    = parseInt(interaction.customId.split('_')[1]);
    const tarea = tareas.get(id);
    if (!tarea) { await interaction.reply({ content: '❌ Tarea no encontrada.', ephemeral: true }); return; }
    const userId = interaction.user.id;
    const nombre = interaction.member?.displayName || interaction.user.username;
    if (tarea.completados.has(userId)) { await interaction.reply({ content: `✅ **${nombre}**, ya marcaste esta tarea.`, ephemeral: true }); return; }
    tarea.completados.add(userId);
    guardarDatos();
    const p   = darPuntos(userId, nombre, 'entrega');
    const rol = getRol(p.pts);
    await actualizarRolDiscord(interaction.member, p.pts);
    await interaction.reply({ content: `✅ **${nombre}** completó **"${tarea.titulo}"**\n📤 +20 pts | Total: **${p.pts} pts** ${rol.emoji}` });
    return;
  }

  // Botón Ver completados
  if (interaction.isButton() && interaction.customId.startsWith('vercompletados_')) {
    const id    = parseInt(interaction.customId.split('_')[1]);
    const tarea = tareas.get(id);
    if (!tarea) { await interaction.reply({ content: '❌ Tarea no encontrada.', ephemeral: true }); return; }
    // Resolver nombres desde puntos Map
    const nombresCompletados = [...tarea.completados].map(uid => {
      const p = puntos.get(uid);
      return p ? p.nombre : uid;
    });
    const lista = nombresCompletados.length > 0 ? nombresCompletados.map((n, i) => `${i + 1}. ${n}`).join('\n') : 'Nadie completó esta tarea todavía.';
    await interaction.reply({ content: `👥 **Completaron "${tarea.titulo}"** (${tarea.completados.size}):\n\n${lista}`, ephemeral: true });
    return;
  }

  // Botón Presente — MEJORA 2: usa sesión por servidor
  if (interaction.isButton() && interaction.customId === 'presente') {
    const sesion = getSesion(interaction.guildId);
    if (!sesion.activa) { await interaction.reply({ content: '⚠️ La clase ya cerró.', ephemeral: true }); return; }
    const userId = interaction.user.id;
    const nombre = interaction.member?.displayName || interaction.user.username;
    if (sesion.asistentes.has(userId)) { await interaction.reply({ content: `✅ **${nombre}**, ya registraste tu presencia.`, ephemeral: true }); return; }
    const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    sesion.asistentes.set(userId, { nombre, hora });
    await guardarAsistencia(nombre, sesion.fecha, hora);
    const p   = darPuntos(userId, nombre, 'asistencia');
    const rol = getRol(p.pts);
    await actualizarRolDiscord(interaction.member, p.pts);
    await interaction.reply({ content: `✅ **${nombre}** — presencia a las **${hora}**\n${rol.emoji} +10 pts | Total: **${p.pts} pts** | Rol: **${rol.nombre}**` });
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();

  // MEJORA 3 — verificar permisos del profesor
  if (SOLO_PROFESOR.includes(interaction.commandName) && !esProfesor(interaction.user.id)) {
    await interaction.editReply('❌ Este comando es solo para el profesor.');
    return;
  }

  try {
    switch (interaction.commandName) {

      case 'materia': {
        const materia = detectarMateria(interaction.guildId, interaction.channel?.name);
        const nombres = { iev: 'Internet y Entornos Virtuales (IEV)', bd: 'Base de Datos', informatica: 'Informática' };
        await interaction.editReply(`🔍 **Detección de materia**\n\nCanal: **#${interaction.channel?.name}** | Servidor: **${interaction.guild?.name}**\n✅ Materia detectada: **${nombres[materia]}**\n\nPalabras clave por canal:\n• BD → \`bd\`, \`base\`, \`datos\`\n• Informática → \`info\`, \`informatica\`\n• IEV → \`iev\`, \`internet\`, \`entornos\``);
        break;
      }

      case 'iniciar-clase': {
        const titulo = interaction.options.getString('titulo') || 'Clase de hoy';
        await iniciarClase(interaction.channel, titulo, interaction.guildId);
        await interaction.editReply('✅ Clase iniciada.');
        break;
      }

      case 'cerrar-clase': {
        const sesion = getSesion(interaction.guildId);
        if (!sesion.activa) { await interaction.editReply('⚠️ No hay clase activa.'); break; }
        sesion.activa = false;
        const lista   = [...sesion.asistentes.values()];
        const resumen = lista.length > 0 ? lista.map((a, i) => `${i + 1}. **${a.nombre}** — ${a.hora}`).join('\n') : 'Ningún alumno registró presencia.';
        await interaction.editReply(`📋 **Clase cerrada — ${sesion.fecha}**\n👥 Total: **${lista.length} presentes**\n\n${resumen}\n\n📊 Guardado en Google Sheets.`);
        break;
      }

      case 'asistencia': {
        const sesion = getSesion(interaction.guildId);
        if (sesion.asistentes.size === 0) { await interaction.editReply('No hay asistencia registrada hoy.'); break; }
        const lista = [...sesion.asistentes.values()];
        await interaction.editReply(`📋 **Asistencia ${sesion.fecha}** — ${lista.length} presentes\n\n${lista.map((a, i) => `${i + 1}. **${a.nombre}** — ${a.hora}`).join('\n')}`);
        break;
      }

      case 'noticias': {
        await interaction.editReply('📰 Generando noticias...');
        publicarNoticias(interaction.guild).then(() => interaction.editReply('📰 ¡Publicadas en #noticias-tech!')).catch(() => interaction.editReply('❌ Error.'));
        break;
      }

      case 'corregir': {
        const correccion = await corregirEntrega(interaction.options.getString('texto'));
        await interaction.editReply(`🤖 **Corrección:**\n\n${correccion}\n\n*⚠️ Orientativa.*`);
        break;
      }

      case 'unidad': {
        const num             = interaction.options.getInteger('numero');
        const unidadesMateria = getUnidades(interaction.guildId, interaction.channel?.name);
        await interaction.editReply(unidadesMateria[num] || `❌ Esta materia no tiene unidad ${num}.`);
        break;
      }

      case 'preguntar': {
        const pregunta = interaction.options.getString('pregunta');
        const ctx      = getContexto(interaction.guildId, interaction.channel?.name);
        const resp     = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 800, messages: [{ role: 'user', content: `${ctx}\n\nPregunta: ${pregunta}` }] });
        darPuntos(interaction.user.id, interaction.member?.displayName || interaction.user.username, 'pregunta');
        await interaction.editReply(`🤖 **Respuesta:**\n\n${resp.content[0].text}\n\n💡 +5 pts`);
        break;
      }

      case 'ranking': {
        const top = getRanking();
        if (top.length === 0) { await interaction.editReply('No hay puntos registrados todavía.'); break; }
        const medallas = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
        const lista    = top.map(([, p], i) => `${medallas[i]} **${p.nombre}** — ${p.pts} pts ${getRol(p.pts).emoji}`).join('\n');
        await interaction.editReply(`🏆 **Ranking 2026**\n\n${lista}\n\n💡 Asistencia +10 | Entrega +20 | Pregunta +5`);
        break;
      }

      // MEJORA 5 — posición real aunque no esté en top 10
      case 'mispuntos': {
        const userId = interaction.user.id;
        const nombre = interaction.member?.displayName || interaction.user.username;
        if (!puntos.has(userId)) { await interaction.editReply('Todavía no tenés puntos. ¡Participá en clase!'); break; }
        const p   = puntos.get(userId);
        const rol = getRol(p.pts);
        const pos = getPosicion(userId);
        const total = getRankingCompleto().length;
        await interaction.editReply(`${rol.emoji} **${nombre}** — ${rol.nombre}\n\n📊 **${p.pts} pts** | Posición **#${pos}** de ${total} alumnos\n\n✅ Asistencias: ${p.asistencias} (+${p.asistencias * 10} pts)\n📤 Entregas: ${p.entregas} (+${p.entregas * 20} pts)\n💬 Preguntas: ${p.preguntas} (+${p.preguntas * 5} pts)`);
        break;
      }

      case 'entrega':
        await interaction.editReply('📤 **Cómo entregar:**\n\n1. Andá a **#entregas** (o #entrega-bd, #entrega-info)\n2. Escribí cualquier cosa para iniciar el formulario\n3. Seguí los 3 pasos\n4. La IA corrige automáticamente\n5. El profesor confirma la nota\n\n⚠️ No se aceptan entregas por WhatsApp ni privado.');
        break;

      case 'herramientas':
        await interaction.editReply('🛠️ **Herramientas:**\n\n📘 Chamilo → aulasvirtuales.name/chamilo\n📗 Moodle → aulasvirtuales.name/innova\n🐙 GitHub → github.com\n💬 Discord → Este servidor ✅');
        break;

      case 'craap': {
        const url  = interaction.options.getString('url');
        const ctx  = getContexto(interaction.guildId, interaction.channel?.name);
        const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 800, messages: [{ role: 'user', content: `${ctx}\n\nEvaluá "${url}" con criterio CRAAP. Puntuá del 1 al 5 y dá conclusión final.` }] });
        await interaction.editReply(`🔍 **CRAAP: \`${url}\`**\n\n${resp.content[0].text}`);
        break;
      }

      case 'moodle': {
        const mc = getMoodleConfig(interaction.guild?.name);
        if (!mc.token) { await interaction.editReply(`❌ Token no configurado para ${mc.nombre}`); break; }
        const cursos = await getCursos(mc.url, mc.token);
        if (!cursos)       { await interaction.editReply(`❌ Error de conexión con ${mc.url}`); break; }
        if (cursos._error) { await interaction.editReply(`❌ Error Moodle: ${cursos._error}`); break; }
        await interaction.editReply(`✅ Moodle **${mc.nombre}** conectado. Cursos: **${Array.isArray(cursos) ? cursos.length : 0}**`);
        break;
      }

      case 'miscursos': {
        const mc     = getMoodleConfig(interaction.guild?.name);
        const cursos = await getCursos(mc.url, mc.token);
        if (!cursos || !Array.isArray(cursos)) { await interaction.editReply('❌ No se pudo obtener los cursos.'); break; }
        const activos = cursos.filter(c => c.visible === 1 && c.id > 1);
        if (!activos.length) { await interaction.editReply('No hay cursos activos.'); break; }
        await interaction.editReply(`📚 **Cursos Moodle ${mc.nombre}:**\n\n${activos.slice(0, 15).map(c => `#${c.id} — ${c.fullname}`).join('\n')}\n\nUsá /actividades curso:[id]`);
        break;
      }

      case 'actividades': {
        const mc        = getMoodleConfig(interaction.guild?.name);
        const courseId  = interaction.options.getInteger('curso');
        const secciones = await getActividades(mc.url, mc.token, courseId);
        if (!secciones || !Array.isArray(secciones)) { await interaction.editReply('❌ No se pudo obtener las actividades.'); break; }
        let msg = `📋 **Actividades #${courseId}:**\n`;
        let total = 0;
        for (const sec of secciones.slice(0, 5)) {
          if (!sec.modules?.length) continue;
          msg += `\n**${sec.name}:**\n`;
          for (const mod of sec.modules.slice(0, 5)) { msg += `  • ${mod.name} (${mod.modname})\n`; total++; }
        }
        await interaction.editReply(total === 0 ? 'No hay actividades.' : msg);
        break;
      }

      case 'misnota': {
        const mc           = getMoodleConfig(interaction.guild?.name);
        const nombreBuscar = interaction.options.getString('nombre');
        const usuario      = await getUsuarioPorNombre(mc.url, mc.token, nombreBuscar);
        if (!usuario) { await interaction.editReply(`❌ No encontré **${nombreBuscar}** en Moodle ${mc.nombre}.`); break; }
        const cursos = await getCursos(mc.url, mc.token);
        if (!cursos || !Array.isArray(cursos)) { await interaction.editReply('No se pudo obtener los cursos.'); break; }
        let msg = `📊 **Notas de ${usuario.fullname}:**\n`;
        for (const curso of cursos.filter(c => c.visible === 1 && c.id > 1).slice(0, 3)) {
          const notas = await getNotasUsuario(mc.url, mc.token, usuario.id, curso.id);
          if (!notas?.usergrades?.length) continue;
          msg += `\n**${curso.shortname}:**\n`;
          for (const item of (notas.usergrades[0]?.gradeitems || []).slice(0, 5)) msg += `  • ${item.itemname}: **${item.gradeformatted || 'Sin calificar'}**\n`;
        }
        await interaction.editReply(msg || 'No se encontraron notas.');
        break;
      }

      case 'evento': {
        const titulo      = interaction.options.getString('titulo');
        const fecha       = interaction.options.getString('fecha');
        const tipo        = interaction.options.getString('tipo');
        const descripcion = interaction.options.getString('descripcion') || '';
        if (!parseFecha(fecha)) { await interaction.editReply('❌ Fecha inválida. Formato: dd/mm/yyyy'); break; }
        const id   = eventoCounter++;
        const dias = diasRestantes(parseFecha(fecha));
        eventos.set(id, { titulo, fecha, tipo, descripcion, avisado3d: false, avisado1d: false, avisadoHoy: false });
        guardarDatos();
        await interaction.editReply(`${emojiTipo(tipo)} **#${id} — ${titulo}**\n📅 ${fecha} (${dias < 0 ? 'ya pasó' : dias === 0 ? 'HOY' : 'en ' + dias + ' días'})\n\nAvisaré 3 días antes, 1 día antes y el mismo día.`);
        break;
      }

      case 'calendario': {
        const lista   = [...eventos.entries()].sort((a, b) => parseFecha(a[1].fecha) - parseFecha(b[1].fecha));
        const futuros = lista.filter(([, ev]) => diasRestantes(parseFecha(ev.fecha)) >= 0);
        const pasados = lista.filter(([, ev]) => diasRestantes(parseFecha(ev.fecha)) < 0);
        let msg = '📅 **CALENDARIO DEL CUATRIMESTRE**\n\n';
        if (futuros.length) msg += '**Próximos:**\n\n' + formatEventos(futuros);
        if (pasados.length) msg += '\n\n**Pasados:**\n\n' + formatEventos(pasados);
        if (!lista.length)  msg += 'No hay eventos. Agregá con /evento';
        await interaction.editReply(msg);
        break;
      }

      case 'proximo': {
        const futuros = [...eventos.entries()].filter(([, ev]) => diasRestantes(parseFecha(ev.fecha)) >= 0).sort((a, b) => parseFecha(a[1].fecha) - parseFecha(b[1].fecha));
        if (!futuros.length) { await interaction.editReply('No hay eventos próximos.'); break; }
        const [, ev] = futuros[0];
        const dias   = diasRestantes(parseFecha(ev.fecha));
        await interaction.editReply(`${emojiTipo(ev.tipo)} **${ev.titulo}**\n📅 **${ev.fecha}** — ${dias === 0 ? '**HOY**' : dias === 1 ? 'mañana' : 'en **' + dias + ' días**'}${ev.descripcion ? '\n📋 ' + ev.descripcion : ''}`);
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
        const unidadNum = interaction.options.getInteger('unidad');
        const userId    = interaction.user.id;
        const ctx       = getContexto(interaction.guildId, interaction.channel?.name);
        await interaction.editReply('🧠 Generando pregunta...');
        const quizResp = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514', max_tokens: 500,
          messages: [{ role: 'user', content: `${ctx}\n\nGenerá UNA pregunta sobre Unidad ${unidadNum}. SOLO JSON: {"pregunta":"...","opciones":["A) ...","B) ...","C) ...","D) ..."],"correcta":"A","explicacion":"..."}` }]
        });
        let quizData;
        try { quizData = JSON.parse(quizResp.content[0].text.replace(/```json|```/g, '').trim()); }
        catch (e) { await interaction.editReply('❌ Error generando pregunta. Intentá de nuevo.'); break; }
        quizActivo.set(userId, { ...quizData, unidad: unidadNum, respondido: false });
        const botones = new ActionRowBuilder().addComponents(
          ...'ABCD'.split('').map(l => new ButtonBuilder().setCustomId(`quiz_${l}_${userId}`).setLabel(l).setStyle(ButtonStyle.Secondary))
        );
        await interaction.editReply({ content: `🧠 **Quiz Unidad ${unidadNum}**\n\n${quizData.pregunta}\n\n${quizData.opciones.join('\n')}\n\nSeleccioná:`, components: [botones] });
        break;
      }

      case 'desafio': {
        const materia = interaction.options.getString('materia').toLowerCase();
        const ctx     = CONTEXTOS[materia] || CONTEXTOS.iev;
        await interaction.editReply('⏳ Generando desafio...');
        const respD = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 600, messages: [{ role: 'user', content: `${ctx}\n\nGenerá un desafio semanal. Formato: DESAFIO: [título] ENUNCIADO: [3-5 líneas] PISTA: [sin solución] DIFICULTAD: [Básico/Intermedio/Avanzado]` }] });
        const id = desafioCounter++;
        desafioActivo = id;
        desafios.set(id, { enunciado: respD.content[0].text, materia, soluciones: new Map() });
        await interaction.editReply('✅ Desafio publicado.');
        await interaction.channel.send(`🏆 **DESAFIO SEMANAL #${id}**\n\n${respD.content[0].text}\n\n+25 pts. Usá /solucionar para enviar tu respuesta.`);
        break;
      }

      case 'solucionar': {
        if (!desafioActivo || !desafios.has(desafioActivo)) { await interaction.editReply('❌ No hay desafio activo.'); break; }
        const desafio = desafios.get(desafioActivo);
        const userId  = interaction.user.id;
        const nombre  = interaction.member?.displayName || interaction.user.username;
        const codigo  = interaction.options.getString('codigo');
        if (desafio.soluciones.has(userId)) { await interaction.editReply('✅ Ya enviaste una solución.'); break; }
        desafio.soluciones.set(userId, { nombre, codigo, hora: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) });
        const p  = darPuntos(userId, nombre, 'entrega');
        const p2 = darPuntos(userId, nombre, 'pregunta');
        await actualizarRolDiscord(interaction.member, p2.pts);
        const evalR = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 400, messages: [{ role: 'user', content: `${CONTEXTOS[desafio.materia] || CONTEXTOS.iev}\nDesafio: ${desafio.enunciado}\nSolución de ${nombre}: ${codigo}\nEvaluá brevemente. Sé pedagógico.` }] });
        await interaction.editReply(`✅ **${nombre}** — solución registrada.\n\n🤖 ${evalR.content[0].text}\n\n📤 +25 pts | Total: **${p2.pts} pts**`);
        break;
      }

      case 'soluciones': {
        if (!desafioActivo || !desafios.has(desafioActivo)) { await interaction.editReply('No hay desafio activo.'); break; }
        const desafio = desafios.get(desafioActivo);
        if (!desafio.soluciones.size) { await interaction.editReply('Ningún alumno envió solución todavía.'); break; }
        const lista = [...desafio.soluciones.values()].map((s, i) => `${i + 1}. **${s.nombre}** (${s.hora}): ${s.codigo.substring(0, 80)}`).join('\n');
        await interaction.editReply(`📋 **Soluciones (${desafio.soluciones.size}):**\n\n${lista}`);
        break;
      }

      case 'cerrar-desafio': {
        if (!desafioActivo || !desafios.has(desafioActivo)) { await interaction.editReply('No hay desafio activo.'); break; }
        const desafio = desafios.get(desafioActivo);
        if (!desafio.soluciones.size) { desafioActivo = null; await interaction.editReply('Cerrado sin participantes.'); break; }
        const [ganadorId, ganadorData] = [...desafio.soluciones.entries()][0];
        const gm = await interaction.guild.members.fetch(ganadorId).catch(() => null);
        const pG = darPuntos(ganadorId, ganadorData.nombre, 'entrega');
        const pG2 = darPuntos(ganadorId, ganadorData.nombre, 'entrega');
        if (gm) await actualizarRolDiscord(gm, pG2.pts);
        desafioActivo = null;
        await interaction.editReply('✅ Desafio cerrado.');
        await interaction.channel.send(`🏆 **DESAFIO CERRADO** — ${desafio.soluciones.size} participantes\n🥇 **${ganadorData.nombre}** ganó con la primera solución (${ganadorData.hora})\n\n¡Felicitaciones! Usá /ranking para ver los cambios.`);
        break;
      }

      case 'tarea': {
        const titulo      = interaction.options.getString('titulo');
        const descripcion = interaction.options.getString('descripcion');
        const fecha       = interaction.options.getString('fecha');
        const id          = tareaCounter++;
        const botones = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`completar_${id}`).setLabel('✅  Marcar como completada').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`vercompletados_${id}`).setLabel('👥  Ver quién completó').setStyle(ButtonStyle.Secondary)
        );
        // MEJORA 6: completados guarda userId (no nombre)
        tareas.set(id, { titulo, descripcion, fecha, canal: interaction.channelId, completados: new Set() });
        guardarDatos();
        await interaction.editReply('✅ Tarea publicada.');
        await interaction.channel.send({ content: `📚 **NUEVA TAREA #${id}**\n\n📌 **${titulo}**\n\n${descripcion}\n\n⏰ **Fecha límite:** ${fecha}`, components: [botones] });
        const partes = fecha.split('/');
        if (partes.length === 3) {
          const recordatorio = new Date(partes[2], partes[1] - 1, partes[0]).getTime() - Date.now() - 86400000;
          if (recordatorio > 0) {
            setTimeout(async () => {
              const t = tareas.get(id);
              if (t) {
                const canal = interaction.guild.channels.cache.get(t.canal);
                if (canal) await canal.send(`⚠️ **Recordatorio:** **"${t.titulo}"** vence mañana **${t.fecha}** — ${t.completados.size} completaron.`);
              }
            }, recordatorio);
          }
        }
        break;
      }

      case 'tareas': {
        if (!tareas.size) { await interaction.editReply('No hay tareas activas.'); break; }
        const lista = [...tareas.entries()].map(([id, t]) => `**#${id} — ${t.titulo}**\n⏰ ${t.fecha} | ✅ ${t.completados.size} completaron`).join('\n\n');
        await interaction.editReply(`📚 **Tareas activas:**\n\n${lista}`);
        break;
      }

      // MEJORA 6: completar por comando también usa userId
      case 'completar': {
        const id    = interaction.options.getInteger('id');
        const tarea = tareas.get(id);
        if (!tarea) { await interaction.editReply(`❌ No existe la tarea #${id}.`); break; }
        const userId = interaction.user.id;
        const nombre = interaction.member?.displayName || interaction.user.username;
        if (tarea.completados.has(userId)) { await interaction.editReply(`✅ **${nombre}**, ya marcaste esta tarea.`); break; }
        tarea.completados.add(userId);
        guardarDatos();
        const p   = darPuntos(userId, nombre, 'entrega');
        const rol = getRol(p.pts);
        await actualizarRolDiscord(interaction.member, p.pts);
        await interaction.editReply(`✅ **${nombre}** completó **"${tarea.titulo}"**\n📤 +20 pts | Total: **${p.pts} pts** ${rol.emoji}`);
        break;
      }

      case 'similitudes': {
        if (!entregasPorActividad.size) { await interaction.editReply('No hay entregas registradas aún.'); break; }
        let msg = '🔍 **Entregas por actividad:**\n\n';
        for (const [actividad, lista] of entregasPorActividad.entries()) {
          msg += `📚 **${actividad}** — ${lista.length} entrega${lista.length !== 1 ? 's' : ''}\n`;
          msg += lista.map(e => `  · ${e.nombre} (${e.hora})`).join('\n') + '\n\n';
        }
        await interaction.editReply(msg);
        break;
      }

      case 'backup': {
        await interaction.editReply('💾 Guardando puntos en Google Sheets...');
        await backupPuntosSheets();
        await interaction.editReply(`✅ Backup completado. ${puntos.size} alumnos guardados en la hoja "Puntos".`);
        break;
      }
    }
  } catch (e) {
    console.error(e);
    await interaction.editReply('❌ Error. Intentá de nuevo.');
  }
});

// =============================================
// BIENVENIDA A NUEVOS MIEMBROS
// =============================================
client.on(Events.GuildMemberAdd, async (member) => {
  const canal   = member.guild.channels.cache.find(c => c.name === 'aviso' || c.name === 'bienvenida');
  const esIES11 = member.guild.name.toLowerCase().includes('11');
  if (canal) {
    await canal.send(esIES11
      ? `👋 ¡Bienvenido/a **${member.displayName}** al IES N°11!\n\n📚 Tecnicatura en Desarrollo de Software\n• **/preguntar** — consultas de BD o Informática con IA\n• **/quiz** — practicá con preguntas interactivas\n• **#entregas** — entregá trabajos y la IA los corrige\n• **/materia** — verificá qué materia detecta el bot`
      : `👋 ¡Bienvenido/a **${member.displayName}** al IES N°6!\n\n📚 Internet y Entornos Virtuales 2026\n• **/preguntar** — consultas con IA\n• **#entregas** — entregá y el bot corrige\n• **/ranking** — mirá tu posición\n• 📰 Noticias tech todos los días en **#noticias-tech**`
    );
  }
});

client.login(DISCORD_TOKEN);