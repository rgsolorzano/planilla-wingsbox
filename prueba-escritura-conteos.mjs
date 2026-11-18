/* PRUEBA · La escritura de conteos en PostgreSQL
   ---------------------------------------------------------------------------
   Comprueba que lo que sale de la pantalla hacia core.guardar_conteo lleva de
   verdad las tres defensas, y que lo que vuelve se le cuenta al usuario como
   es. Se sustituye el escritor por un espía: lo que se verifica es la llamada
   que la app construye, no la base, que ya tiene sus propias 16 pruebas.

   Uso:  node nucleo/prueba-escritura-conteos.mjs [ruta/index.html]
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

  /* ── El doble del lector: traduce ids y recuerda versiones ──────────── */
  const versiones = new Map([['salp_guantes|2026-11-18|Paquete', 7]]);
  _sbLectorInv = {
    uuidDe: id => id === 'desconocido' ? null : 'uuid-' + id,
    versionDe: (id, f, u) => versiones.get(`${id}|${f}|${u ?? ''}`) ?? null,
    anotarVersion: (id, f, u, v) => versiones.set(`${id}|${f}|${u ?? ''}`, v),
  };

  /* ── El espía del escritor: anota la llamada y responde lo que se le diga ── */
  let llamadas = [];
  let respuesta = () => ({ estado: 'creado', id: 'x', version: 1 });
  _sbEscritor = { guardarConteo: async p => { llamadas.push(p); return respuesta(p); } };
  const desde = () => { llamadas = []; };

  /* ══ 1 · La llamada que se construye ════════════════════════════════ */
  desde();
  respuesta = () => ({ estado: 'actualizado', id: 'x', version: 8 });
  let res = await sbGuardarConteos([
    { productoId:'salp_guantes', fecha:'2026-11-18', unidad:'Paquete', cantidad:50 },
    { productoId:'salp_ketchup', fecha:'2026-11-18', unidad:'Caja',    cantidad:2  },
  ]);
  comp('se manda una llamada por celda cambiada', llamadas.length, 2);
  comp('el id del Spreadsheet se traduce a uuid', llamadas[0].articuloId, 'uuid-salp_guantes');
  comp('viaja la versión que el lector conocía', llamadas[0].version, 7);
  comp('una celda sin versión conocida viaja en null', llamadas[1].version, null);

  const [a0, a1] = llamadas.map(l => l.clave.split(':')[0]);
  comp('la clave de idempotencia es UNA por acción', a0 === a1, true);
  comp('…y cada celda cuelga de ella', llamadas[0].clave.endsWith(':salp_guantes:Paquete'), true);
  comp('el resultado cuenta las actualizaciones', res.actualizados, 2);

  /* La versión nueva queda anotada: si no, el siguiente guardado del mismo
     día llegaría con la vieja y la base lo rechazaría. */
  desde();
  await sbGuardarConteos([{ productoId:'salp_guantes', fecha:'2026-11-18', unidad:'Paquete', cantidad:51 }]);
  comp('tras guardar, la versión anotada es la nueva', llamadas[0].version, 8);

  /* Dos acciones distintas no comparten clave: son dos guardados de verdad. */
  const clave1 = llamadas[0].clave.split(':')[0];
  desde();
  await sbGuardarConteos([{ productoId:'salp_guantes', fecha:'2026-11-18', unidad:'Paquete', cantidad:52 }]);
  comp('dos clics distintos usan claves distintas',
       llamadas[0].clave.split(':')[0] !== clave1, true);

  /* ══ 2 · Nada que mandar ════════════════════════════════════════════ */
  desde();
  res = await sbGuardarConteos([]);
  comp('sin celdas cambiadas no se llama a la base', llamadas.length, 0);
  comp('…y se considera correcto', res.ok, true);

  /* ══ 3 · Lo que vuelve mal NO se anuncia como éxito ═════════════════ */
  respuesta = () => ({ estado:'conflicto', motivo:'alguien más lo modificó mientras lo editabas' });
  res = await sbGuardarConteos([{ productoId:'salp_guantes', fecha:'2026-11-18', unidad:'Paquete', cantidad:9 }]);
  comp('un conflicto marca el resultado como fallido', res.ok, false);
  let t = sbExplicarConteos(res, 'Inventario de salón');
  comp('…el aviso es de error', t.tipo, 'error');
  comp('…y dice que recargue', /Recarga/.test(t.msg), true);

  respuesta = () => ({ estado:'denegado', accion:'actualizar' });
  res = await sbGuardarConteos([{ productoId:'salp_ketchup', fecha:'2026-11-18', unidad:'Caja', cantidad:9 }]);
  t = sbExplicarConteos(res, 'Inventario de salón');
  comp('un denegado habla de permiso, no de otra cosa', /permiso/.test(t.msg), true);

  respuesta = () => ({ estado:'error', mensaje:'network' });
  res = await sbGuardarConteos([{ productoId:'salp_ketchup', fecha:'2026-11-18', unidad:'Caja', cantidad:9 }]);
  comp('un error de red tampoco pasa por éxito', sbExplicarConteos(res,'x').tipo, 'error');

  /* Un artículo que la base no conoce no se traga en silencio. */
  desde();
  respuesta = () => ({ estado:'creado', id:'x', version:1 });
  res = await sbGuardarConteos([{ productoId:'desconocido', fecha:'2026-11-18', unidad:'Caja', cantidad:1 }]);
  comp('un artículo inexistente no se manda', llamadas.length, 0);
  comp('…y se reporta', res.ok, false);

  /* ══ 4 · La pantalla manda SOLO lo que cambió ═══════════════════════ */
  S.salonProductos = [{ id:'salp_guantes', nombre:'Guantes', unidades:['Paquete'] },
                      { id:'salp_ketchup', nombre:'Ketchup', unidades:['Caja'] }];
  S.salonInventario = [{ id:'r1', productoId:'salp_guantes', fecha:'2026-11-18', unidad:'Paquete', cantidad:50 }];
  salonFecha = '2026-11-18';
  try { localStorage.setItem('wb_fuente','base'); } catch(e){}
  RENDERERS.invDiarioSalon();
  // Guantes se deja igual (50) y Ketchup se escribe por primera vez.
  document.querySelectorAll('.salon-inp').forEach(inp => {
    if(inp.dataset.prod === 'salp_guantes') inp.value = '50';
    if(inp.dataset.prod === 'salp_ketchup') inp.value = '3';
  });
  desde();
  await document.getElementById('salonGuardar').onclick.call(document.getElementById('salonGuardar'));
  comp('la pantalla manda solo la celda que cambió', llamadas.length, 1);
  comp('…y es la correcta', llamadas[0].articuloId, 'uuid-salp_ketchup');

  /* ══ 5 · Menaje: rotas y rajadas tienen que llegar ══════════════════ */
  S.menajeArticulos = [{ id:'menj_vasos', nombre:'Vasos' }];
  S.menajeInventario = [];
  menajeFecha = '2026-11-18';
  RENDERERS.invDiarioMenaje();
  const pon = (campo, v) => {
    const el = document.querySelector(`.menaje-inp[data-art="menj_vasos"][data-campo="${campo}"]`);
    if(el) el.value = v;
  };
  pon('total', '20'); pon('rotas', '2'); pon('rajadas', '1');
  desde();
  await document.getElementById('menajeGuardar').onclick.call(document.getElementById('menajeGuardar'));
  comp('menaje manda la celda nueva', llamadas.length, 1);
  comp('…con las rotas', llamadas[0]?.rotas, 2);
  comp('…y las rajadas', llamadas[0]?.rajadas, 1);

  /* Volver a guardar lo mismo no manda nada. */
  desde();
  await document.getElementById('menajeGuardar').onclick.call(document.getElementById('menajeGuardar'));
  comp('guardar menaje sin cambios no llama a la base', llamadas.length, 0);

  /* ══ 6 · Cocina: el borrado se avisa, no se finge ═══════════════════ */
  const avisos = [];
  const toastOrig = window.toast;
  window.toast = (m, t) => avisos.push((t || '') + ':' + m);
  toast = window.toast;

  S.cocinaProductos = [{ id:'coc_sal', nombre:'Sal', unidad:'bolsa 1kg' }];
  S.cocinaInventario = [{ id:'ci1', productoId:'coc_sal', fecha:'2026-11-18', cantidad: 5 }];
  cocinaFecha = '2026-11-18';
  RENDERERS.invDiarioCocina();
  document.querySelectorAll('.cocina-inp').forEach(i => { i.value = ''; });   // vaciar = borrar
  desde();
  await document.getElementById('cocGuardar').onclick.call(document.getElementById('cocGuardar'));
  comp('al borrar en cocina se avisa que la base no lo aplica',
       avisos.some(a => a.startsWith('error:') && /borrado todav/.test(a)), true);
  comp('…y no se anuncia como guardado correcto',
       avisos.some(a => a.startsWith('success:')), false);
  window.toast = toastOrig; toast = toastOrig;

  try { localStorage.setItem('wb_fuente','sheets'); } catch(e){}

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
