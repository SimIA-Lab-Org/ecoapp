const params = new URLSearchParams(location.search);
const sala = params.get('sala');
if (!sala) {
  alert('No se ha indicado ninguna sala. Volviendo al inicio.');
  window.location.href = '/';
}
const socket = crearTransporte(sala, 'control');

// ── Estado ─────────────────────────────────────────────────────────
let catalogoZonas  = [];   // datos del JSON
let zonaActiva     = null; // zona seleccionada ahora
let clipEmitiendo  = null; // clip que se está emitiendo
let zonaEmitiendo  = null; // zona cuyo probe debe colorearse (verde/rojo)
let congelado      = false;
let filtroActivo   = null; // nombre del clip preseleccionado, o null = todos
let casoActivo     = null; // caso clínico activo, o null
let casoClipsEmitidos = []; // ids de clips ya emitidos en el caso activo
let segundos       = 0;
let timerInterval  = null;

// ── DOM ────────────────────────────────────────────────────────────
const siluetaWrap   = document.getElementById('silueta-wrap');
const dropdown       = document.getElementById('probe-dropdown');
const ddTitulo       = document.getElementById('dd-titulo');
const ddSub          = document.getElementById('dd-sub');
const ddClips        = document.getElementById('dd-clips');
const nowPlaying     = document.getElementById('now-playing');
const nowPlayingTit  = document.getElementById('now-playing-titulo');
const connDot        = document.getElementById('conn-dot');
const connTexto      = document.getElementById('conn-texto');
const timerEl        = document.getElementById('timer');
const btnCongelar    = document.getElementById('btn-congelar');
const filtroBadge    = document.getElementById('filtro-badge');
const filtroMenu     = document.getElementById('filtro-menu');
const filtroBadgeValor = document.getElementById('filtro-badge-valor');
const casoActivoPanel  = document.getElementById('caso-activo-panel');
const casoActivoNombre = document.getElementById('caso-activo-nombre');
const casoActivoClips  = document.getElementById('caso-activo-clips');
const btnDetener     = document.getElementById('btn-detener');

const ICONO_PAUSA = '<svg class="icon-inline" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const ICONO_PLAY  = '<svg class="icon-inline" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 4l13 8-13 8V4z"/></svg>';

// Mostrar el código de sesión en la esquina de la silueta, por si se olvida copiar
document.getElementById('sala-badge-codigo').textContent = sala;



// ── Cargar catálogo ────────────────────────────────────────────────
async function cargarCatalogo() {
  const res  = await fetch('/api/clips');
  catalogoZonas = await res.json();
  await construirMenuFiltro();
}

// ── Menú de preselección — chips ──────────────────────────────────
async function construirMenuFiltro() {
  // ── Casos clínicos ──
  const casosWrap  = document.getElementById('filtro-casos-wrap');
  const casosChips = document.getElementById('filtro-casos-chips');
  casosChips.innerHTML = '';

  let casos = [];
  try { casos = await fetch('/api/casos').then(r => r.json()); } catch(e) {}

  if (casos.length > 0) {
    casosWrap.style.display = '';
    casos.forEach(caso => {
      const chip = document.createElement('button');
      chip.className = 'chip caso';
      chip.dataset.casoId = caso.id;
      chip.textContent = caso.nombre;
      chip.addEventListener('click', () => aplicarCaso(caso));
      casosChips.appendChild(chip);
    });
  } else {
    casosWrap.style.display = 'none';
  }

  // ── Filtro rápido ──
  const rapidoChips = document.getElementById('filtro-rapido-chips');
  rapidoChips.innerHTML = '';

  const chipTodos = document.createElement('button');
  chipTodos.className = 'chip todos activo';
  chipTodos.id = 'chip-todos';
  chipTodos.textContent = 'Todos';
  chipTodos.addEventListener('click', () => aplicarFiltro(null));
  rapidoChips.appendChild(chipTodos);

  const nombresSet = new Set();
  catalogoZonas.forEach(z => z.clips.forEach(c => nombresSet.add(c.nombre)));
  Array.from(nombresSet).sort().forEach(nombre => {
    const chip = document.createElement('button');
    chip.className = 'chip rapido';
    chip.dataset.nombre = nombre;
    chip.textContent = nombre;
    chip.addEventListener('click', () => aplicarFiltro(nombre));
    rapidoChips.appendChild(chip);
  });
}

// ── Activar caso clínico ───────────────────────────────────────────
function aplicarCaso(caso) {
  casoActivo          = caso;
  filtroActivo        = null;
  casoClipsEmitidos   = [];
  filtroMenu.classList.remove('visible');

  // Badge: mostrar panel de caso
  filtroBadge.style.display = 'none';
  casoActivoPanel.classList.add('visible');
  casoActivoNombre.textContent = caso.nombre;
  actualizarPanelCaso();

  // Marcar chip seleccionado
  document.querySelectorAll('.chip.caso').forEach(c => c.classList.toggle('activo', c.dataset.casoId === caso.id));
  document.querySelectorAll('.chip.rapido, .chip.todos').forEach(c => c.classList.remove('activo'));

  actualizarResaltadoProbes();
  cerrarDropdown();
}

function actualizarPanelCaso() {
  if (!casoActivo) return;
  casoActivoClips.innerHTML = casoActivo.clips.map(c => {
    const emitido = casoClipsEmitidos.includes(c.id);
    return `<div class="caso-clip-row ${emitido ? 'emitido' : ''}">
      <span class="caso-clip-dot"></span>
      <span>${c.zona_titulo} · ${c.nombre}</span>
    </div>`;
  }).join('');
}

function aplicarFiltro(nombre) {
  filtroActivo      = nombre;
  casoActivo        = null;
  casoClipsEmitidos = [];
  filtroMenu.classList.remove('visible');

  // Mostrar badge de filtro, ocultar panel de caso
  filtroBadge.style.display = '';
  casoActivoPanel.classList.remove('visible');

  // Actualizar badge
  filtroBadgeValor.textContent = nombre || 'Todos';
  filtroBadge.classList.remove('activo', 'modo-filtro', 'modo-caso');
  if (nombre) filtroBadge.classList.add('activo', 'modo-filtro');

  // Marcar chip seleccionado
  document.querySelectorAll('.chip.rapido').forEach(c => c.classList.toggle('activo', c.dataset.nombre === nombre));
  const chipTodos = document.getElementById('chip-todos');
  if (chipTodos) chipTodos.classList.toggle('activo', !nombre);
  document.querySelectorAll('.chip.caso').forEach(c => c.classList.remove('activo'));

  actualizarResaltadoProbes();
  cerrarDropdown();
}

function actualizarResaltadoProbes() {
  document.querySelectorAll('.probe').forEach(btn => {
    btn.classList.remove('filtro-disponible', 'filtro-no-disponible', 'caso-disponible');
    const zona  = btn.dataset.zona;
    const datos = catalogoZonas.find(z => z.zona === zona);

    if (casoActivo) {
      const tiene = casoActivo.clips.some(c => c.zona === zona);
      btn.classList.add(tiene ? 'caso-disponible' : 'filtro-no-disponible');
    } else if (filtroActivo) {
      const tiene = datos && datos.clips.some(c => c.nombre === filtroActivo);
      btn.classList.add(tiene ? 'filtro-disponible' : 'filtro-no-disponible');
    }
  });
}

// Toggle del menú de filtro
filtroBadge.addEventListener('click', (e) => {
  e.stopPropagation();
  filtroMenu.classList.toggle('visible');
  cerrarDropdown();
});

// Cerrar menú de filtro al pulsar fuera
document.addEventListener('click', (e) => {
  if (filtroMenu.classList.contains('visible') &&
      !filtroMenu.contains(e.target) &&
      e.target !== filtroBadge) {
    filtroMenu.classList.remove('visible');
  }
});

// ── Botones de probe (silueta) ─────────────────────────────────────
document.querySelectorAll('.probe').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const zona = btn.dataset.zona;

    // Si hay caso activo, emitir directamente el clip del caso
    if (casoActivo) {
      const clipCaso = casoActivo.clips.find(c => c.zona === zona);
      if (clipCaso) {
        const datos = catalogoZonas.find(z => z.zona === zona);
        // Construir clip compatible con emitirClip
        const clip = { id: clipCaso.id, nombre: clipCaso.nombre, archivo: clipCaso.archivo, patologico: clipCaso.patologico, sub: clipCaso.sub || '' };
        emitirClip(clip, datos || { zona, titulo: clipCaso.zona_titulo, clips: [clip] });
        if (!casoClipsEmitidos.includes(clipCaso.id)) casoClipsEmitidos.push(clipCaso.id);
        actualizarPanelCaso();
      }
      return;
    }

    // Si hay filtro activo, emitir directamente sin abrir el menú
    if (filtroActivo) {
      const datos = catalogoZonas.find(z => z.zona === zona);
      if (datos) {
        const clip = datos.clips.find(c => c.nombre === filtroActivo);
        if (clip) {
          emitirClip(clip, datos);
          return;
        }
      }
      return;
    }

    if (zonaActiva === zona && dropdown.classList.contains('visible')) {
      cerrarDropdown();
      return;
    }
    abrirDropdown(zona, btn);
  });
});

function abrirDropdown(zonaId, btnEl) {
  zonaActiva = zonaId;

  // Marcar botón activo (puede haber varios con la misma zona)
  document.querySelectorAll('.probe').forEach(b => b.classList.remove('activo'));
  document.querySelectorAll(`.probe[data-zona="${zonaId}"]`).forEach(b => b.classList.add('activo'));

  const datos = catalogoZonas.find(z => z.zona === zonaId);
  if (!datos) return;

  ddTitulo.textContent = datos.titulo;
  ddSub.textContent    = `${datos.clips.length} clips disponibles`;

  renderDropdownClips(datos);
  posicionarDropdown(btnEl);
  dropdown.classList.add('visible');
}

function cerrarDropdown() {
  dropdown.classList.remove('visible');
  document.querySelectorAll('.probe').forEach(b => b.classList.remove('activo'));
  zonaActiva = null;
}

// Posiciona el desplegable junto al icono pulsado, dentro de los límites de la silueta
function posicionarDropdown(btnEl) {
  const wrapRect = siluetaWrap.getBoundingClientRect();
  const btnRect  = btnEl.getBoundingClientRect();
  const relX = btnRect.left + btnRect.width / 2 - wrapRect.left;
  const relY = btnRect.top  + btnRect.height / 2 - wrapRect.top;

  const ddWidth = 270;
  let left = relX - ddWidth / 2;
  left = Math.max(8, Math.min(left, wrapRect.width - ddWidth - 8));

  dropdown.style.width = ddWidth + 'px';
  dropdown.style.left  = left + 'px';

  const margen = 28;
  if (relY < wrapRect.height / 2) {
    // icono en la mitad superior → desplegable hacia abajo
    dropdown.style.top    = (relY + margen) + 'px';
    dropdown.style.bottom = 'auto';
  } else {
    // icono en la mitad inferior → desplegable hacia arriba
    dropdown.style.bottom = (wrapRect.height - relY + margen) + 'px';
    dropdown.style.top    = 'auto';
  }
}

function renderDropdownClips(datos) {
  ddClips.innerHTML = '';
  datos.clips.forEach(clip => {
    const esActivo = clipEmitiendo && clipEmitiendo.id === clip.id;

    const card = document.createElement('div');
    card.className = 'clip-card' + (esActivo ? ' emitiendo' : '');

    card.innerHTML = `
      <div class="clip-info">
        <div class="clip-nombre">${clip.nombre}</div>
        <div class="clip-sub">${clip.sub}</div>
      </div>
      <span class="clip-badge ${clip.patologico ? 'badge-p' : 'badge-n'}">
        ${clip.patologico ? 'Patológico' : 'Normal'}
      </span>
      <button class="clip-btn ${esActivo ? 'on' : ''}">
        ${esActivo ? 'Emitiendo' : 'Emitir'}
      </button>
    `;

    card.querySelector('.clip-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      emitirClip(clip, datos);
    });

    ddClips.appendChild(card);
  });
}

// ── Emitir clip ────────────────────────────────────────────────────
function emitirClip(clip, datos) {
  // Si ya estaba emitiendo este mismo, lo para
  if (clipEmitiendo && clipEmitiendo.id === clip.id) {
    detener();
    return;
  }

  clipEmitiendo = clip;
  zonaEmitiendo = datos.zona;
  actualizarColorProbes();

  // Al emitir un nuevo clip, se desactivan congelado y pantalla negra
  congelado = false;
  btnCongelar.classList.remove('congelado');
  btnCongelar.innerHTML = ICONO_PAUSA + 'Congelar';

  // Solo se envía lo necesario para reproducir: el archivo y la zona
  // anatómica. NUNCA se envía "nombre", "sub" ni "patologico", para que
  // el alumno no pueda ver el diagnóstico y tenga que interpretarlo él mismo.
  socket.emit('cambiar-clip', { archivo: clip.archivo, zona: datos.titulo });

  // Now playing
  nowPlayingTit.textContent = `${datos.titulo} · ${clip.nombre}`;
  nowPlaying.classList.add('visible');

  // Timer
  segundos = 0;
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    segundos++;
    const m = String(Math.floor(segundos / 60)).padStart(2, '0');
    const s = String(segundos % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
  }, 1000);

  renderDropdownClips(datos);
}

// ── Colorear el probe según el clip emitido (blanco / verde / rojo) ─
function actualizarColorProbes() {
  document.querySelectorAll('.probe').forEach(btn => {
    btn.classList.remove('emit-normal', 'emit-patologico');
  });

  if (zonaEmitiendo && clipEmitiendo) {
    const btnEmitiendo = document.querySelector(`.probe[data-zona="${zonaEmitiendo}"]`);
    if (btnEmitiendo) {
      btnEmitiendo.classList.add(clipEmitiendo.patologico ? 'emit-patologico' : 'emit-normal');
    }
  }
}

// ── Detener ────────────────────────────────────────────────────────
function detener() {
  clipEmitiendo = null;
  zonaEmitiendo = null;
  actualizarColorProbes();
  socket.emit('cambiar-clip', null);
  nowPlaying.classList.remove('visible');
  clearInterval(timerInterval);
  timerEl.textContent = '00:00';

  const datos = catalogoZonas.find(z => z.zona === zonaActiva);
  if (datos) renderDropdownClips(datos);
}

btnDetener.addEventListener('click', detener);

// ── Congelar ───────────────────────────────────────────────────────
btnCongelar.addEventListener('click', () => {
  congelado = !congelado;
  socket.emit('congelar', congelado);
  btnCongelar.classList.toggle('congelado', congelado);
  btnCongelar.innerHTML = congelado ? (ICONO_PLAY + 'Descongelar') : (ICONO_PAUSA + 'Congelar');
});

// ── Cerrar el desplegable al pulsar fuera de él ──────────────────────
document.addEventListener('click', (e) => {
  if (dropdown.classList.contains('visible') &&
      !dropdown.contains(e.target) &&
      !e.target.closest('.probe')) {
    cerrarDropdown();
  }
});

// ── Reposicionar el desplegable si cambia el tamaño de la ventana ───
window.addEventListener('resize', () => {
  if (dropdown.classList.contains('visible') && zonaActiva) {
    const btnActivo = document.querySelector(`.probe[data-zona="${zonaActiva}"]`);
    if (btnActivo) posicionarDropdown(btnActivo);
  }
});

// ── Socket ─────────────────────────────────────────────────────────
socket.on('companero-estado', (datos) => {
  if (datos.presente) {
    connDot.classList.add('on');
    connTexto.textContent = 'Alumno conectado';
  } else {
    connDot.classList.remove('on');
    connTexto.textContent = 'Desconectado';
  }
});

// ── Arrancar ───────────────────────────────────────────────────────
cargarCatalogo();