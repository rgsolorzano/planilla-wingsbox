/* PRUEBA · Guardar un insumo tiene que llegar al Spreadsheet
   ---------------------------------------------------------------------------
   Lo que falló con SALCHICHA VIENESSA: renombrar un insumo guardaba en el
   navegador y nunca sincronizaba, porque la sincronización vivía solo en el
   botón "Actualizar" de la tabla de abajo. El cambio se veía en pantalla, la
   hoja seguía igual, y nadie se enteraba hasta cotejar.

   Aquí se carga la app real, se sustituye gsSaveSheet por un espía y se
   comprueba que CADA acción sobre un insumo —crear, renombrar, eliminar,
   reordenar— termina escribiendo la pestaña Insumos.

   Uso:  node nucleo/prueba-insumos-guardar.mjs [ruta/index.html]
*/
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');

const APP = 'file://' + (process.argv[2] || '/home/claude/w/index.html');

const browser = await chromium.launch();
const page = await browser.newPage();
const errores = [];
page.on('pageerror', e => errores.push(String(e.message).slice(0, 300)));
await page.goto(APP, { waitUntil: 'load' });
await page.waitForTimeout(400);

const pruebas = await page.evaluate(async () => {
  const r = [];
  const comp = (nombre, obtenido, esperado) => r.push({
    nombre, obtenido: String(obtenido), esperado: String(esperado),
    pasa: String(obtenido) === String(esperado) });

  /* El espía: anota qué pestañas se mandaron a guardar y responde que sí. */
  let enviadas = [];
  /* Sin sesión de Google, _syncSheetConfirmado ni siquiera intenta escribir
     —devuelve "Sesión no autorizada"— así que hay que fingir la sesión para
     poder observar la escritura. */
  window.isAuthorized = () => true;
  isAuthorized = window.isAuthorized;
  const original = window.gsSaveSheet;
  window.gsSaveSheet = async (dominio, hoja) => { enviadas.push(dominio + '/' + hoja); return true; };
  // Las funciones internas capturaron la referencia original, así que se
  // sustituye también ahí donde se resuelve por nombre global.
  gsSaveSheet = window.gsSaveSheet;

  S.insumos = [];
  const desde = () => { enviadas = []; };

  /* ── Crear ─────────────────────────────────────────────────────────── */
  RENDERERS.insumos();
  document.getElementById('insNombre').value = 'ZZ Prueba';
  document.getElementById('insUnidad').value = 'kg';
  desde();
  await insumoSave();
  comp('crear un insumo lo sincroniza', enviadas.join(','), 'inventario/Insumos');
  comp('…y queda en el estado', S.insumos.length, 1);

  /* ── Renombrar: el caso de la salchicha ────────────────────────────── */
  const id = S.insumos[0].id;
  editInsumoId = id;
  RENDERERS.insumos();
  document.getElementById('insNombre').value = 'ZZ Prueba (Bolsa)';
  document.getElementById('insUnidad').value = 'kg';
  desde();
  await insumoSave();
  comp('renombrar lo sincroniza', enviadas.join(','), 'inventario/Insumos');
  comp('…y el nombre nuevo está en el estado', S.insumos[0].nombre, 'ZZ Prueba (Bolsa)');

  /* ── Reordenar: ya sincronizaba por su cuenta, dentro de insumoMover ── */
  S.insumos.push({ id:'zz2', nombre:'ZZ Segundo', unidad:'kg', orden:1 });
  S.insumos[0].orden = 0;
  desde();
  insumoBajar(id);
  await new Promise(res => setTimeout(res, 50));
  comp('mover un insumo lo sincroniza', enviadas.join(','), 'inventario/Insumos');

  /* ── Eliminar ──────────────────────────────────────────────────────── */
  window.confirm = () => true;
  desde();
  await insumoDel('zz2');
  comp('eliminar lo sincroniza', enviadas.join(','), 'inventario/Insumos');

  /* ── Y el guardado bloqueado NO se anuncia como éxito ──────────────── */
  window.gsSaveSheet = original; gsSaveSheet = original;
  const avisos = [];
  const toastOrig = window.toast;
  window.toast = (m, t) => avisos.push((t || '') + ':' + m);
  toast = window.toast;
  try { localStorage.setItem('wb_fuente', 'base'); } catch(e) {}
  desde();
  await insumosGuardarYSincronizar('Insumo actualizado');
  comp('leyendo de la base, avisa que NO se sincronizó',
       avisos.some(a => a.startsWith('error:') && /NO llegó a Google Sheets/.test(a)), true);
  comp('…y no dice que se sincronizó',
       avisos.some(a => /y sincronizado/.test(a)), false);
  try { localStorage.setItem('wb_fuente', 'sheets'); } catch(e) {}
  window.toast = toastOrig; toast = toastOrig;

  return r;
});

await browser.close();

const ancho = Math.max(...pruebas.map(p => p.nombre.length));
let fallan = 0;
for (const p of pruebas) {
  if (!p.pasa) fallan++;
  console.log(`${p.pasa ? '  ok ' : 'FALLA'} · ${p.nombre.padEnd(ancho)} · ${p.obtenido}` +
              (p.pasa ? '' : `   (esperado: ${p.esperado})`));
}
if (errores.length) { console.log('\nErrores de página:'); errores.forEach(e => console.log('  ' + e)); }
if (!pruebas.length) { console.log('\nABORTA: no se ejecutó ninguna comprobación'); process.exit(1); }
console.log(`\n${pruebas.length - fallan} de ${pruebas.length} comprobaciones ` +
            (fallan ? `· ${fallan} FALLAN` : '· TODAS PASARON'));
process.exit(fallan || errores.length ? 1 : 0);
