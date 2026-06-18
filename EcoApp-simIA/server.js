const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/clips', (req, res) => {
  const clips = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'clips.json'), 'utf8'));
  res.json(clips);
});

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

server.listen(PORT, () => {
  console.log(`\nEcoApp SimIA → http://localhost:${PORT}\n`);
});