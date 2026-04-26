# 🤖 Bot IEV — IES N°6
### Bot de Discord con IA para Internet y Entornos Virtuales

---

## ¿Qué hace este bot?

| Comando | Función |
|---|---|
| `/unidad 1` al `/unidad 5` | Muestra el contenido de cada unidad |
| `/preguntar [pregunta]` | Le preguntás cualquier cosa a la IA sobre la materia |
| `/entrega` | Instrucciones para entregar trabajos |
| `/herramientas` | Links de Chamilo, Moodle, GitHub |
| `/craap [url]` | Evalúa una fuente con el criterio CRAAP (Unidad 3) |
| Mencionar al bot en #dudas | Responde automáticamente con IA |
| Nuevo miembro entra | Manda bienvenida automática con instrucciones |

---

## Instalación paso a paso

### 1. Instalar Node.js
Descargá Node.js desde: https://nodejs.org (versión LTS)

### 2. Crear el bot en Discord
1. Entrá a https://discord.com/developers/applications
2. → "New Application" → ponele nombre (ej: "Bot IEV")
3. → "Bot" en el menú izquierdo → "Add Bot"
4. → Copiá el **TOKEN** (lo vas a poner en el código)
5. → Activá los 3 "Privileged Gateway Intents":
   - PRESENCE INTENT ✅
   - SERVER MEMBERS INTENT ✅
   - MESSAGE CONTENT INTENT ✅

### 3. Invitar el bot a tu servidor
1. En el Developer Portal → "OAuth2" → "URL Generator"
2. Marcá: `bot` + `applications.commands`
3. En permisos marcá: `Send Messages`, `Read Messages`, `Use Slash Commands`
4. Copiá la URL generada y abrila en el navegador
5. Seleccioná tu servidor IES 6

### 4. Obtener tu Client ID
En el Developer Portal → "General Information" → copiá el **Application ID**

### 5. Configurar el código
Abrí el archivo `index.js` y completá estas 3 líneas:

```javascript
const DISCORD_TOKEN = 'pegá tu token aquí';
const CLIENT_ID = 'pegá tu client ID aquí';
const ANTHROPIC_API_KEY = 'pegá tu clave de Anthropic aquí';
```

**¿Dónde conseguís la clave de Anthropic?**
Entrá a https://console.anthropic.com → API Keys → Create Key

### 6. Instalar y correr
Abrí la terminal (CMD) en la carpeta del bot y ejecutá:

```bash
npm install
npm start
```

Si ves `✅ Bot conectado como Bot IEV#xxxx` → ¡funcionó!

---

## Mantener el bot activo

Por defecto el bot solo funciona mientras tenés la PC encendida.
Para tenerlo 24/7 podés usar:
- **Railway.app** (gratis hasta cierto límite)
- **Render.com** (gratis)
- Una Raspberry Pi o PC vieja siempre encendida

---

## Personalizar el contenido

En el archivo `index.js` podés editar:
- `CONTEXTO_MATERIA` → le explicás al bot más detalles de tu materia
- `UNIDADES` → el contenido de cada unidad
- Los mensajes de bienvenida

---

*Desarrollado para IES N°6 — Prof. Ing. Corimayo Ricardo Daniel*
*Materia: Internet y Entornos Virtuales 2026*
