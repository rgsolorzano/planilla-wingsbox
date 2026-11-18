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
import { crearLector } from '../datos-supabase.mjs';

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
/* Qué columna une una tabla con otra. Se lee del catálogo de PostgreSQL en
   vez de deducirla del nombre: condiciones_laborales se une por condicion_id,
   que ninguna regla de singularizar acierta. */
const _fks = new Map();
function fkDe(tabla, relacion){
  const llave = tabla + '→' + relacion;
  if(!_fks.has(llave)){
    const sql = `select a.attname from pg_constraint c
      join unnest(c.conkey) k on true
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
      where c.contype = 'f' and c.conrelid = 'core.${tabla}'::regclass
        and c.confrelid = 'core.${relacion}'::regclass limit 1`;
    const out = execFileSync('psql', ['-U','wingsbox','-d',BASE,'-tA','-c',sql],
                             { env, encoding: 'utf-8' }).trim();
    if(!out) throw new Error(`No hay clave foránea de core.${tabla} a core.${relacion}`);
    _fks.set(llave, out);
  }
  return _fks.get(llave);
}

/* PostgREST permite pedir una tabla relacionada como "empleados!inner(col)" o
   "condiciones_laborales(col)". psql no, así que se traduce a una subconsulta
   de la misma forma. El sufijo !inner exige que la relación exista; sin él, la
   fila sale igual y el anidado viene en null, como en PostgREST. */
function traducir(select, tabla){
  let filtro = '';
  const cols = select.replace(/(\w+)(!inner)?\(([^)]*)\)/g, (_, rel, inner, campos) => {
    const fk = fkDe(tabla, rel);
    const lista = campos.split(',').map(c => `'${c.trim()}', r.${c.trim()}`).join(', ');
    if(inner) filtro += ` and core.${tabla}.${fk} is not null`;
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
  /* Planilla. Las pestañas que NO figuran en GS_SHEET_KEYS caen en ['id'] del
     lado de la app, así que esa es su identidad real y así se comparan. Donde
     la hoja no tiene columna id se usa su clave natural. */
  Descuentos:['id'], PagosExtra:['id'], DiasLibres:['id'],
  Horarios:['empleadoId','dia'],
  ValidacionTarjeta:['fecha'],
  ConsiderarHoraExtra:['empleadoId','fecha'],
  ExoneracionTardanza:['empleadoId','fecha'],
};

/* Pestañas que la base devuelve vacías a propósito: el catálogo de licores
   paralelo quedó abandonado y se decidió dejarlo fuera. Compararlas solo
   produciría ruido. */
const OMITIDAS = new Set(['Bebidas', 'InvBebidas', 'Meta', 'Resumen']);

/* Propinas vive en el Spreadsheet de inventario; el de planilla arrastra una
   copia antigua y más corta que la app lee pero no mantiene. El adaptador
   devuelve la única propina que hay en la base para las dos lecturas, así que
   cotejarla contra la copia vieja solo mediría lo atrasada que está esa copia.
   Se compara en el informe de inventario, que es su sitio. */
const OMITIDAS_PLANILLA = new Set(['Propinas']);

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
/* Columnas que no se comparan porque la app tampoco las mira.

   Marcaciones es el caso: su identidad para la app es (empleado, fecha), no
   el id — está escrito así en GS_SHEET_KEYS y con el motivo al lado, porque
   la app regenera los ids al reemplazar y compararlos duplicaba la hoja
   entera. La base tampoco guarda el id original, así que el adaptador emite
   el suyo. Da igual para quien la usa.

   Ojo: esto NO vale para DiasLibres. Esa pestaña no figura en GS_SHEET_KEYS,
   así que la app cae en ['id'] y ahí el id SÍ es la identidad. */
const IGNORAR = { Marcaciones: ['id'] };

/* Los siete productos de salón que tenían dos fichas en el catálogo. Se
   fusionaron el 16/11 y la base guarda su historia bajo el id vigente; el
   Spreadsheet todavía usa los dos. El cargador hace esta misma traducción al
   cargar (FUSIONADOS en cargar_historico.py), así que aquí se aplica al lado
   de la hoja antes de emparejar: sin esto el informe acusa 1,313 filas de
   diferencia que en realidad son las mismas. */
const FUSIONADOS = {
  mrjtgjpcd4ev5: 'salp_canas_grandes', mrjtgjpc3xw6o: 'salp_canas_pequenas',
  mrjtgjpc920c1: 'salp_guantes',       mrjtgjpce1ez8: 'salp_ketchup',
  mrjtgjpc2bwur: 'salp_mayonesa',      mrjtgjpc8m0dy: 'salp_mostaza',
  mrjtgjpcxeoh5: 'salp_removedores',
};
const COL_PRODUCTO = { SalonProductos: 'id', SalonInventario: 'productoId' };

/* Diferencias que YA se decidieron y no son hallazgos. Se listan aparte para
   que el informe distinga "esto lo decidimos" de "esto es nuevo". Cada una
   lleva la razón, porque dentro de seis meses nadie se acordará. */
const ESPERADAS = [
  { hoja:'Insumos', clave:/^(mwdu7lq8mf692|mwdu7sia6vxyj)$/, campos:['nombre'],
    razon:'SALCHICHA VIENESSA (Bolsa)/(Pqt): el renombre está en la base y la hoja aún no lo refleja' },
  { hoja:'InvLicores', clave:/·2026-10-22$/, campos:['salidaOzs','salidaBots'],
    razon:'salidas del 22/10 corregidas en la base; la columna ya no entra en ningún cálculo' },
  { hoja:'Licores', soloBase:/^mqpras04a0psu$/,
    razon:'PISCO GALPON: salió del catálogo de la hoja y se desactivó conservando sus 143 movimientos' },
];

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
/* Un JSON con las mismas claves en otro orden es el mismo dato. La columna
   'condiciones' de Empleados lo traía escrito distinto a cada lado —esLibre
   antes o después del sueldo— y eso acusaba 18 empleados "distintos" que son
   idénticos. Se reescribe en forma canónica antes de comparar. */
const canonico = x => Array.isArray(x) ? x.map(canonico)
  : (x && typeof x === 'object')
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonico(x[k])]))
    : x;

const norm = v => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  const s = String(v).trim();
  if (s.startsWith('[') || s.startsWith('{')) {
    try { return JSON.stringify(canonico(JSON.parse(s))); } catch { /* no era JSON */ }
  }
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

/* Qué adaptador reconstruye estas pestañas. Se decide por el contenido del
   archivo y no por su nombre: un archivo renombrado seguiría comparándose
   bien. */
const esPlanilla = 'Marcaciones' in exportado || 'Horarios' in exportado;
const reconstruido = esPlanilla
  ? await crearLector(consultar).leerPlanilla()
  : await crearLectorInventario(consultar).leerInventario();
console.log(`Comparando ${esPlanilla ? 'PLANILLA' : 'INVENTARIO'} · ${ARCHIVO}`);

const yaDecididas = [];
let totalFilas = 0, pestanasIguales = 0, totalDistintas = 0, totalSoloHoja = 0, totalSoloBase = 0;
const informe = [];

for (const hoja of Object.keys(exportado)) {
  if (!(hoja in reconstruido)) continue;            // pestaña que el adaptador no cubre
  if (OMITIDAS.has(hoja)) continue;
  if (esPlanilla && OMITIDAS_PLANILLA.has(hoja)) continue;
  const claves = CLAVES[hoja];
  const a = aObjetos(exportado[hoja]);
  const b = aObjetos(reconstruido[hoja]);
  totalFilas += Math.max(a.length, b.length);

  if (!claves) { informe.push({ hoja, sinClave: true, hojaN: a.length, baseN: b.length }); continue; }

  /* El lado de la hoja habla en ids viejos para los siete fusionados. Al
     traducirlos, dos filas de la hoja pueden caer en la misma clave: la del
     id retirado, que la app sigue escribiendo en cero, y la del id vigente,
     que lleva el conteo real. Gana siempre la vigente — que es lo que hace
     el cargador— porque quedarse con la otra acusaría un "cantidad: hoja=0
     base=50" que es justo al revés de lo que pasa. */
  const colProd = COL_PRODUCTO[hoja];
  if (colProd) for (const o of a)
    if (FUSIONADOS[o[colProd]]) { o[colProd] = FUSIONADOS[o[colProd]]; o.__retirado = true; }

  const clave = o => claves.map(c => norm(o[c])).join('\u0001');
  const mapaA = new Map();
  for (const o of a) {
    const k = clave(o), previo = mapaA.get(k);
    if (!previo || (previo.__retirado && !o.__retirado)) mapaA.set(k, o);
  }
  const mapaB = new Map(b.map(o => [clave(o), o]));
  // Las columnas se comparan por intersección: si un lado trae una columna que
  // el otro no conoce, no es una diferencia de datos.
  const eq = EQUIVALENCIAS[hoja];
  const fuera = new Set(IGNORAR[hoja] || []);
  const columnas = (eq
    ? Object.keys(eq(a[0] || {}, norm))
    : (exportado[hoja][0] || []).filter(c => (reconstruido[hoja][0] || []).includes(c))
  ).filter(c => !fuera.has(c));
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

  /* Se apartan las diferencias ya decididas. No desaparecen: se cuentan y se
     listan al final, para que el informe diga qué es nuevo y qué no. */
  const esperada = (tipo, k, campos) => ESPERADAS.find(e =>
    e.hoja === hoja &&
    (tipo === 'soloBase' ? e.soloBase?.test(k.replace(/\u0001/g,'·'))
                         : e.clave?.test(k.replace(/\u0001/g,'·')) &&
                           campos.every(c => e.campos.includes(c))));

  const distReales = [], soloBaseReales = [];
  for (const d of distintas) {
    const e = esperada('dist', d.k, d.campos);
    if (e) yaDecididas.push({ hoja, k: d.k, razon: e.razon }); else distReales.push(d);
  }
  for (const k of soloBase) {
    const e = esperada('soloBase', k, []);
    if (e) yaDecididas.push({ hoja, k, razon: e.razon }); else soloBaseReales.push(k);
  }

  totalSoloHoja += soloHoja.length; totalSoloBase += soloBaseReales.length; totalDistintas += distReales.length;
  if (!soloHoja.length && !soloBaseReales.length && !distReales.length) { pestanasIguales++; continue; }
  informe.push({ hoja, hojaN: a.length, baseN: b.length,
                 soloHoja, soloBase: soloBaseReales, distintas: distReales, claves });
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

if (yaDecididas.length) {
  console.log(`\n── ${yaDecididas.length} diferencia(s) ya decidida(s), no son hallazgos ──`);
  const porRazon = new Map();
  for (const d of yaDecididas) porRazon.set(d.razon, (porRazon.get(d.razon) || 0) + 1);
  for (const [razon, n] of porRazon) console.log(`   ${String(n).padStart(3)} · ${razon}`);
}

if (!totalFilas) { console.log('\nABORTA: no se comparó ninguna fila. Revisa que la base esté en pie.'); process.exit(1); }
console.log(`\n${pestanasIguales} de ${pestanasIguales + informe.length} pestañas idénticas · ${totalFilas} filas cotejadas`);
console.log(`faltan por cargar: ${totalSoloHoja} · solo en la base: ${totalSoloBase} · DISTINTAS: ${totalDistintas}`);
if (totalDistintas) console.log('\nLas DISTINTAS necesitan decisión: volver a correr la carga no las cambia.');
