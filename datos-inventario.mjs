/* ═══════════════════════════════════════════════════════════════════════════
   WINGSBOX · Lectura del inventario desde PostgreSQL
   ---------------------------------------------------------------------------
   Reconstruye las pestañas del Spreadsheet de inventario a partir de las
   tablas de la base, con la misma forma exacta: { hoja: matriz }, encabezados
   en la fila 0.

   El objetivo no es que la app sea más bonita por dentro, sino que no se
   entere. index.html tiene 17,600 líneas que esperan estos datos con esta
   forma; devolviéndosela, cambia de dónde vienen sin tocar lo que hace con
   ellos. Y lo que hace con ellos ya está probado por años de uso.

   DOS DECISIONES QUE CONVIENE CONOCER

   1. Los catálogos incluyen los artículos vigentes MÁS los retirados que
      todavía guarden conteos o movimientos. La app vieja no conoce la columna
      'activo'; filtrar solo por ella dejaría conteos históricos apuntando a
      un artículo que no existe, y devolver el catálogo completo mostraba
      filas repetidas de productos ya retirados. La regla es la misma para
      cualquier producto que se retire en el futuro, sin casos especiales.
      Las pantallas NUEVAS sí filtran solo por activo.

   2. Las pestañas Bebidas e InvBebidas se devuelven vacías. Son un catálogo
      de licores abandonado y sus 12 movimientos del 19/06 quedaron fuera de
      la migración por decisión del 13/11/2026.
   ═══════════════════════════════════════════════════════════════════════════ */

/* La versión de ESTE archivo. El arranque la coteja con la del index y avisa
   si no coinciden: una subida a medias deja un .mjs viejo en caché sirviendo
   código que ya se arregló, y eso costó una tarde de dar vueltas. */
export const VERSION = '2026-11-27.3';

const t = x => (x === null || x === undefined) ? '' : x;
const n0 = x => (x === null || x === undefined || x === '') ? 0 : Number(x);
const b01 = x => (x === true || x === 't' || x === 1) ? 1 : 0;

const porClaves = (...claves) => (a, b) => {
  for(const k of claves){
    const x = String(k(a) ?? ''), y = String(k(b) ?? '');
    if(x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

/* Clave de un conteo tal como la nombra la app: producto, fecha y unidad.
   La unidad puede no existir (cocina y bebidas no la usan) y ahí vale ''. */
export const claveConteo = (idExterno, fecha, unidad) =>
  `${idExterno}|${fecha}|${unidad ?? ''}`;

/* Clave de un movimiento tal como lo identifica la base: artículo, fecha y
   tipo. No lleva el id de la hoja a propósito; ver el mapa versionMov. */
export const claveMovimiento = (idExterno, fecha, tipo) =>
  `${idExterno}|${fecha}|${tipo}`;

export function crearLectorInventario(consultar){
  /* Se llenan al leer y los consulta la escritura. Viven fuera de
     leerInventario para que sobrevivan a la lectura que los pobló. */
  const uuidPorExterno = new Map();   // artículos e insumos, por su id de la hoja
  const versionConteo  = new Map();
  /* Movimientos, por ARTÍCULO + FECHA + TIPO, que es como los identifica
     core.guardar_movimiento. Tentaba usar el id_externo, que es más corto,
     pero esa función no lo guarda: todo movimiento que escriba la app nace
     con id_externo en null, así que una versión guardada bajo esa clave sería
     inencontrable justo para las filas que la app acaba de crear. */
  const versionMov     = new Map();
  /* El id en la base y la versión de cada fila, en una lista paralela a cada
     matriz (como en el lector de planilla). Solo para las pestañas que se
     escriben a través del motor de sincronización; las demás de inventario
     llevan su propio mapa de versiones desde antes. */
  let ultimaMeta = {};
  const versionStock   = new Map();   // stock_diario, por insumo y fecha

  async function leerInventario(){
    /* Las nueve consultas se lanzan A LA VEZ y se esperan más abajo, cada
       una donde ya se usaba. Antes iban una detrás de otra: veintitrés viajes
       de ida y vuelta en fila, que son casi veinte segundos antes de poder
       trabajar. Ninguna depende de otra, así que no había razón para la cola.

       Await sobre una promesa que ya está en marcha devuelve al instante; el
       resto del archivo no cambia. */
    /* La calibración va PRIMERO, antes de lanzar nada: estaba después de
       articulos y esa consulta ya había salido sin la cota, pagando una
       petición de más. Lo que calibra no sirve si el resto ya está en vuelo.

       Conteos es la mayor (6,012 filas) y su primera página se guarda, así que
       la recoge su propia consulta más abajo. Es lo único que no va en
       paralelo, y da igual: conteos marca el tiempo de la carga de todos
       modos. La cota queda puesta también para planilla, que comparte
       conexión. */
    const CONTEOS = {
      select: 'id, id_externo, articulo_id, fecha, cantidad, unidad, rotas, rajadas, version',
      // Orden único: sin él, paginar de mil en mil se salta filas.
      order: 'id',
    };
    if(consultar.calibrar) await consultar.calibrar('conteos', CONTEOS);

    const _p_articulos = consultar('articulos', {
      select: 'id, version, id_externo, categoria, subcategoria, nombre, unidad, tamano_ml, ' +
              'oz_por_botella, stock_minimo, botellas_vacias, unidades, activo, eliminado, orden',
      order: 'nombre',
    });
    const _p_conteos = consultar('conteos', CONTEOS);
    const _p_movimientos = consultar('movimientos', {
      select: 'id, id_externo, articulo_id, fecha, tipo, cantidad, cantidad_botellas, version',
      // Orden único: sin él, paginar de mil en mil se salta filas.
      order: 'id',
    });
    const _p_insumos = consultar('insumos', {
      select: 'id, version, activo, id_externo, nombre, unidad, inventario, tipo_registro, orden, ' +
              'umbral_consumo, umbral_minimo, alerta_consumo, alerta_minimo, ' +
              'resaltado_celda, alerta_rendimiento, rendimiento_min, rendimiento_max',
      order: 'orden',
    });
    const _p_stock_diario = consultar('stock_diario', {
      select: 'id, id_externo, insumo_id, fecha, stock_inicial, stock_cierre, version',
      // Orden único: sin él, paginar de mil en mil se salta filas.
      order: 'id',
    });
    const _p_produccion = consultar('produccion', {
      select: 'id, id_externo, insumo_id, fecha, cantidad',
      // Orden único: sin él, paginar de mil en mil se salta filas.
      order: 'id',
    });
    const _p_efectivo_caja = consultar('efectivo_caja', {
      select: 'id, version, id_externo, fecha, turno, responsable, apertura, cierre',
    });
    const _p_propinas = consultar('propinas', {
      select: 'id, version, id_externo, fecha, medio, monto, ov, empleados!inner(id, id_externo)',
      // Orden único: sin él, paginar de mil en mil se salta filas.
      order: 'id',
    });
    const _p_empleados = consultar('empleados', {
      select: 'id, id_externo, nombre, es_mesero',
      igual: { es_mesero: true },
      order: 'nombre',
    });

    const hojas = {};
    const meta = {};

    /* ── Catálogo de artículos, una consulta para las cinco categorías ──── */
    const articulos = await _p_articulos;
    const porId = new Map(articulos.map(a => [a.id, a]));
    /* La app habla en ids del Spreadsheet; la base, en uuid. Este mapa es el
       traductor que necesita la escritura. */
    for(const a of articulos) uuidPorExterno.set(a.id_externo, a.id);

    /* Los dos registros de movimiento se leen aquí arriba, antes de armar los
       catálogos, porque son ellos los que dicen qué artículo tiene historia.
       Son consultas independientes: adelantarlas no cambia nada más. */
    const conteos = (await _p_conteos).sort(porClaves(r => r.fecha, r => r.id_externo));

    const movimientos = await _p_movimientos;

    /* Un artículo entra al catálogo si está vigente, o si está retirado pero
       todavía guarda historia. Lo segundo es lo que evita que un conteo de
       julio apunte a un artículo que la app no conoce. Y como la fusión de
       los duplicados de salón dejó las fichas antiguas sin conteos, esas
       desaparecen por esta misma regla, sin necesidad de nombrarlas. */
    /* La versión de cada conteo se guarda aquí, no en la hoja reconstruida.
       Hacerla una columna más cambiaría la forma de la pestaña y la app no
       sabría qué hacer con ella. Pero sin versión no se puede actualizar sin
       pisar a otro: guardar_conteo la exige justamente para eso. */
    let sinVersion = 0, sinArticulo = 0;
    for(const c of conteos){
      const ext = porId.get(c.articulo_id)?.id_externo;
      if(!ext){ sinArticulo++; continue; }
      if(c.version === undefined || c.version === null){ sinVersion++; continue; }
      versionConteo.set(claveConteo(ext, c.fecha, c.unidad), c.version);
    }
    /* Si estos números no cuadran, el guardado va a fallar más tarde con un
       "ya existe un conteo" que no explica nada. Mejor verlo aquí. */
    if(sinVersion || sinArticulo || versionConteo.size !== conteos.length)
      console.warn('[Conteos] versiones mapeadas', versionConteo.size, 'de', conteos.length,
                   '· sin version:', sinVersion, '· sin artículo:', sinArticulo);
    else
      console.log('[Conteos] ' + conteos.length + ' conteos leídos, todos con versión.');

    const conHistoria = new Set();
    for(const c of conteos) conHistoria.add(c.articulo_id);
    for(const m of movimientos){
      conHistoria.add(m.articulo_id);
      const a = porId.get(m.articulo_id);
      if(a) versionMov.set(claveMovimiento(a.id_externo, m.fecha, m.tipo), m.version);
    }
    /* Qué artículos aparecen en cada catálogo. Decisión del usuario (25/11):
       un artículo eliminado ya no aparece, como en la hoja. Antes se incluían
       los retirados que tuvieran historia, y PISCO GALPON —borrado de la
       hoja— seguía saliendo en modo base.

       Bebidas es la excepción, porque su pestaña SÍ tiene columna activo: en
       su formulario hay una casilla para desactivar sin borrar, y una bebida
       desactivada tiene que seguir en la lista para poder reactivarla. Allí
       solo desaparece lo eliminado. En las demás no existe "desactivado" para
       la app, así que lo inactivo no aparece.

       La historia de un eliminado no se pierde: conteos y movimientos se
       siguen reconstruyendo, porque el traductor de ids recorre TODOS los
       artículos, no solo los de esta lista. */
    const de = cat => articulos.filter(a => a.categoria === cat && !a.eliminado
      && (cat === 'bebidas' || a.activo));
    const fila = (hoja, a) => (meta[hoja] || (meta[hoja] = [])).push({ id: a.id, version: a.version });

    hojas.Licores = [['id','nombre','tamanoMl','ozPorBotella']];
    for(const a of de('licores')){
      hojas.Licores.push([a.id_externo, a.nombre, n0(a.tamano_ml), n0(a.oz_por_botella)]);
      fila('Licores', a);
    }

    hojas.BebidasCat = [['id','categoria','nombre','activo','nroBotellasVacias','stockMinimo']];
    for(const a of de('bebidas')){
      // t() y no n0(): la hoja distingue "sin dato" de 0, y la app también.
      // Y recorta las celdas finales vacías, como hace la hoja.
      const fila = [a.id_externo, t(a.subcategoria), a.nombre, b01(a.activo),
                    t(a.botellas_vacias), t(a.stock_minimo)];
      while(fila.length > 4 && fila[fila.length-1] === '') fila.pop();
      hojas.BebidasCat.push(fila);
      (meta.BebidasCat || (meta.BebidasCat = [])).push({ id: a.id, version: a.version });
    }

    hojas.SalonProductos = [['id','nombre','unidades']];
    for(const a of de('salon')){
      hojas.SalonProductos.push([a.id_externo, a.nombre, t(a.unidades)]);
      fila('SalonProductos', a);
    }

    hojas.MenajeArticulos = [['id','nombre']];
    for(const a of de('menaje')){
      hojas.MenajeArticulos.push([a.id_externo, a.nombre]);
      fila('MenajeArticulos', a);
    }

    /* La pestaña Cocina vivía vacía en el Spreadsheet —su catálogo estaba
       sembrado en el código de la app— y por eso se devolvía vacía. Desde el
       17/11/2026 la hoja ya trae los 31 artículos con los mismos ids, así que
       se devuelve lo que hay en la base: devolverla vacía obligaría a la app
       a volver a sembrarla y dejaría el 'orden' en blanco. */
    hojas.Cocina = [['id','nombre','unidad','orden']];
    for(const a of de('cocina')){
      hojas.Cocina.push([a.id_externo, a.nombre, t(a.unidad), a.orden ?? '']);
      fila('Cocina', a);
    }

    /* ── Conteos: una tabla, cuatro pestañas, según la categoría ────────── */
    const conteosDe = cat => conteos.filter(c => porId.get(c.articulo_id)?.categoria === cat);
    const ext = c => porId.get(c.articulo_id)?.id_externo ?? '';

    hojas.StockBebidas = [['id','bebidaId','fecha','stock']];
    for(const c of conteosDe('bebidas'))
      hojas.StockBebidas.push([c.id_externo, ext(c), c.fecha, n0(c.cantidad)]);

    hojas.SalonInventario = [['id','productoId','fecha','unidad','cantidad']];
    for(const c of conteosDe('salon'))
      hojas.SalonInventario.push([c.id_externo, ext(c), c.fecha, t(c.unidad), n0(c.cantidad)]);

    hojas.MenajeInventario = [['id','articuloId','fecha','cantidad','rotas','rajadas']];
    for(const c of conteosDe('menaje'))
      hojas.MenajeInventario.push([c.id_externo, ext(c), c.fecha, n0(c.cantidad),
                                   n0(c.rotas), n0(c.rajadas)]);

    hojas.InvCocina = [['id','productoId','fecha','cantidad']];
    for(const c of conteosDe('cocina'))
      hojas.InvCocina.push([c.id_externo, ext(c), c.fecha, n0(c.cantidad)]);

    /* ── Movimientos ─────────────────────────────────────────────────────
       InvLicores guarda entrada y salida del día en UNA fila; la base los
       guarda como dos movimientos, con el id original más ':e' o ':s'. Aquí
       se vuelven a juntar por ese id base, que es justo para lo que se
       guardó con ese sufijo. */
    const filasLic = new Map();
    for(const m of movimientos){
      if(porId.get(m.articulo_id)?.categoria !== 'licores') continue;
      /* Las filas que escribe la app nacen sin id_externo, porque
         guardar_movimiento no lo guarda. Sin un id propio todas caerían en
         la misma clave '' y se verían como UNA sola fila. El id derivado del
         artículo y la fecha es además estable entre recargas, cosa que un
         uid() al azar no era. */
      const base = m.id_externo ? String(m.id_externo).replace(/:(e|s)$/, '')
                                : `lic:${ext(m)}:${m.fecha}`;
      const f = filasLic.get(base) || { id: base, bebidaId: ext(m), fecha: m.fecha,
        entradaOzs: 0, entradaBots: 0, salidaOzs: 0, salidaBots: 0 };
      if(m.tipo === 'ingreso'){ f.entradaOzs = n0(m.cantidad); f.entradaBots = n0(m.cantidad_botellas); }
      else                    { f.salidaOzs  = n0(m.cantidad); f.salidaBots  = n0(m.cantidad_botellas); }
      filasLic.set(base, f);
    }
    hojas.InvLicores = [['id','bebidaId','fecha','entradaOzs','entradaBots','salidaOzs','salidaBots']];
    for(const f of [...filasLic.values()].sort(porClaves(r => r.fecha, r => r.id)))
      hojas.InvLicores.push([f.id, f.bebidaId, f.fecha, f.entradaOzs, f.entradaBots,
                             f.salidaOzs, f.salidaBots]);

    /* Los movimientos que escribe la app nacen sin id_externo, porque
       guardar_movimiento no lo guarda. La app aguanta un id vacío —le pone
       uno al azar al leer—, pero entonces cambia en cada recarga y nadie
       puede emparejar esa fila de una vez a la siguiente: el comparador del
       25/11 la mostró con la clave en blanco. Un id derivado de artículo,
       fecha y tipo es estable, y es justo lo que identifica al movimiento en
       la base. */
    const idMov = (m, prefijo) => m.id_externo || `${prefijo}:${ext(m)}:${m.fecha}:${m.tipo}`;

    hojas.MovBebidas = [['id','bebidaId','fecha','cantidad','tipoMovimiento']];
    for(const m of movimientos.filter(m => porId.get(m.articulo_id)?.categoria === 'bebidas')
                              .sort(porClaves(r => r.fecha, r => idMov(r, 'mb'))))
      hojas.MovBebidas.push([idMov(m, 'mb'), ext(m), m.fecha, n0(m.cantidad),
                             // Capitalizado como en la hoja. La app lo normaliza
                             // igual, pero reproducirlo exacto deja el comparador
                             // limpio y así las diferencias que salgan son reales.
                             m.tipo === 'ingreso' ? 'Entrada' : 'Salida']);

    /* Cocina estuvo VACÍA hasta el 25/11: había cabecera y ningún bucle.
       La escritura de movimientos de cocina se conectó el 20/11, pero su
       lectura nunca, así que lo que se guardaba desaparecía al recargar.
       La columna es 'tipo' en minúsculas, que es como la lee la app
       (S.cocinaMovimientos), no 'tipoMovimiento' como en bebidas. */
    hojas.MovCocina = [['id','productoId','fecha','cantidad','tipo']];
    for(const m of movimientos.filter(m => porId.get(m.articulo_id)?.categoria === 'cocina')
                              .sort(porClaves(r => r.fecha, r => idMov(r, 'mc'))))
      hojas.MovCocina.push([idMov(m, 'mc'), ext(m), m.fecha, n0(m.cantidad), m.tipo]);

    /* ── Insumos de cocina y su stock diario ─────────────────────────────── */
    const insumos = await _p_insumos;
    const insPorId = new Map(insumos.map(i => [i.id, i]));
    // Los insumos entran al mismo traductor que los artículos: la escritura
    // necesita el uuid y la app solo conoce el id de la hoja.
    for(const i of insumos) uuidPorExterno.set(i.id_externo, i.id);
    hojas.Insumos = [['id','nombre','unidad','umbralConsumo','umbralMinimo','alertaConsumo',
                      'alertaMinimo','resaltadoCelda','inventario','tipoRegistro','orden',
                      'alertaRendimiento','rendMin','rendMax']];
    /* Un insumo retirado no aparece (la pestaña no tiene columna activo),
       pero sigue en el traductor de ids de arriba: su stock histórico se
       reconstruye igual. */
    for(const i of insumos.filter(i => i.activo !== false)){
      (meta.Insumos || (meta.Insumos = [])).push({ id: i.id, version: i.version });
      hojas.Insumos.push([i.id_externo, i.nombre, t(i.unidad), n0(i.umbral_consumo),
        n0(i.umbral_minimo), b01(i.alerta_consumo), b01(i.alerta_minimo),
        b01(i.resaltado_celda), t(i.inventario), t(i.tipo_registro), n0(i.orden),
        b01(i.alerta_rendimiento), n0(i.rendimiento_min), n0(i.rendimiento_max)]);
    }

    /* La base guarda la forma v2 (stockInicial / stockCierre). Las columnas
       viejas 'produccion' y 'cierre' salen vacías y migradoV2 en 1: así la
       app ve un dato ya migrado y no intenta volver a migrarlo. */
    const stock = (await _p_stock_diario).sort(porClaves(r => r.fecha, r => r.id_externo));
    /* Lo mismo que con los conteos: la versión no cabe en la hoja
       reconstruida, pero sin ella no se puede actualizar sin pisar a otro. */
    for(const r of stock){
      const ext = insPorId.get(r.insumo_id)?.id_externo;
      if(ext && r.version !== undefined && r.version !== null)
        versionStock.set(ext + '|' + r.fecha, r.version);
    }
    hojas.Produccion = [['id','insumoId','fecha','produccion','cierre','stockInicial','stockCierre','migradoV2']];
    for(const s of stock)
      hojas.Produccion.push([t(s.id_externo), insPorId.get(s.insumo_id)?.id_externo ?? '',
        s.fecha, '', '', s.stock_inicial ?? '', s.stock_cierre ?? '', 1]);

    const produccion = (await _p_produccion).sort(porClaves(r => r.fecha, r => r.id_externo));
    hojas.ProduccionInsumos = [['id','insumoId','fecha','cantidad']];
    for(const p of produccion)
      hojas.ProduccionInsumos.push([t(p.id_externo), insPorId.get(p.insumo_id)?.id_externo ?? '',
                                    p.fecha, n0(p.cantidad)]);

    /* ── Arqueo de efectivo: el jsonb vuelve a ser 24 columnas ──────────── */
    const caja = (await _p_efectivo_caja).sort(porClaves(r => r.fecha, r => r.id_externo));
    const cols = ['id','fecha','turno','responsable','apBolsa'];
    for(let i = 0; i <= 10; i++) cols.push('ap' + i);
    cols.push('clBolsa');
    for(let i = 0; i <= 10; i++) cols.push('cl' + i);
    hojas.EfectivoCaja = [cols];
    for(const c of caja){
      const a = c.apertura || {}, z = c.cierre || {};
      const fila = [t(c.id_externo), c.fecha, t(c.turno), t(c.responsable), n0(a.bolsa)];
      for(let i = 0; i <= 10; i++) fila.push(n0(a['d' + i]));
      fila.push(n0(z.bolsa));
      for(let i = 0; i <= 10; i++) fila.push(n0(z['d' + i]));
      hojas.EfectivoCaja.push(fila);
      (meta.EfectivoCaja || (meta.EfectivoCaja = [])).push({ id: c.id, version: c.version });
    }

    /* ── Propinas y meseros: viven en planilla, la app los lee aquí ─────── */
    const propinas = (await _p_propinas).sort(porClaves(r => r.fecha, r => r.empleados.id_externo, r => r.id_externo));
    hojas.Propinas = [['id','empleadoId','fecha','tipo','monto','ov']];
    for(const p of propinas){
      const fila = [p.id_externo || p.id, p.empleados.id_externo, p.fecha, p.medio, n0(p.monto)];
      // La hoja omite la última celda cuando está vacía en vez de dejarla en
      // blanco; para la app es lo mismo, pero igualarlo mantiene el
      // comparador en cero.
      if(t(p.ov) !== '') fila.push(p.ov);
      hojas.Propinas.push(fila);
      (meta.Propinas || (meta.Propinas = [])).push({ id: p.id, version: p.version });
      (meta.empleados || (meta.empleados = {}))[p.empleados.id_externo] = { id: p.empleados.id };
    }

    /* La marca es_mesero, no el puesto. Deducirla de puesto='Mesero' daba 13
       en vez de 9: la lista incluye a dos personas inactivas y excluye a
       otras cuatro que también fueron meseras. Es una lista mantenida a
       mano y se guarda como tal. */
    const meseros = await _p_empleados;
    hojas.Meseros = [['id','nombre']];
    /* El id de cada mesero EN LA BASE. La cuenta de inventario registra
       propinas sin acceso a planilla, así que nunca lee la pestaña Empleados:
       sin esto no sabría a quién apuntar una propina nueva. */
    for(const m of meseros){
      hojas.Meseros.push([m.id_externo, m.nombre]);
      (meta.empleados || (meta.empleados = {}))[m.id_externo] = { id: m.id };
    }

    // Catálogo de licores abandonado: ver la cabecera de este archivo.
    hojas.Bebidas    = [['id','nombre','tamanoMl','ozPorBotella']];
    hojas.InvBebidas = [['id','bebidaId','fecha','momento','onzas','botellas']];

    hojas.Meta = [['clave','valor'], ['app','WingsBox Inventario']];

    ultimaMeta = meta;
    return hojas;
  }

  return {
    leerInventario,
    /* La meta de la última lectura, aparte de las hojas: la app recorre las
       hojas por nombre y una clave extra ahí dentro sería una pestaña más. */
    meta: () => ultimaMeta,
    /* Tras crear una ficha desde la app, su uuid. Sin esto, un conteo de un
       artículo recién creado fallaría con "no existe en la base" hasta la
       siguiente recarga. */
    anotarUuid: (idExterno, uuid) => { if(idExterno && uuid) uuidPorExterno.set(idExterno, uuid); },
    /* Lo que la escritura necesita y la hoja reconstruida no puede llevar. */
    uuidDe: idExterno => uuidPorExterno.get(idExterno) || null,
    /* ¿Llegó a leerse algo? Si una consulta se pasó del tiempo límite, el
       traductor queda vacío y conviene distinguir "no existe ese artículo" de
       "no hay datos", que mandan a buscar en sitios muy distintos. */
    tieneCatalogo: () => uuidPorExterno.size > 0,
    versionDe: (idExterno, fecha, unidad) =>
      versionConteo.get(claveConteo(idExterno, fecha, unidad)) ?? null,
    versionStockDe: (idExterno, fecha) => versionStock.get(idExterno + '|' + fecha) ?? null,
    anotarVersionStock: (idExterno, fecha, version) =>
      version === null ? versionStock.delete(idExterno + '|' + fecha)
                       : versionStock.set(idExterno + '|' + fecha, version),
    /* Tras una escritura, la versión cambia: si no se anota, el siguiente
       guardado del mismo día llegaría con la vieja y daría conflicto. */
    anotarVersion: (idExterno, fecha, unidad, version) =>
      versionConteo.set(claveConteo(idExterno, fecha, unidad), version),
    /* Movimientos: artículo, fecha y tipo. Null si esa fila todavía no está
       en la base, que es lo que guardar_movimiento espera para crearla. */
    versionMovDe: (idExterno, fecha, tipo) =>
      versionMov.get(claveMovimiento(idExterno, fecha, tipo)) ?? null,
    anotarVersionMov: (idExterno, fecha, tipo, version) =>
      versionMov.set(claveMovimiento(idExterno, fecha, tipo), version),
  };
}
