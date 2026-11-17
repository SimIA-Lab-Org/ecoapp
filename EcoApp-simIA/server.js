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
let casosClinicos    = []; // casos guardados en Cloudinary como JSON
let protocolos       = []; // protocolos de evaluación guardados en Cloudinary como JSON

async function cargarCasosClinicos() {
  if (!CLOUDINARY_CLOUD || !CLOUDINARY_KEY || !CLOUDINARY_SECRET) return;
  try {
    const auth = Buffer.from(`${CLOUDINARY_KEY}:${CLOUDINARY_SECRET}`).toString('base64');
    // type=upload y prefix exacto del folder donde se guardan los JSON
    const data = await httpGet(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/resources/raw?type=upload&max_results=500&prefix=ecoapp-casos/`,
      { Authorization: `Basic ${auth}` }
    );
    const parsed = JSON.parse(data);
    const recursos = parsed.resources || [];
    const casos = [];
    for (const r of recursos) {
      try {
        // Descargar el JSON usando autenticación Basic (los raw pueden ser privados)
        const json = await httpGet(r.secure_url, { Authorization: `Basic ${auth}` });
        const caso = JSON.parse(json);
        if (caso && caso.id) {
          // Guardamos el public_id REAL de Cloudinary (incluye la extensión .json).
          // Es lo que necesitamos para poder borrarlo luego sin fallar.
          caso._publicId = r.public_id;
          casos.push(caso);
        }
      } catch(e) {
        console.error('Error leyendo caso:', r.public_id, e.message);
      }
    }
    casosClinicos = casos;
    console.log(`Cloudinary: ${casosClinicos.length} casos clínicos cargados`);
  } catch(e) {
    console.error('Error cargando casos:', e.message);
  }
}

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
// Librería para generar el PDF del informe en el navegador (pantalla de entrenamiento)
app.use('/vendor/jspdf', express.static(path.join(__dirname, 'node_modules', 'jspdf', 'dist')));
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
  // Solo se admiten vídeos .mp4
  if (!/\.mp4($|\?)/i.test(secure_url)) {
    return res.status(400).json({ ok: false, error: 'Solo se permiten vídeos en formato .mp4' });
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
    const toSign    = `context=${contexto}&public_id=${publicId}&timestamp=${timestamp}&type=upload${CLOUDINARY_SECRET}`;
    const signature = crypto.createHash('sha1').update(toSign).digest('hex');

    const postData = new URLSearchParams({
      public_id: publicId, context: contexto, type: 'upload',
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
      r.on('end', () => {
        let json;
        try { json = JSON.parse(body); }
        catch(e) { return reject(new Error('Respuesta inválida de Cloudinary: ' + body)); }
        // Cloudinary devuelve { result: "ok" } si lo borró, o "not found"
        // si el archivo ya no existía. Cualquier otra cosa es un fallo real:
        // rechazamos para NO limpiar la memoria y evitar que reaparezca al reiniciar.
        if (json.result === 'ok' || json.result === 'not found') resolve(json);
        else reject(new Error('Cloudinary no borró el vídeo (' + (json.result || (json.error && json.error.message) || 'sin respuesta') + ')'));
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── API: listar casos clínicos ─────────────────────────────────────
app.get('/api/admin/casos', (req, res) => {
  res.json(casosClinicos.map(({ _publicId, ...c }) => c));
});

// ── API: crear o actualizar caso clínico ───────────────────────────
app.post('/api/admin/casos', async (req, res) => {
  if (!CLOUDINARY_CLOUD || !CLOUDINARY_KEY || !CLOUDINARY_SECRET) {
    return res.status(500).json({ ok: false, error: 'Cloudinary no configurado' });
  }
  try {
    const { id, nombre, descripcion, clips } = req.body;
    if (!nombre || !clips || clips.length === 0) {
      return res.status(400).json({ ok: false, error: 'Faltan datos' });
    }

    const casoId  = id || `caso-${Date.now()}`;
    const caso    = { id: casoId, nombre, descripcion: descripcion || '', clips };
    const json    = JSON.stringify(caso);
    const crypto  = require('crypto');
    const timestamp = Math.floor(Date.now() / 1000);
    const publicId  = `ecoapp-casos/${casoId}`;

    // Subir JSON como raw a Cloudinary
    const toSign  = `overwrite=true&public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_SECRET}`;
    const signature = crypto.createHash('sha1').update(toSign).digest('hex');

    const boundary = '----FormBoundary' + Date.now();
    const bodyParts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${casoId}.json"\r\nContent-Type: application/json\r\n\r\n${json}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="public_id"\r\n\r\n${publicId}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="api_key"\r\n\r\n${CLOUDINARY_KEY}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="timestamp"\r\n\r\n${timestamp}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="signature"\r\n\r\n${signature}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue`,
      `--${boundary}--`
    ].join('\r\n');

    const bodyBuf = Buffer.from(bodyParts);
    const reqOpts = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUDINARY_CLOUD}/raw/upload`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuf.length
      }
    };

    await new Promise((resolve, reject) => {
      const r = https.request(reqOpts, resp => {
        let body = '';
        resp.on('data', c => body += c);
        resp.on('end', () => {
          const parsed = JSON.parse(body);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed);
        });
      });
      r.on('error', reject);
      r.write(bodyBuf);
      r.end();
    });

    // Actualizar memoria. Guardamos también el public_id real de Cloudinary
    // (con extensión .json) para poder borrarlo después de forma fiable.
    const caso_mem = { ...caso, _publicId: `${publicId}.json` };
    const idx = casosClinicos.findIndex(c => c.id === casoId);
    if (idx !== -1) casosClinicos[idx] = caso_mem;
    else casosClinicos.push(caso_mem);

    res.json({ ok: true, id: casoId });
  } catch(e) {
    console.error('Error guardando caso:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: borrar caso clínico ───────────────────────────────────────
app.delete('/api/admin/casos/:casoId', async (req, res) => {
  if (!CLOUDINARY_CLOUD || !CLOUDINARY_KEY || !CLOUDINARY_SECRET) {
    return res.status(500).json({ ok: false, error: 'Cloudinary no configurado' });
  }
  try {
    const casoId  = req.params.casoId;
    // Buscamos el caso en memoria para usar su public_id REAL de Cloudinary.
    // Los recursos raw se guardan CON extensión (ecoapp-casos/caso-123.json),
    // así que borrar por "ecoapp-casos/caso-123" (sin .json) devolvería
    // "not found" y el archivo seguiría ahí, reapareciendo al reiniciar.
    const casoMem  = casosClinicos.find(c => c.id === casoId);
    const publicId = (casoMem && casoMem._publicId) || `ecoapp-casos/${casoId}.json`;
    const crypto   = require('crypto');
    const timestamp = Math.floor(Date.now() / 1000);
    // Cloudinary NO firma 'resource_type' (va en la URL, no en la firma).
    // Si se incluye aquí, la firma es inválida y el borrado falla en silencio.
    const toSign   = `public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_SECRET}`;
    const signature = crypto.createHash('sha1').update(toSign).digest('hex');

    const postData = new URLSearchParams({
      public_id: publicId, resource_type: 'raw',
      timestamp, api_key: CLOUDINARY_KEY, signature
    }).toString();

    const reqOpts = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUDINARY_CLOUD}/raw/destroy`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const respuesta = await new Promise((resolve, reject) => {
      const r = https.request(reqOpts, resp => {
        let body = '';
        resp.on('data', c => body += c);
        resp.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch(e) { reject(new Error('Respuesta inválida de Cloudinary: ' + body)); }
        });
      });
      r.on('error', reject);
      r.write(postData);
      r.end();
    });

    // Cloudinary devuelve { result: "ok" } si lo borró, o { result: "not found" }
    // si el archivo ya no existía. Ambos casos son válidos para limpiar la memoria.
    // Cualquier otra respuesta es un fallo real: NO tocamos la memoria y avisamos,
    // porque si no el caso reaparecería al reiniciar el servidor.
    const resultado = respuesta && respuesta.result;
    if (resultado !== 'ok' && resultado !== 'not found') {
      console.error('Cloudinary no borró el caso:', casoId, JSON.stringify(respuesta));
      const motivo = resultado
        || (respuesta && respuesta.error && respuesta.error.message)
        || 'sin respuesta';
      return res.status(500).json({
        ok: false,
        error: 'Cloudinary no pudo borrar el caso (' + motivo + ')'
      });
    }

    casosClinicos = casosClinicos.filter(c => c.id !== casoId);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: casos clínicos para el panel de control ───────────────────
app.get('/api/casos', (req, res) => {
  res.json(casosClinicos.map(({ _publicId, ...c }) => c));
});

// ── PROTOCOLOS ─────────────────────────────────────────────────────
// Cada protocolo define el checklist (pasos ordenados, cada uno con su
// ventana y hallazgo opcionales), un diagnóstico global al final y los
// criterios para considerar "superado".
// Se guardan como JSON raw en Cloudinary, en la carpeta ecoapp-protocolos/,
// igual que los casos clínicos.
const CARPETA_PROTOCOLOS = 'ecoapp-protocolos';
const NIVELES = ['basico', 'medio', 'avanzado'];
const TIPOS   = ['entrenamiento', 'simulacion'];

function cloudinaryConfigurado() {
  return !!(CLOUDINARY_CLOUD && CLOUDINARY_KEY && CLOUDINARY_SECRET);
}

// Descarga todos los JSON raw de una carpeta de Cloudinary.
// Devuelve [{ datos, publicId }] (solo los que tienen "id").
async function cargarJsonsDeCarpeta(carpeta) {
  const auth = Buffer.from(`${CLOUDINARY_KEY}:${CLOUDINARY_SECRET}`).toString('base64');
  const data = await httpGet(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/resources/raw?type=upload&max_results=500&prefix=${carpeta}/`,
    { Authorization: `Basic ${auth}` }
  );
  const recursos = JSON.parse(data).resources || [];
  const resultado = [];
  for (const r of recursos) {
    try {
      const json  = await httpGet(r.secure_url, { Authorization: `Basic ${auth}` });
      const datos = JSON.parse(json);
      if (datos && datos.id) resultado.push({ datos, publicId: r.public_id });
    } catch (e) {
      console.error('Error leyendo JSON:', r.public_id, e.message);
    }
  }
  return resultado;
}

// Sube (o sobrescribe) un objeto como JSON raw. Devuelve el public_id REAL
// que asigna Cloudinary, que es el que hace falta luego para borrarlo.
function subirJsonCloudinary(publicId, nombreArchivo, objeto) {
  const crypto    = require('crypto');
  const timestamp = Math.floor(Date.now() / 1000);
  const toSign    = `overwrite=true&public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_SECRET}`;
  const signature = crypto.createHash('sha1').update(toSign).digest('hex');

  const boundary = '----FormBoundary' + Date.now();
  const bodyBuf  = Buffer.from([
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${nombreArchivo}"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(objeto)}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="public_id"\r\n\r\n${publicId}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="api_key"\r\n\r\n${CLOUDINARY_KEY}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="timestamp"\r\n\r\n${timestamp}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="signature"\r\n\r\n${signature}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue`,
    `--${boundary}--`
  ].join('\r\n'));

  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUDINARY_CLOUD}/raw/upload`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuf.length
      }
    }, resp => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); }
        catch (e) { return reject(new Error('Respuesta inválida de Cloudinary: ' + body)); }
        if (parsed.error) reject(new Error(parsed.error.message));
        else resolve(parsed.public_id || `${publicId}.json`);
      });
    });
    r.on('error', reject);
    r.write(bodyBuf);
    r.end();
  });
}

// Borra un recurso raw. Acepta "ok" y "not found" como éxito (igual que casos).
function borrarRawCloudinary(publicId) {
  const crypto    = require('crypto');
  const timestamp = Math.floor(Date.now() / 1000);
  // resource_type NO se firma (va en la URL)
  const toSign    = `public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_SECRET}`;
  const signature = crypto.createHash('sha1').update(toSign).digest('hex');
  const postData  = new URLSearchParams({
    public_id: publicId, resource_type: 'raw',
    timestamp, api_key: CLOUDINARY_KEY, signature
  }).toString();

  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUDINARY_CLOUD}/raw/destroy`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, resp => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => {
        let json;
        try { json = JSON.parse(body); }
        catch (e) { return reject(new Error('Respuesta inválida de Cloudinary: ' + body)); }
        if (json.result === 'ok' || json.result === 'not found') resolve(json);
        else reject(new Error('Cloudinary no pudo borrarlo (' + (json.result || (json.error && json.error.message) || 'sin respuesta') + ')'));
      });
    });
    r.on('error', reject);
    r.write(postData);
    r.end();
  });
}

async function cargarProtocolos() {
  if (!cloudinaryConfigurado()) return;
  try {
    const items = await cargarJsonsDeCarpeta(CARPETA_PROTOCOLOS);
    protocolos = items.map(({ datos, publicId }) => ({ ...datos, _publicId: publicId }));
    console.log(`Cloudinary: ${protocolos.length} protocolos cargados`);
  } catch (e) {
    console.error('Error cargando protocolos:', e.message);
  }
}

// Limpia y valida lo que llega del formulario. Devuelve { error } o { protocolo }.
function normalizarProtocolo(body) {
  const texto = (v, max = 300) => String(v == null ? '' : v).trim().slice(0, max);
  const nombre = texto(body.nombre, 120);
  if (!nombre) return { error: 'El protocolo necesita un nombre' };

  // Bloque evaluable: { evaluar, <campoTexto>, <campoOblig> }
  const bloque = (b, campoTexto, campoOblig) => {
    b = b || {};
    const evaluar = !!b.evaluar;
    return {
      evaluar,
      [campoTexto]: evaluar ? texto(b[campoTexto]) : '',
      [campoOblig]: evaluar ? b[campoOblig] !== false : false
    };
  };

  const pasos = (Array.isArray(body.pasos) ? body.pasos : [])
    .map((p, i) => ({
      id:       texto(p && p.id, 40) || `paso-${Date.now()}-${i}`,
      texto:    texto(p && p.texto),
      zona:     texto(p && p.zona, 60) || null,
      ventana:  bloque(p && p.ventana,  'esperada', 'obligatoria'),
      hallazgo: bloque(p && p.hallazgo, 'esperado', 'obligatorio')
    }))
    .filter(p => p.texto);
  if (pasos.length === 0) return { error: 'Añade al menos un paso al checklist' };
  for (let i = 0; i < pasos.length; i++) {
    if (pasos[i].ventana.evaluar  && !pasos[i].ventana.esperada)  return { error: `Paso ${i + 1}: indica la ventana correcta` };
    if (pasos[i].hallazgo.evaluar && !pasos[i].hallazgo.esperado) return { error: `Paso ${i + 1}: indica el hallazgo esperado` };
  }

  const diagnostico = bloque((body.evaluacion || {}).diagnostico, 'esperado', 'obligatorio');
  if (diagnostico.evaluar && !diagnostico.esperado) return { error: 'Indica el diagnóstico esperado' };
  const cr = body.criterios  || {};
  const porcentaje = Math.round(Number(cr.porcentajeMinimo));
  const tiempo     = Number(cr.tiempoMaxMin);

  return {
    protocolo: {
      id:          texto(body.id, 60) || `protocolo-${Date.now()}`,
      nombre,
      descripcion: texto(body.descripcion),
      casoId:      texto(body.casoId, 60) || null,
      nivel:       NIVELES.includes(body.nivel) ? body.nivel : 'basico',
      tipo:        TIPOS.includes(body.tipo) ? body.tipo : 'entrenamiento',
      ordenObligatorio: !!body.ordenObligatorio,
      pasos,
      // Diagnóstico global del caso (se pregunta una vez al final)
      evaluacion: { diagnostico },
      criterios: {
        porcentajeMinimo: Number.isFinite(porcentaje) ? Math.min(100, Math.max(0, porcentaje)) : 80,
        tiempoMaxMin:     Number.isFinite(tiempo) && tiempo > 0 ? tiempo : null
      },
      actualizado: new Date().toISOString()
    }
  };
}

const sinPublicId = ({ _publicId, ...p }) => p;

// ── API: listar protocolos (admin y pantallas de entrenamiento) ────
app.get('/api/admin/protocolos', (req, res) => res.json(protocolos.map(sinPublicId)));
app.get('/api/protocolos',       (req, res) => res.json(protocolos.map(sinPublicId)));

// ── API: crear o actualizar protocolo ──────────────────────────────
app.post('/api/admin/protocolos', async (req, res) => {
  if (!cloudinaryConfigurado()) {
    return res.status(500).json({ ok: false, error: 'Cloudinary no configurado' });
  }
  const { error, protocolo } = normalizarProtocolo(req.body || {});
  if (error) return res.status(400).json({ ok: false, error });

  try {
    const publicIdReal = await subirJsonCloudinary(
      `${CARPETA_PROTOCOLOS}/${protocolo.id}`, `${protocolo.id}.json`, protocolo
    );
    const enMemoria = { ...protocolo, _publicId: publicIdReal };
    const idx = protocolos.findIndex(p => p.id === protocolo.id);
    if (idx !== -1) protocolos[idx] = enMemoria;
    else protocolos.push(enMemoria);
    res.json({ ok: true, id: protocolo.id });
  } catch (e) {
    console.error('Error guardando protocolo:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: borrar protocolo ──────────────────────────────────────────
app.delete('/api/admin/protocolos/:id', async (req, res) => {
  if (!cloudinaryConfigurado()) {
    return res.status(500).json({ ok: false, error: 'Cloudinary no configurado' });
  }
  const id  = req.params.id;
  const mem = protocolos.find(p => p.id === id);
  try {
    await borrarRawCloudinary((mem && mem._publicId) || `${CARPETA_PROTOCOLOS}/${id}.json`);
    protocolos = protocolos.filter(p => p.id !== id);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error borrando protocolo:', id, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: verificar contraseña de admin ────────────────────────────
app.post('/api/admin/auth', (req, res) => {
  const { pwd } = req.body;
  const PWD = process.env.ADMIN_PASSWORD || 'Simialab2.0';
  if (pwd === PWD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false });
  }
});

// ── Salas ──────────────────────────────────────────────────────────
// Cada sala tiene su propio estado y sus propios roles ocupados.
// Roles: control (instructor), eco (pantalla del alumno) y
// entrenamiento (evaluador, pantalla E).
// salas['ABCDE'] = { control, eco, entrenamiento: socket.id|null, estado: {...}, infoClip }
const ROLES = ['control', 'eco', 'entrenamiento'];
const salas = {};

function obtenerOcrearSala(salaId) {
  if (!salas[salaId]) {
    salas[salaId] = {
      control: null,
      eco: null,
      entrenamiento: null,
      estado: { clip: null, congelado: false, negro: false },
      // Datos del clip que SOLO recibe el evaluador (zona, nombre, patológico).
      // Se guardan aparte de "estado" para que nunca lleguen al alumno.
      infoClip: null
    };
  }
  return salas[salaId];
}

function presencia(sala) {
  return { control: !!sala.control, eco: !!sala.eco, entrenamiento: !!sala.entrenamiento };
}

io.on('connection', (socket) => {

  // El Lobby pregunta si los roles de una sala están libres
  socket.on('comprobar-sala', (salaId) => {
    const sala = obtenerOcrearSala(salaId);
    socket.emit('estado-sala', {
      controlOcupado:       !!sala.control,
      ecoOcupado:           !!sala.eco,
      entrenamientoOcupado: !!sala.entrenamiento
    });
  });

  // Reservar un rol dentro de una sala
  socket.on('unirse-sala', ({ sala: salaId, rol }) => {
    if (!ROLES.includes(rol)) {
      socket.emit('unirse-resultado', { ok: false, motivo: 'rol-invalido' });
      return;
    }
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
    if (rol === 'entrenamiento') socket.emit('info-clip', sala.infoClip);

    // Control y eco se avisan entre sí (como antes)
    if (rol === 'control' || rol === 'eco') {
      const otroRol = rol === 'control' ? 'eco' : 'control';
      if (sala[otroRol]) {
        io.to(sala[otroRol]).emit('companero-estado', { presente: true });
        socket.emit('companero-estado', { presente: true });
      }
    }
    io.to(salaId).emit('presencia-sala', presencia(sala));
  });

  socket.on('cambiar-clip', (clip) => {
    const salaId = socket.data.sala;
    if (!salaId || !salas[salaId]) return;
    salas[salaId].estado.clip      = clip;
    salas[salaId].estado.congelado = false;
    salas[salaId].estado.negro     = false;
    if (!clip) {
      salas[salaId].infoClip = null;
      if (salas[salaId].entrenamiento) io.to(salas[salaId].entrenamiento).emit('info-clip', null);
    }
    io.to(salaId).emit('clip-cambiado', clip);
    io.to(salaId).emit('pantalla-negra', false);
  });

  // El control manda qué clip es (zona, nombre...). Solo se reenvía al
  // evaluador: el alumno no debe poder ver el diagnóstico.
  socket.on('info-clip', (info) => {
    const salaId = socket.data.sala;
    if (!salaId || !salas[salaId] || socket.data.rol !== 'control') return;
    const limpio = info ? {
      zona:       String(info.zona || ''),
      zonaTitulo: String(info.zonaTitulo || ''),
      nombre:     String(info.nombre || ''),
      patologico: !!info.patologico,
      t:          Date.now()
    } : null;
    salas[salaId].infoClip = limpio;
    if (salas[salaId].entrenamiento) io.to(salas[salaId].entrenamiento).emit('info-clip', limpio);
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

  // El instructor cierra la sesión deliberadamente → avisar a los demás
  // roles de la sala (p.ej. al monitor de eco) para que también salgan.
  // Se usa un evento explícito (y no el disconnect) para que un simple
  // refresco de página del control NO eche al alumno sin querer.
  socket.on('cerrar-sesion', () => {
    const salaId = socket.data.sala;
    if (!salaId || !salas[salaId]) return;
    socket.to(salaId).emit('sesion-cerrada');
  });

  socket.on('disconnect', () => {
    const salaId = socket.data.sala;
    const rol    = socket.data.rol;
    if (!salaId || !rol || !salas[salaId]) return;
    const sala = salas[salaId];

    sala[rol] = null;

    if (rol === 'control' || rol === 'eco') {
      const otroRol = rol === 'control' ? 'eco' : 'control';
      if (sala[otroRol]) io.to(sala[otroRol]).emit('companero-estado', { presente: false });
    }
    io.to(salaId).emit('presencia-sala', presencia(sala));

    // limpiar la sala de memoria si se queda vacía
    if (!sala.control && !sala.eco && !sala.entrenamiento) {
      delete salas[salaId];
    }
  });
});

server.listen(PORT, async () => {
  console.log(`\nEcoApp SimIA → http://localhost:${PORT}\n`);
  await cargarClipsDeCloudinary();
  await cargarCasosClinicos();
  await cargarProtocolos();
});