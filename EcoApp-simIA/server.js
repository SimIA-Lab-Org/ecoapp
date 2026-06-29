const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const https      = require('https');
const { Readable } = require('stream');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 3000;

// ── Cloudinary ─────────────────────────────────────────────────────
const CLOUDINARY_CLOUD = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_KEY   = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_SECRET = process.env.CLOUDINARY_API_SECRET;

// Clips subidos por profesores en esta sesión (en memoria)
// Se recargan de Cloudinary al arrancar el servidor
let clipsCloudinary = [];

async function cargarClipsDeCloudinary() {
  if (!CLOUDINARY_CLOUD || !CLOUDINARY_KEY || !CLOUDINARY_SECRET) return;
  try {
    const auth = Buffer.from(`${CLOUDINARY_KEY}:${CLOUDINARY_SECRET}`).toString('base64');
    const data = await httpGet(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/resources/video?max_results=500&tags=true&context=true`,
      { Authorization: `Basic ${auth}` }
    );
    const recursos = JSON.parse(data).resources || [];
    clipsCloudinary = recursos.map(r => {
      const ctx = parseContext(r.context?.custom || {});
      return {
        zona:       ctx.zona       || 'sin-zona',
        titulo:     ctx.titulo_zona || ctx.zona || 'Sin zona',
        id:         r.public_id,
        nombre:     ctx.nombre     || r.public_id,
        sub:        ctx.sub        || '',
        patologico: ctx.patologico === 'true',
        archivo:    r.secure_url
      };
    });
    console.log(`Cloudinary: ${clipsCloudinary.length} vídeos cargados`);
  } catch (e) {
    console.error('Error cargando Cloudinary:', e.message);
  }
}

function parseContext(ctx) {
  // El contexto de Cloudinary puede llegar como objeto o como string "key=val|key2=val2"
  if (typeof ctx === 'string') {
    return Object.fromEntries(ctx.split('|').map(p => p.split('=')));
  }
  return ctx;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ── Middleware ─────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
// Para parsear JSON en el body de las peticiones de admin
app.use(express.json({ limit: '5mb' }));

// ── API: catálogo de clips ─────────────────────────────────────────
app.get('/api/clips', (req, res) => {
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'clips.json'), 'utf8'));

  // Mezclar clips locales con los de Cloudinary, agrupados por zona
  const mapaZonas = {};
  base.forEach(z => { mapaZonas[z.zona] = { ...z, clips: [...z.clips] }; });

  clipsCloudinary.forEach(c => {
    if (!mapaZonas[c.zona]) {
      mapaZonas[c.zona] = { zona: c.zona, titulo: c.titulo, clips: [] };
    }
    // Evitar duplicados por id
    if (!mapaZonas[c.zona].clips.find(x => x.id === c.id)) {
      mapaZonas[c.zona].clips.push({
        id:         c.id,
        nombre:     c.nombre,
        sub:        c.sub,
        patologico: c.patologico,
        archivo:    c.archivo
      });
    }
  });

  res.json(Object.values(mapaZonas));
});

// ── API: generar firma para subida directa desde el navegador ──────
// El navegador subirá el vídeo directamente a Cloudinary con esta firma,
// sin pasar el archivo por el servidor (evita límite de tamaño).
app.post('/api/admin/firma', (req, res) => {
  if (!CLOUDINARY_CLOUD || !CLOUDINARY_KEY || !CLOUDINARY_SECRET) {
    return res.status(500).json({ ok: false, error: 'Cloudinary no configurado' });
  }
  const { nombre, sub, patologico, zona, titulo_zona } = req.body;
  if (!zona || !nombre) return res.status(400).json({ ok: false, error: 'Faltan datos' });

  const crypto    = require('crypto');
  const timestamp = Math.floor(Date.now() / 1000);
  const contexto  = `nombre=${nombre}|sub=${sub || ''}|patologico=${patologico ? 'true' : 'false'}|zona=${zona}|titulo_zona=${titulo_zona || zona}`;
  const folder    = 'ecoapp-simia';
  const tags      = `ecoapp,${zona}`;

  // Los parámetros a firmar deben estar ordenados alfabéticamente
  const paramsToSign = `context=${contexto}&folder=${folder}&tags=${tags}&timestamp=${timestamp}${CLOUDINARY_SECRET}`;
  const signature = crypto.createHash('sha1').update(paramsToSign).digest('hex');

  res.json({
    ok: true,
    cloudName: CLOUDINARY_CLOUD,
    apiKey:    CLOUDINARY_KEY,
    timestamp,
    signature,
    folder,
    context:   contexto,
    tags,
    // metadatos para guardar en memoria tras la subida
    meta: { nombre, sub: sub || '', patologico: !!patologico, zona, titulo_zona: titulo_zona || zona }
  });
});

// ── API: registrar clip en memoria tras subida directa ─────────────
// El navegador llama a este endpoint después de subir a Cloudinary con éxito.
app.post('/api/admin/registrar', (req, res) => {
  const { public_id, secure_url, nombre, sub, patologico, zona, titulo_zona } = req.body;
  if (!public_id || !secure_url || !zona) {
    return res.status(400).json({ ok: false, error: 'Faltan datos' });
  }
  // Evitar duplicados
  if (!clipsCloudinary.find(c => c.id === public_id)) {
    clipsCloudinary.push({
      zona,
      titulo:     titulo_zona || zona,
      id:         public_id,
      nombre:     nombre || public_id,
      sub:        sub || '',
      patologico: !!patologico,
      archivo:    secure_url
    });
  }
  res.json({ ok: true });
});

// ── API: editar metadatos de un clip en Cloudinary ────────────────
app.put('/api/admin/editar/:publicId(*)', async (req, res) => {
  if (!CLOUDINARY_CLOUD || !CLOUDINARY_KEY || !CLOUDINARY_SECRET) {
    return res.status(500).json({ ok: false, error: 'Cloudinary no configurado' });
  }
  try {
    const publicId = req.params.publicId;
    const { nombre, sub, patologico, zona, titulo_zona } = req.body;
    if (!nombre || !zona) return res.status(400).json({ ok: false, error: 'Faltan datos' });

    const contexto = `nombre=${nombre}|sub=${sub || ''}|patologico=${patologico ? 'true' : 'false'}|zona=${zona}|titulo_zona=${titulo_zona || zona}`;

    const crypto    = require('crypto');
    const timestamp = Math.floor(Date.now() / 1000);
    const toSign    = `context=${contexto}&public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_SECRET}`;
    const signature = crypto.createHash('sha1').update(toSign).digest('hex');

    const postData = new URLSearchParams({
      public_id: publicId, context: contexto,
      timestamp, api_key: CLOUDINARY_KEY, signature
    }).toString();

    const reqOpts = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUDINARY_CLOUD}/video/explicit`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    await new Promise((resolve, reject) => {
      const r = https.request(reqOpts, resp => {
        let body = '';
        resp.on('data', c => body += c);
        resp.on('end', () => {
          const json = JSON.parse(body);
          if (json.error) reject(new Error(json.error.message));
          else resolve(json);
        });
      });
      r.on('error', reject);
      r.write(postData);
      r.end();
    });

    // Actualizar en memoria
    const idx = clipsCloudinary.findIndex(c => c.id === publicId);
    if (idx !== -1) {
      clipsCloudinary[idx] = {
        ...clipsCloudinary[idx],
        nombre, sub: sub || '', patologico: !!patologico,
        zona, titulo: titulo_zona || zona
      };
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('Error editando en Cloudinary:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: borrar vídeo de Cloudinary ───────────────────────────────
app.delete('/api/admin/borrar/:publicId(*)', async (req, res) => {
  if (!CLOUDINARY_CLOUD || !CLOUDINARY_KEY || !CLOUDINARY_SECRET) {
    return res.status(500).json({ ok: false, error: 'Cloudinary no configurado' });
  }
  try {
    const publicId = req.params.publicId;
    await cloudinaryDestroy(publicId);
    clipsCloudinary = clipsCloudinary.filter(c => c.id !== publicId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: lista de zonas disponibles (para el formulario de admin) ──
app.get('/api/zonas', (req, res) => {
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'clips.json'), 'utf8'));
  res.json(base.map(z => ({ zona: z.zona, titulo: z.titulo })));
});

// ── Helpers Cloudinary ─────────────────────────────────────────────
function cloudinaryUpload(dataUri, options) {
  return new Promise((resolve, reject) => {
    const params = {
      file: dataUri,
      api_key: CLOUDINARY_KEY,
      timestamp: Math.floor(Date.now() / 1000),
      ...options
    };

    // Generar firma
    const crypto = require('crypto');
    const toSign = Object.keys(params)
      .filter(k => k !== 'file' && k !== 'api_key' && k !== 'resource_type')
      .sort()
      .map(k => `${k}=${Array.isArray(params[k]) ? params[k].join(',') : params[k]}`)
      .join('&') + CLOUDINARY_SECRET;

    params.signature = crypto.createHash('sha1').update(toSign).digest('hex');

    const postData = new URLSearchParams(params).toString();
    const urlPath  = `/v1_1/${CLOUDINARY_CLOUD}/${options.resource_type || 'video'}/upload`;

    const reqOpts = {
      hostname: 'api.cloudinary.com',
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(reqOpts, r => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => {
        const json = JSON.parse(body);
        if (json.error) reject(new Error(json.error.message));
        else resolve(json);
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function cloudinaryDestroy(publicId) {
  return new Promise((resolve, reject) => {
    const crypto    = require('crypto');
    const timestamp = Math.floor(Date.now() / 1000);
    const toSign    = `public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_SECRET}`;
    const signature = crypto.createHash('sha1').update(toSign).digest('hex');

    const postData = new URLSearchParams({
      public_id: publicId, timestamp, api_key: CLOUDINARY_KEY,
      signature, resource_type: 'video'
    }).toString();

    const reqOpts = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUDINARY_CLOUD}/video/destroy`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(reqOpts, r => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── Salas ──────────────────────────────────────────────────────────
// Cada sala tiene su propio estado y sus propios roles ocupados.
// salas['ABCDE'] = { control: socket.id|null, eco: socket.id|null, estado: {...} }
const salas = {};

function obtenerOcrearSala(salaId) {
  if (!salas[salaId]) {
    salas[salaId] = {
      control: null,
      eco: null,
      estado: { clip: null, congelado: false, negro: false }
    };
  }
  return salas[salaId];
}

io.on('connection', (socket) => {

  // El Lobby pregunta si los roles de una sala están libres
  socket.on('comprobar-sala', (salaId) => {
    const sala = obtenerOcrearSala(salaId);
    socket.emit('estado-sala', {
      controlOcupado: !!sala.control,
      ecoOcupado: !!sala.eco
    });
  });

  // Reservar un rol dentro de una sala
  socket.on('unirse-sala', ({ sala: salaId, rol }) => {
    const sala = obtenerOcrearSala(salaId);

    if (sala[rol]) {
      socket.emit('unirse-resultado', { ok: false, motivo: 'ocupado' });
      return;
    }

    sala[rol] = socket.id;
    socket.data.sala = salaId;
    socket.data.rol  = rol;
    socket.join(salaId);

    socket.emit('unirse-resultado', { ok: true });
    socket.emit('estado-inicial', sala.estado);

    // avisar al otro rol (si ya está) de que su compañero está presente
    const otroRol = rol === 'control' ? 'eco' : 'control';
    if (sala[otroRol]) {
      io.to(sala[otroRol]).emit('companero-estado', { presente: true });
      socket.emit('companero-estado', { presente: true });
    }
  });

  socket.on('cambiar-clip', (clip) => {
    const salaId = socket.data.sala;
    if (!salaId || !salas[salaId]) return;
    salas[salaId].estado.clip      = clip;
    salas[salaId].estado.congelado = false;
    salas[salaId].estado.negro     = false;
    io.to(salaId).emit('clip-cambiado', clip);
    io.to(salaId).emit('pantalla-negra', false);
  });

  socket.on('congelar', (valor) => {
    const salaId = socket.data.sala;
    if (!salaId || !salas[salaId]) return;
    salas[salaId].estado.congelado = valor;
    io.to(salaId).emit('imagen-congelada', valor);
  });

  socket.on('pantalla-negra', (valor) => {
    const salaId = socket.data.sala;
    if (!salaId || !salas[salaId]) return;
    salas[salaId].estado.negro = valor;
    io.to(salaId).emit('pantalla-negra', valor);
  });

  socket.on('disconnect', () => {
    const salaId = socket.data.sala;
    const rol    = socket.data.rol;
    if (!salaId || !rol || !salas[salaId]) return;

    salas[salaId][rol] = null;

    const otroRol = rol === 'control' ? 'eco' : 'control';
    if (salas[salaId][otroRol]) {
      io.to(salas[salaId][otroRol]).emit('companero-estado', { presente: false });
    }

    // limpiar la sala de memoria si se queda vacía
    if (!salas[salaId].control && !salas[salaId].eco) {
      delete salas[salaId];
    }
  });
});

server.listen(PORT, async () => {
  console.log(`\nEcoApp SimIA → http://localhost:${PORT}\n`);
  await cargarClipsDeCloudinary();
});