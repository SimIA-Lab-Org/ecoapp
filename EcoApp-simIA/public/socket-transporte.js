// socket-transporte.js
// Habla con el servidor central por Socket.io. Mantiene la misma firma, crearTransporte(sala, rol),
// para que control.js y eco.html no necesiten cambiar cómo lo usan.

function crearTransporte(sala, rol) {
  const socket = io();

  socket.on('connect', () => {
    socket.emit('unirse-sala', { sala, rol });
  });

  socket.on('unirse-resultado', (res) => {
    if (!res.ok) {
      alert('Ese rol ya está ocupado en esta sala. Volviendo al inicio.');
      window.location.href = '/';
    }
  });

  return socket;
}
