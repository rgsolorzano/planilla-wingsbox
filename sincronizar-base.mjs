/* ═══════════════════════════════════════════════════════════════════════════
   MOTOR DE SINCRONIZACIÓN CON LA BASE
   ---------------------------------------------------------------------------
   Hace contra PostgreSQL lo mismo que _syncSheet hace contra Google Sheets, y
   por eso ninguna pantalla cambia: las 64 llamadas a syncMarcaciones(),
   syncEmpleados()… siguen igual, y en modo base terminan aquí.

   Cómo: la app serializa la pestaña entera, como siempre (gsSerializeSheet).
   El motor la compara con la FOTO de lo que se cargó de la base —que tiene la
   misma forma, eso es lo que lleva días comprobando el comparador— y para cada
   fila creada o cambiada llama a la función de la base que le toca, con su
   versión. Es el comparador corriendo en el navegador, con manos.

   Tres reglas copiadas de cómo se comporta HOY la hoja, para que cambiar de
   modo no cambie lo que pasa:

   · Una fila solo se BORRA si la app la marcó con gsMarcarEliminado. Si
     simplemente falta en memoria, se conserva, igual que la hoja la conserva.
     Excepción: las pestañas de interruptores (hora extra, exoneración), donde
     la memoria tiene el estado completo y una ausencia es "volvió a su valor
     por omisión". Ahí la app quita la entrada al apagarla, sin marcarla.

   · Si una fila marcada para borrar sigue en memoria, gana la memoria.

   · Los registros de un empleado que se está eliminando no se borran uno a
     uno: lo hace borrar_empleado, todo o nada. Si la base se niega (tiene
     propinas, está en una quincena cerrada), borrarlos sueltos dejaría a la
     persona a medias.

   Y una de orden: las sincronizaciones se procesan DE UNA EN UNA, en el orden
   en que la app las pide. Al crear un empleado la app lanza a la vez
   syncEmpleados() y syncHorarios(), y los horarios necesitan el id que la
   base le da al empleado. Con la cola, cuando llegan, ya lo tiene.

   El motor no sabe nada del navegador: recibe la forma de llamar a la base y
   de calcular la clave de la app. Así se prueba en Node contra la base real.
   ═══════════════════════════════════════════════════════════════════════════ */

export const VERSION = '2026-11-25.8';

/* ── Normalización: la MISMA que usa el comparador ───────────────────────── */
const canonico = x => Array.isArray(x) ? x.map(canonico)
  : (x && typeof x === 'object')
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonico(x[k])]))
    : x;
export const norm = v => {
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
const objetos = m => (!m || !m.length) ? []
  : m.slice(1).map(f => Object.fromEntries(m[0].map((c, i) => [c, f[i] === undefined ? '' : f[i]])));
const hm  = v => (v === null || v === undefined || String(v).trim() === '') ? null : String(v).trim().slice(0, 5);
const num = v => (v === null || v === undefined || String(v).trim() === '') ? null : Number(v);
const sino = v => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
const fecha = v => norm(v) || null;

/* Las condiciones viajan como JSON dentro del empleado. Para saber si una
   cambió se comparan sus valores, no su texto: la app y el lector pueden
   escribir el mismo número como 1200 o "1200". */
const condicionesDe = o => { try { return JSON.parse(o?.condiciones || '[]') || []; } catch { return []; } };
const vistaCondicion = c => JSON.stringify({
  desde: norm(c.desde), hasta: norm(c.hasta), tipo: String(c.tipo ?? ''), esLibre: sino(c.esLibre),
  sq: Number(c.sueldoQuincenal) || 0, sp: Number(c.sueldoPlanilla) || 0, sh: Number(c.sueldoHora) || 0,
  afp: Number(c.afpComision) || 0, aj: Number(c.ajustePlanilla) || 0, hc: Number(c.horasCierre) || 0,
});

/* ═══════════════════════════════════════════════════════════════════════════
   LAS PESTAÑAS
   ---------------------------------------------------------------------------
   Para cada una: cómo se reconoce una fila (clave), a qué empleado pertenece,
   cómo se guarda y cómo se borra. guardar devuelve una LISTA de operaciones,
   porque un empleado son varias llamadas (la persona y sus condiciones) y
   mover un día libre de fecha son dos (borrar el viejo, crear el nuevo).

   Los parámetros van en una función y no en un objeto: se calculan al
   ejecutar cada llamada, no antes. Así la segunda operación puede usar el id
   que la base le dio a la persona en la primera.
   ═══════════════════════════════════════════════════════════════════════════ */
const movimientoPlanilla = (fn, tabla) => ({
  clave: o => String(o.id),
  deEmpleado: o => o.empleadoId,
  guardar: (o, ant, m, ctx) => [{ fn, params: () => ({
    p_id_externo: String(o.id), p_empleado: ctx.empleado(o.empleadoId), p_fecha: fecha(o.fecha),
    p_tipo: o.tipo, p_monto: Number(o.monto) || 0, p_detalle: o.detalle || null,
    p_version: m?.version ?? null }) }],
  borrar: (ant, m) => ({ fn: 'borrar_fila_planilla',
    params: { p_tabla: tabla, p_id: m.id, p_version: m.version } }),
});

/* Catálogos: una ficha por artículo, identificada por el id de la app. Cada
   pestaña manda SOLO sus columnas, y la base actualiza solo esas (ver 43):
   así guardar un licor desde su pestaña no deja en blanco lo que esa pestaña
   no muestra. Eliminar no borra: lo retira, y su historia se queda. */
const catalogo = (categoria, columnas) => ({
  clave: o => String(o.id),
  catalogo: true,
  guardar: (o, ant, m) => [{ fn: 'guardar_articulo', params: () => ({
    p_id: m?.id ?? null, p_categoria: categoria, p_nombre: o.nombre,
    p_id_externo: String(o.id), p_version: m?.version ?? null,
    p_activo: null,             // solo Bebidas lo lleva; null = no tocarlo
    ...columnas(o) }) }],
  borrar: (ant, m) => ({ fn: 'retirar_articulo', params: { p_id: m.id, p_version: m.version } }),
});

export const HOJAS = {
  Licores:         catalogo('licores', o => ({ p_tamano_ml: num(o.tamanoMl), p_oz_botella: num(o.ozPorBotella) })),
  BebidasCat:      catalogo('bebidas', o => ({ p_subcategoria: o.categoria || null, p_activo: sino(o.activo),
                                              p_stock_minimo: num(o.stockMinimo),
                                              p_botellas_vacias: num(o.nroBotellasVacias) })),
  SalonProductos:  catalogo('salon',   o => ({ p_unidades: o.unidades || null })),
  MenajeArticulos: catalogo('menaje',  () => ({})),
  Cocina:          catalogo('cocina',  o => ({ p_unidad: o.unidad || null, p_orden: num(o.orden) })),

  /* Insumos: su pestaña lleva TODAS sus columnas, así que se manda la ficha
     entera. */
  Insumos: {
    clave: o => String(o.id),
    catalogo: true,
    guardar: (o, ant, m) => [{ fn: 'guardar_insumo', params: () => ({
      p_id: m?.id ?? null, p_nombre: o.nombre, p_unidad: o.unidad,
      p_inventario: o.inventario || 'ambos', p_tipo_registro: o.tipoRegistro || 'ambos',
      p_orden: num(o.orden) === null ? null : Math.round(num(o.orden)),
      p_umbral_consumo: num(o.umbralConsumo), p_umbral_minimo: num(o.umbralMinimo),
      p_alerta_consumo: sino(o.alertaConsumo), p_alerta_minimo: sino(o.alertaMinimo),
      p_activo: null, p_version: m?.version ?? null, p_id_externo: String(o.id),
      p_resaltado_celda: sino(o.resaltadoCelda), p_alerta_rendimiento: sino(o.alertaRendimiento),
      p_rendimiento_min: num(o.rendMin), p_rendimiento_max: num(o.rendMax) }) }],
    borrar: (ant, m) => ({ fn: 'retirar_insumo', params: { p_id: m.id, p_version: m.version } }),
  },

  Marcaciones: {
    clave: o => `${o.empleadoId}|${norm(o.fecha)}`,
    deEmpleado: o => o.empleadoId,
    /* El id de la app no es la identidad (empleado y día lo son) y la app lo
       regenera al reemplazar: compararlo marcaría cambios que no existen. */
    ignorar: ['id'],
    guardar: (o, ant, m, ctx) => [{ fn: 'guardar_marcacion', params: () => {
      /* null en la base es "no lo toques", para que la salida de la noche no
         borre la entrada de la mañana. Vaciar a propósito se dice aparte. */
      const limpiar = [];
      if (!hm(o.entradaReal) && ant && hm(ant.entradaReal)) limpiar.push('entrada');
      if (!hm(o.salidaReal)  && ant && hm(ant.salidaReal))  limpiar.push('salida');
      return { p_empleado: ctx.empleado(o.empleadoId), p_fecha: fecha(o.fecha),
               p_entrada: hm(o.entradaReal), p_salida: hm(o.salidaReal),
               p_origen_e: o.origenEntrada || o.origen || null,
               p_origen_s: o.origenSalida  || o.origen || null,
               p_limpiar: limpiar, p_version: m?.version ?? null };
    } }],
    borrar: (ant, m) => ({ fn: 'borrar_fila_planilla',
      params: { p_tabla: 'marcaciones', p_id: m.id, p_version: m.version } }),
  },

  Descuentos: movimientoPlanilla('guardar_descuento', 'descuentos'),
  PagosExtra: movimientoPlanilla('guardar_pago_extra', 'pagos_extra'),

  Propinas: {
    clave: o => String(o.id),
    deEmpleado: o => o.empleadoId,
    guardar: (o, ant, m, ctx) => [{ fn: 'guardar_propina', params: () => ({
      p_id_externo: String(o.id), p_empleado: ctx.empleado(o.empleadoId), p_fecha: fecha(o.fecha),
      p_medio: o.tipo, p_monto: Number(o.monto) || 0, p_ov: (o.ov === '' ? null : o.ov),
      p_version: m?.version ?? null }) }],
    borrar: (ant, m) => ({ fn: 'borrar_fila_planilla',
      params: { p_tabla: 'propinas', p_id: m.id, p_version: m.version } }),
  },

  DiasLibres: {
    clave: o => String(o.id),
    // Los feriados (empleado '*') son de toda la casa, no de nadie.
    deEmpleado: o => o.empleadoId === '*' ? null : o.empleadoId,
    guardar: (o, ant, m, ctx) => {
      if (o.empleadoId === '*') return [{ fn: 'guardar_feriado', params: () => ({
        p_id_externo: String(o.id), p_fecha: fecha(o.fecha), p_nombre: o.comentario || null }) }];
      /* La base identifica el día libre por empleado y fecha. Si la app le
         cambió la fecha, para la base es OTRO día: se borra el de antes y se
         crea el nuevo. Actualizarlo crearía el nuevo y dejaría el viejo. */
      const movido = ant && m?.id && (ant.empleadoId !== o.empleadoId || norm(ant.fecha) !== norm(o.fecha));
      const ops = [];
      if (movido) ops.push({ fn: 'borrar_fila_planilla',
        params: () => ({ p_tabla: 'dias_libres', p_id: m.id, p_version: m.version }) });
      ops.push({ fn: 'guardar_dia_libre', params: () => ({
        p_empleado: ctx.empleado(o.empleadoId), p_fecha: fecha(o.fecha), p_tipo: o.tipo,
        p_detalle: o.comentario || null, p_version: movido ? null : (m?.version ?? null) }) });
      return ops;
    },
    borrar: (ant, m) => ant.empleadoId === '*'
      ? { fn: 'borrar_feriado', params: { p_id_externo: String(ant.id) } }
      : { fn: 'borrar_fila_planilla', params: { p_tabla: 'dias_libres', p_id: m.id, p_version: m.version } },
  },

  /* Interruptores. La memoria tiene el estado COMPLETO —se carga entero— y
     la app quita la entrada al apagarla, sin marcarla. Una ausencia es
     "volvió a su valor por omisión", y eso hay que escribirlo. */
  ConsiderarHoraExtra: {
    clave: o => `${o.empleadoId}|${norm(o.fecha)}`,
    deEmpleado: o => o.empleadoId,
    estadoCompleto: true,
    // Lo normal es considerarla: la pestaña solo guarda las excepciones.
    porOmision: o => ({ ...o, considerar: 1 }),
    guardar: (o, ant, m, ctx) => [{ fn: 'guardar_considerar_hora_extra', params: () => ({
      p_empleado: ctx.empleado(o.empleadoId), p_fecha: fecha(o.fecha),
      p_considerar: sino(o.considerar), p_version: m?.version ?? null }) }],
  },
  ExoneracionTardanza: {
    clave: o => `${o.empleadoId}|${norm(o.fecha)}`,
    deEmpleado: o => o.empleadoId,
    estadoCompleto: true,
    // Desactivarla es no tenerla: se borra.
    porOmision: null,
    guardar: (o, ant, m, ctx) => [{ fn: 'guardar_exoneracion_tardanza', params: () => ({
      p_empleado: ctx.empleado(o.empleadoId), p_fecha: fecha(o.fecha),
      p_horas: Number(o.horas) || 0, p_activa: sino(o.activa), p_motivo: null,
      p_version: m?.version ?? null }) }],
    borrar: (ant, m) => ({ fn: 'borrar_fila_planilla',
      params: { p_tabla: 'exoneraciones_tardanza', p_id: m.id, p_version: m.version } }),
  },

  ValidacionTarjeta: {
    clave: o => norm(o.fecha),
    guardar: (o, ant, m) => [{ fn: 'guardar_validacion_tarjeta', params: () => ({
      p_fecha: fecha(o.fecha), p_niubiz: num(o.niubiz), p_caja: num(o.caja),
      p_version: m?.version ?? null }) }],
  },

  Horarios: {
    clave: o => `${o.empleadoId}|${Number(o.dia)}|${o.condicionId || ''}`,
    deEmpleado: o => o.empleadoId,
    guardar: (o, ant, m, ctx) => [{ fn: 'guardar_horario', params: () => {
      const libre = sino(o.libre);
      return { p_empleado: ctx.empleado(o.empleadoId), p_dia: Number(o.dia),
               p_condicion: o.condicionId ? ctx.condicion(o.condicionId) : null,
               p_entrada: libre ? null : hm(o.entrada), p_salida: libre ? null : hm(o.salida),
               p_libre: libre, p_orden: null, p_version: m?.version ?? null };
    } }],
    // Los horarios solo se borran con su empleado, y eso lo hace borrar_empleado.
  },

  Empleados: {
    clave: o => String(o.id),
    guardar: (o, ant, m, ctx) => {
      const ops = [];
      /* Las columnas tipo, sueldos… son ESPEJO de la condición vigente: se
         escriben al guardar las condiciones, no como datos de la persona. */
      const persona = ['nombre', 'documento', 'activo', 'visible', 'fechaIngreso'];
      if (!ant || persona.some(c => norm(o[c]) !== norm(ant[c])))
        ops.push({ fn: 'guardar_empleado', params: () => ({
          p_id_externo: String(o.id), p_documento: o.documento, p_nombre: o.nombre,
          p_fecha_ingreso: fecha(o.fechaIngreso), p_es_mesero: null,
          p_visible: sino(o.visible), p_activo: sino(o.activo),
          p_version: ctx.versionEmpleado(o.id) }),
          alGuardar: r => ctx.anotarEmpleado(o.id, r) });

      const viejas = new Map(condicionesDe(ant).map(c => [c.id, c]));
      const cambiadas = condicionesDe(o).filter(c =>
        !viejas.has(c.id) || vistaCondicion(c) !== vistaCondicion(viejas.get(c.id)));
      /* Primero las que ya existían —puede que se estén cerrando— y después
         las nuevas, cada grupo por fecha de inicio. Al revés, abrir la nueva
         chocaría con la vieja todavía sin cerrar. */
      cambiadas.sort((a, b) => (viejas.has(b.id) - viejas.has(a.id))
                            || String(a.desde).localeCompare(String(b.desde)));
      for (const c of cambiadas)
        ops.push({ fn: 'guardar_condicion_laboral', params: () => ({
          p_id_externo: c.id, p_empleado: ctx.empleado(o.id),
          p_desde: fecha(c.desde), p_hasta: fecha(c.hasta), p_puesto: c.tipo,
          p_es_libre: sino(c.esLibre),
          p_sueldo_quincenal: Number(c.sueldoQuincenal) || 0, p_sueldo_hora: Number(c.sueldoHora) || 0,
          p_sueldo_planilla: Number(c.sueldoPlanilla) || 0, p_afp_comision: Number(c.afpComision) || 0,
          p_ajuste_planilla: Number(c.ajustePlanilla) || 0, p_horas_cierre: Number(c.horasCierre) || 0,
          p_version: ctx.versionCondicion(c.id) }),
          alGuardar: r => ctx.anotarCondicion(c.id, r) });
      return ops;
    },
    borrar: (ant, m) => ({ fn: 'borrar_empleado', params: { p_id: m.id, p_version: m.version } }),
    alBorrar: (ant, ctx) => ctx.olvidarEmpleado(ant.id),
  },

  EfectivoCaja: {
    clave: o => `${norm(o.fecha)}|${o.turno}`,
    ignorar: ['id'],
    guardar: (o, ant, m) => [{ fn: 'guardar_efectivo_caja', params: () => {
      const lado = p => {
        const x = { bolsa: Number(o[p + 'Bolsa']) || 0 };
        for (let i = 0; i <= 10; i++) x['d' + i] = Number(o[p + i]) || 0;
        return x;
      };
      return { p_fecha: fecha(o.fecha), p_turno: o.turno, p_responsable: o.responsable || null,
               p_apertura: lado('ap'), p_cierre: lado('cl'), p_version: m?.version ?? null };
    } }],
  },

  /* Copia derivada que la app arma para la cuenta de inventario. En la base
     sale de las condiciones laborales: no hay nada que escribir. */
  Meseros: { derivada: true },
  Meta:    { derivada: true },
};

const OK = new Set(['creado', 'actualizado', 'repetido', 'borrado', 'ausente']);

/* ═══════════════════════════════════════════════════════════════════════════
   EL MOTOR
   rpc(fn, params)       → la respuesta jsonb de la función (lanza si la red falla)
   claveApp(hoja, fila)  → la clave con que la app marca los borrados (gsClaveDe)
   uid()                 → un id único por acción, para las claves de reintento
   ═══════════════════════════════════════════════════════════════════════════ */
export function crearMotor({ rpc, claveApp, uid, log = () => {}, alEscribir = () => {} }){
  const fotos = new Map();                 // 'dominio/Hoja' → { filas:[obj], meta:[{id,version}] }
  const empleados = new Map();             // id de la app → { id, version }
  const condiciones = new Map();           // id de la app → { id, version }
  const empleadosBorrados = new Set();     // borrados en esta sesión: lo suyo ya no existe
  let cola = Promise.resolve();

  const ctx = {
    empleado: ext => empleados.get(String(ext))?.id ?? null,
    versionEmpleado: ext => empleados.get(String(ext))?.version ?? null,
    anotarEmpleado: (ext, r) => empleados.set(String(ext), { id: r.id ?? empleados.get(String(ext))?.id, version: r.version }),
    olvidarEmpleado: ext => { empleados.delete(String(ext)); empleadosBorrados.add(String(ext)); },
    condicion: ext => condiciones.get(String(ext))?.id ?? null,
    versionCondicion: ext => condiciones.get(String(ext))?.version ?? null,
    anotarCondicion: (ext, r) => condiciones.set(String(ext), { id: r.id ?? condiciones.get(String(ext))?.id, version: r.version }),
  };

  /* Guarda lo que se acaba de leer de la base. Es contra esto que se compara
     después: sin foto no se sabe qué cambió, y el motor se niega a escribir. */
  function fotografiar(dominio, hojas, meta = {}){
    for (const [hoja, matriz] of Object.entries(hojas || {})) {
      if (!HOJAS[hoja] || HOJAS[hoja].derivada) continue;
      const filas = objetos(matriz), m = meta[hoja] || [];
      if (m.length !== filas.length) {
        log(`[Base] ${hoja}: ${filas.length} filas y ${m.length} metadatos; no se puede escribir en esa pestaña hasta recargar`);
        fotos.delete(`${dominio}/${hoja}`);
        continue;
      }
      fotos.set(`${dominio}/${hoja}`, { filas, meta: m.map(x => ({ ...x })) });
    }
    if (hojas?.Empleados && meta.Empleados) {
      empleados.clear();
      objetos(hojas.Empleados).forEach((e, i) => empleados.set(String(e.id), { ...meta.Empleados[i] }));
    }
    /* La cuenta de inventario no lee Empleados, pero las propinas necesitan
       el id de cada persona en la base. El lector de inventario lo trae para
       meseros y para quien ya tenga propinas. No pisa lo que haya leído
       planilla, que además trae la versión. */
    if (meta.empleados)
      for (const [ext, v] of Object.entries(meta.empleados))
        if (!empleados.has(ext)) empleados.set(ext, { ...v });
    if (meta.condiciones) {
      condiciones.clear();
      for (const [ext, v] of Object.entries(meta.condiciones)) condiciones.set(ext, { ...v });
    }
  }

  const maneja = hoja => !!HOJAS[hoja];

  /* opciones: { marcas: Set de claves de la app marcadas para borrar en esta
     pestaña, marcasEmpleados: las de la pestaña Empleados, alTerminar(r):
     se espera DENTRO de la cola, para que una recarga tras un fallo termine
     antes de que empiece la siguiente sincronización. */
  function sincronizar(dominio, hoja, matriz, opciones = {}){
    const p = cola.then(async () => {
      const r = await sincronizarYa(dominio, hoja, matriz, opciones);
      if (opciones.alTerminar) await opciones.alTerminar(r);
      return r;
    });
    cola = p.catch(() => {});
    return p;
  }

  async function sincronizarYa(dominio, hoja, matriz, { marcas = new Set(), marcasEmpleados = new Set() } = {}){
    const cfg = HOJAS[hoja];
    const res = { hoja, ok: true, creados: 0, actualizados: 0, borrados: 0, repetidos: 0,
                  sinCambios: 0, incidencias: [], marcasAplicadas: [] };
    if (!cfg || cfg.derivada) return res;

    const clave = `${dominio}/${hoja}`;
    const foto = fotos.get(clave);
    if (!foto) {
      res.ok = false;
      res.incidencias.push({ estado: 'sin-foto', motivo: 'no hay una lectura de la base con la que comparar; recarga la página' });
      return res;
    }
    const actual = objetos(matriz);
    const indice = new Map(foto.filas.map((f, i) => [cfg.clave(f), i]));
    const enActual = new Set(actual.map(cfg.clave));
    const nuevaMeta = new Map();             // clave → meta, para la foto siguiente

    // Empleados que se están eliminando AHORA: lo suyo lo borra borrar_empleado.
    const enBorrado = new Set();
    const fe = fotos.get('planilla/Empleados');
    if (fe && marcasEmpleados.size)
      for (const e of fe.filas) if (marcasEmpleados.has(claveApp('Empleados', e))) enBorrado.add(String(e.id));
    const deAlguienQueSeVa = f => {
      const e = cfg.deEmpleado?.(f);
      return e != null && (enBorrado.has(String(e)) || empleadosBorrados.has(String(e)));
    };

    const accion = uid();
    let n = 0;
    const llamar = async op => {
      const params = typeof op.params === 'function' ? op.params() : op.params;
      return rpc(op.fn, { p_clave: `${accion}:${hoja}:${n++}`, ...params });
    };
    const incidencia = (fila, r, op) => {
      res.ok = false;
      res.incidencias.push({ fila, funcion: op?.fn, estado: r?.estado || 'error',
                             motivo: r?.motivo || r?.mensaje || 'sin detalle' });
    };

    try {
      /* ── 1 · Borrados ─────────────────────────────────────────────────── */
      for (const [i, f] of foto.filas.entries()) {
        const k = cfg.clave(f);
        if (enActual.has(k)) continue;                       // sigue en memoria: gana la memoria
        const kApp = claveApp(hoja, f);
        const marcada = marcas.has(kApp);
        if (!marcada && !cfg.estadoCompleto) { nuevaMeta.set(k, foto.meta[i]); continue; }   // se conserva
        if (deAlguienQueSeVa(f)) { if (marcada) res.marcasAplicadas.push(kApp); continue; }

        if (!marcada && cfg.porOmision) {                    // interruptor apagado: vuelve a su valor
          const o = cfg.porOmision(f);
          for (const op of cfg.guardar(o, f, foto.meta[i], ctx)) {
            const r = await llamar(op);
            if (!OK.has(r?.estado)) { incidencia(o, r, op); break; }
            res.actualizados++;
          }
          continue;
        }
        if (!cfg.borrar) {
          incidencia(f, { estado: 'no-se-puede', motivo: `en ${hoja} no se puede borrar una fila` });
          continue;
        }
        const op = cfg.borrar(f, foto.meta[i]);
        const r = await llamar(op);
        if (OK.has(r?.estado)) {
          res.borrados++;
          if (marcada) res.marcasAplicadas.push(kApp);
          cfg.alBorrar?.(f, ctx);
        } else incidencia(f, r, op);
      }

      /* ── 2 · Altas y cambios ──────────────────────────────────────────── */
      const fuera = new Set(cfg.ignorar || []);
      for (const o of actual) {
        const k = cfg.clave(o);
        const i = indice.get(k);
        const ant = i === undefined ? null : foto.filas[i];
        const m = i === undefined ? null : foto.meta[i];
        if (ant && Object.keys(o).every(c => fuera.has(c) || norm(o[c]) === norm(ant[c]))) {
          res.sinCambios++; nuevaMeta.set(k, m); continue;
        }
        if (deAlguienQueSeVa(o)) continue;
        const emp = cfg.deEmpleado?.(o);
        // Un empleado que la base no conoce: o lo crea un guardado anterior de
        // la cola, o hay un problema que no se arregla escribiendo a ciegas.
        if (emp != null && hoja !== 'Empleados' && !ctx.empleado(emp)) {
          incidencia(o, { estado: 'desconocido', motivo: `el empleado ${emp} no está en la base` });
          continue;
        }
        if (!cfg.guardar) { incidencia(o, { estado: 'no-se-puede', motivo: `${hoja} no se puede editar` }); continue; }

        let meta = m ? { ...m } : {};
        let bien = true, escrito = false;
        for (const op of cfg.guardar(o, ant, m, ctx)) {
          const r = await llamar(op);
          if (!OK.has(r?.estado)) { incidencia(o, r, op); bien = false; break; }
          escrito = true;
          if (r.estado === 'repetido') res.repetidos++;
          op.alGuardar?.(r);
          // Quien llama se entera: tras crear una ficha de catálogo, el
          // traductor de ids del inventario tiene que conocerla ya.
          alEscribir(hoja, o, r, op.fn);
          // La meta de la FILA es la de su última escritura propia (en
          // Empleados, la de la persona; las condiciones van en su mapa).
          if (op.fn !== 'guardar_condicion_laboral' && op.fn !== 'borrar_fila_planilla')
            meta = { ...meta, ...(r.id ? { id: r.id } : {}), ...(r.version != null ? { version: r.version } : {}) };
        }
        if (!bien) continue;
        if (escrito) { if (ant) res.actualizados++; else res.creados++; }
        else res.sinCambios++;
        if (o.empleadoId === '*' && hoja === 'DiasLibres') meta = { feriado: true };
        nuevaMeta.set(k, meta);
      }
    } catch (e) {
      // La red se cortó a mitad: lo que entró, entró; el resto no se sabe.
      res.ok = false;
      res.incidencias.push({ estado: 'error', motivo: 'no se pudo hablar con la base: ' + (e?.message || e) });
    }

    /* ── 3 · La foto siguiente ────────────────────────────────────────────
       Solo si todo fue bien. Si algo falló, quien llama recarga de la base,
       y la foto sale de esa lectura: así nunca queda una foto que diga algo
       que la base no dice. */
    if (res.ok) {
      const filas = [], meta = [];
      for (const o of actual) { filas.push(o); meta.push(nuevaMeta.get(cfg.clave(o)) || {}); }
      // Las que no estaban en memoria y se conservaron siguen en la foto.
      for (const [i, f] of foto.filas.entries()) {
        const k = cfg.clave(f);
        if (!enActual.has(k) && nuevaMeta.has(k)) { filas.push(f); meta.push(foto.meta[i]); }
      }
      fotos.set(clave, { filas, meta });
    }
    log(`[Base] ${hoja}: ${res.creados} nueva(s) · ${res.actualizados} cambiada(s) · ${res.borrados} borrada(s)`
        + (res.incidencias.length ? ` · ${res.incidencias.length} con problema` : ''));
    return res;
  }

  return { fotografiar, sincronizar, maneja, _foto: (d, h) => fotos.get(`${d}/${h}`), _ctx: ctx };
}
