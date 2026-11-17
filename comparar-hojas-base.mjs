/* COMPARADOR · Spreadsheet contra PostgreSQL
   ---------------------------------------------------------------------------
   Reconstruye las pestañas desde la base con los mismos adaptadores que usa
   la app y las coteja contra una exportación del Spreadsheet, emparejando por
   la clave REAL de cada pestaña (la misma que usa gsClaveDe en index.html),
   no por posición.

   Por qué emparejar por clave y no comparar conjuntos: un conjunto solo sabe
   decir "sobra" y "falta". Con la clave se distinguen tres cosas distintas,
   y la tercera es la que importa:

     · solo en la hoja  → días nuevos que todavía no se cargaron
     · solo en la base  → filas que alguien borró del Spreadsheet
     · DISTINTAS        → la misma fila con otro valor a cada lado

   Las "distintas" son el punto ciego del cargador. Carga con
   `on conflict do nothing`, que es lo correcto para no duplicar, pero
   significa que una fila CORREGIDA en el Spreadsheet después de la primera
   carga se queda vieja en la base y nadie se entera. Volver a correr la carga
   no las arregla: hay que verlas primero y decidir.

   Uso:
     node nucleo/comparar-hojas-base.mjs datos/hojas-inventario.json
     node nucleo/comparar-hojas-base.mjs datos/hojas-inventario.json --detalle SalonInventario
*/
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { crearLectorInventario } from '../datos-inventario.mjs';

const ARCHIVO = process.argv[2];
const DETALLE = process.argv.includes('--detalle')
  ? process.argv[process.argv.indexOf('--detalle') + 1] : null;
if (!ARCHIVO) { console.error('Falta la exportación. Uso: node nucleo/comparar-hojas-base.mjs <hojas.json>'); process.exit(2); }

const env = { ...process.env, PGHOST: process.env.PGHOST || '/tmp/pgrun',
                              PGPORT: process.env.PGPORT || '5433' };
const BASE = process.env.PGDATABASE || 'wingsbox';

/* PostgREST permite pedir una tabla relacionada como "empleados!inner(col)".
   psql no, así que se traduce a una subconsulta de la misma forma, resolviendo
   la clave foránea por el nombre en singular: empleados → empleado_id. */
function traducir(select, tabla){
  let filtro = '';
  const cols = select.replace(/(\w+)!inner\(([^)]*)\)/g, (_, rel, campos) => {
    const fk = rel.replace(/s$/, '') + '_id';
    const lista = campos.split(',').map(c => `'${c.trim()}', r.${c.trim()}`).join(', ');
    filtro += ` and core.${tabla}.${fk} is not null`;
    return `(select jsonb_build_object(${lista}) from core.${rel} r `
         + `where r.id = core.${tabla}.${fk}) as ${rel}`;
  });
  return [cols, filtro ? ' where true' + filtro : ''];
}

const lit = v => typeof v === 'boolean' ? String(v)
              : typeof v === 'number' ? String(v)
              : `'${String(v).replace(/'/g, "''")}'`;

function consultar(tabla, { select = '*', order, igual } = {}){
  const [cols, donde] = traducir(select, tabla);
  /* El filtro `igual` NO es opcional de implementar. El adaptador lo usa para
     pedir solo los meseros; ignorarlo devolvía los 24 empleados y el informe
     acusaba de una diferencia que no existía. */
  let filtro = donde;
  if(igual) for(const [col, val] of Object.entries(igual))
    filtro += (filtro ? ' and ' : ' where ') + `${col} = ${lit(val)}`;
  const sql = `select coalesce(json_agg(t), '[]') from (select ${cols} from core.${tabla}${filtro}`
            + (order ? ` order by ${order}` : '') + ') t';
  const out = execFileSync('psql', ['-U', 'wingsbox', '-d', BASE, '-tA', '-c', sql],
                           { env, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(out);
}

/* La identidad de cada pestaña, igual que GS_SHEET_KEYS en index.html. Si las
   dos listas se separan, este comparador diría que hay diferencias donde no
   las hay — o peor, las callaría. */
const CLAVES = {
  Insumos:['id'], Licores:['id'], BebidasCat:['id'],
  SalonProductos:['id'], MenajeArticulos:['id'], Empleados:['id'], Cocina:['id'],
  Marcaciones:['empleadoId','fecha'],
  Produccion:['insumoId','fecha'],
  ProduccionInsumos:['insumoId','fecha'],
  InvLicores:['bebidaId','fecha'],
  StockBebidas:['bebidaId','fecha'],
  SalonInventario:['productoId','fecha','unidad'],
  MenajeInventario:['articuloId','fecha'],
  MovCocina:['id'], MovBebidas:['id'], Propinas:['id'], Meseros:['id'],
  InvCocina:['productoId','fecha'],
  EfectivoCaja:['fecha'],
};

/* Pestañas que la base devuelve vacías a propósito: el catálogo de licores
   paralelo quedó abandonado y se decidió dejarlo fuera. Compararlas solo
   produciría ruido. */
const OMITIDAS = new Set(['Bebidas', 'InvBebidas', 'Meta']);

/* Hay columnas que dicen lo mismo con otro nombre, y compararlas en crudo
   acusa diferencias que no existen.

   Producción es el caso: la hoja arrastra las columnas legadas 'produccion' y
   'cierre'; la base guarda la forma nueva y el adaptador marca migradoV2 para
   que la app no vuelva a migrar. La app lee `stockCierre ?? cierre`
   (stockCierreDe en index.html), así que lo que hay que comparar es ese valor
   efectivo, no en qué columna está escrito. Sin esto el informe mostraba
   4,896 filas "distintas" que la app lee idénticas, y ese ruido tapaba las
   diferencias de verdad.

   La columna 'produccion' queda fuera por lo mismo: ya se migró a la pestaña
   ProduccionInsumos, que sí se compara por su cuenta. */
const EQUIVALENCIAS = {
  Produccion: (o, norm) => ({
    id: norm(o.id), insumoId: norm(o.insumoId), fecha: norm(o.fecha),
    stockInicial: norm(o.stockInicial),
    stockCierre: norm(o.stockCierre) !== '' ? norm(o.stockCierre) : norm(o.cierre),
  }),
};

/* Un valor "igual" a los dos lados puede llegar escrito distinto: la hoja
   devuelve 3 como "3" o como 3, y las fechas como serial o como 22/10/2026
   según el formato de la celda. Comparar sin normalizar produciría un informe
   lleno de diferencias falsas que taparían las de verdad. */
const norm = v => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  return /^-?\d+(\.\d+)?$/.test(s) ? String(Number(s)) : s;
};

const aObjetos = matriz => {
  if (!matriz || !matriz.length) return [];
  const cab = matriz[0];
  return matriz.slice(1).map(f => Object.fromEntries(cab.map((c, i) => [c, f[i]])));
};

const exportado = JSON.parse(readFileSync(ARCHIVO, 'utf-8')).hojas;
const reconstruido = await crearLectorInventario(consultar).leerInventario();

let totalFilas = 0, pestanasIguales = 0, totalDistintas = 0, totalSoloHoja = 0, totalSoloBase = 0;
const informe = [];

for (const hoja of Object.keys(exportado)) {
  if (!(hoja in reconstruido)) continue;            // pestaña que el adaptador no cubre
  if (OMITIDAS.has(hoja)) continue;
  const claves = CLAVES[hoja];
  const a = aObjetos(exportado[hoja]);
  const b = aObjetos(reconstruido[hoja]);
  totalFilas += Math.max(a.length, b.length);

  if (!claves) { informe.push({ hoja, sinClave: true, hojaN: a.length, baseN: b.length }); continue; }

  const clave = o => claves.map(c => norm(o[c])).join('\u0001');
  const mapaA = new Map(a.map(o => [clave(o), o]));
  const mapaB = new Map(b.map(o => [clave(o), o]));
  // Las columnas se comparan por intersección: si un lado trae una columna que
  // el otro no conoce, no es una diferencia de datos.
  const eq = EQUIVALENCIAS[hoja];
  const columnas = eq
    ? Object.keys(eq(a[0] || {}, norm))
    : (exportado[hoja][0] || []).filter(c => (reconstruido[hoja][0] || []).includes(c));
  const vista = o => eq ? eq(o, norm) : o;

  const soloHoja = [...mapaA.keys()].filter(k => !mapaB.has(k));
  const soloBase = [...mapaB.keys()].filter(k => !mapaA.has(k));
  const distintas = [];
  for (const [k, oa] of mapaA) {
    const ob = mapaB.get(k); if (!ob) continue;
    const va = vista(oa), vb = vista(ob);
    const campos = columnas.filter(c => norm(va[c]) !== norm(vb[c]));
    if (campos.length) distintas.push({ k, campos, oa: va, ob: vb });
  }

  totalSoloHoja += soloHoja.length; totalSoloBase += soloBase.length; totalDistintas += distintas.length;
  if (!soloHoja.length && !soloBase.length && !distintas.length) { pestanasIguales++; continue; }
  informe.push({ hoja, hojaN: a.length, baseN: b.length, soloHoja, soloBase, distintas, claves });
}

/* ── Salida ──────────────────────────────────────────────────────────────── */
const kv = k => k.replace(/\u0001/g, ' · ');
for (const r of informe) {
  if (r.sinClave) { console.log(`\n■ ${r.hoja} — sin clave definida, no se compara (hoja ${r.hojaN} · base ${r.baseN})`); continue; }
  console.log(`\n■ ${r.hoja}  ·  hoja ${r.hojaN} filas · base ${r.baseN} filas  ·  clave: ${r.claves.join(' + ')}`);
  if (r.soloHoja.length) {
    console.log(`   ${r.soloHoja.length} solo en la hoja (faltan por cargar)`);
    r.soloHoja.slice(0, 5).forEach(k => console.log('      ' + kv(k)));
    if (r.soloHoja.length > 5) console.log(`      … y ${r.soloHoja.length - 5} más`);
  }
  if (r.soloBase.length) {
    console.log(`   ${r.soloBase.length} solo en la base (borradas del Spreadsheet, o ya corregidas aquí)`);
    r.soloBase.slice(0, 5).forEach(k => console.log('      ' + kv(k)));
    if (r.soloBase.length > 5) console.log(`      … y ${r.soloBase.length - 5} más`);
  }
  if (r.distintas.length) {
    console.log(`   ${r.distintas.length} DISTINTAS — misma fila, otro valor. El cargador NO las corrige:`);
    for (const d of r.distintas.slice(0, 8)) {
      const det = d.campos.map(c => `${c}: hoja=${norm(d.oa[c]) || '∅'} base=${norm(d.ob[c]) || '∅'}`).join(' · ');
      console.log(`      ${kv(d.k)} → ${det}`);
    }
    if (r.distintas.length > 8) console.log(`      … y ${r.distintas.length - 8} más`);
  }
  if (DETALLE === r.hoja) {
    console.log('   ── detalle completo ──');
    r.distintas.forEach(d => console.log('      ' + kv(d.k) + ' → ' +
      d.campos.map(c => `${c}: hoja=${norm(d.oa[c])} base=${norm(d.ob[c])}`).join(' · ')));
  }
}

if (!totalFilas) { console.log('\nABORTA: no se comparó ninguna fila. Revisa que la base esté en pie.'); process.exit(1); }
console.log(`\n${pestanasIguales} de ${pestanasIguales + informe.length} pestañas idénticas · ${totalFilas} filas cotejadas`);
console.log(`faltan por cargar: ${totalSoloHoja} · solo en la base: ${totalSoloBase} · DISTINTAS: ${totalDistintas}`);
if (totalDistintas) console.log('\nLas DISTINTAS necesitan decisión: volver a correr la carga no las cambia.');
