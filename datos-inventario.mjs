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

   1. Los catálogos se devuelven COMPLETOS, incluidos los artículos
      desactivados. La app vieja no conoce la columna 'activo', así que
      filtrarlos dejaría conteos históricos apuntando a un artículo que no
      existe. Las pantallas NUEVAS sí filtran por activo; ahí es donde la
      desactivación de los duplicados surte efecto.

   2. Las pestañas Bebidas e InvBebidas se devuelven vacías. Son un catálogo
      de licores abandonado y sus 12 movimientos del 19/06 quedaron fuera de
      la migración por decisión del 13/11/2026.
   ═══════════════════════════════════════════════════════════════════════════ */

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

export function crearLectorInventario(consultar){

  async function leerInventario(){
    const hojas = {};

    /* ── Catálogo de artículos, una consulta para las cinco categorías ──── */
    const articulos = await consultar('articulos', {
      select: 'id, id_externo, categoria, subcategoria, nombre, unidad, tamano_ml, ' +
              'oz_por_botella, stock_minimo, botellas_vacias, unidades, activo',
      order: 'nombre',
    });
    const porId = new Map(articulos.map(a => [a.id, a]));
    const de = cat => articulos.filter(a => a.categoria === cat);

    hojas.Licores = [['id','nombre','tamanoMl','ozPorBotella']];
    for(const a of de('licores'))
      hojas.Licores.push([a.id_externo, a.nombre, n0(a.tamano_ml), n0(a.oz_por_botella)]);

    hojas.BebidasCat = [['id','categoria','nombre','activo','nroBotellasVacias','stockMinimo']];
    for(const a of de('bebidas')){
      // t() y no n0(): la hoja distingue "sin dato" de 0, y la app también.
      // Y recorta las celdas finales vacías, como hace la hoja.
      const fila = [a.id_externo, t(a.subcategoria), a.nombre, b01(a.activo),
                    t(a.botellas_vacias), t(a.stock_minimo)];
      while(fila.length > 4 && fila[fila.length-1] === '') fila.pop();
      hojas.BebidasCat.push(fila);
    }

    hojas.SalonProductos = [['id','nombre','unidades']];
    for(const a of de('salon'))
      hojas.SalonProductos.push([a.id_externo, a.nombre, t(a.unidades)]);

    hojas.MenajeArticulos = [['id','nombre']];
    for(const a of de('menaje'))
      hojas.MenajeArticulos.push([a.id_externo, a.nombre]);

    /* La pestaña Cocina vive vacía en el Spreadsheet: su catálogo está
       sembrado en el código de la app. Se devuelve vacía igual, para que la
       app siga sembrándolo como siempre. */
    hojas.Cocina = [['id','nombre','unidad']];

    /* ── Conteos: una tabla, cuatro pestañas, según la categoría ────────── */
    const conteos = (await consultar('conteos', {
      select: 'id, id_externo, articulo_id, fecha, cantidad, unidad, rotas, rajadas',
    })).sort(porClaves(r => r.fecha, r => r.id_externo));
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
    const movimientos = await consultar('movimientos', {
      select: 'id, id_externo, articulo_id, fecha, tipo, cantidad, cantidad_botellas',
    });

    const filasLic = new Map();
    for(const m of movimientos){
      if(porId.get(m.articulo_id)?.categoria !== 'licores') continue;
      const base = String(m.id_externo || '').replace(/:(e|s)$/, '');
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

    hojas.MovBebidas = [['id','bebidaId','fecha','cantidad','tipoMovimiento']];
    for(const m of movimientos.filter(m => porId.get(m.articulo_id)?.categoria === 'bebidas')
                              .sort(porClaves(r => r.fecha, r => r.id_externo)))
      hojas.MovBebidas.push([m.id_externo, ext(m), m.fecha, n0(m.cantidad),
                             // Capitalizado como en la hoja. La app lo normaliza
                             // igual, pero reproducirlo exacto deja el comparador
                             // limpio y así las diferencias que salgan son reales.
                             m.tipo === 'ingreso' ? 'Entrada' : 'Salida']);

    hojas.MovCocina = [['id','productoId','fecha','cantidad','tipoMovimiento']];

    /* ── Insumos de cocina y su stock diario ─────────────────────────────── */
    const insumos = await consultar('insumos', {
      select: 'id, id_externo, nombre, unidad, inventario, tipo_registro, orden, ' +
              'umbral_consumo, umbral_minimo, alerta_consumo, alerta_minimo, ' +
              'resaltado_celda, alerta_rendimiento, rendimiento_min, rendimiento_max',
      order: 'orden',
    });
    const insPorId = new Map(insumos.map(i => [i.id, i]));
    hojas.Insumos = [['id','nombre','unidad','umbralConsumo','umbralMinimo','alertaConsumo',
                      'alertaMinimo','resaltadoCelda','inventario','tipoRegistro','orden',
                      'alertaRendimiento','rendMin','rendMax']];
    for(const i of insumos)
      hojas.Insumos.push([i.id_externo, i.nombre, t(i.unidad), n0(i.umbral_consumo),
        n0(i.umbral_minimo), b01(i.alerta_consumo), b01(i.alerta_minimo),
        b01(i.resaltado_celda), t(i.inventario), t(i.tipo_registro), n0(i.orden),
        b01(i.alerta_rendimiento), n0(i.rendimiento_min), n0(i.rendimiento_max)]);

    /* La base guarda la forma v2 (stockInicial / stockCierre). Las columnas
       viejas 'produccion' y 'cierre' salen vacías y migradoV2 en 1: así la
       app ve un dato ya migrado y no intenta volver a migrarlo. */
    const stock = (await consultar('stock_diario', {
      select: 'id_externo, insumo_id, fecha, stock_inicial, stock_cierre',
    })).sort(porClaves(r => r.fecha, r => r.id_externo));
    hojas.Produccion = [['id','insumoId','fecha','produccion','cierre','stockInicial','stockCierre','migradoV2']];
    for(const s of stock)
      hojas.Produccion.push([t(s.id_externo), insPorId.get(s.insumo_id)?.id_externo ?? '',
        s.fecha, '', '', s.stock_inicial ?? '', s.stock_cierre ?? '', 1]);

    const produccion = (await consultar('produccion', {
      select: 'id_externo, insumo_id, fecha, cantidad',
    })).sort(porClaves(r => r.fecha, r => r.id_externo));
    hojas.ProduccionInsumos = [['id','insumoId','fecha','cantidad']];
    for(const p of produccion)
      hojas.ProduccionInsumos.push([t(p.id_externo), insPorId.get(p.insumo_id)?.id_externo ?? '',
                                    p.fecha, n0(p.cantidad)]);

    /* ── Arqueo de efectivo: el jsonb vuelve a ser 24 columnas ──────────── */
    const caja = (await consultar('efectivo_caja', {
      select: 'id_externo, fecha, turno, responsable, apertura, cierre',
    })).sort(porClaves(r => r.fecha, r => r.id_externo));
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
    }

    /* ── Propinas y meseros: viven en planilla, la app los lee aquí ─────── */
    const propinas = (await consultar('propinas', {
      select: 'id, id_externo, fecha, medio, monto, ov, empleados!inner(id_externo)',
    })).sort(porClaves(r => r.fecha, r => r.empleados.id_externo, r => r.id_externo));
    hojas.Propinas = [['id','empleadoId','fecha','tipo','monto','ov']];
    for(const p of propinas){
      const fila = [p.id_externo || p.id, p.empleados.id_externo, p.fecha, p.medio, n0(p.monto)];
      // La hoja omite la última celda cuando está vacía en vez de dejarla en
      // blanco; para la app es lo mismo, pero igualarlo mantiene el
      // comparador en cero.
      if(t(p.ov) !== '') fila.push(p.ov);
      hojas.Propinas.push(fila);
    }

    /* La marca es_mesero, no el puesto. Deducirla de puesto='Mesero' daba 13
       en vez de 9: la lista incluye a dos personas inactivas y excluye a
       otras cuatro que también fueron meseras. Es una lista mantenida a
       mano y se guarda como tal. */
    const meseros = await consultar('empleados', {
      select: 'id_externo, nombre, es_mesero',
      igual: { es_mesero: true },
      order: 'nombre',
    });
    hojas.Meseros = [['id','nombre']];
    for(const m of meseros) hojas.Meseros.push([m.id_externo, m.nombre]);

    // Catálogo de licores abandonado: ver la cabecera de este archivo.
    hojas.Bebidas    = [['id','nombre','tamanoMl','ozPorBotella']];
    hojas.InvBebidas = [['id','bebidaId','fecha','momento','onzas','botellas']];

    hojas.Meta = [['clave','valor'], ['app','WingsBox Inventario']];

    return hojas;
  }

  return { leerInventario };
}
