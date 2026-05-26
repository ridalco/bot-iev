// =============================================
// BOT MENTOR IEV - VERSIÓN 2.0 PROFESIONAL
// Corregido para Render + Hora Argentina + deferReply
// =============================================
require('dotenv').config();
const chalk = require('chalk');
const fs = require('fs');
const {
  Client, GatewayIntentBits, Events, Collection,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');

const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

// ====================== VALIDACIÓN DE VARIABLES ======================
const REQUIRED_VARS = ['DISCORD_TOKEN', 'ANTHROPIC_API_KEY', 'SPREADSHEET_ID', 'GOOGLE_CREDENTIALS'];
const missing = REQUIRED_VARS.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error(chalk.red(`❌ Faltan variables: ${missing.join(', ')}`));
  process.exit(1);
}

let GOOGLE_CREDENTIALS;
try {
  GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
} catch (e) {
  console.error(chalk.red('❌ GOOGLE_CREDENTIALS no es JSON válido'));
  process.exit(1);
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const PROFESOR_ID = process.env.PROFESOR_ID;

// ====================== CLIENT ======================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
});

client.commands = new Collection();
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ====================== HORA LOCAL ARGENTINA ======================
function horaCortaArgentina() {
  return new Date().toLocaleTimeString('es-AR', { 
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: '2-digit', 
    minute: '2-digit' 
  });
}

// ====================== GRACEFUL SHUTDOWN ======================
process.on('SIGTERM', () => {
  console.log(chalk.yellow('🛑 Render → Apagando bot...'));
  client.destroy();
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  console.error(chalk.red('❌ Error no manejado:'), error);
});

setInterval(() => {
  console.log(chalk.gray(`[${horaCortaArgentina()}] Keep-alive`));
}, 300000);

client.once(Events.ClientReady, () => {
  console.log(chalk.green.bold(`✅ BOT ONLINE → ${client.user.tag}`));
});
// ====================== PARTE 2/5 - PERSISTENCIA Y FUNCIONES BÁSICAS ======================
const DATA_FILE = './data.json';
const puntos = new Map();
const tareas = new Map();
const eventos = new Map();
let tareaCounter = 1;
let eventoCounter = 1;

function cargarDatos() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (raw.puntos)  for (const [k, v] of Object.entries(raw.puntos))  puntos.set(k, v);
    if (raw.eventos) for (const [k, v] of Object.entries(raw.eventos)) eventos.set(parseInt(k), v);
    if (raw.tareas)  for (const [k, v] of Object.entries(raw.tareas))
      tareas.set(parseInt(k), { ...v, completados: new Set(v.completados || []) });
    if (raw.tareaCounter)  tareaCounter  = raw.tareaCounter;
    if (raw.eventoCounter) eventoCounter = raw.eventoCounter;
    console.log(`✅ Datos cargados: ${puntos.size} alumnos, ${tareas.size} tareas, ${eventos.size} eventos`);
  } catch (e) { console.error('Error cargando datos:', e); }
}

let _saveTimeout = null;
function guardarDatos() {
  if (_saveTimeout) clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(() => {
    try {
      const data = {
        puntos: Object.fromEntries(puntos),
        eventos: Object.fromEntries(eventos),
        tareas: Object.fromEntries([...tareas.entries()].map(([k, v]) => [k, { ...v, completados: [...v.completados] }])),
        tareaCounter,
        eventoCounter,
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) { console.error('Error guardando datos:', e); }
  }, 3000);
}

// ====================== UTILIDADES ======================
const sesiones = new Map();
function getSesion(guildId) {
  if (!sesiones.has(guildId))
    sesiones.set(guildId, { activa: false, asistentes: new Map(), fecha: '', preguntas: [] });
  return sesiones.get(guildId);
}

function esProfesor(userId) {
  if (!PROFESOR_ID) return true;
  return userId === PROFESOR_ID;
}

const SOLO_PROFESOR = ['iniciar-clase', 'cerrar-clase', 'noticias', 'evento', 'borrar-evento', 'desafio', 'soluciones', 'cerrar-desafio', 'tarea', 'similitudes', 'backup', 'reporte'];

// Cooldown
const cooldowns = new Map();
const COOLDOWN_SEGUNDOS = 30;
function verificarCooldown(userId) {
  const ahora = Date.now();
  const ultimo = cooldowns.get(userId) || 0;
  if (ahora - ultimo < COOLDOWN_SEGUNDOS * 1000) {
    return Math.ceil((COOLDOWN_SEGUNDOS * 1000 - (ahora - ultimo)) / 1000);
  }
  cooldowns.set(userId, ahora);
  return 0;
}

function safe(texto, max = 1900) {
  if (!texto) return '—';
  return texto.length > max ? texto.substring(0, max) + '\n…*(respuesta truncada)*' : texto;
}
// ====================== PARTE 3/5 - CONTEXTOS, UNIDADES Y HERRAMIENTAS ======================
function detectarMateria(guildId, channelName) {
  const canal = (channelName || '').toLowerCase();
  if (canal.includes('practica') || canal.includes('pract') || canal.includes('pp3')) return 'practica';
  if (canal.includes('bd') || canal.includes('base') || canal.includes('datos')) return 'bd';
  if (canal.includes('info') || canal.includes('informatica')) return 'informatica';
  return 'iev';
}

const CONTEXTOS = {
  iev: `Sos el asistente de "Internet y Entornos Virtuales" del Profesorado en Informática del IES N°6, Prof. Ing. Corimayo Ricardo Daniel. Respondé en español, claro y pedagógico.`,
  bd: `Sos el asistente de "Base de Datos" de la Tecnicatura Superior en Desarrollo de Software del IES N°11, Prof. Ing. Corimayo Ricardo Daniel. Respondé en español, claro y pedagógico.`,
  informatica: `Sos el asistente de "Informática" de la Tecnicatura Superior en Desarrollo de Software del IES N°11.`,
  practica: `Sos el asistente de "Práctica Profesionalizante III" de la Tecnicatura Superior en Ciencias de Datos e Inteligencia Artificial del IES N°6.`
};

function getContexto(guildId, channelName) {
  return CONTEXTOS[detectarMateria(guildId, channelName)] || CONTEXTOS.iev;
}

// ====================== UNIDADES ======================
const UNIDADES = {
  iev: {
    1: '🌐 **IEV — Unidad 1: Introducción a Internet**',
    2: '📧 **IEV — Unidad 2: Correo y Netiqueta**',
    3: '🔍 **IEV — Unidad 3: Criterio CRAAP**',
    4: '💬 **IEV — Unidad 4: Comunicación**',
    5: '🖥️ **IEV — Unidad 5: Entornos Virtuales**'
  },
  // Agregá aquí el resto de tus unidades originales si querés
};

const HERRAMIENTAS = {
  iev: '🛠️ **Herramientas IEV:**\n📗 Moodle IES6 → ies6.aulasvirtuales.name',
  bd: '🛠️ **Herramientas BD:**\n📗 Moodle IES11 → ies11.aulasvirtuales.name',
  informatica: '🛠️ **Herramientas Informática**',
  practica: '🛠️ **Herramientas PP3**'
};

// ====================== SISTEMA DE PUNTOS ======================
function darPuntos(userId, nombre, tipo) {
  if (!puntos.has(userId)) puntos.set(userId, { nombre, pts: 0, entregas: 0, asistencias: 0, preguntas: 0 });
  const p = puntos.get(userId);
  p.nombre = nombre;
  if (tipo === 'asistencia') { p.pts += 10; p.asistencias++; }
  if (tipo === 'entrega')    { p.pts += 20; p.entregas++; }
  if (tipo === 'pregunta')   { p.pts += 5;  p.preguntas++; }
  puntos.set(userId, p);
  guardarDatos();
  return p;
}

function getRanking() {
  return [...puntos.entries()].sort((a, b) => b[1].pts - a[1].pts).slice(0, 10);
}

function getRol(pts) {
  if (pts >= 200) return { nombre: 'Experto Digital', emoji: '🏆' };
  if (pts >= 100) return { nombre: 'Colaborador Activo', emoji: '⭐' };
  if (pts >= 50)  return { nombre: 'Aprendiz', emoji: '📚' };
  return { nombre: 'Novato', emoji: '🌱' };
}
// ====================== PARTE 4/5 - INTERACCIONES (CORREGIDO) ======================
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // ← ESTO ES CLAVE PARA EVITAR "Unknown interaction"
    await interaction.deferReply({ ephemeral: false });

    const { commandName } = interaction;

    switch (commandName) {

      case 'asistencia':
        await registrarAsistencia(interaction);   // ← Función con hora Argentina
        break;

      case 'ranking':
        const ranking = getRanking();
        let msg = '🏆 **Ranking General**\n\n';
        ranking.forEach(([id, data], i) => {
          msg += `${i+1}. <@${id}> — **${data.pts} pts** ${getRol(data.pts).emoji}\n`;
        });
        await interaction.editReply(safe(msg));
        break;

      case 'preguntar':
        const pregunta = interaction.options.getString('pregunta');
        const contexto = getContexto(interaction.guildId, interaction.channel?.name);
        
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{ role: 'user', content: `${contexto}\n\nPregunta: ${pregunta}` }]
        });

        await interaction.editReply(safe(response.content[0].text));
        darPuntos(interaction.user.id, interaction.member?.displayName || interaction.user.username, 'pregunta');
        break;

      case 'herramientas':
       const materia = detectarMateria(interaction.guildId, interaction.channel?.name);
       await interaction.editReply(HERRAMIENTAS[materia] || HERRAMIENTAS.iev);
       break;
      case 'ayuda':
        await interaction.editReply('📋 Usa `/ayuda` para ver los comandos disponibles.');
        break;

      // Agregá aquí el resto de tus comandos (/unidad, /tarea, /evento, etc.)
      default:
        await interaction.editReply('Comando en desarrollo...');
    }

  } catch (error) {
    console.error(chalk.red('Error en interacción:'), error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Ocurrió un error. Intentá de nuevo.', ephemeral: true });
    }
  }
});
// ====================== PARTE 5/5 - LOGIN FINAL ======================
client.login(DISCORD_TOKEN).catch(err => {
  console.error(chalk.red('❌ Error al hacer login:'), err);
});

console.log(chalk.blue.bold('🚀 Bot IEV v2.0 cargado correctamente'));
console.log(chalk.cyan(`   Hora Argentina: ${horaCortaArgentina()}`));

// Cargar datos persistentes al iniciar
cargarDatos();

console.log(chalk.green('✅ Todo listo para Render'));
  
