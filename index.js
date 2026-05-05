require('dotenv').config();
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
const DISCORD_TOKEN       = process.env.DISCORD_TOKEN;
const CLIENT_ID           = '1497945827874967733';
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const SPREADSHEET_ID      = process.env.SPREADSHEET_ID;
const GOOGLE_CREDENTIALS  = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const PROFESOR_ID         = process.env.PROFESOR_ID; // tu ID de Discord para DMs

// Moodle
const MOODLE_TOKEN_IES6   = process.env.MOODLE_TOKEN_IES6;
const MOODLE_TOKEN_IES11  = process.env.MOODLE_TOKEN_IES11;
const MOODLE_URL_IES6     = 'https://ies6.aulasvirtuales.name';
const MOODLE_URL_IES11    = 'https://ies11.aulasvirtuales.name';

// Canales especiales
const CANAL_ASISTENCIA = 'dudas';
const CANAL_ENTREGAS   = 'entregas';
const CANAL_NOTICIAS   = 'noticias-tech';

// =============================================
// DETECCIÓN DE MATERIA — NÚCLEO DEL SISTEMA
// =============================================
// IES 6  → materia por defecto: IEV
// IES 11 → materia por defecto: BD, excepto canales con "info" → Informática
//
// Detección en cascada:
//   1. Nombre del canal  (más específico)
//   2. Nombre del servidor (fallback por institución)
//   3. IEV como último recurso

function detectarMateria(guildId, channelName) {
  const canal = (channelName || '').toLowerCase();

  // 1 — Por nombre de canal (tiene prioridad sobre todo)
  if (canal.includes('bd') || canal.includes('base') || canal.includes('datos')) return 'bd';
  if (canal.includes('info') || canal.includes('informatica'))                   return 'informatica';
  if (canal.includes('iev') || canal.includes('internet') || canal.includes('entornos')) return 'iev';

  // 2 — Por servidor
  const guild = client.guilds.cache.get(guildId);
  if (guild) {
    const servidor = guild.name.toLowerCase();
    if (servidor.includes('11')) return 'bd';        // IES 11 → BD por defecto
    if (servidor.includes('6'))  return 'iev';       // IES 6  → IEV por defecto
  }

  // 3 — Fallback
  return 'iev';
}

// =============================================
// CONTEXTOS POR MATERIA
// =============================================
const CONTEXTOS = {
  iev: `Sos el asistente de "Internet y Entornos Virtuales" del Profesorado en Informática del IES N°6, Prof. Ing. Corimayo Ricardo Daniel.
Respondé en español, claro y pedagógico.
Unidades: 1-Introducción a Internet (TCP/IP, HTTP, comandos CMD), 2-Correo y netiqueta (SMTP, POP3, IMAP), 3-Criterio CRAAP para evaluar fuentes, 4-Comunicación sincrónica/asincrónica (Discord, Meet, foros), 5-Entornos virtuales Chamilo/Moodle.
Si no sabés algo decí que consulte al profesor.`,

  bd: `Sos el asistente de "Base de Datos" de la Tecnicatura Superior en Desarrollo de Software del IES N°11, Prof. Ing. Corimayo Ricardo Daniel.
Respondé en español, claro y pedagógico.
Unidades: 1-Introducción y arquitectura de SGBD (DDL/DML, niveles de abstracción), 2-Modelo de datos (conceptual vs lógico, restricciones de integridad), 3-Diseño E-R (entidades, atributos, relaciones, cardinalidad, herencia), 4-Modelo Relacional (claves, vistas, consultas), 5-Normalización (1FN a 5FN, BCNF), 6-Álgebra y Cálculo Relacional, 7-SQL (DDL: CREATE/ALTER/DROP, DML: SELECT/INSERT/UPDATE/DELETE).
Si no sabés algo decí que consulte al profesor.`,

  informatica: `Sos el asistente de "Informática" de la Tecnicatura Superior en Desarrollo de Software del IES N°11, 1er año, Prof. Ing. Corimayo Ricardo Daniel.
Respondé en español, claro y pedagógico.
Unidades: 1-Introducción a la Informática (hardware, software, sistemas operativos), 2-Ofimática (procesadores de texto, hojas de cálculo, presentaciones), 3-Redes y Computación Distribuida (TCP/IP, cliente/servidor, peer-to-peer), 4-Computación Paralela y Concurrente (multinúcleo, paralelismo), 5-Inteligencia Artificial (machine learning, redes neuronales, PLN).
Si no sabés algo decí que consulte al profesor.`,
};

function getContexto(guildId, channelName) {
  return CONTEXTOS[detectarMateria(guildId, channelName)];
}

// =============================================
// CONTENIDO DE UNIDADES POR MATERIA
// =============================================
const UNIDADES = {
  iev: {
    1: '🌐 **IEV — Unidad 1: Introducción a Internet**\n\nProtocolos TCP/IP, HTTP, HTTPS, FTP. Comandos CMD: ping, tracert, ipconfig, nslookup.\n\n**Plataforma:** Chamilo → aulasvirtuales.name/chamilo',
    2: '📧 **IEV — Unidad 2: Correo y Netiqueta**\n\nSMTP, POP3, IMAP. Netiqueta digital. CC vs CCO.',
    3: '🔍 **IEV — Unidad 3: Búsqueda y Evaluación**\n\nMotores de búsqueda. Criterio CRAAP. Fake news.\n\n**Probá:** /craap [url]',
    4: '💬 **IEV — Unidad 4: Comunicación**\n\nSincrónica vs Asincrónica. Discord, Meet, Zoom. Foros.',
    5: '🖥️ **IEV — Unidad 5: Entornos Virtuales**\n\nChamilo y Moodle. Roles. Creación de cursos.\n\n**Proyecto final:** Aula virtual en Chamilo.',
  },
  bd: {
    1: '🗄️ **BD — Unidad 1: Introducción y Arquitectura de SGBD**\n\nDefinición de BD y SGBD, niveles de abstracción (físico, conceptual, externo), independencia de datos, DDL y DML.',
    2: '📊 **BD — Unidad 2: Modelo de Datos**\n\nModelos conceptuales vs lógicos. Restricciones de integridad. Aspectos estáticos y dinámicos.',
    3: '🔗 **BD — Unidad 3: Diseño y Diagrama E-R**\n\nEntidades, atributos, relaciones, cardinalidad, entidades débiles, herencia, especialización y generalización.',
    4: '📋 **BD — Unidad 4: Modelo Relacional**\n\nClaves primarias y foráneas, restricciones de integridad, vistas, consultas relacionales.',
    5: '📐 **BD — Unidad 5: Normalización**\n\nDependencias funcionales. Formas normales: 1FN, 2FN, 3FN, BCNF, 4FN, 5FN.',
    6: '🔢 **BD — Unidad 6: Álgebra y Cálculo Relacional**\n\nOperadores primitivos (selección, proyección, unión, diferencia, producto cartesiano) y derivados.',
    7: '💻 **BD — Unidad 7: SQL**\n\nDDL: CREATE, ALTER, DROP. DML: SELECT, INSERT, UPDATE, DELETE. Restricciones, vistas, subconsultas.',
  },
  informatica: {
    1: '💻 **Informática — Unidad 1: Introducción**\n\nConcepto de informática, hardware, software, sistemas operativos. Evolución histórica.',
    2: '📝 **Informática — Unidad 2: Ofimática**\n\nProcesadores de texto, hojas de cálculo, presentaciones. Uso profesional.',
    3: '🌐 **Informática — Unidad 3: Redes y Computación Distribuida**\n\nTipos de redes, protocolos. Cliente/servidor vs peer-to-peer. Computación móvil.',
    4: '⚡ **Informática — Unidad 4: Computación Paralela y Concurrente**\n\nProcesadores multinúcleo, paralelismo, concurrencia.',
    5: '🤖 **Informática — Unidad 5: Inteligencia Artificial**\n\nMachine learning, redes neuronales, PLN. Tendencias futuras.',
  }
};

function getUnidades(guildId, channelName) {
  return UNIDADES[detectarMateria(guildId, channelName)] || UNIDADES.iev;
}

// =============================================
// SISTEMA DE PUNTOS
// =============================================
const puntos = new Map();

function darPuntos(userId, nombre, tipo) {
  if (!puntos.has(userId)) puntos.set(userId, { nombre, pts: 0, entregas: 0, asistencias: 0, preguntas: 0 });
  const p = puntos.get(userId);
  p.nombre = nombre;
  if (tipo === 'asistencia') { p.pts += 10; p.asistencias++; }
  if (tipo === 'entrega')    { p.pts += 20; p.entregas++;    }
  if (tipo === 'pregunta')   { p.pts += 5;  p.preguntas++;   }
  puntos.set(userId, p);
  return p;
}

function getRanking() {
  return [...puntos.entries()].sort((a, b) => b[1].pts - a[1].pts).slice(0, 10);
}

function getRol(pts) {
  if (pts >= 200) return { nombre: 'Experto Digital',     emoji: '🏆' };
  if (pts >= 100) return { nombre: 'Colaborador Activo',  emoji: '⭐' };
  if (pts >= 50)  return { nombre: 'Aprendiz',            emoji: '📚' };
  return              { nombre: 'Novato',               emoji: '🌱' };
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
      if (!rol) rol = await guild.roles.create({ name: rolDef.nombre, color: rolDef.color, reason: 'Rol automático Bot IEV' });
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
  const palabras = t => new Set(
    t.toLowerCase().replace(/[^a-záéíóúñ0-9\s]/gi, '').split(/\s+/).filter(p => p.length > 3)
  );
  const set1 = palabras(texto1);
  const set2 = palabras(texto2);
  if (set1.size === 0 || set2.size === 0) return 0;
  const interseccion = [...set1].filter(p => set2.has(p)).length;
  const union = new Set([...set1, ...set2]).size;
  return Math.round((interseccion / union) * 100);
}

async function verificarPlagioConIA(actividad, nombre1, contenido1, nombre2, contenido2, similitudBasica) {
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Analizá estas dos entregas de la actividad "${actividad}" y determiná si hay copia o colaboración excesiva.

Entrega de ${nombre1}: ${contenido1.substring(0, 800)}

Entrega de ${nombre2}: ${contenido2.substring(0, 800)}

Respondé SOLO en JSON exacto: {"similitud_real": número 0-100, "veredicto": "Copia evidente" o "Muy similar" o "Colaboración" o "Coincidencia", "detalle": "explicación en 1 oración"}`
      }]
    });
    const txt = resp.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(txt);
  } catch (e) {
    return { similitud_real: similitudBasica, veredicto: 'Muy similar', detalle: 'Análisis automático por similitud de palabras.' };
  }
}

async function avisarPlagio(guild, actividad, nombre1, nombre2, similitud, analisis) {
  try {
    if (!PROFESOR_ID) { console.log('PROFESOR_ID no configurado en Railway'); return; }
    const profesor = await guild.client.users.fetch(PROFESOR_ID);
    if (!profesor) return;
    const nivel = similitud >= 90 ? '🔴 COPIA MUY PROBABLE' : similitud >= 75 ? '🟠 SIMILITUD ALTA' : '🟡 SIMILITUD MODERADA';
    const msg = `⚠️ **Alerta de similitud en entrega**\n\n${nivel}\n📚 **Actividad:** ${actividad}\n👤 **Alumnos:** ${nombre1} y ${nombre2}\n📊 **Similitud:** ${similitud}%\n🤖 **Veredicto IA:** ${analisis.veredicto}\n💬 **Detalle:** ${analisis.detalle}\n\n_Revisá las entregas en #entregas para confirmar._`;
    await profesor.send(msg);
    console.log(`Alerta de plagio: ${nombre1} y ${nombre2} en "${actividad}"`);
  } catch (e) { console.error('Error enviando DM al profesor:', e.message); }
}

async function compararEntregas(guild, actividad, nombreNuevo, userIdNuevo, contenidoNuevo) {
  const clave = actividad.toLowerCase().trim();
  if (!entregasPorActividad.has(clave)) entregasPorActividad.set(clave, []);
  const entregas = entregasPorActividad.get(clave);
  for (const entregaPrevia of entregas) {
    if (entregaPrevia.userId === userIdNuevo) continue;
    const similitudBasica = calcularSimilitud(contenidoNuevo, entregaPrevia.contenido);
    if (similitudBasica >= 50) {
      const analisis = await verificarPlagioConIA(actividad, nombreNuevo, contenidoNuevo, entregaPrevia.nombre, entregaPrevia.contenido, similitudBasica);
      if (analisis.similitud_real >= 70) {
        await avisarPlagio(guild, actividad, nombreNuevo, entregaPrevia.nombre, analisis.similitud_real, analisis);
      }
    }
  }
  entregas.push({
    nombre: nombreNuevo,
    userId: userIdNuevo,
    contenido: contenidoNuevo,
    hora: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
  });
}

// =============================================
// ESTADO DE CLASES Y ASISTENCIA
// =============================================
const formularioActivo = new Map();
const tareas    = new Map(); let tareaCounter   = 1;
const eventos   = new Map(); let eventoCounter  = 1;
const quizActivo = new Map();
const desafios  = new Map(); let desafioCounter = 1;
let desafioActivo = null;

let sesionActiva   = false;
let asistentesHoy  = new Map();
let fechaClaseActual = '';

const HORARIOS_CLASE = [
  { dia: 2, hora: 8, minuto: 0 },
  { dia: 4, hora: 8, minuto: 0 },
];
const HORA_NOTICIAS = { hora: 8, minuto: 0 };

// =============================================
// CLIENTE DISCORD Y ANTHROPIC
// =============================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});
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
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Asistencia!A:D',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[fecha, hora, nombre, 'Presente']] },
    });
  } catch (e) { console.error('Error Sheets:', e); }
}

// =============================================
// MOODLE
// =============================================
async function moodleAPI(url, token, func, params = {}) {
  try {
    const qs = new URLSearchParams({ wstoken: token, wsfunction: func, moodlewsrestformat: 'json', ...params });
    const resp = await fetch(url + '/webservice/rest/server.php?' + qs.toString());
    const data = await resp.json();
    if (data && data.exception) { console.error('Moodle error:', data.message); return { _error: data.message, _code: data.errorcode }; }
    return data;
  } catch (e) { console.error('Moodle fetch error:', e.message); return null; }
}

function getMoodleConfig(guildName) {
  const esIES11 = guildName && guildName.toLowerCase().includes('11');
  return {
    url:    esIES11 ? MOODLE_URL_IES11    : MOODLE_URL_IES6,
    token:  esIES11 ? MOODLE_TOKEN_IES11  : MOODLE_TOKEN_IES6,
    nombre: esIES11 ? 'IES N°11'          : 'IES N°6'
  };
}

async function getCursos(url, token)                        { return await moodleAPI(url, token, 'core_course_get_courses'); }
async function getActividades(url, token, courseId)         { return await moodleAPI(url, token, 'core_course_get_contents', { courseid: courseId }); }
async function getUsuarioPorNombre(url, token, nombre) {
  const data = await moodleAPI(url, token, 'core_user_get_users', { 'criteria[0][key]': 'fullname', 'criteria[0][value]': nombre });
  return data && data.users && data.users.length > 0 ? data.users[0] : null;
}
async function getNotasUsuario(url, token, userId, courseId) { return await moodleAPI(url, token, 'gradereport_user_get_grade_items', { userid: userId, courseid: courseId }); }

// =============================================
// CALENDARIO
// =============================================
function parseFecha(str) {
  const p = str.split('/');
  if (p.length !== 3) return null;
  return new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0]));
}
function diasRestantes(fecha) {
  const hoy = new Date(); hoy.setHours(0,0,0,0); fecha.setHours(0,0,0,0);
  return Math.round((fecha - hoy) / 86400000);
}
function emojiTipo(tipo) { return { parcial:'📝', entrega:'📤', proyecto:'🎓', clase:'📚', recuperatorio:'🔄' }[tipo] || '📅'; }
function formatEventos(lista) {
  if (lista.length === 0) return 'No hay eventos registrados.';
  return lista.map(([id, ev]) => {
    const dias = diasRestantes(parseFecha(ev.fecha));
    const estado = dias < 0 ? '✅ Pasado' : dias === 0 ? '🔴 HOY' : dias === 1 ? '🟠 Mañana' : dias <= 3 ? '🟡 En ' + dias + ' días' : '🟢 En ' + dias + ' días';
    return `${emojiTipo(ev.tipo)} **#${id} — ${ev.titulo}**\n📅 ${ev.fecha} · ${estado}${ev.descripcion ? '\n📋 ' + ev.descripcion : ''}`;
  }).join('\n\n');
}

// =============================================
// NOTICIAS TECH AUTOMÁTICAS
// =============================================
async function publicarNoticias(guild) {
  const canal = guild.channels.cache.find(c => c.name === CANAL_NOTICIAS);
  if (!canal) return;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Generá un resumen de 3 noticias tecnológicas relevantes para estudiantes de Informática del nivel terciario en Argentina. 
Relacionalas con: Internet, IA, educación virtual, redes, ciberseguridad.
Formato:
**🔹 [Título]**
Resumen en 2-3 oraciones.
💡 *Por qué importa para tu carrera: [explicación breve]*

Separalas con una línea. Lenguaje juvenil pero profesional. Hoy es ${new Date().toLocaleDateString('es-AR')}.`
      }]
    });
    await canal.send(`📰 **NOTICIAS TECH DEL DÍA — ${new Date().toLocaleDateString('es-AR')}**\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n${resp.content[0].text}\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n*Generado automáticamente por Bot IEV 🤖*`);
  } catch (e) { console.error('Error noticias:', e); }
}

// =============================================
// CORRECCIÓN DE ENTREGAS CON IA
// =============================================
async function corregirEntrega(texto) {
  if (!texto || texto.length < 20) return null;
  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: `Sos el asistente del Prof. Ing. Corimayo Ricardo Daniel. Analizá esta entrega y respondé con este formato exacto:

✅ **Aspectos positivos:**
[puntos fuertes]

🔧 **Aspectos a mejorar:**
[lo que falta o está incompleto]

📊 **Evaluación orientativa:** [Excelente / Muy bueno / Bueno / Regular / Insuficiente]

💡 **Sugerencia del profesor:**
[consejo personalizado]

Sé constructivo, empático y pedagógico.

TRABAJO DEL ALUMNO:
${texto.substring(0, 3000)}`
    }]
  });
  return resp.content[0].text;
}

// =============================================
// INICIAR CLASE
// =============================================
async function iniciarClase(channel, titulo = 'Clase de hoy') {
  if (sesionActiva) { await channel.send('⚠️ Ya hay una clase activa. Cerrá con `/cerrar-clase`'); return; }
  sesionActiva    = true;
  asistentesHoy   = new Map();
  const ahora     = new Date();
  fechaClaseActual = ahora.toLocaleDateString('es-AR');
  const boton = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('presente').setLabel('✅  Marcar presencia').setStyle(ButtonStyle.Success)
  );
  await channel.send({
    content: `📋 **ASISTENCIA — ${titulo}**\n📅 Fecha: **${fechaClaseActual}** | 🕐 Inicio: **${ahora.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}**\n\nHacé clic para registrar tu presencia.`,
    components: [boton],
  });
}

// =============================================
// COMANDOS SLASH
// =============================================
const commands = [
  new SlashCommandBuilder().setName('iniciar-clase').setDescription('Iniciar toma de asistencia').addStringOption(o => o.setName('titulo').setDescription('Tema de la clase').setRequired(false)),
  new SlashCommandBuilder().setName('cerrar-clase').setDescription('Cerrar asistencia y ver resumen'),
  new SlashCommandBuilder().setName('asistencia').setDescription('Ver asistencia del día'),
  new SlashCommandBuilder().setName('noticias').setDescription('Publicar noticias tech del día ahora'),
  new SlashCommandBuilder().setName('corregir').setDescription('Corregir un trabajo con IA').addStringOption(o => o.setName('texto').setDescription('Pegá el texto del trabajo aquí').setRequired(true)),
  new SlashCommandBuilder().setName('unidad').setDescription('Info de una unidad de la materia').addIntegerOption(o => o.setName('numero').setDescription('Número de unidad').setRequired(true).setMinValue(1).setMaxValue(7)),
  new SlashCommandBuilder().setName('preguntar').setDescription('Preguntá a la IA sobre la materia').addStringOption(o => o.setName('pregunta').setDescription('Tu pregunta').setRequired(true)),
  new SlashCommandBuilder().setName('entrega').setDescription('Instrucciones para entregar trabajos'),
  new SlashCommandBuilder().setName('herramientas').setDescription('Links de las herramientas del curso'),
  new SlashCommandBuilder().setName('craap').setDescription('Evaluar una fuente con criterio CRAAP').addStringOption(o => o.setName('url').setDescription('URL a evaluar').setRequired(true)),
  new SlashCommandBuilder().setName('ranking').setDescription('Ver el ranking de participación del curso'),
  new SlashCommandBuilder().setName('mispuntos').setDescription('Ver tus puntos y rol actual'),
  new SlashCommandBuilder().setName('miscursos').setDescription('Ver tus cursos activos en Moodle'),
  new SlashCommandBuilder().setName('misnota').setDescription('Consultar tus notas en Moodle').addStringOption(o => o.setName('nombre').setDescription('Tu nombre completo en Moodle').setRequired(true)),
  new SlashCommandBuilder().setName('actividades').setDescription('Ver actividades de un curso Moodle').addIntegerOption(o => o.setName('curso').setDescription('ID del curso (usá /miscursos)').setRequired(true)),
  new SlashCommandBuilder().setName('moodle').setDescription('Ver estado de conexión con Moodle'),
  new SlashCommandBuilder().setName('evento')
    .setDescription('Agregar evento al calendario (solo profesor)')
    .addStringOption(o => o.setName('titulo').setDescription('Nombre del evento').setRequired(true))
    .addStringOption(o => o.setName('fecha').setDescription('Fecha (dd/mm/yyyy)').setRequired(true))
    .addStringOption(o => o.setName('tipo').setDescription('Tipo').setRequired(true)
      .addChoices(
        { name: 'Parcial',          value: 'parcial'        },
        { name: 'Entrega',          value: 'entrega'        },
        { name: 'Proyecto final',   value: 'proyecto'       },
        { name: 'Clase especial',   value: 'clase'          },
        { name: 'Recuperatorio',    value: 'recuperatorio'  },
      ))
    .addStringOption(o => o.setName('descripcion').setDescription('Descripción opcional').setRequired(false)),
  new SlashCommandBuilder().setName('calendario').setDescription('Ver todos los eventos del cuatrimestre'),
  new SlashCommandBuilder().setName('proximo').setDescription('Ver el próximo evento importante'),
  new SlashCommandBuilder().setName('borrar-evento').setDescription('Borrar un evento (solo profesor)').addIntegerOption(o => o.setName('id').setDescription('ID del evento').setRequired(true)),
  new SlashCommandBuilder().setName('quiz').setDescription('Quiz de opción múltiple (+15 pts si aprobás)').addIntegerOption(o => o.setName('unidad').setDescription('Número de unidad').setRequired(true).setMinValue(1).setMaxValue(7)),
  new SlashCommandBuilder().setName('desafio').setDescription('Publicar desafio semanal con IA (solo profesor)').addStringOption(o => o.setName('materia').setDescription('iev, bd o informatica').setRequired(true)),
  new SlashCommandBuilder().setName('solucionar').setDescription('Enviar tu solución al desafio activo').addStringOption(o => o.setName('codigo').setDescription('Tu solución o respuesta').setRequired(true)),
  new SlashCommandBuilder().setName('soluciones').setDescription('Ver soluciones del desafio actual (solo profesor)'),
  new SlashCommandBuilder().setName('cerrar-desafio').setDescription('Cerrar el desafio y anunciar ganador (solo profesor)'),
  new SlashCommandBuilder().setName('tarea')
    .setDescription('Publicar una nueva tarea (solo profesor)')
    .addStringOption(o => o.setName('titulo').setDescription('Título').setRequired(true))
    .addStringOption(o => o.setName('descripcion').setDescription('Descripción detallada').setRequired(true))
    .addStringOption(o => o.setName('fecha').setDescription('Fecha límite ej: 30/05/2026').setRequired(true)),
  new SlashCommandBuilder().setName('tareas').setDescription('Ver todas las tareas activas'),
  new SlashCommandBuilder().setName('completar').setDescription('Marcar una tarea como completada').addIntegerOption(o => o.setName('id').setDescription('ID de la tarea').setRequired(true)),
  new SlashCommandBuilder().setName('similitudes').setDescription('Ver estadísticas de entregas registradas (solo profesor)'),
  new SlashCommandBuilder().setName('materia').setDescription('Ver qué materia detecta el bot en este canal'),
];

async function registrarComandos(guildId) {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commands.map(c => c.toJSON()) });
  console.log(`✅ Comandos registrados en guild ${guildId}`);
}

// =============================================
// EVENTO: BOT LISTO
// =============================================
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot conectado como ${c.user.tag}`);
  for (const guild of c.guilds.cache.values()) await registrarComandos(guild.id);

  setInterval(async () => {
    const ahora = new Date();
    const dia   = ahora.getDay();
    const hora  = ahora.getHours();
    const min   = ahora.getMinutes();

    // Verificar actividades Moodle cada hora
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
                    await canal.send(`📌 **Recordatorio Moodle ${mc.nombre}**\n📚 ${mod.name} — Curso: ${curso.shortname}\n📅 Vence: ${new Date(date.timestamp * 1000).toLocaleDateString('es-AR')}`);
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
      if (dias === 3 && !ev.avisado3d)  { ev.avisado3d  = true; await avisar(`⏰ **Recordatorio — Faltan 3 días**\n\n${emojiTipo(ev.tipo)} **${ev.titulo}**\n📅 **${ev.fecha}**${ev.descripcion ? '\n📋 ' + ev.descripcion : ''}`); }
      if (dias === 1 && !ev.avisado1d)  { ev.avisado1d  = true; await avisar(`🚨 **Mañana es el día**\n\n${emojiTipo(ev.tipo)} **${ev.titulo}** es MAÑANA\n📅 **${ev.fecha}**${ev.descripcion ? '\n📋 ' + ev.descripcion : ''}`); }
      if (dias === 0 && !ev.avisadoHoy) { ev.avisadoHoy = true; await avisar(`🔴 **HOY — ${ev.titulo}**\n\n${emojiTipo(ev.tipo)} Recordá que hoy es el día.\n📅 **${ev.fecha}**${ev.descripcion ? '\n📋 ' + ev.descripcion : ''}`); }
    }

    // Asistencia automática
    for (const h of HORARIOS_CLASE) {
      if (h.dia === dia && h.hora === hora && min === h.minuto) {
        for (const guild of client.guilds.cache.values()) {
          const canal = guild.channels.cache.find(c => c.name === CANAL_ASISTENCIA);
          if (canal) await iniciarClase(canal, 'Clase programada');
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
// EVENTO: MENSAJES (formulario de entregas + menciones)
// =============================================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // Formulario de entregas
  if (message.channel.name === CANAL_ENTREGAS) {
    const userId = message.author.id;
    const nombre = message.member?.displayName || message.author.username;

    if (formularioActivo.has(userId)) {
      const form = formularioActivo.get(userId);

      if (form.paso === 1) {
        form.actividad = message.content; form.paso = 2; formularioActivo.set(userId, form);
        await message.reply('📎 **Paso 2/3:** Pegá el link de tu trabajo (GitHub, Google Drive) o adjuntá el archivo.');
        return;
      }
      if (form.paso === 2) {
        form.link = message.content || (message.attachments.first()?.url || 'Sin link'); form.paso = 3; formularioActivo.set(userId, form);
        await message.reply('💬 **Paso 3/3:** ¿Algún comentario sobre tu entrega? (o escribí "listo" para terminar)');
        return;
      }
      if (form.paso === 3) {
        form.comentario = message.content === 'listo' ? '' : message.content;
        formularioActivo.delete(userId);

        await message.channel.send(`📋 **ENTREGA REGISTRADA**\n👤 Alumno: **${form.nombre}**\n📚 Actividad: **${form.actividad}**\n🔗 Link: ${form.link}\n💬 Comentario: ${form.comentario || 'Ninguno'}`);

        // Detección de similitud
        const contenidoCompleto = `${form.actividad} ${form.link} ${form.comentario}`;
        compararEntregas(message.guild, form.actividad, nombre, userId, contenidoCompleto).catch(console.error);

        // Puntos y rol
        const p   = darPuntos(userId, nombre, 'entrega');
        const rol = getRol(p.pts);
        await actualizarRolDiscord(message.member, p.pts);

        // Corrección con IA
        try {
          await message.channel.sendTyping();
          const correccion = await corregirEntrega(`Actividad: ${form.actividad}. Link: ${form.link}. Comentario: ${form.comentario}`);
          if (correccion) {
            await message.reply(`🤖 **Corrección automática:**\n\n${correccion}\n\n*⚠️ Orientativa. La nota final la define el profesor.*\n\n📤 +20 puntos | Total: **${p.pts} pts** ${rol.emoji}`);
          }
        } catch (e) { console.error('Error corrección:', e); }
        return;
      }
    }

    // Iniciar formulario
    if (!formularioActivo.has(userId) && message.content.length > 2) {
      formularioActivo.set(userId, { paso: 1, nombre, actividad: '', link: '', comentario: '' });
      await message.reply(`📝 **Formulario de entrega**\n\nHola **${nombre}**, registremos tu entrega paso a paso.\n\n**Paso 1/3:** ¿Cuál es el nombre de la actividad que entregás?`);
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
// EVENTO: INTERACCIONES
// =============================================
client.on(Events.InteractionCreate, async (interaction) => {

  // ── Botón: Quiz ──
  if (interaction.isButton() && interaction.customId.startsWith('quiz_')) {
    const [, respuesta, targetUserId] = interaction.customId.split('_');
    const userId = interaction.user.id;
    if (userId !== targetUserId) { await interaction.reply({ content: '⚠️ Este quiz es de otro alumno.', ephemeral: true }); return; }
    const quiz = quizActivo.get(userId);
    if (!quiz)           { await interaction.reply({ content: '⚠️ No tenés quiz activo. Usá /quiz.', ephemeral: true }); return; }
    if (quiz.respondido) { await interaction.reply({ content: '✅ Ya respondiste. Usá /quiz para una nueva pregunta.', ephemeral: true }); return; }
    quiz.respondido = true; quizActivo.set(userId, quiz);
    const nombre     = interaction.member?.displayName || interaction.user.username;
    const esCorrecta = respuesta === quiz.correcta;
    let msg;
    if (esCorrecta) {
      const p = darPuntos(userId, nombre, 'pregunta'); darPuntos(userId, nombre, 'pregunta'); const p3 = darPuntos(userId, nombre, 'pregunta');
      await actualizarRolDiscord(interaction.member, p3.pts);
      msg = `✅ **¡Correcto ${nombre}!** ${quiz.explicacion}\n\n+15 puntos | Total: **${p3.pts} pts**. Usá /quiz ${quiz.unidad} para otra pregunta.`;
    } else {
      msg = `❌ **Incorrecto ${nombre}.** Tu respuesta: ${respuesta} — Correcta: ${quiz.correcta}\n${quiz.explicacion}\n\nSin descuento. Usá /quiz ${quiz.unidad} para intentar de nuevo.`;
    }
    await interaction.update({ content: msg, components: [] });
    return;
  }

  // ── Botón: Completar tarea ──
  if (interaction.isButton() && interaction.customId.startsWith('completar_')) {
    const id    = parseInt(interaction.customId.split('_')[1]);
    const tarea = tareas.get(id);
    if (!tarea) { await interaction.reply({ content: '❌ Tarea no encontrada.', ephemeral: true }); return; }
    const nombre = interaction.member?.displayName || interaction.user.username;
    if (tarea.completados.has(nombre)) { await interaction.reply({ content: `✅ **${nombre}**, ya marcaste esta tarea.`, ephemeral: true }); return; }
    tarea.completados.add(nombre);
    const p   = darPuntos(interaction.user.id, nombre, 'entrega');
    const rol = getRol(p.pts);
    await actualizarRolDiscord(interaction.member, p.pts);
    await interaction.reply({ content: `✅ **${nombre}** completó **"${tarea.titulo}"**\n📤 +20 puntos | Total: **${p.pts} pts** ${rol.emoji}` });
    return;
  }

  // ── Botón: Ver completados ──
  if (interaction.isButton() && interaction.customId.startsWith('vercompletados_')) {
    const id    = parseInt(interaction.customId.split('_')[1]);
    const tarea = tareas.get(id);
    if (!tarea) { await interaction.reply({ content: '❌ Tarea no encontrada.', ephemeral: true }); return; }
    const lista = [...tarea.completados].map((n, i) => `${i + 1}. ${n}`).join('\n') || 'Nadie completó esta tarea todavía.';
    await interaction.reply({ content: `👥 **Completaron "${tarea.titulo}"** (${tarea.completados.size}):\n\n${lista}`, ephemeral: true });
    return;
  }

  // ── Botón: Presente ──
  if (interaction.isButton() && interaction.customId === 'presente') {
    if (!sesionActiva) { await interaction.reply({ content: '⚠️ La clase ya cerró.', ephemeral: true }); return; }
    const userId = interaction.user.id;
    const nombre = interaction.member?.displayName || interaction.user.username;
    if (asistentesHoy.has(userId)) { await interaction.reply({ content: `✅ **${nombre}**, ya registraste tu presencia.`, ephemeral: true }); return; }
    const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    asistentesHoy.set(userId, { nombre, hora });
    await guardarAsistencia(nombre, fechaClaseActual, hora);
    const p   = darPuntos(userId, nombre, 'asistencia');
    const rol = getRol(p.pts);
    await actualizarRolDiscord(interaction.member, p.pts);
    await interaction.reply({ content: `✅ **${nombre}** registró presencia a las **${hora}**\n${rol.emoji} +10 puntos | Total: **${p.pts} pts** | Rol: **${rol.nombre}**` });
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();

  try {
    switch (interaction.commandName) {

      // ── DIAGNÓSTICO DE MATERIA ──
      case 'materia': {
        const materia = detectarMateria(interaction.guildId, interaction.channel?.name);
        const nombres = { iev: 'Internet y Entornos Virtuales (IEV)', bd: 'Base de Datos', informatica: 'Informática' };
        await interaction.editReply(
          `🔍 **Detección de materia**\n\n` +
          `Canal: **#${interaction.channel?.name}** | Servidor: **${interaction.guild?.name}**\n\n` +
          `✅ Materia detectada: **${nombres[materia]}**\n\n` +
          `Si no es la correcta, el nombre del canal debe incluir:\n` +
          `• Base de Datos → \`bd\`, \`base\` o \`datos\`\n` +
          `• Informática → \`info\` o \`informatica\`\n` +
          `• IEV → \`iev\`, \`internet\` o \`entornos\``
        );
        break;
      }

      case 'iniciar-clase': {
        const titulo = interaction.options.getString('titulo') || 'Clase de hoy';
        await iniciarClase(interaction.channel, titulo);
        await interaction.editReply('✅ Clase iniciada.');
        break;
      }

      case 'cerrar-clase': {
        if (!sesionActiva) { await interaction.editReply('⚠️ No hay clase activa.'); break; }
        sesionActiva = false;
        const lista  = [...asistentesHoy.values()];
        const resumen = lista.length > 0 ? lista.map((a, i) => `${i + 1}. **${a.nombre}** — ${a.hora}`).join('\n') : 'Ningún alumno registró presencia.';
        await interaction.editReply(`📋 **Clase cerrada — ${fechaClaseActual}**\n👥 Total: **${lista.length} presentes**\n\n${resumen}\n\n📊 Guardado en Google Sheets.`);
        break;
      }

      case 'asistencia': {
        if (asistentesHoy.size === 0) { await interaction.editReply('No hay asistencia registrada hoy.'); break; }
        const lista = [...asistentesHoy.values()];
        await interaction.editReply(`📋 **Asistencia ${fechaClaseActual}** — ${lista.length} presentes\n\n${lista.map((a, i) => `${i + 1}. **${a.nombre}** — ${a.hora}`).join('\n')}`);
        break;
      }

      case 'noticias': {
        await interaction.editReply('📰 Generando noticias...');
        publicarNoticias(interaction.guild)
          .then(() => interaction.editReply('📰 ¡Noticias publicadas en #noticias-tech!'))
          .catch(() => interaction.editReply('❌ Error generando noticias.'));
        break;
      }

      case 'corregir': {
        const texto      = interaction.options.getString('texto');
        const correccion = await corregirEntrega(texto);
        await interaction.editReply(`🤖 **Corrección automática:**\n\n${correccion}\n\n*⚠️ Orientativa. La nota final la define el profesor.*`);
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
        await interaction.editReply(`🤖 **Respuesta:**\n\n${resp.content[0].text}\n\n💡 +5 puntos por participar`);
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

      case 'mispuntos': {
        const userId = interaction.user.id;
        const nombre = interaction.member?.displayName || interaction.user.username;
        if (!puntos.has(userId)) { await interaction.editReply('Todavía no tenés puntos. ¡Participá en clase!'); break; }
        const p   = puntos.get(userId);
        const rol = getRol(p.pts);
        const pos = getRanking().findIndex(([id]) => id === userId) + 1;
        await interaction.editReply(`${rol.emoji} **${nombre}** — ${rol.nombre}\n\n📊 **Total: ${p.pts} pts** | Posición #${pos}\n\n✅ Asistencias: ${p.asistencias} (+${p.asistencias * 10} pts)\n📤 Entregas: ${p.entregas} (+${p.entregas * 20} pts)\n💬 Preguntas: ${p.preguntas} (+${p.preguntas * 5} pts)`);
        break;
      }

      case 'entrega':
        await interaction.editReply('📤 **Cómo entregar:**\n\n1. Andá a **#entregas**\n2. Escribí cualquier cosa para iniciar el formulario\n3. Seguí los 3 pasos que indica el bot\n4. El bot corrige automáticamente con IA\n5. El profesor confirma la nota final\n\n⚠️ No se aceptan entregas por WhatsApp ni privado.');
        break;

      case 'herramientas':
        await interaction.editReply('🛠️ **Herramientas del curso:**\n\n📘 Chamilo → aulasvirtuales.name/chamilo\n📗 Moodle → aulasvirtuales.name/innova\n🐙 GitHub → github.com\n💬 Discord → Este servidor ✅');
        break;

      case 'craap': {
        const url  = interaction.options.getString('url');
        const ctx  = getContexto(interaction.guildId, interaction.channel?.name);
        const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 800, messages: [{ role: 'user', content: `${ctx}\n\nEvaluá "${url}" con criterio CRAAP. Puntuá del 1 al 5 cada dimensión y dá conclusión final.` }] });
        await interaction.editReply(`🔍 **Evaluación CRAAP: \`${url}\`**\n\n${resp.content[0].text}`);
        break;
      }

      case 'moodle': {
        const mc = getMoodleConfig(interaction.guild?.name);
        if (!mc.token) { await interaction.editReply(`❌ Token de Moodle no configurado en Railway para ${mc.nombre}`); break; }
        const cursos = await getCursos(mc.url, mc.token);
        if (!cursos)       { await interaction.editReply(`❌ Error de conexión con ${mc.url}`); break; }
        if (cursos._error) { await interaction.editReply(`❌ Error Moodle: ${cursos._error}`); break; }
        await interaction.editReply(`✅ Moodle **${mc.nombre}** conectado. Cursos: **${Array.isArray(cursos) ? cursos.length : 0}** — ${mc.url}`);
        break;
      }

      case 'miscursos': {
        const mc     = getMoodleConfig(interaction.guild?.name);
        const cursos = await getCursos(mc.url, mc.token);
        if (!cursos || !Array.isArray(cursos)) { await interaction.editReply('❌ No se pudo obtener los cursos.'); break; }
        const activos = cursos.filter(c => c.visible === 1 && c.id > 1);
        if (activos.length === 0) { await interaction.editReply('No hay cursos activos en Moodle.'); break; }
        const lista = activos.slice(0, 15).map(c => `#${c.id} — ${c.fullname}`).join('\n');
        await interaction.editReply(`📚 **Cursos en Moodle ${mc.nombre}:**\n\n${lista}\n\nUsá /actividades curso:[id] para ver actividades.`);
        break;
      }

      case 'actividades': {
        const mc        = getMoodleConfig(interaction.guild?.name);
        const courseId  = interaction.options.getInteger('curso');
        const secciones = await getActividades(mc.url, mc.token, courseId);
        if (!secciones || !Array.isArray(secciones)) { await interaction.editReply('❌ No se pudo obtener las actividades.'); break; }
        let msg = `📋 **Actividades del curso #${courseId}:**\n`;
        let totalActs = 0;
        for (const sec of secciones.slice(0, 5)) {
          if (!sec.modules || sec.modules.length === 0) continue;
          msg += `\n**${sec.name}:**\n`;
          for (const mod of sec.modules.slice(0, 5)) { msg += `  • ${mod.name} (${mod.modname})\n`; totalActs++; }
        }
        await interaction.editReply(totalActs === 0 ? 'No hay actividades en este curso.' : msg);
        break;
      }

      case 'misnota': {
        const mc           = getMoodleConfig(interaction.guild?.name);
        const nombreBuscar = interaction.options.getString('nombre');
        const usuario      = await getUsuarioPorNombre(mc.url, mc.token, nombreBuscar);
        if (!usuario) { await interaction.editReply(`❌ No encontré **${nombreBuscar}** en Moodle ${mc.nombre}.`); break; }
        const cursos = await getCursos(mc.url, mc.token);
        if (!cursos || !Array.isArray(cursos)) { await interaction.editReply('No se pudo obtener los cursos.'); break; }
        let notasMsg = `📊 **Notas de ${usuario.fullname} en ${mc.nombre}:**\n`;
        for (const curso of cursos.filter(c => c.visible === 1 && c.id > 1).slice(0, 3)) {
          const notas = await getNotasUsuario(mc.url, mc.token, usuario.id, curso.id);
          if (!notas || !notas.usergrades || notas.usergrades.length === 0) continue;
          notasMsg += `\n**${curso.shortname}:**\n`;
          for (const item of (notas.usergrades[0]?.gradeitems || []).slice(0, 5)) {
            notasMsg += `  • ${item.itemname}: **${item.gradeformatted || 'Sin calificar'}**\n`;
          }
        }
        await interaction.editReply(notasMsg || 'No se encontraron notas.');
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
        await interaction.editReply(`${emojiTipo(tipo)} **Evento #${id} agregado**\n\n**${titulo}**\n📅 ${fecha} (${dias < 0 ? 'ya pasó' : dias === 0 ? 'es HOY' : 'en ' + dias + ' días'})\n\nAvisaré 3 días antes, 1 día antes y el mismo día en #aviso.`);
        break;
      }

      case 'calendario': {
        const lista   = [...eventos.entries()].sort((a, b) => parseFecha(a[1].fecha) - parseFecha(b[1].fecha));
        const futuros = lista.filter(([, ev]) => diasRestantes(parseFecha(ev.fecha)) >= 0);
        const pasados = lista.filter(([, ev]) => diasRestantes(parseFecha(ev.fecha)) < 0);
        let msg = '📅 **CALENDARIO DEL CUATRIMESTRE**\n\n';
        if (futuros.length > 0) msg += '**Próximos eventos:**\n\n' + formatEventos(futuros);
        if (pasados.length > 0) msg += '\n\n**Eventos pasados:**\n\n' + formatEventos(pasados);
        if (lista.length === 0)  msg += 'No hay eventos. El profesor puede agregar con /evento';
        await interaction.editReply(msg);
        break;
      }

      case 'proximo': {
        const futuros = [...eventos.entries()].filter(([, ev]) => diasRestantes(parseFecha(ev.fecha)) >= 0).sort((a, b) => parseFecha(a[1].fecha) - parseFecha(b[1].fecha));
        if (futuros.length === 0) { await interaction.editReply('No hay eventos próximos.'); break; }
        const [, ev] = futuros[0];
        const dias   = diasRestantes(parseFecha(ev.fecha));
        await interaction.editReply(`${emojiTipo(ev.tipo)} **Próximo: ${ev.titulo}**\n\n📅 **${ev.fecha}** — ${dias === 0 ? '**HOY**' : dias === 1 ? 'mañana' : 'en **' + dias + ' días**'}${ev.descripcion ? '\n📋 ' + ev.descripcion : ''}\n\nUsá /calendario para ver todos.`);
        break;
      }

      case 'borrar-evento': {
        const id = interaction.options.getInteger('id');
        if (!eventos.has(id)) { await interaction.editReply(`❌ No existe el evento #${id}`); break; }
        const ev = eventos.get(id); eventos.delete(id);
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
          messages: [{ role: 'user', content: `${ctx}\n\nGenerá UNA pregunta de opción múltiple sobre la Unidad ${unidadNum}. Respondé SOLO en JSON: {"pregunta":"...","opciones":["A) ...","B) ...","C) ...","D) ..."],"correcta":"A","explicacion":"..."}` }]
        });
        let quizData;
        try { quizData = JSON.parse(quizResp.content[0].text.replace(/```json|```/g, '').trim()); }
        catch (e) { await interaction.editReply('❌ Error generando la pregunta. Intentá de nuevo.'); break; }
        quizActivo.set(userId, { pregunta: quizData.pregunta, opciones: quizData.opciones, correcta: quizData.correcta, explicacion: quizData.explicacion, unidad: unidadNum, respondido: false });
        const botonesQuiz = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`quiz_A_${userId}`).setLabel('A').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`quiz_B_${userId}`).setLabel('B').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`quiz_C_${userId}`).setLabel('C').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`quiz_D_${userId}`).setLabel('D').setStyle(ButtonStyle.Secondary),
        );
        await interaction.editReply({ content: `🧠 **Quiz Unidad ${unidadNum}**\n\n${quizData.pregunta}\n\n${quizData.opciones.join('\n')}\n\nSeleccioná tu respuesta:`, components: [botonesQuiz] });
        break;
      }

      case 'desafio': {
        const materia = interaction.options.getString('materia').toLowerCase();
        const ctx     = CONTEXTOS[materia] || CONTEXTOS.iev;
        await interaction.editReply('⏳ Generando desafio...');
        const respD = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 600, messages: [{ role: 'user', content: `${ctx}\n\nGenerá un desafio semanal. Formato: DESAFIO: [título] ENUNCIADO: [3-5 líneas] PISTA: [sin revelar solución] DIFICULTAD: [Básico/Intermedio/Avanzado]` }] });
        const id = desafioCounter++;
        desafioActivo = id;
        desafios.set(id, { titulo: `Desafio #${id}`, enunciado: respD.content[0].text, materia, soluciones: new Map() });
        await interaction.editReply('✅ Desafio publicado.');
        await interaction.channel.send(`🏆 **DESAFIO SEMANAL #${id}**\n\n${respD.content[0].text}\n\n+25 pts por participar. Usá /solucionar para enviar tu respuesta.`);
        break;
      }

      case 'solucionar': {
        if (!desafioActivo || !desafios.has(desafioActivo)) { await interaction.editReply('❌ No hay desafio activo.'); break; }
        const desafio = desafios.get(desafioActivo);
        const userId  = interaction.user.id;
        const nombre  = interaction.member?.displayName || interaction.user.username;
        const codigo  = interaction.options.getString('codigo');
        if (desafio.soluciones.has(userId)) { await interaction.editReply('✅ Ya enviaste una solución.'); break; }
        const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
        desafio.soluciones.set(userId, { nombre, codigo, hora });
        const p  = darPuntos(userId, nombre, 'entrega');
        const p2 = darPuntos(userId, nombre, 'pregunta');
        await actualizarRolDiscord(interaction.member, p2.pts);
        const ctx   = CONTEXTOS[desafio.materia] || CONTEXTOS.iev;
        const evalR = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 400, messages: [{ role: 'user', content: `${ctx}\nDesafio: ${desafio.enunciado}\nSolución de ${nombre}: ${codigo}\nEvaluá brevemente: ¿es correcta? ¿qué está bien? ¿qué mejorarías? Sé pedagógico y alentador.` }] });
        await interaction.editReply(`✅ **${nombre}**, tu solución fue registrada.\n\n🤖 **Feedback:**\n${evalR.content[0].text}\n\n📤 +25 puntos | Total: **${p2.pts} pts**`);
        break;
      }

      case 'soluciones': {
        if (!desafioActivo || !desafios.has(desafioActivo)) { await interaction.editReply('No hay desafio activo.'); break; }
        const desafio = desafios.get(desafioActivo);
        if (desafio.soluciones.size === 0) { await interaction.editReply('Ningún alumno envió solución todavía.'); break; }
        const lista = [...desafio.soluciones.values()].map((s, i) => `${i + 1}. **${s.nombre}** (${s.hora}): ${s.codigo.substring(0, 80)}`).join('\n');
        await interaction.editReply(`📋 **Soluciones (${desafio.soluciones.size}):**\n\n${lista}`);
        break;
      }

      case 'cerrar-desafio': {
        if (!desafioActivo || !desafios.has(desafioActivo)) { await interaction.editReply('No hay desafio activo.'); break; }
        const desafio = desafios.get(desafioActivo);
        if (desafio.soluciones.size === 0) { desafioActivo = null; await interaction.editReply('Desafio cerrado sin participantes.'); break; }
        const [ganadorId, ganadorData] = [...desafio.soluciones.entries()][0];
        const ganadorMember = await interaction.guild.members.fetch(ganadorId).catch(() => null);
        const pG  = darPuntos(ganadorId, ganadorData.nombre, 'entrega');
        const pG2 = darPuntos(ganadorId, ganadorData.nombre, 'entrega');
        if (ganadorMember) await actualizarRolDiscord(ganadorMember, pG2.pts);
        desafioActivo = null;
        await interaction.editReply('✅ Desafio cerrado.');
        await interaction.channel.send(`🏆 **DESAFIO CERRADO** — ${desafio.soluciones.size} participantes\n🥇 Ganador: **${ganadorData.nombre}** (primera solución a las ${ganadorData.hora})\n\n¡Felicitaciones a todos! Usá /ranking para ver los cambios.`);
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
        tareas.set(id, { titulo, descripcion, fecha, canal: interaction.channelId, completados: new Set() });
        await interaction.editReply('✅ Tarea publicada.');
        await interaction.channel.send({ content: `📚 **NUEVA TAREA #${id}**\n\n📌 **${titulo}**\n\n${descripcion}\n\n⏰ **Fecha límite:** ${fecha}\n\nHacé clic cuando la completes.`, components: [botones] });
        const partes = fecha.split('/');
        if (partes.length === 3) {
          const recordatorio = new Date(partes[2], partes[1] - 1, partes[0]).getTime() - Date.now() - 86400000;
          if (recordatorio > 0) {
            setTimeout(async () => {
              const t = tareas.get(id);
              if (t) {
                const canal = interaction.guild.channels.cache.get(t.canal);
                if (canal) await canal.send(`⚠️ **Recordatorio:** La tarea **"${t.titulo}"** vence mañana **${t.fecha}**. ¡${t.completados.size} alumnos ya la completaron!`);
              }
            }, recordatorio);
          }
        }
        break;
      }

      case 'tareas': {
        if (tareas.size === 0) { await interaction.editReply('No hay tareas activas.'); break; }
        const lista = [...tareas.entries()].map(([id, t]) => `**#${id} — ${t.titulo}**\n⏰ Vence: ${t.fecha} | ✅ Completaron: ${t.completados.size}`).join('\n\n');
        await interaction.editReply(`📚 **Tareas activas:**\n\n${lista}`);
        break;
      }

      case 'completar': {
        const id    = interaction.options.getInteger('id');
        const tarea = tareas.get(id);
        if (!tarea) { await interaction.editReply(`❌ No existe la tarea #${id}.`); break; }
        const nombre = interaction.member?.displayName || interaction.user.username;
        tarea.completados.add(nombre);
        const p   = darPuntos(interaction.user.id, nombre, 'entrega');
        const rol = getRol(p.pts);
        await actualizarRolDiscord(interaction.member, p.pts);
        await interaction.editReply(`✅ **${nombre}** marcó **"${tarea.titulo}"** como completada.\n📤 +20 puntos | Total: **${p.pts} pts** ${rol.emoji}`);
        break;
      }

      case 'similitudes': {
        if (entregasPorActividad.size === 0) { await interaction.editReply('No hay entregas registradas aún.'); break; }
        let msg = '🔍 **Entregas registradas por actividad:**\n\n';
        for (const [actividad, lista] of entregasPorActividad.entries()) {
          msg += `📚 **${actividad}** — ${lista.length} entrega${lista.length !== 1 ? 's' : ''}\n`;
          msg += lista.map(e => `  · ${e.nombre} (${e.hora})`).join('\n') + '\n\n';
        }
        await interaction.editReply(msg);
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
  const canal    = member.guild.channels.cache.find(c => c.name === 'aviso' || c.name === 'bienvenida');
  const esIES11  = member.guild.name.toLowerCase().includes('11');
  if (canal) {
    await canal.send(esIES11
      ? `👋 ¡Bienvenido/a **${member.displayName}** al servidor del IES N°11!\n\n📚 Tecnicatura en Desarrollo de Software\n• Usá **/preguntar** para consultas de Base de Datos o Informática\n• Registrá asistencia con el botón al inicio de cada clase ✅\n• Entregá en **#entregas** y la IA corrige automáticamente 🤖\n• Usá **/materia** para ver qué contexto usa el bot en cada canal 🔍`
      : `👋 ¡Bienvenido/a **${member.displayName}** al servidor del IES N°6!\n\n📚 Internet y Entornos Virtuales 2026\n• Usá **/preguntar** para consultas con IA\n• Asistencia al inicio de cada clase ✅\n• Entregá en **#entregas** y el bot corrige 🤖\n• Noticias tech en **#noticias-tech** 📰`
    );
  }
});

client.login(DISCORD_TOKEN);