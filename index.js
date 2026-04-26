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
  new SlashCommandBuilder().setName('unidad').setDescription('Info de una unidad').addIntegerOption(o => o.setName('numero').setDescription('Número 1-5').setRequired(true).setMinValue(1).setMaxValue(5)),
  new SlashCommandBuilder().setName('preguntar').setDescription('Preguntá a la IA sobre la materia').addStringOption(o => o.setName('pregunta').setDescription('Tu pregunta').setRequired(true)),
  new SlashCommandBuilder().setName('entrega').setDescription('Instrucciones para entregar trabajos'),
  new SlashCommandBuilder().setName('herramientas').setDescription('Links de las herramientas del curso'),
  new SlashCommandBuilder().setName('craap').setDescription('Evaluar una fuente con criterio CRAAP').addStringOption(o => o.setName('url').setDescription('URL a evaluar').setRequired(true)),
  new SlashCommandBuilder().setName('ranking').setDescription('Ver el ranking de participación del curso'),
  new SlashCommandBuilder().setName('mispuntos').setDescription('Ver tus puntos y rol actual'),
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

const CONTEXTO = `Sos el asistente de "Internet y Entornos Virtuales" del Profesorado en Informática del IES N°6, Prof. Ing. Corimayo Ricardo Daniel. Respondé en español, claro y pedagógico. Unidades: 1-Introducción a Internet, 2-Correo y netiqueta, 3-Criterio CRAAP, 4-Comunicación sincrónica/asincrónica, 5-Entornos virtuales Chamilo/Moodle.`;

const UNIDADES = {
  1: '🌐 **Unidad 1 — Introducción a Internet**\n\nProtocolos TCP/IP, HTTP, HTTPS, FTP. Comandos CMD: ping, tracert, ipconfig, nslookup.\n\n**Plataforma:** Chamilo → aulasvirtuales.name/chamilo',
  2: '📧 **Unidad 2 — Correo Electrónico y Netiqueta**\n\nSMTP, POP3, IMAP. Netiqueta digital. CC vs CCO.\n\n**Plataforma:** Moodle → aulasvirtuales.name/innova',
  3: '🔍 **Unidad 3 — Búsqueda y Evaluación**\n\nMotores de búsqueda. Criterio CRAAP. Fake news.\n\n**Probá:** /craap [url]',
  4: '💬 **Unidad 4 — Comunicación**\n\nSincrónica vs Asincrónica. Discord, Meet, Zoom. Foros.',
  5: '🖥️ **Unidad 5 — Entornos Virtuales**\n\nChamilo y Moodle. Roles. Creación de cursos.\n\n**Proyecto final:** Aula virtual en Chamilo.',
};

// =============================================
// EVENTOS
// =============================================
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot conectado como ${c.user.tag}`);
  for (const guild of c.guilds.cache.values()) await registrarComandos(guild.id);

  setInterval(async () => {
    const ahora = new Date();
    const dia = ahora.getDay();
    const hora = ahora.getHours();
    const min = ahora.getMinutes();

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
      const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 600, messages: [{ role: 'user', content: `${CONTEXTO}\n\nPregunta: ${pregunta}` }] });
      message.reply(`🤖 ${resp.content[0].text}`);
    } catch (e) { message.reply('❌ No pude procesar tu pregunta.'); }
  }
});

// Interacciones
client.on(Events.InteractionCreate, async (interaction) => {
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
        await interaction.editReply(UNIDADES[num]);
        break;
      }
      case 'preguntar': {
        const pregunta = interaction.options.getString('pregunta');
        const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 800, messages: [{ role: 'user', content: `${CONTEXTO}\n\nPregunta: ${pregunta}` }] });
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
        const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 800, messages: [{ role: 'user', content: `${CONTEXTO}\n\nEvaluá "${url}" con criterio CRAAP. Puntuá del 1 al 5 cada dimensión y dá conclusión final.` }] });
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