// entrenamiento.js — Pantalla E (evaluador) de EcoApp SimIA
//
// Flujo: 1) elegir protocolo + ID del alumno → 2) evaluar (checklist ✓/✗,
// mini vídeo sincronizado con el control, crono) → 3) resultado APTO/NO APTO,
// PDF y JSON. Nada se guarda en el servidor: la evaluación en curso se guarda
// solo en este dispositivo (localStorage) por si se recarga la página.

const params = new URLSearchParams(location.search);
const sala   = params.get('sala');
if (!sala) {
  alert('No se ha indicado ninguna sala. Volviendo al inicio.');
  window.location.href = '/';
}
const socket = crearTransporte(sala, 'entrenamiento');
const CLAVE_GUARDADO = 'ecoapp-evaluacion-' + sala;

// ── Estado ─────────────────────────────────────────────────────────
let protocolos = [];
let zonas      = [];
let ev         = null;   // evaluación en curso (ver nuevaEvaluacion)
let timerId    = null;
let infoClipActual = null;

const $ = id => document.getElementById(id);

const NIVEL_TXT = { basico: 'Básico', medio: 'Medio', avanzado: 'Avanzado' };
const SVG_OK    = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const SVG_FALLO = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const SVG_PIN   = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0114 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
const SVG_PAUSA = '<svg class="icon-inline" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const SVG_PLAY  = '<svg class="icon-inline" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 4l13 8-13 8V4z"/></svg>';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function mmss(seg) {
  seg = Math.max(0, Math.floor(seg || 0));
  return String(Math.floor(seg / 60)).padStart(2, '0') + ':' + String(seg % 60).padStart(2, '0');
}
function tituloZona(z) {
  const x = zonas.find(a => a.zona === z);
  return x ? x.titulo : z;
}
function mostrarPantalla(id) {
  document.querySelectorAll('.pantalla').forEach(p => p.classList.toggle('visible', p.id === id));
  window.scrollTo(0, 0);
}
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('visible'), 2600);
}

// ── Guardado local (por si se recarga la página) ──────────────────
function guardarLocal() {
  try { if (ev) localStorage.setItem(CLAVE_GUARDADO, JSON.stringify(ev)); } catch (e) {}
}
function leerLocal() {
  try { return JSON.parse(localStorage.getItem(CLAVE_GUARDADO) || 'null'); } catch (e) { return null; }
}
function borrarLocal() {
  try { localStorage.removeItem(CLAVE_GUARDADO); } catch (e) {}
}

// ════════════════════════════════════════════════════════════════
// 1. CONFIGURACIÓN
// ════════════════════════════════════════════════════════════════
async function cargarDatos() {
  try { zonas = await fetch('/api/zonas').then(r => r.json()); } catch (e) { zonas = []; }
  try { protocolos = await fetch('/api/protocolos').then(r => r.json()); } catch (e) { protocolos = []; }

  const sel = $('sel-protocolo');
  if (protocolos.length === 0) {
    sel.innerHTML = '<option value="">No hay protocolos: créalos en Gestión de contenido</option>';
    sel.disabled = true;
  } else {
    protocolos.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    sel.innerHTML = '<option value="">— Elige un protocolo —</option>' +
      protocolos.map(p => `<option value="${esc(p.id)}">${esc(p.nombre)} · ${NIVEL_TXT[p.nivel] || ''}</option>`).join('');
  }
  actualizarConfig();

  // ¿Hay una evaluación a medias en este dispositivo para esta sala?
  const guardada = leerLocal();
  if (guardada && guardada.protocolo && !guardada.finalizada) {
    $('aviso-recuperar-txt').textContent =
      `Hay una evaluación sin terminar: alumno ${guardada.alumnoId}, ${guardada.protocolo.nombre} (${mmss(guardada.seg)}).`;
    $('aviso-recuperar').style.display = '';
  }
}

function protocoloElegido() {
  return protocolos.find(p => p.id === $('sel-protocolo').value) || null;
}

function actualizarConfig() {
  const p = protocoloElegido();
  const resumen = $('resumen-proto');
  if (p) {
    const nV = p.pasos.filter(x => x.ventana && x.ventana.evaluar).length;
    const nH = p.pasos.filter(x => x.hallazgo && x.hallazgo.evaluar).length;
    const d  = p.evaluacion && p.evaluacion.diagnostico;
    const cr = p.criterios || {};
    resumen.innerHTML =
      `<strong>${p.pasos.length} pasos</strong>${p.ordenObligatorio ? ' en orden obligatorio' : ''}` +
      `${nV ? ` · ${nV} ventana${nV > 1 ? 's' : ''}` : ''}${nH ? ` · ${nH} hallazgo${nH > 1 ? 's' : ''}` : ''}` +
      `${d && d.evaluar ? ' · diagnóstico final' : ''}<br>` +
      `Para superar: <strong>${cr.porcentajeMinimo != null ? cr.porcentajeMinimo : 80}%</strong> de aciertos` +
      `${cr.tiempoMaxMin ? ` en menos de <strong>${cr.tiempoMaxMin} min</strong>` : ''}` +
      `${p.descripcion ? `<br>${esc(p.descripcion)}` : ''}`;
    resumen.classList.add('visible');
  } else {
    resumen.classList.remove('visible');
  }
  $('btn-empezar').disabled = !(p && $('inp-alumno').value.trim());
}
$('sel-protocolo').addEventListener('change', actualizarConfig);
$('inp-alumno').addEventListener('input', actualizarConfig);
$('inp-alumno').addEventListener('keydown', e => { if (e.key === 'Enter' && !$('btn-empezar').disabled) $('btn-empezar').click(); });

function nuevaEvaluacion(protocolo, alumnoId) {
  const pasos = {};
  protocolo.pasos.forEach(p => {
    pasos[p.id] = { estado: null, t: null, auto: false, fueraDeOrden: false, ventana: null, hallazgo: null };
  });
  return {
    version: 1,
    sala,
    alumnoId,
    protocolo,                 // copia completa: el informe no depende de cambios posteriores
    inicio: new Date().toISOString(),
    fin: null,
    seg: 0,
    corriendo: true,
    pasos,
    diagnostico: null,
    observaciones: '',
    clipsEmitidos: [],
    finalizada: false
  };
}

$('btn-empezar').addEventListener('click', () => {
  const p = protocoloElegido();
  const alumno = $('inp-alumno').value.trim();
  if (!p || !alumno) return;
  ev = nuevaEvaluacion(p, alumno);
  borrarLocal();
  guardarLocal();
  entrarEvaluacion();
});

$('btn-recuperar').addEventListener('click', () => {
  ev = leerLocal();
  if (!ev) return;
  ev.corriendo = false;   // vuelve en pausa: que el evaluador decida cuándo seguir
  $('aviso-recuperar').style.display = 'none';
  entrarEvaluacion();
});
$('btn-descartar').addEventListener('click', () => {
  if (!confirm('¿Descartar la evaluación sin terminar? Se perderán sus marcas.')) return;
  borrarLocal();
  $('aviso-recuperar').style.display = 'none';
});

// ════════════════════════════════════════════════════════════════
// 2. EVALUACIÓN
// ════════════════════════════════════════════════════════════════
function entrarEvaluacion() {
  $('info-alumno').textContent   = ev.alumnoId;
  $('info-protocolo').textContent = ev.protocolo.nombre;
  $('inp-observaciones').value   = ev.observaciones || '';
  const d = ev.protocolo.evaluacion && ev.protocolo.evaluacion.diagnostico;
  $('card-diagnostico').style.display = d && d.evaluar ? '' : 'none';
  renderPasos();
  renderDiagnostico();
  arrancarCrono();
  mostrarPantalla('pantalla-eval');
  pintarInfoClip();
}

// ── Crono ──────────────────────────────────────────────────────────
function arrancarCrono() {
  clearInterval(timerId);
  timerId = setInterval(() => {
    if (!ev || ev.finalizada || !ev.corriendo) return;
    ev.seg++;
    pintarCrono();
    if (ev.seg % 5 === 0) guardarLocal();
  }, 1000);
  pintarCrono();
}
function pintarCrono() {
  const c = $('crono');
  if (!ev) { c.textContent = '00:00'; c.className = 'crono'; return; }
  c.textContent = mmss(ev.seg);
  const max = ev.protocolo.criterios && ev.protocolo.criterios.tiempoMaxMin;
  c.className = 'crono' + (!ev.corriendo && !ev.finalizada ? ' pausado' : '') + (max && ev.seg > max * 60 ? ' excedido' : '');
  $('btn-crono').innerHTML = ev.corriendo ? SVG_PAUSA + ' Pausar crono' : SVG_PLAY + ' Reanudar crono';
}
$('btn-crono').addEventListener('click', () => {
  if (!ev) return;
  ev.corriendo = !ev.corriendo;
  pintarCrono();
  guardarLocal();
});

// ── Checklist ─────────────────────────────────────────────────────
function htmlMarcas(valor, attrs) {
  return `<div class="marcas">
    <button type="button" class="marca ok ${valor === 'ok' ? 'on' : ''}" data-valor="ok" ${attrs} title="Correcto">${SVG_OK}</button>
    <button type="button" class="marca fallo ${valor === 'fallo' ? 'on' : ''}" data-valor="fallo" ${attrs} title="Incorrecto">${SVG_FALLO}</button>
  </div>`;
}

// Primer paso sin marcar (el "siguiente" que toca hacer)
function pasoActualId() {
  const p = ev.protocolo.pasos.find(x => !ev.pasos[x.id].estado);
  return p ? p.id : null;
}

function renderPasos() {
  const cont   = $('lista-pasos');
  const actual = pasoActualId();
  const zonaEmitida = infoClipActual && infoClipActual.zona;
  cont.innerHTML = '';

  ev.protocolo.pasos.forEach((p, i) => {
    const r = ev.pasos[p.id];
    const div = document.createElement('div');
    div.className = 'paso' +
      (p.id === actual ? ' actual' : '') +
      (zonaEmitida && p.zona === zonaEmitida ? ' emitiendo' : '') +
      (r.estado === 'ok' ? ' hecho-ok' : r.estado === 'fallo' ? ' hecho-fallo' : '');

    const tags = [];
    if (r.auto)         tags.push('<span class="tag tag-auto">Auto</span>');
    if (r.fueraDeOrden) tags.push('<span class="tag tag-orden">Fuera de orden</span>');

    let html = `
      <div class="paso-cab">
        <span class="paso-num">${i + 1}</span>
        <div style="flex:1;min-width:0">
          <div class="paso-texto">${esc(p.texto)}</div>
          <div class="paso-meta">
            ${p.zona ? `<span class="zona">${SVG_PIN}${esc(tituloZona(p.zona))}</span>` : '<span>Lo marca el evaluador</span>'}
            ${tags.join('')}
          </div>
        </div>
        <span class="paso-tiempo">${r.t != null ? mmss(r.t) : ''}</span>
      </div>
      <div class="linea">
        <div class="linea-txt">Paso realizado</div>
        ${htmlMarcas(r.estado, `data-paso="${esc(p.id)}" data-campo="estado"`)}
      </div>`;
    if (p.ventana && p.ventana.evaluar) {
      html += `
      <div class="linea">
        <div class="linea-txt"><b>Ventana:</b> ${esc(p.ventana.esperada)}${p.ventana.obligatoria ? ' <span class="estrella">★</span>' : ''}</div>
        ${htmlMarcas(r.ventana, `data-paso="${esc(p.id)}" data-campo="ventana"`)}
      </div>`;
    }
    if (p.hallazgo && p.hallazgo.evaluar) {
      html += `
      <div class="linea">
        <div class="linea-txt"><b>Hallazgo:</b> ${esc(p.hallazgo.esperado)}${p.hallazgo.obligatorio ? ' <span class="estrella">★</span>' : ''}</div>
        ${htmlMarcas(r.hallazgo, `data-paso="${esc(p.id)}" data-campo="hallazgo"`)}
      </div>`;
    }
    div.innerHTML = html;
    cont.appendChild(div);
  });

  cont.querySelectorAll('.marca').forEach(btn => btn.addEventListener('click', () => {
    marcar(btn.dataset.paso, btn.dataset.campo, btn.dataset.valor);
  }));
  pintarProgreso();
}

function marcar(pasoId, campo, valor) {
  if (!ev || ev.finalizada) return;
  const r = ev.pasos[pasoId];
  const nuevo = r[campo] === valor ? null : valor;   // pulsar de nuevo = desmarcar
  r[campo] = nuevo;
  if (campo === 'estado') {
    r.auto = false;                                   // ahora es una decisión del evaluador
    if (nuevo === null) { r.t = null; r.fueraDeOrden = false; }
    else if (r.t == null) r.t = ev.seg;
  }
  guardarLocal();
  renderPasos();
}

function renderDiagnostico() {
  const d = ev.protocolo.evaluacion && ev.protocolo.evaluacion.diagnostico;
  if (!d || !d.evaluar) return;
  $('diag-txt').innerHTML = `<b>Esperado:</b> ${esc(d.esperado)}${d.obligatorio ? ' <span class="estrella">★</span>' : ''}`;
  $('diag-marcas').outerHTML = htmlMarcas(ev.diagnostico, 'data-diag="1"').replace('class="marcas"', 'class="marcas" id="diag-marcas"');
  $('diag-marcas').querySelectorAll('.marca').forEach(btn => btn.addEventListener('click', () => {
    if (ev.finalizada) return;
    ev.diagnostico = ev.diagnostico === btn.dataset.valor ? null : btn.dataset.valor;
    guardarLocal();
    renderDiagnostico();
    pintarProgreso();
  }));
}

$('inp-observaciones').addEventListener('input', e => {
  if (!ev) return;
  ev.observaciones = e.target.value;
  guardarLocal();
});

function pintarProgreso() {
  const items = listaItems(ev);
  const marcados = items.filter(x => x.valor).length;
  $('info-progreso').textContent = `${marcados} de ${items.length} marcados`;
  $('info-barra').style.width = (items.length ? (marcados / items.length * 100) : 0) + '%';
}

// ── Auto-marcado cuando el instructor emite un clip ──────────────
// Si el clip es de la zona de un paso sin marcar, ese paso se marca solo.
// Con orden obligatorio, si quedan pasos ANTERIORES con zona sin hacer,
// se marca como ✗ "fuera de orden". El evaluador puede cambiarlo siempre.
function autoMarcar(info) {
  if (!ev || ev.finalizada || !info || !info.zona) return;
  const pasosProto = ev.protocolo.pasos;
  const idx = pasosProto.findIndex(p => p.zona === info.zona && !ev.pasos[p.id].estado);
  if (idx === -1) return;

  const paso = pasosProto[idx];
  const r    = ev.pasos[paso.id];
  const saltados = ev.protocolo.ordenObligatorio
    ? pasosProto.slice(0, idx).filter(p => p.zona && !ev.pasos[p.id].estado)
    : [];

  r.estado       = saltados.length ? 'fallo' : 'ok';
  r.fueraDeOrden = saltados.length > 0;
  r.auto         = true;
  r.t            = ev.seg;
  guardarLocal();
  toast(saltados.length
    ? `Paso ${idx + 1} fuera de orden (faltaba el ${pasosProto.indexOf(saltados[0]) + 1})`
    : `Paso ${idx + 1} marcado como hecho`);
}

// ════════════════════════════════════════════════════════════════
// 3. RESULTADO
// ════════════════════════════════════════════════════════════════

// Todo lo que se puntúa, en orden: cada paso, su ventana, su hallazgo y el
// diagnóstico final. Cada elemento correcto es un acierto.
function listaItems(e) {
  const items = [];
  e.protocolo.pasos.forEach((p, i) => {
    const r = e.pasos[p.id];
    items.push({ tipo: 'Paso', n: i + 1, texto: p.texto, valor: r.estado, imprescindible: false });
    if (p.ventana && p.ventana.evaluar)
      items.push({ tipo: 'Ventana', n: i + 1, texto: p.ventana.esperada, valor: r.ventana, imprescindible: !!p.ventana.obligatoria });
    if (p.hallazgo && p.hallazgo.evaluar)
      items.push({ tipo: 'Hallazgo', n: i + 1, texto: p.hallazgo.esperado, valor: r.hallazgo, imprescindible: !!p.hallazgo.obligatorio });
  });
  const d = e.protocolo.evaluacion && e.protocolo.evaluacion.diagnostico;
  if (d && d.evaluar)
    items.push({ tipo: 'Diagnóstico', n: null, texto: d.esperado, valor: e.diagnostico, imprescindible: !!d.obligatorio });
  return items;
}

function calcularResultado(e) {
  const items    = listaItems(e);
  const cr       = e.protocolo.criterios || {};
  const minimo   = cr.porcentajeMinimo != null ? cr.porcentajeMinimo : 80;
  const aciertos = items.filter(x => x.valor === 'ok').length;
  const pct      = items.length ? Math.round(aciertos / items.length * 100) : 0;
  const fallosImprescindibles = items.filter(x => x.imprescindible && x.valor !== 'ok');
  const tiempoMaxSeg = cr.tiempoMaxMin ? cr.tiempoMaxMin * 60 : null;
  const fueraDeTiempo = tiempoMaxSeg != null && e.seg > tiempoMaxSeg;

  const motivos = [];
  if (pct < minimo) motivos.push(`${pct}% de aciertos (mínimo ${minimo}%)`);
  fallosImprescindibles.forEach(x => motivos.push(
    `${x.tipo}${x.n ? ' del paso ' + x.n : ''} imprescindible ${x.valor === 'fallo' ? 'incorrecto' : 'sin marcar'}: ${x.texto}`));
  if (fueraDeTiempo) motivos.push(`Tiempo ${mmss(e.seg)} (máximo ${cr.tiempoMaxMin} min)`);

  return {
    supera: motivos.length === 0,
    aciertos, total: items.length, porcentaje: pct, minimo,
    sinMarcar: items.filter(x => !x.valor).length,
    pasosFueraDeOrden: e.protocolo.pasos.filter(p => e.pasos[p.id].fueraDeOrden).length,
    motivos, items
  };
}

$('btn-finalizar').addEventListener('click', () => {
  const sinMarcar = listaItems(ev).filter(x => !x.valor).length;
  if (sinMarcar && !confirm(`Quedan ${sinMarcar} elementos sin marcar y contarán como fallo. ¿Finalizar igualmente?`)) return;
  ev.finalizada = true;
  ev.corriendo  = false;
  ev.fin        = new Date().toISOString();
  guardarLocal();
  pintarCrono();
  mostrarResultado();
});

function celda(valor) {
  if (valor === 'ok')    return '<span class="r-ok">✓</span>';
  if (valor === 'fallo') return '<span class="r-fallo">✗</span>';
  if (valor === undefined) return '<span class="r-na">—</span>';
  return '<span class="r-fallo">Sin marcar</span>';
}

function mostrarResultado() {
  const res = calcularResultado(ev);
  $('veredicto').className = 'veredicto ' + (res.supera ? 'apto' : 'no-apto');
  $('veredicto-txt').textContent = res.supera ? 'APTO' : 'NO APTO';
  $('veredicto-sub').textContent = `${res.aciertos} de ${res.total} aciertos (${res.porcentaje}%) · ${mmss(ev.seg)}`;
  $('motivos').innerHTML = res.motivos.map(m => `<li>${esc(m)}</li>`).join('');

  const p = ev.protocolo;
  const tieneV = p.pasos.some(x => x.ventana && x.ventana.evaluar);
  const tieneH = p.pasos.some(x => x.hallazgo && x.hallazgo.evaluar);
  let html = `<tr><th>#</th><th>Paso</th><th>Hecho</th>${tieneV ? '<th>Ventana</th>' : ''}${tieneH ? '<th>Hallazgo</th>' : ''}<th>Tiempo</th></tr>`;
  p.pasos.forEach((x, i) => {
    const r = ev.pasos[x.id];
    html += `<tr>
      <td>${i + 1}</td>
      <td>${esc(x.texto)}${r.fueraDeOrden ? ' <span class="tag tag-orden">Fuera de orden</span>' : ''}</td>
      <td>${celda(r.estado)}</td>
      ${tieneV ? `<td>${x.ventana && x.ventana.evaluar ? celda(r.ventana) : celda(undefined)}</td>` : ''}
      ${tieneH ? `<td>${x.hallazgo && x.hallazgo.evaluar ? celda(r.hallazgo) : celda(undefined)}</td>` : ''}
      <td>${r.t != null ? mmss(r.t) : ''}</td>
    </tr>`;
  });
  const d = p.evaluacion && p.evaluacion.diagnostico;
  if (d && d.evaluar) {
    const cols = 2 + (tieneV ? 1 : 0) + (tieneH ? 1 : 0);
    html += `<tr><td></td><td><b>Diagnóstico final:</b> ${esc(d.esperado)}</td><td colspan="${cols - 1}">${celda(ev.diagnostico)}</td><td></td></tr>`;
  }
  $('tabla-res').innerHTML = html;
  mostrarPantalla('pantalla-resultado');
}

$('btn-corregir').addEventListener('click', () => {
  ev.finalizada = false;
  ev.fin = null;
  guardarLocal();
  entrarEvaluacion();
});

$('btn-nueva').addEventListener('click', () => {
  if (!confirm('¿Empezar una nueva evaluación? Si no has descargado el PDF o los datos, se perderán.')) return;
  borrarLocal();
  ev = null;
  pintarCrono();
  $('inp-alumno').value = '';
  actualizarConfig();
  mostrarPantalla('pantalla-config');
  $('inp-alumno').focus();
});

// ── Descargas ─────────────────────────────────────────────────────
function nombreArchivo(ext) {
  const limpiar = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  const fecha = (ev.fin || ev.inicio).slice(0, 10);
  return `informe_${limpiar(ev.alumnoId)}_${limpiar(ev.protocolo.nombre)}_${fecha}.${ext}`;
}

function descargar(blob, nombre) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

$('btn-json').addEventListener('click', () => {
  const res = calcularResultado(ev);
  const datos = {
    app: 'EcoApp SimIA',
    tipo: 'evaluacion-entrenamiento',
    version: 1,
    alumnoId: ev.alumnoId,
    sala: ev.sala,
    inicio: ev.inicio,
    fin: ev.fin,
    duracionSeg: ev.seg,
    protocolo: ev.protocolo,
    resultado: {
      supera: res.supera, aciertos: res.aciertos, total: res.total,
      porcentaje: res.porcentaje, minimo: res.minimo, motivos: res.motivos
    },
    pasos: ev.protocolo.pasos.map((p, i) => ({
      n: i + 1, id: p.id, texto: p.texto, zona: p.zona,
      ...ev.pasos[p.id]
    })),
    diagnostico: ev.diagnostico,
    observaciones: ev.observaciones,
    clipsEmitidos: ev.clipsEmitidos
  };
  descargar(new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' }), nombreArchivo('json'));
});

$('btn-pdf').addEventListener('click', () => {
  if (!window.jspdf) { alert('No se ha podido cargar el generador de PDF.'); return; }
  try {
    const doc = generarPDF(ev, calcularResultado(ev));
    descargar(doc.output('blob'), nombreArchivo('pdf'));
  } catch (e) {
    console.error(e);
    alert('Error generando el PDF: ' + e.message);
  }
});

// ── PDF (jsPDF) ───────────────────────────────────────────────────
function generarPDF(e, res) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const M = 16, W = 210 - 2 * M, ALTO = 297;
  const TEAL = [13, 107, 83], ROJO = [163, 32, 32], VERDE = [30, 107, 46], GRIS = [110, 110, 110];
  let y = M;

  const salto = (h) => { if (y + h > ALTO - 16) { doc.addPage(); y = M; return true; } return false; };
  const texto = (t, x, opts = {}) => {
    doc.setFont('helvetica', opts.negrita ? 'bold' : 'normal');
    doc.setFontSize(opts.tam || 10);
    doc.setTextColor(...(opts.color || [17, 17, 17]));
    doc.text(t, x, y, opts.align ? { align: opts.align } : undefined);
  };
  const fecha = d => d ? new Date(d).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '';

  // Cabecera
  texto('EcoApp SimIA', M, { tam: 9, color: TEAL, negrita: true });
  texto('Informe de entrenamiento', M + W, { tam: 9, color: GRIS, align: 'right' });
  y += 3;
  doc.setDrawColor(...TEAL); doc.setLineWidth(0.6); doc.line(M, y, M + W, y);
  y += 9;
  texto(e.protocolo.nombre, M, { tam: 16, negrita: true });
  y += 8;

  // Datos
  const p = e.protocolo, cr = p.criterios || {};
  const datos = [
    ['Alumno', e.alumnoId],
    ['Nivel', NIVEL_TXT[p.nivel] || p.nivel],
    ['Fecha', fecha(e.inicio)],
    ['Duración', mmss(e.seg) + (cr.tiempoMaxMin ? `  (máximo ${cr.tiempoMaxMin} min)` : '')],
  ];
  datos.forEach(([k, v], i) => {
    const x = M + (i % 2) * (W / 2);
    texto(k, x, { tam: 8, color: GRIS });
    y += 4.5;
    texto(String(v), x, { tam: 11 });
    if (i % 2 === 0) y -= 4.5; else y += 7;
  });
  y += 2;

  // Veredicto
  const col = res.supera ? VERDE : ROJO;
  const lineasMotivos = res.motivos.flatMap(m => doc.splitTextToSize('• ' + m, W - 10));
  const altoCaja = 20 + (lineasMotivos.length ? lineasMotivos.length * 4.6 + 3 : 0);
  doc.setFillColor(...(res.supera ? [228, 245, 232] : [251, 234, 234]));
  doc.roundedRect(M, y, W, altoCaja, 3, 3, 'F');
  const yCaja = y;
  y += 9;
  texto(res.supera ? 'APTO' : 'NO APTO', M + 6, { tam: 18, negrita: true, color: col });
  texto(`${res.aciertos} de ${res.total} aciertos · ${res.porcentaje}% (mínimo ${res.minimo}%)`, M + W - 6, { tam: 10, color: col, align: 'right' });
  y += 7;
  if (lineasMotivos.length) {
    y += 1;
    lineasMotivos.forEach(l => { texto(l, M + 6, { tam: 9 }); y += 4.6; });
  }
  y = yCaja + altoCaja + 10;

  // Tabla de pasos
  const tieneV = p.pasos.some(x => x.ventana && x.ventana.evaluar);
  const tieneH = p.pasos.some(x => x.hallazgo && x.hallazgo.evaluar);
  const cols = [{ t: '#', w: 8 }, { t: 'Paso', w: 0 }, { t: 'Hecho', w: 22 }];
  if (tieneV) cols.push({ t: 'Ventana', w: 22 });
  if (tieneH) cols.push({ t: 'Hallazgo', w: 22 });
  cols.push({ t: 'Tiempo', w: 16 });
  cols[1].w = W - cols.reduce((s, c) => s + c.w, 0);

  const cabeceraTabla = () => {
    texto('Checklist', M, { tam: 12, negrita: true });
    y += 6;
    let x = M;
    cols.forEach(c => { texto(c.t, x + 1, { tam: 8, color: GRIS, negrita: true }); x += c.w; });
    y += 2;
    doc.setDrawColor(210); doc.setLineWidth(0.2); doc.line(M, y, M + W, y);
    y += 4.5;
  };
  const txtRes = v => v === 'ok' ? ['Correcto', VERDE] : v === 'fallo' ? ['Incorrecto', ROJO] : v === undefined ? ['—', [180, 180, 180]] : ['Sin marcar', ROJO];

  salto(30);
  cabeceraTabla();
  p.pasos.forEach((x, i) => {
    const r = e.pasos[x.id];
    const sub = [];
    if (x.zona) sub.push('Zona: ' + tituloZona(x.zona));
    if (x.ventana && x.ventana.evaluar)   sub.push('Ventana: ' + x.ventana.esperada + (x.ventana.obligatoria ? ' (imprescindible)' : ''));
    if (x.hallazgo && x.hallazgo.evaluar) sub.push('Hallazgo: ' + x.hallazgo.esperado + (x.hallazgo.obligatorio ? ' (imprescindible)' : ''));
    if (r.fueraDeOrden) sub.push('Fuera de orden');
    doc.setFontSize(10);
    const lt = doc.splitTextToSize(x.texto, cols[1].w - 2);
    doc.setFontSize(8);
    const ls = sub.flatMap(s => doc.splitTextToSize(s, cols[1].w - 2));
    const alto = lt.length * 4.4 + ls.length * 3.6 + 3;
    if (salto(alto + 2)) cabeceraTabla();

    const y0 = y;
    let xx = M;
    texto(String(i + 1), xx + 1, { tam: 10, color: GRIS }); xx += cols[0].w;
    lt.forEach((l, k) => { y = y0 + k * 4.4; texto(l, xx + 1, { tam: 10 }); });
    y = y0 + lt.length * 4.4 - 0.8;
    ls.forEach(l => { texto(l, xx + 1, { tam: 8, color: l === 'Fuera de orden' ? [122, 72, 0] : GRIS }); y += 3.6; });
    y = y0; xx += cols[1].w;
    const valores = [r.estado];
    if (tieneV) valores.push(x.ventana && x.ventana.evaluar ? r.ventana : undefined);
    if (tieneH) valores.push(x.hallazgo && x.hallazgo.evaluar ? r.hallazgo : undefined);
    valores.forEach((v, k) => {
      const [t, c] = txtRes(v);
      texto(t, xx + 1, { tam: 9, color: c, negrita: v === 'ok' || v === 'fallo' });
      xx += cols[2 + k].w;
    });
    texto(r.t != null ? mmss(r.t) : '', xx + 1, { tam: 9, color: GRIS });
    y = y0 + alto;
    doc.setDrawColor(230); doc.line(M, y - 3, M + W, y - 3);
    y += 1;
  });

  // Diagnóstico final
  const d = p.evaluacion && p.evaluacion.diagnostico;
  if (d && d.evaluar) {
    salto(20);
    y += 4;
    texto('Diagnóstico final', M, { tam: 12, negrita: true });
    y += 6;
    const [t, c] = txtRes(e.diagnostico);
    texto('Esperado: ' + d.esperado + (d.obligatorio ? ' (imprescindible)' : ''), M, { tam: 10 });
    texto(t, M + W, { tam: 10, color: c, negrita: true, align: 'right' });
    y += 6;
  }

  // Observaciones
  if (e.observaciones && e.observaciones.trim()) {
    doc.setFontSize(10);
    const lo = doc.splitTextToSize(e.observaciones.trim(), W);
    salto(14);
    y += 4;
    texto('Observaciones', M, { tam: 12, negrita: true });
    y += 6;
    lo.forEach(l => { salto(5); texto(l, M, { tam: 10 }); y += 4.6; });
  }

  // Pie en todas las páginas
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...GRIS);
    doc.text(`EcoApp SimIA · SIMIAlab · ISABIAL — Generado el ${fecha(new Date())}`, M, ALTO - 9);
    doc.text(`Página ${i} de ${n}`, M + W, ALTO - 9, { align: 'right' });
  }
  return doc;
}

// ════════════════════════════════════════════════════════════════
// SOCKET: mini vídeo, info del clip y presencia
// ════════════════════════════════════════════════════════════════
const miniVideo = $('mini-video');
const miniCapa  = $('mini-capa');

function cargarClipVideo(clip) {
  if (clip && clip.archivo) {
    miniCapa.style.display = 'none';
    if (miniVideo.getAttribute('src') !== clip.archivo) miniVideo.src = clip.archivo;
    miniVideo.play().catch(() => {});
  } else {
    miniVideo.pause();
    miniVideo.removeAttribute('src');
    miniVideo.load();
    miniCapa.textContent = 'Esperando imagen del instructor...';
    miniCapa.style.display = 'flex';
    $('mini-pausa').style.display = 'none';
  }
}

function pintarInfoClip() {
  const i = infoClipActual;
  if (i) {
    $('info-zona').textContent = i.zonaTitulo || tituloZona(i.zona);
    $('info-nombre').innerHTML = `${esc(i.nombre)} <span class="badge ${i.patologico ? 'badge-p' : 'badge-n'}">${i.patologico ? 'Patológico' : 'Normal'}</span>`;
  } else {
    $('info-zona').textContent = '—';
    $('info-nombre').textContent = 'Sin emisión';
  }
  if (ev && document.getElementById('pantalla-eval').classList.contains('visible')) renderPasos();
}

socket.on('estado-inicial', (estado) => {
  cargarClipVideo(estado.clip);
  if (estado.congelado) { miniVideo.pause(); $('mini-pausa').style.display = 'block'; }
  if (estado.negro) { miniCapa.textContent = 'Pantalla en negro'; miniCapa.style.display = 'flex'; }
});
socket.on('clip-cambiado', (clip) => cargarClipVideo(clip));
socket.on('imagen-congelada', (v) => {
  $('mini-pausa').style.display = v ? 'block' : 'none';
  if (v) miniVideo.pause(); else miniVideo.play().catch(() => {});
});
socket.on('pantalla-negra', (v) => {
  if (v) { miniCapa.textContent = 'Pantalla en negro'; miniCapa.style.display = 'flex'; }
  else if (miniVideo.getAttribute('src')) miniCapa.style.display = 'none';
});

socket.on('info-clip', (info) => {
  const esNuevo = info && (!infoClipActual || info.t !== infoClipActual.t);
  infoClipActual = info;
  if (esNuevo && ev && !ev.finalizada) {
    ev.clipsEmitidos.push({ t: ev.seg, zona: info.zona, zonaTitulo: info.zonaTitulo, nombre: info.nombre, patologico: info.patologico });
    autoMarcar(info);
    guardarLocal();
  }
  pintarInfoClip();
});

socket.on('presencia-sala', (p) => {
  $('dot-control').classList.toggle('on', !!p.control);
  $('dot-eco').classList.toggle('on', !!p.eco);
});

socket.on('sesion-cerrada', () => {
  if (ev && !ev.finalizada) $('aviso-cerrada').style.display = '';
  else window.location.href = '/?sala=' + encodeURIComponent(sala);
});

$('btn-salir').addEventListener('click', () => {
  if (ev && !ev.finalizada &&
      !confirm('¿Salir? La evaluación queda guardada en este dispositivo y podrás continuarla al volver a esta sala.')) return;
  window.location.href = '/?sala=' + encodeURIComponent(sala);
});

// ── Arrancar ───────────────────────────────────────────────────────
pintarInfoClip();
cargarDatos();
