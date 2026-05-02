require('dotenv').config();
const { Client, GatewayIntentBits, Events, SlashCommandBuilder, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

// =============================================
// CONFIGURACIÓN
// =============================================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = '1497945827874967733';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);

const CANAL_ASISTENCIA = 'dudas';
const CANAL_ENTREGAS = 'entregas';
const CANAL_NOTICIAS = 'noticias-tech';
const CANAL_RANKING = 'ranking';

// Sistema de puntos en memoria
const puntos = new Map(); // userId -> { nombre, pts, entregas, asistencias, preguntas }

// Formulario de entregas guiado
const formularioActivo = new Map(); // userId -> { paso, nombre, actividad, link }

// Sistema de tareas
const tareas = new Map(); // tareaId -> { titulo, descripcion, fechaLimite, canal, completados: Set }
let tareaCounter = 1;

// Sistema de calendario del cuatrimestre
const eventos = new Map(); // eventoId -> { titulo, fecha, tipo, materia, descripcion, avisado3d, avisado1d }
let eventoCounter = 1;

// Sistema de quiz interactivo
const quizActivo = new Map(); // userId -> { pregunta, opciones, correcta, materia, unidad, puntos }

// Sistema de desafio semanal
const desafios = new Map(); // desafioId -> { titulo, enunciado, materia, soluciones: Map(userId -> {nombre, codigo, hora}) }
let desafioCounter = 1;
let desafioActivo = null; // id del desafio activo

// Roles Discord por nivel de puntos
const ROLES_PUNTOS = [
  { nombre: 'Experto Digital', minPts: 200, emoji: '🏆' },
  { nombre: 'Colaborador Activo', minPts: 100, emoji: '⭐' },
  { nombre: 'Aprendiz', minPts: 50, emoji: '📚' },
  { nombre: 'Novato', minPts: 0, emoji: '🌱' },
];

async function actualizarRolDiscord(member, pts) {
  try {
    const guild = member.guild;
    // Buscar o crear roles
    for (const rolDef of ROLES_PUNTOS) {
      let rol = guild.roles.cache.find(r => r.name === rolDef.nombre);
      if (!rol) {
        rol = await guild.roles.create({ name: rolDef.nombre, color: rolDef.nombre === 'Experto Digital' ? '#FFD700' : rolDef.nombre === 'Colaborador Activo' ? '#C0C0C0' : rolDef.nombre === 'Aprendiz' ? '#4FC3F7' : '#90A4AE', reason: 'Rol automático Bot IEV' });
      }
    }
    // Quitar todos los roles de nivel
    for (const rolDef of ROLES_PUNTOS) {
      const rol = guild.roles.cache.find(r => r.name === rolDef.nombre);
      if (rol && member.roles.cache.has(rol.id)) await member.roles.remove(rol);
    }
    // Asignar el rol correspondiente
    const rolCorrespondiente = ROLES_PUNTOS.find(r => pts >= r.minPts);
    if (rolCorrespondiente) {
      const rol = guild.roles.cache.find(r => r.name === rolCorrespondiente.nombre);
      if (rol) await member.roles.add(rol);
    }
  } catch (e) { console.error('Error asignando rol:', e); }
}

function darPuntos(userId, nombre, tipo) {
  if (!puntos.has(userId)) puntos.set(userId, { nombre, pts: 0, entregas: 0, asistencias: 0, preguntas: 0 });
  const p = puntos.get(userId);
  p.nombre = nombre;
  if (tipo === 'asistencia') { p.pts += 10; p.asistencias++; }
  if (tipo === 'entrega') { p.pts += 20; p.entregas++; }
  if (tipo === 'pregunta') { p.pts += 5; p.preguntas++; }
  puntos.set(userId, p);
  return p;
}

function getRanking() {
  return [...puntos.entries()]
    .sort((a, b) => b[1].pts - a[1].pts)
    .slice(0, 10);
}

function getRol(pts) {
  if (pts >= 200) return { nombre: 'Experto Digital', emoji: '🏆' };
  if (pts >= 100) return { nombre: 'Colaborador Activo', emoji: '⭐' };
  if (pts >= 50) return { nombre: 'Aprendiz', emoji: '📚' };
  return { nombre: 'Novato', emoji: '🌱' };
}

// Horarios de clase
const HORARIOS_CLASE = [
  { dia: 2, hora: 8, minuto: 0 },
  { dia: 4, hora: 8, minuto: 0 },
];

// Hora de noticias automáticas (todos los días a las 8 AM)
const HORA_NOTICIAS = { hora: 8, minuto: 0 };
// =============================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers]
});
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

let sesionActiva = false;
let asistentesHoy = new Map();
let fechaClaseActual = '';

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
        Relacionalas cuando sea posible con estos temas: Internet, IA, educación virtual, redes, ciberseguridad.
        Formato para cada noticia:
        **🔹 [Título llamativo]**
        Resumen en 2-3 oraciones simples y claras.
        💡 *Por qué importa para tu carrera: [explicación breve]*
        
        Separalas con una línea. Usá lenguaje juvenil pero profesional. Hoy es ${new Date().toLocaleDateString('es-AR')}.`
      }]
    });

    await canal.send(`📰 **NOTICIAS TECH DEL DÍA — ${new Date().toLocaleDateString('es-AR')}**\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n${resp.content[0].text}\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n*Generado automáticamente por Bot IEV 🤖*`);
  } catch (e) {
    console.error('Error noticias:', e);
  }
}

// =============================================
// CORRECCIÓN DE ENTREGAS CON IA
// =============================================
async function corregirEntrega(message, adjunto) {
  let contenido = '';

  // Si pegó texto directamente
  if (message.content.length > 100) {
    contenido = message.content;
  }
  // Si adjuntó un archivo de texto
  else if (adjunto && adjunto.contentType?.includes('text')) {
    const resp = await fetch(adjunto.url);
    contenido = await resp.text();
  }

  if (!contenido) return null;

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: `Sos el asistente del Prof. Ing. Corimayo Ricardo Daniel de la materia "Internet y Entornos Virtuales" del IES N°6.
      
      Un alumno acaba de entregar un trabajo. Analizalo y dá una corrección pedagógica con este formato exacto:

      ✅ **Aspectos positivos:**
      [listá los puntos fuertes]

      🔧 **Aspectos a mejorar:**
      [listá lo que falta o está incompleto]

      📊 **Evaluación orientativa:** [Excelente / Muy bueno / Bueno / Regular / Insuficiente]

      💡 **Sugerencia del profesor:**
      [un consejo personalizado para mejorar]

      Sé constructivo, empático y pedagógico. No seas demasiado duro.
      
      TRABAJO DEL ALUMNO:
      ${contenido.substring(0, 3000)}`
    }]
  });

  return resp.content[0].text;
}

// =============================================
// INICIAR CLASE
// =============================================
async function iniciarClase(channel, titulo = 'Clase de hoy') {
  if (sesionActiva) { channel.send('⚠️ Ya hay una clase activa. Cerrá con `/cerrar-clase`'); return; }
  sesionActiva = true;
  asistentesHoy = new Map();
  const ahora = new Date();
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
// COMANDOS
// =============================================
const commands = [
  new SlashCommandBuilder().setName('iniciar-clase').setDescription('Iniciar toma de asistencia').addStringOption(o => o.setName('titulo').setDescription('Tema de la clase').setRequired(false)),
  new SlashCommandBuilder().setName('cerrar-clase').setDescription('Cerrar asistencia y ver resumen'),
  new SlashCommandBuilder().setName('asistencia').setDescription('Ver asistencia del día'),
  new SlashCommandBuilder().setName('noticias').setDescription('Publicar noticias tech del día ahora'),
  new SlashCommandBuilder().setName('corregir').setDescription('Corregir un trabajo con IA').addStringOption(o => o.setName('texto').setDescription('Pegá el texto del trabajo aquí').setRequired(true)),
  new SlashCommandBuilder().setName('unidad').setDescription('Info de una unidad de la materia').addIntegerOption(o => o.setName('numero').setDescription('Número de unidad (1-7 según materia)').setRequired(true).setMinValue(1).setMaxValue(7)),
  new SlashCommandBuilder().setName('preguntar').setDescription('Preguntá a la IA sobre la materia').addStringOption(o => o.setName('pregunta').setDescription('Tu pregunta').setRequired(true)),
  new SlashCommandBuilder().setName('entrega').setDescription('Instrucciones para entregar trabajos'),
  new SlashCommandBuilder().setName('herramientas').setDescription('Links de las herramientas del curso'),
  new SlashCommandBuilder().setName('craap').setDescription('Evaluar una fuente con criterio CRAAP').addStringOption(o => o.setName('url').setDescription('URL a evaluar').setRequired(true)),
  new SlashCommandBuilder().setName('ranking').setDescription('Ver el ranking de participación del curso'),
  new SlashCommandBuilder().setName('mispuntos').setDescription('Ver tus puntos y rol actual'),
  new SlashCommandBuilder().setName('evento')
    .setDescription('Agregar un evento al calendario del cuatrimestre (solo profesor)')
    .addStringOption(o => o.setName('titulo').setDescription('Nombre del evento').setRequired(true))
    .addStringOption(o => o.setName('fecha').setDescription('Fecha (dd/mm/yyyy)').setRequired(true))
    .addStringOption(o => o.setName('tipo').setDescription('Tipo de evento').setRequired(true)
      .addChoices(
        { name: 'Parcial', value: 'parcial' },
        { name: 'Entrega', value: 'entrega' },
        { name: 'Proyecto final', value: 'proyecto' },
        { name: 'Clase especial', value: 'clase' },
        { name: 'Recuperatorio', value: 'recuperatorio' },
      ))
    .addStringOption(o => o.setName('descripcion').setDescription('Descripción opcional').setRequired(false)),
  new SlashCommandBuilder().setName('calendario')
    .setDescription('Ver todos los eventos del cuatrimestre'),
  new SlashCommandBuilder().setName('proximo')
    .setDescription('Ver el próximo evento importante'),
  new SlashCommandBuilder().setName('borrar-evento')
    .setDescription('Borrar un evento del calendario (solo profesor)')
    .addIntegerOption(o => o.setName('id').setDescription('ID del evento').setRequired(true)),
  new SlashCommandBuilder().setName('quiz')
    .setDescription('Iniciá un quiz de opción múltiple sobre una unidad (+15 pts si aprobás)')
    .addIntegerOption(o => o.setName('unidad').setDescription('Número de unidad').setRequired(true).setMinValue(1).setMaxValue(7)),
  new SlashCommandBuilder().setName('desafio')
    .setDescription('Publicar desafio semanal con IA (solo profesor)')
    .addStringOption(o => o.setName('materia').setDescription('iev, bd o informatica').setRequired(true)),
  new SlashCommandBuilder().setName('solucionar')
    .setDescription('Enviar tu solución al desafio activo')
    .addStringOption(o => o.setName('codigo').setDescription('Tu solución o respuesta').setRequired(true)),
  new SlashCommandBuilder().setName('soluciones')
    .setDescription('Ver las soluciones del desafio actual (solo profesor)'),
  new SlashCommandBuilder().setName('cerrar-desafio')
    .setDescription('Cerrar el desafio y anunciar al ganador (solo profesor)'),
  new SlashCommandBuilder().setName('tarea')
    .setDescription('Publicar una nueva tarea (solo profesor)')
    .addStringOption(o => o.setName('titulo').setDescription('Título de la tarea').setRequired(true))
    .addStringOption(o => o.setName('descripcion').setDescription('Descripción detallada').setRequired(true))
    .addStringOption(o => o.setName('fecha').setDescription('Fecha límite (ej: 30/05/2026)').setRequired(true)),
  new SlashCommandBuilder().setName('tareas').setDescription('Ver todas las tareas activas'),
  new SlashCommandBuilder().setName('completar').setDescription('Marcar una tarea como completada').addIntegerOption(o => o.setName('id').setDescription('ID de la tarea').setRequired(true)),
];

async function registrarComandos(guildId) {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commands.map(c => c.toJSON()) });
  console.log('✅ Comandos registrados');
}

// Contextos por materia según servidor/canal
const CONTEXTOS = {
  iev: `Sos el asistente de "Internet y Entornos Virtuales" del Profesorado en Informática del IES N°6, Prof. Ing. Corimayo Ricardo Daniel. Respondé en español, claro y pedagógico. Unidades: 1-Introducción a Internet (TCP/IP, HTTP, comandos CMD), 2-Correo y netiqueta (SMTP, POP3, IMAP), 3-Criterio CRAAP para evaluar fuentes, 4-Comunicación sincrónica/asincrónica (Discord, Meet, foros), 5-Entornos virtuales Chamilo/Moodle. Plataformas: Chamilo y Moodle.`,

  bd: `Sos el asistente de "Base de Datos" de la Tecnicatura Superior en Desarrollo de Software del IES N°11, Prof. Ing. Corimayo Ricardo Daniel. Respondé en español, claro y pedagógico. El programa tiene 7 unidades: 1-Introducción y arquitectura de SGBD (definiciones, niveles de abstracción, modelos de datos, DDL/DML), 2-Modelo de datos (conceptual vs lógico, restricciones de integridad), 3-Diseño de bases de datos y Diagrama Entidad-Relación (entidades, atributos, relaciones, cardinalidad, herencia, especialización/generalización), 4-Modelo Relacional (restricciones de integridad, claves, vistas, consultas relacionales), 5-Dependencias funcionales y Normalización (1FN, 2FN, 3FN, BCNF, 4FN, 5FN), 6-Álgebra y Cálculo Relacional (operadores primitivos y derivados, cálculo de tuplas y dominios), 7-SQL (DDL: CREATE/ALTER/DROP, DML: SELECT/INSERT/UPDATE/DELETE, restricciones, vistas). Si no sabés algo decí que consulte al profesor.`,

  informatica: `Sos el asistente de "Informática" de la Tecnicatura Superior en Desarrollo de Software del IES N°11, 1er año, Prof. Ing. Corimayo Ricardo Daniel. Respondé en español, claro y pedagógico. El programa tiene 5 unidades: 1-Introducción a la Informática (concepto, hardware, software, sistemas operativos, evolución histórica, disciplinas relacionadas), 2-Ofimática y Aplicaciones de Productividad (procesadores de texto, hojas de cálculo, presentaciones, uso profesional), 3-Computación Distribuida y Redes (tipos de redes, protocolos, cliente/servidor, peer-to-peer, computación móvil), 4-Computación Paralela y Concurrente (procesadores multinúcleo, paralelismo, concurrencia), 5-Inteligencia Artificial y Especializaciones (machine learning, redes neuronales, PLN, tendencias futuras). Recursos: Moodle, Google Classroom, Google Drive. Si no sabés algo decí que consulte al profesor.`,
};

function getContexto(guildId, channelName) {
  // Detectar por nombre de canal
  if (channelName && (channelName.includes('bd') || channelName.includes('base') || channelName.includes('datos'))) return CONTEXTOS.bd;
  if (channelName && (channelName.includes('info') || channelName.includes('informatica'))) return CONTEXTOS.informatica;
  return CONTEXTOS.iev; // default IEV
}

const CONTEXTO = CONTEXTOS.iev; // fallback

const UNIDADES = {
  iev: {
    1: '🌐 **IEV — Unidad 1: Introducción a Internet**\n\nProtocolos TCP/IP, HTTP, HTTPS, FTP. Comandos CMD: ping, tracert, ipconfig, nslookup.\n\n**Plataforma:** Chamilo → aulasvirtuales.name/chamilo',
    2: '📧 **IEV — Unidad 2: Correo Electrónico y Netiqueta**\n\nSMTP, POP3, IMAP. Netiqueta digital. CC vs CCO.\n\n**Plataforma:** Moodle → aulasvirtuales.name/innova',
    3: '🔍 **IEV — Unidad 3: Búsqueda y Evaluación**\n\nMotores de búsqueda. Criterio CRAAP. Fake news.\n\n**Probá:** /craap [url]',
    4: '💬 **IEV — Unidad 4: Comunicación**\n\nSincrónica vs Asincrónica. Discord, Meet, Zoom. Foros.',
    5: '🖥️ **IEV — Unidad 5: Entornos Virtuales**\n\nChamilo y Moodle. Roles. Creación de cursos.\n\n**Proyecto final:** Aula virtual en Chamilo.',
  },
  bd: {
    1: '🗄️ **BD — Unidad 1: Introducción y Arquitectura de SGBD**\n\nDefinición de BD y SGBD, niveles de abstracción (físico, conceptual, externo), independencia de datos, DDL y DML.',
    2: '📊 **BD — Unidad 2: Modelo de Datos**\n\nModelos conceptuales vs lógicos. Restricciones de integridad. Aspectos estáticos y dinámicos.',
    3: '🔗 **BD — Unidad 3: Diseño y Diagrama E-R**\n\nEntidades, atributos, relaciones, cardinalidad, entidades débiles, herencia, especialización y generalización.',
    4: '📋 **BD — Unidad 4: Modelo Relacional**\n\nClaves primarias y foráneas, restricciones de integridad, vistas, consultas relacionales, diseño lógico desde E-R.',
    5: '📐 **BD — Unidad 5: Normalización**\n\nDependencias funcionales. Formas normales: 1FN, 2FN, 3FN, BCNF, 4FN, 5FN. Desnormalización.',
    6: '🔢 **BD — Unidad 6: Álgebra y Cálculo Relacional**\n\nOperadores primitivos (selección, proyección, unión, diferencia, producto cartesiano) y derivados. Cálculo de tuplas y dominios.',
    7: '💻 **BD — Unidad 7: SQL**\n\nDDL: CREATE, ALTER, DROP. DML: SELECT, INSERT, UPDATE, DELETE. Restricciones, vistas, subconsultas.',
  },
  informatica: {
    1: '💻 **Informática — Unidad 1: Introducción**\n\nConcepto de informática, hardware, software, sistemas operativos. Evolución histórica. Disciplinas relacionadas.',
    2: '📝 **Informática — Unidad 2: Ofimática**\n\nProcesadores de texto, hojas de cálculo, presentaciones. Uso profesional de herramientas de productividad.',
    3: '🌐 **Informática — Unidad 3: Redes y Computación Distribuida**\n\nTipos de redes, protocolos. Cliente/servidor vs peer-to-peer. Computación móvil.',
    4: '⚡ **Informática — Unidad 4: Computación Paralela y Concurrente**\n\nProcesadores multinúcleo, paralelismo, concurrencia, gestión de tareas simultáneas.',
    5: '🤖 **Informática — Unidad 5: Inteligencia Artificial**\n\nMachine learning, redes neuronales, PLN. Aplicaciones de IA en redes y sistemas. Tendencias futuras.',
  }
};

function getUnidades(channelName) {
  if (channelName && (channelName.includes('bd') || channelName.includes('base') || channelName.includes('datos'))) return UNIDADES.bd;
  if (channelName && (channelName.includes('info') || channelName.includes('informatica'))) return UNIDADES.informatica;
  return UNIDADES.iev;
}

// =============================================
// EVENTOS
// =============================================
// =============================================
// HELPERS DE CALENDARIO
// =============================================
function parseFecha(str) {
  const p = str.split('/');
  if (p.length !== 3) return null;
  return new Date(parseInt(p[2]), parseInt(p[1])-1, parseInt(p[0]));
}

function diasRestantes(fecha) {
  const hoy = new Date();
  hoy.setHours(0,0,0,0);
  fecha.setHours(0,0,0,0);
  return Math.round((fecha - hoy) / 86400000);
}

function emojiTipo(tipo) {
  const map = { parcial:'📝', entrega:'📤', proyecto:'🎓', clase:'📚', recuperatorio:'🔄' };
  return map[tipo] || '📅';
}

function formatEventos(lista) {
  if (lista.length === 0) return 'No hay eventos registrados.';
  return lista.map(([id, ev]) => {
    const dias = diasRestantes(parseFecha(ev.fecha));
    const estado = dias < 0 ? '✅ Pasado' : dias === 0 ? '🔴 HOY' : dias === 1 ? '🟠 Mañana' : dias <= 3 ? '🟡 En ' + dias + ' días' : '🟢 En ' + dias + ' días';
    return emojiTipo(ev.tipo) + ' **#' + id + ' — ' + ev.titulo + '**' +
      '\n📅 ' + ev.fecha + ' · ' + estado +
      (ev.descripcion ? '\n📋 ' + ev.descripcion : '');
  }).join('\n\n');
}

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot conectado como ${c.user.tag}`);
  for (const guild of c.guilds.cache.values()) await registrarComandos(guild.id);

  setInterval(async () => {
    const ahora = new Date();
    const dia = ahora.getDay();
    const hora = ahora.getHours();
    const min = ahora.getMinutes();

    // Verificar avisos de calendario
    const hoy2 = new Date();
    hoy2.setHours(0,0,0,0);
    for (const [id, ev] of eventos.entries()) {
      const fechaEv = parseFecha(ev.fecha);
      if (!fechaEv) continue;
      const dias = diasRestantes(fechaEv);

      if (dias === 3 && !ev.avisado3d) {
        ev.avisado3d = true;
        for (const guild of client.guilds.cache.values()) {
          const canal = guild.channels.cache.find(c => c.name === 'aviso' || c.name === 'anuncios');
          if (canal) canal.send('⏰ **Recordatorio — Faltan 3 días**\n\n' + emojiTipo(ev.tipo) + ' **' + ev.titulo + '**\n📅 Fecha: **' + ev.fecha + '**' + (ev.descripcion ? '\n📋 ' + ev.descripcion : ''));
        }
      }

      if (dias === 1 && !ev.avisado1d) {
        ev.avisado1d = true;
        for (const guild of client.guilds.cache.values()) {
          const canal = guild.channels.cache.find(c => c.name === 'aviso' || c.name === 'anuncios');
          if (canal) canal.send('🚨 **Aviso — Mañana es el día**\n\n' + emojiTipo(ev.tipo) + ' **' + ev.titulo + '** es MAÑANA\n📅 Fecha: **' + ev.fecha + '**' + (ev.descripcion ? '\n📋 ' + ev.descripcion : ''));
        }
      }

      if (dias === 0 && !ev.avisadoHoy) {
        ev.avisadoHoy = true;
        for (const guild of client.guilds.cache.values()) {
          const canal = guild.channels.cache.find(c => c.name === 'aviso' || c.name === 'anuncios');
          if (canal) canal.send('🔴 **HOY — ' + ev.titulo + '**\n\n' + emojiTipo(ev.tipo) + ' Recordá que hoy es el día de este evento.\n📅 Fecha: **' + ev.fecha + '**' + (ev.descripcion ? '\n📋 ' + ev.descripcion : ''));
        }
      }
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

    // Noticias automáticas cada día a la hora configurada
    if (hora === HORA_NOTICIAS.hora && min === HORA_NOTICIAS.minuto) {
      for (const guild of client.guilds.cache.values()) {
        await publicarNoticias(guild);
      }
    }
  }, 60000);
});

// Detectar entregas en canal #entregas automáticamente
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // Formulario guiado en canal entregas
  if (message.channel.name === CANAL_ENTREGAS && !message.author.bot) {
    const userId = message.author.id;
    const nombre = message.member?.displayName || message.author.username;

    // Si ya tiene formulario activo, procesar respuesta
    if (formularioActivo.has(userId)) {
      const form = formularioActivo.get(userId);

      if (form.paso === 1) {
        form.actividad = message.content;
        form.paso = 2;
        formularioActivo.set(userId, form);
        await message.reply('📎 **Paso 2/3:** Pegá el link de tu trabajo (GitHub, Google Drive) o adjuntá el archivo directamente.');
        return;
      }

      if (form.paso === 2) {
        form.link = message.content || (message.attachments.first()?.url || 'Sin link');
        form.paso = 3;
        formularioActivo.set(userId, form);
        await message.reply('💬 **Paso 3/3:** ¿Querés agregar algún comentario sobre tu entrega? (o escribí "listo" para terminar)');
        return;
      }

      if (form.paso === 3) {
        form.comentario = message.content === 'listo' ? '' : message.content;
        formularioActivo.delete(userId);

        // Guardar y corregir
        const resumen = `📋 **ENTREGA REGISTRADA**\n👤 Alumno: **${form.nombre}**\n📚 Actividad: **${form.actividad}**\n🔗 Link/Archivo: ${form.link}\n💬 Comentario: ${form.comentario || 'Ninguno'}`;
        await message.channel.send(resumen);

        // Dar puntos y actualizar rol
        const p = darPuntos(userId, nombre, 'entrega');
        const rol = getRol(p.pts);
        await actualizarRolDiscord(message.member, p.pts);

        // Corrección automática si hay texto
        try {
          message.channel.sendTyping();
          const textoParaCorregir = `Actividad: ${form.actividad}. Link: ${form.link}. Comentario: ${form.comentario}`;
          const correccion = await corregirEntrega({ content: textoParaCorregir }, null);
          if (correccion) {
            await message.reply(`🤖 **Corrección automática:**\n\n${correccion}\n\n*⚠️ Orientativa. La nota final la define el profesor.*\n\n📤 +20 puntos | Total: **${p.pts} pts** ${rol.emoji}`);
          }
        } catch (e) { console.error('Error corrección:', e); }
        return;
      }
    }

    // Iniciar formulario si escribe algo en #entregas
    if (!formularioActivo.has(userId) && message.content.length > 2) {
      formularioActivo.set(userId, { paso: 1, nombre, actividad: '', link: '', comentario: '' });
      await message.reply(`📝 **Formulario de entrega — IEV 2026**\n\nHola **${nombre}**, vamos a registrar tu entrega paso a paso.\n\n**Paso 1/3:** ¿Cuál es el nombre de la actividad que entregás?`);
    }
  }

  // Mención al bot
  if (message.mentions.has(client.user)) {
    const pregunta = message.content.replace(/<@\d+>/g, '').trim();
    if (!pregunta) return;
    try {
      message.channel.sendTyping();
      const ctxMention = getContexto(message.guildId, message.channel?.name);
    const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 600, messages: [{ role: 'user', content: `${ctxMention}\n\nPregunta: ${pregunta}` }] });
      message.reply(`🤖 ${resp.content[0].text}`);
    } catch (e) { message.reply('❌ No pude procesar tu pregunta.'); }
  }
});

// Interacciones
client.on(Events.InteractionCreate, async (interaction) => {
  // Botones de quiz
  if (interaction.isButton() && interaction.customId.startsWith('quiz_')) {
    const parts = interaction.customId.split('_');
    const respuesta = parts[1];
    const targetUserId = parts[2];
    const userId = interaction.user.id;

    if (userId !== targetUserId) {
      await interaction.reply({ content: '⚠️ Este quiz es de otro alumno. Usá /quiz para el tuyo.', ephemeral: true });
      return;
    }

    const quiz = quizActivo.get(userId);
    if (!quiz) {
      await interaction.reply({ content: '⚠️ No tenés un quiz activo. Usá /quiz para empezar.', ephemeral: true });
      return;
    }

    if (quiz.respondido) {
      await interaction.reply({ content: '✅ Ya respondiste este quiz. Usá /quiz para una nueva pregunta.', ephemeral: true });
      return;
    }

    quiz.respondido = true;
    quizActivo.set(userId, quiz);

    const nombre = interaction.member?.displayName || interaction.user.username;
    const esCorrecta = respuesta === quiz.correcta;

    let msg = '';
    if (esCorrecta) {
      const p = darPuntos(userId, nombre, 'pregunta');
      const p2 = darPuntos(userId, nombre, 'pregunta');
      const p3 = darPuntos(userId, nombre, 'pregunta');
      await actualizarRolDiscord(interaction.member, p3.pts);
      msg = '✅ Correcto ' + nombre + '! ' + quiz.explicacion + ' +15 puntos | Total: ' + p3.pts + ' pts. Usa /quiz ' + quiz.unidad + ' para otra pregunta';
    } else {
      msg = '❌ Incorrecto ' + nombre + '. Tu respuesta: ' + respuesta + ' - Correcta: ' + quiz.correcta + '. ' + quiz.explicacion + ' Sin descuento de puntos. Usa /quiz ' + quiz.unidad + ' para intentar de nuevo';
    }

    await interaction.update({ content: msg, components: [] });
    return;
  }

  // Botones de tarea
  if (interaction.isButton() && interaction.customId.startsWith('completar_')) {
    const id = parseInt(interaction.customId.split('_')[1]);
    const tarea = tareas.get(id);
    if (!tarea) { await interaction.reply({ content: '❌ Tarea no encontrada.', ephemeral: true }); return; }
    const nombre = interaction.member?.displayName || interaction.user.username;
    if (tarea.completados.has(nombre)) { await interaction.reply({ content: `✅ **${nombre}**, ya marcaste esta tarea como completada.`, ephemeral: true }); return; }
    tarea.completados.add(nombre);
    const p = darPuntos(interaction.user.id, nombre, 'entrega');
    const rol = getRol(p.pts);
    await actualizarRolDiscord(interaction.member, p.pts);
    await interaction.reply({ content: `✅ **${nombre}** completó la tarea **"${tarea.titulo}"**
📤 +20 puntos | Total: **${p.pts} pts** ${rol.emoji}` });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('vercompletados_')) {
    const id = parseInt(interaction.customId.split('_')[1]);
    const tarea = tareas.get(id);
    if (!tarea) { await interaction.reply({ content: '❌ Tarea no encontrada.', ephemeral: true }); return; }
    const completadosList = [...tarea.completados];
    const listaTexto = completadosList.length > 0
      ? completadosList.map((n, i) => (i+1) + '. ' + n).join('\n')
      : 'Ningún alumno completó esta tarea todavía.';
    const replyTexto = '👥 **Completaron "' + tarea.titulo + '"** (' + tarea.completados.size + '):\n\n' + listaTexto;
    await interaction.reply({ content: replyTexto, ephemeral: true });
    return;
  }

  if (interaction.isButton() && interaction.customId === 'presente') {
    if (!sesionActiva) { await interaction.reply({ content: '⚠️ La clase ya cerró.', ephemeral: true }); return; }
    const userId = interaction.user.id;
    const nombre = interaction.member?.displayName || interaction.user.username;
    if (asistentesHoy.has(userId)) { await interaction.reply({ content: `✅ **${nombre}**, ya registraste tu presencia.`, ephemeral: true }); return; }
    const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    asistentesHoy.set(userId, { nombre, hora });
    await guardarAsistencia(nombre, fechaClaseActual, hora);
    const p = darPuntos(userId, nombre, 'asistencia');
    const rol = getRol(p.pts);
    await actualizarRolDiscord(interaction.member, p.pts);
    await interaction.reply({ content: `✅ **${nombre}** registró presencia a las **${hora}**\n${rol.emoji} +10 puntos | Total: **${p.pts} pts** | Rol: **${rol.nombre}**` });
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();

  try {
    switch (interaction.commandName) {
      case 'iniciar-clase': {
        const titulo = interaction.options.getString('titulo') || 'Clase de hoy';
        await iniciarClase(interaction.channel, titulo);
        await interaction.editReply('✅ Clase iniciada.');
        break;
      }
      case 'cerrar-clase': {
        if (!sesionActiva) { await interaction.editReply('⚠️ No hay clase activa.'); break; }
        sesionActiva = false;
        const lista = [...asistentesHoy.values()];
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
        await interaction.editReply('📰 Generando noticias tech del día... espera un momento.');
        // Publicar en background para no bloquear
        publicarNoticias(interaction.guild).then(() => {
          interaction.editReply('📰 ¡Noticias publicadas en #noticias-tech!');
        }).catch(e => {
          console.error(e);
          interaction.editReply('❌ Error generando noticias.');
        });
        break;
      }
      case 'corregir': {
        const texto = interaction.options.getString('texto');
        const correccion = await corregirEntrega({ content: texto }, null);
        await interaction.editReply(`🤖 **Corrección automática:**\n\n${correccion}\n\n*⚠️ Corrección orientativa. La nota final la define el profesor.*`);
        break;
      }
      case 'unidad': {
        const num = interaction.options.getInteger('numero');
        const unidadesMateria = getUnidades(interaction.channel?.name);
        const unidadTexto = unidadesMateria[num];
        if (!unidadTexto) {
          await interaction.editReply(`❌ Esta materia no tiene unidad ${num}. Usá un número válido.`);
        } else {
          await interaction.editReply(unidadTexto);
        }
        break;
      }
      case 'preguntar': {
        const pregunta = interaction.options.getString('pregunta');
        const ctxPreg = getContexto(interaction.guildId, interaction.channel?.name);
        const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 800, messages: [{ role: 'user', content: `${ctxPreg}\n\nPregunta: ${pregunta}` }] });
        darPuntos(interaction.user.id, interaction.member?.displayName || interaction.user.username, 'pregunta');
        await interaction.editReply(`🤖 **Respuesta:**\n\n${resp.content[0].text}\n\n💡 +5 puntos por participar`);
        break;
      }
      case 'ranking': {
        const top = getRanking();
        if (top.length === 0) { await interaction.editReply('No hay puntos registrados todavía.'); break; }
        const medallas = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
        const lista = top.map(([, p], i) => {
          const rol = getRol(p.pts);
          return `${medallas[i]} **${p.nombre}** — ${p.pts} pts ${rol.emoji}`;
        }).join('\n');
        await interaction.editReply(`🏆 **Ranking IEV 2026**\n\n${lista}\n\n💡 Puntos: asistencia +10 | entrega +20 | pregunta +5`);
        break;
      }
      case 'mispuntos': {
        const userId = interaction.user.id;
        const nombre = interaction.member?.displayName || interaction.user.username;
        if (!puntos.has(userId)) { await interaction.editReply('Todavía no tenés puntos. ¡Participá en clase!'); break; }
        const p = puntos.get(userId);
        const rol = getRol(p.pts);
        const top = getRanking();
        const pos = top.findIndex(([id]) => id === userId) + 1;
        await interaction.editReply(`${rol.emoji} **${nombre}** — ${rol.nombre}\n\n📊 **Total: ${p.pts} pts** | Posición #${pos}\n\n✅ Asistencias: ${p.asistencias} (+${p.asistencias * 10} pts)\n📤 Entregas: ${p.entregas} (+${p.entregas * 20} pts)\n💬 Preguntas: ${p.preguntas} (+${p.preguntas * 5} pts)`);
        break;
      }
      case 'entrega':
        await interaction.editReply('📤 **Cómo entregar:**\n\n1. Andá a **#entregas**\n2. Escribí tu nombre y la actividad\n3. Pegá el texto o adjuntá el archivo\n4. El bot lo corrige automáticamente con IA\n5. El profesor confirma la nota final\n\n⚠️ No se aceptan entregas por WhatsApp ni privado.');
        break;
      case 'evento': {
        const titulo = interaction.options.getString('titulo');
        const fecha = interaction.options.getString('fecha');
        const tipo = interaction.options.getString('tipo');
        const descripcion = interaction.options.getString('descripcion') || '';

        if (!parseFecha(fecha)) { await interaction.editReply('❌ Fecha inválida. Usá el formato dd/mm/yyyy'); break; }

        const id = eventoCounter++;
        eventos.set(id, { titulo, fecha, tipo, descripcion, avisado3d: false, avisado1d: false, avisadoHoy: false });
        const dias = diasRestantes(parseFecha(fecha));
        const estadoStr = dias < 0 ? 'ya pasó' : dias === 0 ? 'es HOY' : 'en ' + dias + ' días';

        await interaction.editReply(emojiTipo(tipo) + ' **Evento agregado al calendario**\n\n**#' + id + ' — ' + titulo + '**\n📅 ' + fecha + ' (' + estadoStr + ')\n\nEl bot avisará automáticamente 3 días antes, 1 día antes y el día del evento en #aviso.');
        break;
      }

      case 'calendario': {
        const lista = [...eventos.entries()].sort((a,b) => {
          const fa = parseFecha(a[1].fecha);
          const fb = parseFecha(b[1].fecha);
          return fa - fb;
        });
        const futuros = lista.filter(([,ev]) => diasRestantes(parseFecha(ev.fecha)) >= 0);
        const pasados = lista.filter(([,ev]) => diasRestantes(parseFecha(ev.fecha)) < 0);

        let msg = '📅 **CALENDARIO DEL CUATRIMESTRE**\n\n';
        if (futuros.length > 0) msg += '**Próximos eventos:**\n\n' + formatEventos(futuros);
        if (pasados.length > 0) msg += '\n\n**Eventos pasados:**\n\n' + formatEventos(pasados);
        if (lista.length === 0) msg += 'No hay eventos registrados. El profesor puede agregar con /evento';

        await interaction.editReply(msg);
        break;
      }

      case 'proximo': {
        const futuros = [...eventos.entries()]
          .filter(([,ev]) => diasRestantes(parseFecha(ev.fecha)) >= 0)
          .sort((a,b) => parseFecha(a[1].fecha) - parseFecha(b[1].fecha));

        if (futuros.length === 0) { await interaction.editReply('No hay eventos próximos en el calendario.'); break; }

        const [id, ev] = futuros[0];
        const dias = diasRestantes(parseFecha(ev.fecha));
        const diasStr = dias === 0 ? '**HOY**' : dias === 1 ? 'mañana' : 'en **' + dias + ' días**';

        await interaction.editReply(emojiTipo(ev.tipo) + ' **Próximo evento: ' + ev.titulo + '**\n\n📅 Fecha: **' + ev.fecha + '** — ' + diasStr + (ev.descripcion ? '\n📋 ' + ev.descripcion : '') + '\n\nUsá /calendario para ver todos los eventos.');
        break;
      }

      case 'borrar-evento': {
        const id = interaction.options.getInteger('id');
        if (!eventos.has(id)) { await interaction.editReply('❌ No existe el evento #' + id); break; }
        const ev = eventos.get(id);
        eventos.delete(id);
        await interaction.editReply('✅ Evento **' + ev.titulo + '** eliminado del calendario.');
        break;
      }

      case 'quiz': {
        const unidadNum = interaction.options.getInteger('unidad');
        const userId = interaction.user.id;
        const nombre = interaction.member?.displayName || interaction.user.username;
        const ctx = getContexto(interaction.guildId, interaction.channel?.name);

        await interaction.editReply('🧠 Generando pregunta...');

        const quizResp = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: ctx + ' Generá UNA pregunta de opción múltiple sobre la Unidad ' + unidadNum + '. Respondé SOLO en este formato JSON exacto sin nada más: {"pregunta":"texto de la pregunta","opciones":["A) opción1","B) opción2","C) opción3","D) opción4"],"correcta":"A","explicacion":"explicación breve de por qué es correcta"}'
          }]
        });

        let quizData;
        try {
          const txt = quizResp.content[0].text.replace(/```json|```/g, '').trim();
          quizData = JSON.parse(txt);
        } catch(e) {
          await interaction.editReply('❌ Error generando la pregunta. Intentá de nuevo.');
          break;
        }

        quizActivo.set(userId, {
          pregunta: quizData.pregunta,
          opciones: quizData.opciones,
          correcta: quizData.correcta,
          explicacion: quizData.explicacion,
          unidad: unidadNum,
          respondido: false
        });

        const botonesQuiz = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('quiz_A_' + userId).setLabel('A').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('quiz_B_' + userId).setLabel('B').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('quiz_C_' + userId).setLabel('C').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('quiz_D_' + userId).setLabel('D').setStyle(ButtonStyle.Secondary),
        );

        const opcText = quizData.opciones.join('\n');
        const quizMsg = '🧠 QUIZ Unidad ' + unidadNum + '\n\n' + quizData.pregunta + '\n\n' + opcText + '\n\nSelecciona tu respuesta:';
        await interaction.editReply({
          content: quizMsg,
          components: [botonesQuiz]
        });
        break;
      }

      case 'desafio': {
        const materia = interaction.options.getString('materia').toLowerCase();
        const ctx = CONTEXTOS[materia] || CONTEXTOS.iev;
        await interaction.editReply('⏳ Generando desafio con IA...');

        const respDesafio = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          messages: [{ role: 'user', content: ctx + '\n\nGenerá un desafio semanal desafiante pero alcanzable. Formato: DESAFIO: [título] ENUNCIADO: [problema 3-5 líneas] PISTA: [sin revelar solución] DIFICULTAD: [Básico/Intermedio/Avanzado]' }]
        });
        const textoDesafio = respDesafio.content[0].text;
        const id = desafioCounter++;
        desafioActivo = id;
        desafios.set(id, { titulo: 'Desafio #' + id, enunciado: textoDesafio, materia, soluciones: new Map() });

        await interaction.editReply('✅ Desafio publicado.');
        const msgDesafio = '🏆 **DESAFIO SEMANAL #' + id + '**\n\n' + textoDesafio + '\n\n+25 pts por participar. Usá /solucionar para enviar tu respuesta.';
        await interaction.channel.send({ content: msgDesafio });
        break;
      }

      case 'solucionar': {
        if (!desafioActivo || !desafios.has(desafioActivo)) {
          await interaction.editReply('❌ No hay ningún desafio activo. Esperá que el profesor publique uno con /desafio.');
          break;
        }
        const desafio = desafios.get(desafioActivo);
        const userId = interaction.user.id;
        const nombre = interaction.member?.displayName || interaction.user.username;
        const codigo = interaction.options.getString('codigo');

        if (desafio.soluciones.has(userId)) {
          await interaction.editReply('✅ Ya enviaste una solución a este desafio. Solo se acepta una por persona.');
          break;
        }

        const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
        desafio.soluciones.set(userId, { nombre, codigo, hora });

        // Dar puntos por participar
        const p = darPuntos(userId, nombre, 'entrega');
        const p2 = darPuntos(userId, nombre, 'pregunta');
        await actualizarRolDiscord(interaction.member, p2.pts);

        // Evaluar la solución con IA
        const ctx = CONTEXTOS[desafio.materia] || CONTEXTOS.iev;
        const evalResp = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 400,
          messages: [{ role: 'user', content: ctx + ' Desafio: ' + desafio.enunciado + ' Solucion de ' + nombre + ': ' + codigo + ' Evalua brevemente: es correcta, que esta bien, que mejorarias. Se pedagogico y alentador.' }]
        });

        const feedbackMsg = '✅ **' + nombre + '**, tu solucion fue registrada.\n\n🤖 **Feedback:**\n' + evalResp.content[0].text + '\n\n📤 +25 puntos | Total: **' + p2.pts + ' pts**';
        await interaction.editReply(feedbackMsg);
      }

      case 'soluciones': {
        if (!desafioActivo || !desafios.has(desafioActivo)) {
          await interaction.editReply('No hay desafio activo.');
          break;
        }
        const desafio = desafios.get(desafioActivo);
        if (desafio.soluciones.size === 0) {
          await interaction.editReply('Ningún alumno envió solución todavía.');
          break;
        }
        const listaItems2 = [...desafio.soluciones.values()].map((s, i) =>
          (i + 1) + '. ' + s.nombre + ' (' + s.hora + '): ' + s.codigo.substring(0, 80)
        );
        const lista = listaItems2.join('\n');
        await interaction.editReply('📋 Soluciones (' + desafio.soluciones.size + '):\n\n' + lista);
      }

      case 'cerrar-desafio': {
        if (!desafioActivo || !desafios.has(desafioActivo)) {
          await interaction.editReply('No hay desafio activo.');
          break;
        }
        const desafio = desafios.get(desafioActivo);
        const total = desafio.soluciones.size;

        if (total === 0) {
          desafioActivo = null;
          await interaction.editReply('Desafio cerrado sin participantes.');
          break;
        }

        // Elegir ganador (primero en enviar)
        const [ganadorId, ganadorData] = [...desafio.soluciones.entries()][0];
        const ganadorMember = await interaction.guild.members.fetch(ganadorId).catch(() => null);

        // Dar puntos extra al ganador
        const pGanador = darPuntos(ganadorId, ganadorData.nombre, 'entrega');
        const pGanador2 = darPuntos(ganadorId, ganadorData.nombre, 'entrega');
        if (ganadorMember) await actualizarRolDiscord(ganadorMember, pGanador2.pts);

        desafioActivo = null;
        await interaction.editReply('✅ Desafio cerrado.');
        const msgCierre = '🏆 DESAFIO CERRADO - Participantes: ' + total + ' - Ganador: ' + ganadorData.nombre + ' (enviado a las ' + ganadorData.hora + ') - Felicitaciones a todos! Usá /ranking para ver los cambios.';
        await interaction.channel.send({ content: msgCierre });
      }

      case 'tarea': {
        const titulo = interaction.options.getString('titulo');
        const descripcion = interaction.options.getString('descripcion');
        const fecha = interaction.options.getString('fecha');
        const id = tareaCounter++;
        const botonCompletar = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`completar_${id}`).setLabel('✅  Marcar como completada').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`vercompletados_${id}`).setLabel('👥  Ver quién completó').setStyle(ButtonStyle.Secondary)
        );
        tareas.set(id, { titulo, descripcion, fecha, canal: interaction.channelId, completados: new Set() });
        await interaction.editReply('✅ Tarea publicada.');
        await interaction.channel.send({
          content: `📚 **NUEVA TAREA #${id}**

📌 **${titulo}**

${descripcion}

⏰ **Fecha límite:** ${fecha}

Hacé clic en el botón cuando la completes.`,
          components: [botonCompletar]
        });

        // Recordatorio automático 24hs antes
        const partes = fecha.split('/');
        if (partes.length === 3) {
          const fechaDate = new Date(partes[2], partes[1] - 1, partes[0]);
          const recordatorio = fechaDate.getTime() - Date.now() - 86400000;
          if (recordatorio > 0) {
            setTimeout(async () => {
              const tarea = tareas.get(id);
              if (tarea) {
                const canal = interaction.guild.channels.cache.get(tarea.canal);
                if (canal) await canal.send(`⚠️ **Recordatorio:** La tarea **"${tarea.titulo}"** vence mañana **${tarea.fecha}**. ¡${tarea.completados.size} alumnos ya la completaron!`);
              }
            }, recordatorio);
          }
        }
        break;
      }
      case 'tareas': {
        if (tareas.size === 0) { await interaction.editReply('No hay tareas activas.'); break; }
        if (tareas.size === 0) { await interaction.editReply('No hay tareas activas.'); break; }
        const listaItems = [...tareas.entries()].map(([id, t]) =>
          '**#' + id + ' — ' + t.titulo + '**' + '\n' + '⏰ Vence: ' + t.fecha + ' | ✅ Completaron: ' + t.completados.size
        );
        const lista = listaItems.join('\n\n');
        await interaction.editReply('📚 **Tareas activas:**\n\n' + lista);
        break;
      }
      case 'completar': {
        const id = interaction.options.getInteger('id');
        const tarea = tareas.get(id);
        if (!tarea) { await interaction.editReply(`❌ No existe la tarea #${id}.`); break; }
        const nombre = interaction.member?.displayName || interaction.user.username;
        tarea.completados.add(nombre);
        const p = darPuntos(interaction.user.id, nombre, 'entrega');
        const rol = getRol(p.pts);
        await actualizarRolDiscord(interaction.member, p.pts);
        await interaction.editReply(`✅ **${nombre}** marcó la tarea **"${tarea.titulo}"** como completada.
📤 +20 puntos | Total: **${p.pts} pts** ${rol.emoji}`);
        break;
      }
      case 'herramientas':
        await interaction.editReply('🛠️ **Herramientas del curso:**\n\n📘 Chamilo → aulasvirtuales.name/chamilo\n📗 Moodle → aulasvirtuales.name/innova\n🐙 GitHub → github.com\n💬 Discord → Este servidor ✅');
        break;
      case 'craap': {
        const url = interaction.options.getString('url');
        const ctxCraap = getContexto(interaction.guildId, interaction.channel?.name);
        const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 800, messages: [{ role: 'user', content: `${ctxCraap}\n\nEvaluá "${url}" con criterio CRAAP. Puntuá del 1 al 5 cada dimensión y dá conclusión final.` }] });
        await interaction.editReply(`🔍 **Evaluación CRAAP: \`${url}\`**\n\n${resp.content[0].text}`);
        break;
      }
    }
  } catch (e) {
    console.error(e);
    await interaction.editReply('❌ Error. Intentá de nuevo.');
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  const canal = member.guild.channels.cache.find(c => c.name === 'aviso' || c.name === 'bienvenida');
  if (canal) canal.send(`👋 ¡Bienvenido/a **${member.displayName}**!\n\n📚 **IEV 2026 — IES N°6**\n• Usá **/preguntar** para consultas con IA\n• La asistencia se toma al inicio de cada clase ✅\n• Subí tus trabajos en **#entregas** y el bot los corrige automáticamente 🤖\n• Seguí las noticias tech en **#noticias-tech** 📰`);
});

client.login(DISCORD_TOKEN);