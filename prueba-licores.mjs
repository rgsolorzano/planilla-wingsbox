/* PRUEBA DEL MODELO DE INVENTARIO FÍSICO DIARIO DE LICORES
   ---------------------------------------------------------------------------
   Ejercita los escenarios del pedido contra la app real: se carga index.html
   en un navegador headless, se siembra el estado y se lee lo que la pantalla
   termina mostrando. No se reimplementa ninguna fórmula; si el cálculo
   cambiara, esta prueba lo vería.

   Uso:  node nucleo/prueba-licores.mjs [ruta/index.html]
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

const resultado = await page.evaluate(() => {
  const OZB = 25;                       // onzas por botella de los licores de prueba
  const lic = (id, nombre) => ({ id, nombre, tamanoMl: 750, ozPorBotella: OZB });
  // Un inventario físico: botellas + onzas sueltas.
  const inv = (bebidaId, fecha, bots, ozs) => ({
    id: 'r-' + bebidaId + '-' + fecha, bebidaId, fecha,
    entradaBots: bots, entradaOzs: ozs, salidaBots: 0, salidaOzs: 0 });
  // Una fila heredada en la que solo se registró la salida.
  const soloSalida = (bebidaId, fecha, bots, ozs) => ({
    id: 's-' + bebidaId + '-' + fecha, bebidaId, fecha,
    entradaBots: 0, entradaOzs: 0, salidaBots: bots, salidaOzs: ozs });

  S.licores = [lic('L1', 'ALFA'), lic('L2', 'BETA'), lic('L3', 'GAMMA')];
  S.invLicores = [
    inv('L1', '2026-03-01', 4, 0),    // 100 oz
    inv('L1', '2026-03-02', 3, 0),    //  75 oz
    inv('L1', '2026-03-03', 2, 10),   //  60 oz
    inv('L1', '2026-03-04', 2, 20),   //  70 oz
    inv('L2', '2026-03-01', 2, 0),    //  50 oz · sin conteo el 02
    inv('L2', '2026-03-03', 1, 5),    //  30 oz
    soloSalida('L3', '2026-03-01', 2, 5),
  ];

  const pruebas = [];
  const comp = (nombre, obtenido, esperado) => pruebas.push({
    nombre, obtenido: String(obtenido), esperado: String(esperado),
    pasa: String(obtenido) === String(esperado) });

  /* ── Lectura de la tabla del cotejo ──────────────────────────────────── */
  const render = (ini, fin) => {
    cotejoLicFechaIni = ini; cotejoLicFechaFin = fin;
    RENDERERS.cotejoLicores();
    const tabla = document.querySelector('#page-cotejoLicores .cotejo-table');
    const filas = {};
    tabla.querySelectorAll('tbody tr').forEach(tr => {
      const c = [...tr.children].map(td => td.textContent.trim());
      filas[c[0]] = c.slice(1);
    });
    const avisoEl = document.querySelector('#page-cotejoLicores .card[style*="f59e0b"]');
    const diasVisibles = tabla.querySelectorAll('thead tr:first-child th').length - 3;
    return { filas, aviso: !!avisoEl, diasVisibles,
             encabezado: document.querySelector('#page-cotejoLicores .page-head p').textContent };
  };

  /* ── Escenarios del pedido ───────────────────────────────────────────── */
  // Rango 01→03: el consumo del 03 se cierra con el inventario del 04.
  let r = render('2026-03-01', '2026-03-03');
  // Por fila: [bot,oz,consumo] × 3 días, luego acumulado y total.
  const alfa = r.filas['ALFA'];
  comp('El inventario baja de 100 a 75 oz → consumo 25', alfa[2], '25.0');
  comp('El inventario baja de 75 a 60 oz → consumo 15',  alfa[5], '15.0');
  comp('El inventario sube de 60 a 70 oz → consumo −10', alfa[8], '-10.0');
  comp('Consumo acumulado = suma de los diarios (25+15−10)', alfa[9], '30.0 oz');
  comp('Consumo total = Inv(01/03) − Inv(04/03) = 100−70', alfa[10], '30.0 oz');
  comp('Acumulado y total coinciden cuando no falta ningún inventario',
       alfa[9], alfa[10]);
  comp('El inventario se muestra como se registró (4 botellas, 0 oz)',
       alfa[0] + '|' + alfa[1], '4|0');
  comp('El día de referencia (04/03) no se muestra como columna', r.diasVisibles, 3);
  comp('No se advierte nada cuando el inventario de referencia existe', r.aviso, false);

  const beta = r.filas['BETA'];
  comp('Falta el inventario del día siguiente → consumo no disponible', beta[2], '—');
  comp('Un inventario faltante no se asume cero (día sin conteo)', beta[3] + '|' + beta[4], '—|—');
  comp('Sin ningún consumo calculable, el acumulado queda en guion', beta[9], '—');

  const gamma = r.filas['GAMMA'];
  comp('Una fila heredada de solo salida no es inventario cero', gamma[0], '—');
  comp('…y por tanto no produce consumo', gamma[2], '—');

  // Rango 01→04: no hay inventario del 05, el último día no cierra.
  r = render('2026-03-01', '2026-03-04');
  const alfa2 = r.filas['ALFA'];
  comp('Sin el inventario posterior, el último día queda en guion', alfa2[11], '—');
  comp('…y el consumo total del periodo queda no disponible', alfa2[13], '—');
  comp('…y la pantalla lo advierte', r.aviso, true);
  comp('El acumulado sigue sumando solo los días calculables', alfa2[12], '30.0 oz');
  comp('El rango no se amplía visualmente', r.diasVisibles, 4);

  /* ── Registro: actualizar no duplica y no borra la salida histórica ──── */
  S.invLicores.push(soloSalida('L1', '2026-03-10', 1, 7));
  invLicorUpsert('L1', '2026-03-10', 3, 12);
  const delDia = S.invLicores.filter(x => x.bebidaId === 'L1' && x.fecha === '2026-03-10');
  comp('Guardar de nuevo el mismo día actualiza sin duplicar', delDia.length, 1);
  comp('…y conserva la salida histórica del registro', delDia[0].salidaBots + '|' + delDia[0].salidaOzs, '1|7');
  comp('…y deja el inventario físico recién tomado', invFisicoLicor('L1', delDia[0]), 3 * OZB + 12);

  invLicorUpsert('L2', '2026-03-20', 0, 0);
  const cero = S.invLicores.find(x => x.bebidaId === 'L2' && x.fecha === '2026-03-20');
  comp('Un inventario de cero registrado sí vale cero (no es "sin dato")',
       invFisicoLicor('L2', cero), 0);

  /* ── La pantalla de registro ya no pide salidas ──────────────────────── */
  invLicoresFecha = '2026-03-01';
  RENDERERS.invDiarioLicores();
  const reg = document.getElementById('page-invDiarioLicores');
  comp('La pantalla de registro ya no muestra campos de salida',
       reg.querySelectorAll('.invLicSalOz, .invLicSalBot').length, 0);
  comp('…y pide botellas y onzas por licor',
       reg.querySelectorAll('.invLicBot').length + '|' + reg.querySelectorAll('.invLicOz').length,
       '3|3');
  comp('…y conserva los botones de guardar y exportar',
       !!document.getElementById('invLicGuardar') && !!document.getElementById('invLicExport'), true);

  return pruebas;
});

await browser.close();

const ancho = Math.max(...resultado.map(p => p.nombre.length));
let fallan = 0;
for (const p of resultado) {
  if (!p.pasa) fallan++;
  console.log(`${p.pasa ? '  ok ' : 'FALLA'} · ${p.nombre.padEnd(ancho)} · ${p.obtenido}` +
              (p.pasa ? '' : `   (esperado: ${p.esperado})`));
}
if (errores.length) { console.log('\nErrores de página:'); errores.forEach(e => console.log('  ' + e)); }
if (!resultado.length) { console.log('\nABORTA: no se ejecutó ninguna comprobación'); process.exit(1); }
console.log(`\n${resultado.length - fallan} de ${resultado.length} comprobaciones ` +
            (fallan ? `· ${fallan} FALLAN` : '· TODAS PASARON'));
process.exit(fallan || errores.length ? 1 : 0);
