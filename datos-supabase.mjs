/* ═══════════════════════════════════════════════════════════════════════════
   WINGSBOX · Lectura de la planilla desde PostgreSQL
   ---------------------------------------------------------------------------
   Devuelve los datos con la MISMA forma que hoy entrega Google Sheets: un
   objeto { nombreDeHoja: matriz }, con la fila 0 de encabezados.

   Por qué conservar la forma de hoja en vez de dar objetos limpios: así la
   migración no toca las 17,600 líneas de index.html de golpe. La app sigue
   recibiendo lo mismo que siempre y solo cambia de dónde viene. Y sobre todo,
   esta forma YA está validada: es la que produce exportar_a_hojas.py, y
   demostramos que la app alimentada con ella recalcula las 144 liquidaciones
   sin una sola diferencia. Reproducir aquí ese mismo mapeo significa heredar
   esa prueba en lugar de empezar una nueva.

   La costura: crearLector(consultar) recibe cómo consultar. En el navegador
   se le pasa el cliente de Supabase; en las pruebas, una función que lee
   PostgreSQL directamente. La lógica de mapeo —que es donde viven los
   errores— es la misma en los dos casos.
   ═══════════════════════════════════════════════════════════════════════════ */

/* La versión de ESTE archivo. El arranque la coteja con la del index y avisa
   si no coinciden: una subida a medias deja un .mjs viejo en caché sirviendo
   código que ya se arregló, y eso costó una tarde de dar vueltas. */
export const VERSION = '2026-11-27.1';

/* ── Conversiones, equivalentes a las del exportador en Python ───────────── */

/** Número cuando lo es; '' cuando no hay dato. Nunca 0 por omisión. */
export function num(x){
  if(x === '' || x === null || x === undefined) return '';
  const f = Number(x);
  if(Number.isNaN(f)) return x;
  return Number.isInteger(f) ? f : f;
}

/** Booleano → 1 / 0, como lo escribe la hoja. */
export function b01(x){ return (x === true || x === 't' || x === 1) ? 1 : 0; }

/** '18:00:00' → '18:00'. La hoja guarda horas sin segundos. */
export function hm(x){ return x ? String(x).slice(0, 5) : ''; }

/** '' en lugar de null, que es como la hoja representa una celda vacía. */
const t = x => (x === null || x === undefined) ? '' : x;

/* Orden estable por varias claves de texto ASCII (ids, fechas ISO).
   Se evita localeCompare a propósito: debe coincidir con el orden que produce
   PostgreSQL sobre estas columnas, y los ids y las fechas ISO solo tienen
   caracteres donde ambos criterios coinciden. */
const porClaves = (...claves) => (a, b) => {
  for(const k of claves){
    const x = String(k(a) ?? ''), y = String(k(b) ?? '');
    if(x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

/* ═══════════════════════════════════════════════════════════════════════════
   El lector
   ═══════════════════════════════════════════════════════════════════════════ */
export function crearLector(consultar){

  /** Las hojas del dominio de planilla, tal como las espera la app. */
  async function leerPlanilla(){
    /* Todas las consultas se lanzan A LA VEZ y se esperan más abajo, cada una
       donde ya se usaba. Antes iban en fila india, y eso son tantos viajes de
       ida y vuelta seguidos como consultas. Ninguna depende de otra. */
    /* La calibración va PRIMERO, antes de lanzar nada. La traza del 20/11 lo
       dejó claro: estaba a mitad del archivo, y las seis consultas declaradas
       por encima ya habían salido sin la cota puesta, así que seguían pagando
       sonda —empleados, horarios, validacion_tarjeta—. Lo que calibra no sirve
       de nada si el resto ya está en vuelo.

       Marcaciones es la mayor del dominio (1,436 filas) y su primera página se
       guarda, así que la recoge su propia consulta más abajo sin volver a
       pedirla. La cota se comparte con inventario, que usa la misma conexión:
       si inventario cargó antes, aquí ya no se sondea nada. */
    const MARCACIONES = {
      select: 'id, version, fecha, entrada_real, salida_real, origen, origen_entrada, origen_salida, ' +
              'empleados!inner(id_externo)',
      // Orden único: sin él, paginar de mil en mil se salta filas.
      order: 'id',
    };
    if(consultar.calibrar) await consultar.calibrar('marcaciones', MARCACIONES);

    const _p_feriados = consultar('feriados', { select: 'id_externo, fecha, nombre', order: 'fecha' });
    const _p_vt = consultar('validacion_tarjeta', { select: 'fecha, niubiz, caja, version', order: 'fecha' });
    const _p_condiciones_laborales = consultar('condiciones_laborales', {
      select: 'id, version, id_externo, desde, hasta, puesto, sueldo_quincenal, sueldo_planilla, ' +
              'sueldo_hora, afp_comision, ajuste_planilla, horas_cierre, es_libre, ' +
              'empleados!inner(id_externo)',
    });
    const _p_condiciones_laborales2 = consultar('condiciones_laborales', {
      select: 'puesto, empleados!inner(id_externo, nombre)',
      igual: { puesto: 'Mesero' },
    });
    const _p_empleados = consultar('empleados', {
      select: 'id, version, id_externo, nombre, documento, fecha_ingreso, activo, visible',
      order: 'nombre',          // lo ordena PostgreSQL, con su propia colación
    });
    const _p_horarios = consultar('horarios', {
      select: 'id, version, dia_semana, libre, entrada, salida, orden, ' +
              'empleados!inner(id_externo), condiciones_laborales(id_externo)',
      order: 'orden',
    });
    const _p_marcaciones = consultar('marcaciones', MARCACIONES);
    const _p_dias_libres = consultar('dias_libres', {
      select: 'id, version, id_externo, fecha, tipo, detalle, empleados!inner(id_externo)',
    });
    const _p_considerar_hora_extra = consultar('considerar_hora_extra', {
      select: 'id, version, fecha, considerar, empleados!inner(id_externo)',
    });
    const _p_exoneraciones_tardanza = consultar('exoneraciones_tardanza', {
      select: 'id, version, fecha, activa, horas, empleados!inner(id_externo)',
    });
    const _p_propinas = consultar('propinas', {
      select: 'id, version, id_externo, fecha, medio, monto, ov, empleados!inner(id_externo)',
      // Orden único: sin él, paginar de mil en mil se salta filas.
      order: 'id',
    });
    const _p_movs = Object.fromEntries(['descuentos','pagos_extra'].map(tabla => [tabla,
      consultar(tabla, {
        select: 'id, version, id_externo, fecha, tipo, monto, detalle, empleados!inner(id_externo)',
      })]));

    const hojas = {};
    /* Lo que la hoja no puede llevar encima y la escritura necesita: el id de
       cada fila EN LA BASE y su versión. Va en una lista paralela a cada
       matriz, fila por fila, para que quien escribe identifique la fila con
       su propia clave sin que el lector tenga que adivinar cuál es. */
    const meta = {};
    const fila = (hoja, m) => (meta[hoja] || (meta[hoja] = [])).push(m);
    /* Condiciones laborales, por su id en la app: van DENTRO de cada
       empleado como JSON, así que no tienen fila propia a la que alinearse. */
    meta.condiciones = {};

    /* ── Empleados ─────────────────────────────────────────────────────────
       Las columnas sueltas son la condición VIGENTE; la columna 'condiciones'
       lleva el histórico completo en JSON. Así lo guarda hoy la app. */
    const condiciones = await _p_condiciones_laborales;
    const porEmpleado = new Map();
    for(const c of condiciones.sort(porClaves(r => r.empleados.id_externo, r => r.desde))){
      const lista = porEmpleado.get(c.empleados.id_externo) || [];
      if(c.id_externo) meta.condiciones[c.id_externo] = { id: c.id, version: c.version };
      lista.push({
        id: c.id_externo, desde: c.desde, hasta: c.hasta || null, tipo: c.puesto,
        sueldoQuincenal: num(c.sueldo_quincenal), sueldoPlanilla: num(c.sueldo_planilla),
        sueldoHora: num(c.sueldo_hora), afpComision: num(c.afp_comision),
        ajustePlanilla: num(c.ajuste_planilla), horasCierre: num(c.horas_cierre),
        esLibre: c.es_libre === true || c.es_libre === 't',
      });
      porEmpleado.set(c.empleados.id_externo, lista);
    }

    const empleados = await _p_empleados;
    hojas.Empleados = [[
      'id','nombre','documento','tipo','esLibre','activo','sueldoQuincenal','sueldoPlanilla',
      'sueldoHora','afpComision','ajustePlanilla','horasCierre','fechaIngreso','visible','condiciones'
    ]];
    for(const e of empleados){
      const cs = porEmpleado.get(e.id_externo) || [];
      // La vigente es la que no tiene 'hasta'; si todas lo tienen, la última.
      const vig = cs.find(c => !c.hasta) || cs[cs.length - 1] || {};
      hojas.Empleados.push([
        e.id_externo, e.nombre, e.documento, vig.tipo ?? '', vig.esLibre ? 1 : 0,
        b01(e.activo), vig.sueldoQuincenal ?? 0, vig.sueldoPlanilla ?? 0,
        vig.sueldoHora ?? 0, vig.afpComision ?? 0, vig.ajustePlanilla ?? 0,
        vig.horasCierre ?? 0, t(e.fecha_ingreso), b01(e.visible),
        cs.length ? JSON.stringify(cs) : '',
      ]);
      fila('Empleados', { id: e.id, version: e.version });
    }

    /* ── Horarios ──────────────────────────────────────────────────────── */
    const horarios = await _p_horarios;
    hojas.Horarios = [['empleadoId','dia','libre','entrada','salida','condicionId']];
    for(const h of horarios){
      hojas.Horarios.push([
        h.empleados.id_externo, Number(h.dia_semana), b01(h.libre),
        hm(h.entrada), hm(h.salida), t(h.condiciones_laborales?.id_externo),
      ]);
      fila('Horarios', { id: h.id, version: h.version });
    }

    /* ── Marcaciones ───────────────────────────────────────────────────── */
    const marcaciones = (await _p_marcaciones).sort(porClaves(r => r.fecha, r => r.empleados.id_externo));
    hojas.Marcaciones = [['id','empleadoId','fecha','entradaReal','salidaReal','origen','origenEntrada','origenSalida']];
    for(const m of marcaciones){
      hojas.Marcaciones.push([
        m.id, m.empleados.id_externo, m.fecha, hm(m.entrada_real), hm(m.salida_real),
        m.origen, t(m.origen_entrada), t(m.origen_salida),
      ]);
      fila('Marcaciones', { id: m.id, version: m.version });
    }

    /* ── Descuentos y pagos extra ──────────────────────────────────────────
       id_externo desempata: conserva el orden en que se escribieron en la
       hoja. No afecta ningún importe, pero sin él dos descuentos del mismo
       empleado y día salen en orden arbitrario. */
    for(const [hoja, tabla] of [['Descuentos','descuentos'], ['PagosExtra','pagos_extra']]){
      const filas = (await _p_movs[tabla]).sort(
        porClaves(r => r.fecha, r => r.empleados.id_externo, r => r.id_externo));
      hojas[hoja] = [['id','empleadoId','fecha','tipo','monto','detalle']];
      for(const d of filas){
        hojas[hoja].push([d.id_externo || d.id, d.empleados.id_externo, d.fecha,
                          d.tipo, num(d.monto), t(d.detalle)]);
        fila(hoja, { id: d.id, version: d.version });
      }
    }

    /* ── Días libres, con los feriados devueltos a su forma de hoja ──────── */
    /* El id que viaja a la hoja es el de la app, no el de PostgreSQL. La
       pestaña DiasLibres no figura en GS_SHEET_KEYS, así que la app la
       identifica por ['id']: devolver el UUID haría que la fusión viera 44
       filas nuevas donde hay 44 conocidas y duplicara la pestaña entera. */
    const libres = (await _p_dias_libres).sort(porClaves(r => r.fecha, r => r.empleados.id_externo));
    hojas.DiasLibres = [['id','empleadoId','fecha','tipo','comentario']];
    for(const d of libres){
      hojas.DiasLibres.push([d.id_externo || d.id, d.empleados.id_externo, d.fecha, d.tipo, t(d.detalle)]);
      fila('DiasLibres', { id: d.id, version: d.version });
    }
    // Los feriados valen para toda la casa: en la hoja llevan empleadoId '*'.
    const feriados = await _p_feriados;
    for(const f of feriados){
      hojas.DiasLibres.push([t(f.id_externo), '*', f.fecha, 'Feriado', t(f.nombre)]);
      // Los feriados no tienen versión: se escriben una vez al año.
      fila('DiasLibres', { feriado: true });
    }

    /* ── Interruptores por día ─────────────────────────────────────────── */
    const extras = (await _p_considerar_hora_extra).sort(porClaves(r => r.fecha, r => r.empleados.id_externo));
    hojas.ConsiderarHoraExtra = [['empleadoId','fecha','considerar']];
    for(const c of extras){
      hojas.ConsiderarHoraExtra.push([c.empleados.id_externo, c.fecha, b01(c.considerar)]);
      fila('ConsiderarHoraExtra', { id: c.id, version: c.version });
    }

    const exos = (await _p_exoneraciones_tardanza).sort(porClaves(r => r.fecha, r => r.empleados.id_externo));
    hojas.ExoneracionTardanza = [['empleadoId','fecha','activa','horas']];
    for(const x of exos){
      hojas.ExoneracionTardanza.push([x.empleados.id_externo, x.fecha, b01(x.activa), num(x.horas)]);
      fila('ExoneracionTardanza', { id: x.id, version: x.version });
    }

    /* ── Conciliación de tarjeta ───────────────────────────────────────── */
    const vt = await _p_vt;
    hojas.ValidacionTarjeta = [['fecha','niubiz','caja']];
    for(const v of vt){
      hojas.ValidacionTarjeta.push([v.fecha, num(v.niubiz), num(v.caja)]);
      fila('ValidacionTarjeta', { version: v.version });
    }

    /* ── Propinas: vive en inventario, pero la app la lee en ambos ─────── */
    /* id_externo desempata, igual que en los descuentos: una misma persona
       puede tener varias propinas el mismo día (una por medio de pago, y a
       veces varias del mismo medio). Sin el desempate salen en orden
       arbitrario y dos lecturas seguidas pueden diferir. */
    const propinas = (await _p_propinas).sort(porClaves(r => r.fecha, r => r.empleados.id_externo, r => r.id_externo));
    hojas.Propinas = [['id','empleadoId','fecha','tipo','monto','ov']];
    for(const p of propinas){
      hojas.Propinas.push([p.id_externo || p.id, p.empleados.id_externo, p.fecha,
                           p.medio, num(p.monto), t(p.ov)]);
      fila('Propinas', { id: p.id, version: p.version });
    }

    /* ── Meseros: quien tenga alguna condición con ese puesto ──────────── */
    const meseros = await _p_condiciones_laborales2;
    const vistos = new Map();
    for(const m of meseros) vistos.set(m.empleados.id_externo, m.empleados.nombre);
    hojas.Meseros = [['id','nombre']];
    for(const [id, nombre] of [...vistos].sort(porClaves(r => r[1]))) hojas.Meseros.push([id, nombre]);

    // Meta es configuración de la app, no datos de negocio: no vive en la base.
    hojas.Meta = [['clave','valor'], ['app','WingsBox Planilla']];

    ultimaMeta = meta;
    return hojas;
  }

  let ultimaMeta = {};
  /* La meta de la última lectura. Se pide aparte, no viaja dentro de las
     hojas: la app recorre las hojas por nombre y una clave extra ahí dentro
     sería una "pestaña" más que nadie espera. */
  return { leerPlanilla, meta: () => ultimaMeta };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ESCRITURA
   ---------------------------------------------------------------------------
   Toda la defensa vive en la base (ver 07_escritura.sql): reintento,
   concurrencia y permiso. Aquí no se reimplementa nada de eso; esto solo
   traduce la respuesta a algo que una pantalla pueda mostrar.

   La CLAVE se genera una vez por acción del usuario, no por intento. Es lo
   que distingue "el usuario quiere guardar dos veces" de "el usuario reintentó
   lo mismo porque se cortó la conexión". Si se generara en cada envío, el
   reintento entraría como un guardado nuevo y volveríamos al problema.
   ═══════════════════════════════════════════════════════════════════════════ */

export function nuevaClave(){
  return (globalThis.crypto?.randomUUID?.())
      || ('k-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
}

/* Artículos de una categoría junto con el conteo de ese día, si ya existe.
   Van juntos a propósito: la pantalla necesita la VERSIÓN del conteo para
   poder guardarlo después. Si se leyeran por separado, entre una consulta y
   otra alguien podría guardar y la versión llegaría vieja desde el principio. */
export function crearInventarioLector(sb){
  return async function leerInventario(categoria, fecha){
    const [{ data: articulos, error: eA }, { data: conteos, error: eC }] = await Promise.all([
      sb.schema('core').from('articulos')
        .select('id, nombre, unidad, categoria, activo').eq('categoria', categoria)
        .eq('activo', true).order('nombre'),
      sb.schema('core').from('conteos')
        .select('id, articulo_id, cantidad, unidad, rotas, rajadas, version, actualizado_por, actualizado_en')
        .eq('fecha', fecha),
    ]);
    if(eA || eC) throw new Error((eA || eC).message);
    const porArticulo = new Map((conteos || []).map(c => [c.articulo_id, c]));
    return (articulos || []).map(a => ({ articulo: a, conteo: porArticulo.get(a.id) || null }));
  };
}

export function crearEscritor(sb){
  async function guardarConteo({ clave, articuloId, fecha, cantidad,
                                 unidad = null, rotas = null, rajadas = null, version = null }){
    const { data, error } = await sb.schema('core').rpc('guardar_conteo', {
      p_clave: clave, p_articulo: articuloId, p_fecha: fecha, p_cantidad: cantidad,
      p_unidad: unidad, p_rotas: rotas, p_rajadas: rajadas, p_version: version,
    });
    // Un fallo de red o de la API: ni guardado ni rechazado, no se sabe. El
    // que reintente con la MISMA clave es exactamente para este caso.
    if(error) return { estado: 'error', mensaje: error.message };
    return data;
  }

  /* Borrar un conteo. En cocina, vaciar una celda significa "este día no se
     contó este producto", que no es contar cero. Exige la versión a la vista
     —borrar el trabajo de otro con una foto vieja es justo lo que se evita—
     y el permiso inventario:editar, más alto que el de registrar.

     'ausente' no es un fallo: lo que el usuario quería ya se cumple. */
  async function borrarConteo({ clave, articuloId, fecha, unidad = null, version = null }){
    const { data, error } = await sb.schema('core').rpc('borrar_conteo', {
      p_clave: clave, p_articulo: articuloId, p_fecha: fecha,
      p_unidad: unidad, p_version: version,
    });
    if(error) return { estado: 'error', mensaje: error.message };
    return data;
  }

  /* Movimientos de artículo: licores, bebidas y cocina.

     Para licores, 'ingreso' es el INVENTARIO FÍSICO del día desde el
     16/11/2026: botellas cerradas en p_botellas y onzas sueltas en
     p_cantidad. El consumo no se guarda, se deduce comparando dos días
     seguidos. Los movimientos de 'salida' anteriores a esa fecha son
     historia y esta función no los toca. */
  async function guardarMovimiento({ clave, articuloId, fecha, tipo, cantidad,
                                     botellas = null, detalle = null, version = null }){
    const { data, error } = await sb.schema('core').rpc('guardar_movimiento', {
      p_clave: clave, p_articulo: articuloId, p_fecha: fecha, p_tipo: tipo,
      p_cantidad: cantidad, p_botellas: botellas, p_detalle: detalle, p_version: version,
    });
    if(error) return { estado: 'error', mensaje: error.message };
    return data;
  }

  /* Borrar un movimiento (artículo + fecha + tipo). En licores, borrar el
     'ingreso' de un día declara que ese día no se contó. Exige la versión
     a la vista y el permiso inventario:editar. 'ausente' no es un fallo. */
  async function borrarMovimiento({ clave, articuloId, fecha, tipo, version = null }){
    const { data, error } = await sb.schema('core').rpc('borrar_movimiento', {
      p_clave: clave, p_articulo: articuloId, p_fecha: fecha, p_tipo: tipo, p_version: version,
    });
    if(error) return { estado: 'error', mensaje: error.message };
    return data;
  }

  /* Vaciar stock: campo 'inicial', 'cierre' o 'ambos'. Si la fila queda sin
     ninguno (y no está marcada como conservada) la base la borra. */
  async function borrarStock({ clave, insumoId, fecha, campo = 'cierre', version = null }){
    const { data, error } = await sb.schema('core').rpc('borrar_stock', {
      p_clave: clave, p_insumo: insumoId, p_fecha: fecha, p_campo: campo, p_version: version,
    });
    if(error) return { estado: 'error', mensaje: error.message };
    return data;
  }

  async function guardarProduccion({ clave, insumoId, fecha, cantidad, version = null }){
    const { data, error } = await sb.schema('core').rpc('guardar_produccion', {
      p_clave: clave, p_insumo: insumoId, p_fecha: fecha,
      p_cantidad: cantidad, p_version: version,
    });
    if(error) return { estado: 'error', mensaje: error.message };
    return data;
  }

  /* Stock diario. Un campo en null significa "no lo cambies", no "ponlo en
     null": la pantalla de apertura guarda el inicial sin conocer el cierre y
     la de cierre al revés. Si null borrara, cada una pisaría a la otra. */
  async function guardarStock({ clave, insumoId, fecha, inicial = null,
                                cierre = null, conservado = null, version = null }){
    const { data, error } = await sb.schema('core').rpc('guardar_stock', {
      p_clave: clave, p_insumo: insumoId, p_fecha: fecha, p_inicial: inicial,
      p_cierre: cierre, p_conservado: conservado, p_version: version,
    });
    if(error) return { estado: 'error', mensaje: error.message };
    return data;
  }

  /* Catálogos. Dos diferencias con lo anterior, y conviene tenerlas presentes
     al llamar:

       · La identidad es el id, no el nombre. Por eso renombrar conserva la
         historia: `id` en null es un alta, con `id` es una edición.
       · Lo que se manda REEMPLAZA la ficha. La pantalla de catálogo edita el
         registro completo, así que un campo omitido queda en blanco. Esto es
         al revés que guardarStock, donde null significa "no lo cambies".

     No hay función de borrado a propósito: retirar un producto es activo
     false. Sus conteos lo referencian y borrarlo fallaría. */
  async function guardarArticulo({ clave, id = null, categoria = null, nombre,
                                   unidad = null, subcategoria = null, tamanoMl = null,
                                   ozPorBotella = null, stockMinimo = null,
                                   activo = true, version = null }){
    const { data, error } = await sb.schema('core').rpc('guardar_articulo', {
      p_clave: clave, p_id: id, p_categoria: categoria, p_nombre: nombre,
      p_unidad: unidad, p_subcategoria: subcategoria, p_tamano_ml: tamanoMl,
      p_oz_botella: ozPorBotella, p_stock_minimo: stockMinimo,
      p_activo: activo, p_version: version,
    });
    if(error) return { estado: 'error', mensaje: error.message };
    return data;
  }

  async function guardarInsumo({ clave, id = null, nombre, unidad,
                                 inventario = 'ambos', tipoRegistro = 'ambos',
                                 orden = null, umbralConsumo = null, umbralMinimo = null,
                                 alertaConsumo = false, alertaMinimo = false,
                                 activo = true, version = null }){
    const { data, error } = await sb.schema('core').rpc('guardar_insumo', {
      p_clave: clave, p_id: id, p_nombre: nombre, p_unidad: unidad,
      p_inventario: inventario, p_tipo_registro: tipoRegistro, p_orden: orden,
      p_umbral_consumo: umbralConsumo, p_umbral_minimo: umbralMinimo,
      p_alerta_consumo: alertaConsumo, p_alerta_minimo: alertaMinimo,
      p_activo: activo, p_version: version,
    });
    if(error) return { estado: 'error', mensaje: error.message };
    return data;
  }

  /* Texto para la pantalla. Se centraliza para que dos pantallas no expliquen
     el mismo estado de dos formas distintas. */
  function explicar(r){
    switch(r?.estado){
      case 'creado':      return { ok:true,  texto:'Guardado.' };
      case 'actualizado': return { ok:true,  texto:'Actualizado.' };
      case 'repetido':    return { ok:true,  texto:'Ya estaba guardado; no se duplicó.' };
      case 'conflicto':   return { ok:false, texto: r.motivo || 'Hay un conflicto con lo que ya está guardado.' };
      case 'denegado':    return { ok:false, texto:'No tienes permiso para guardar esto.' };
      case 'error':       return { ok:false, texto:'No se pudo contactar con el servidor: ' + r.mensaje };
      default:            return { ok:false, texto:'Respuesta inesperada del servidor.' };
    }
  }

  return { guardarConteo, borrarConteo, guardarMovimiento, borrarMovimiento, borrarStock, guardarProduccion, guardarStock,
           guardarArticulo, guardarInsumo, explicar };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Implementación para el navegador, sobre supabase-js.
   Se pasa el cliente ya creado para que esta pieza no decida credenciales.
   ═══════════════════════════════════════════════════════════════════════════ */
/* El tope de filas por respuesta del servidor, aprendido en la primera
   consulta de la sesión. Supabase corta en 1,000 salvo que se cambie en los
   ajustes del proyecto (API → Max rows).

   Importa porque, sin saberlo, cada tabla paga una petición de más: cuando
   una respuesta viene corta hay que averiguar si se acabaron las filas o si
   el servidor cortó, y eso cuesta una sonda. En la medición del 18/11 esa
   sonda aparecía en las 21 tablas, incluidas las de cuatro filas. Una vez
   conocido el tope, una respuesta corta ya no es ambigua y la sonda sobra. */
export function consultarConSupabase(sb){
  /* Viven aquí, no en el módulo: son hechos de la conexión con la que se
     consulta, no del programa. Fuera, una conexión le dictaría el tope a otra
     y las pruebas dependerían del orden en que se corren. */
  let topeServidor = null;   // cuánto corta el servidor, si se ha averiguado
  /* La cota de abajo: el mayor número de filas que este servidor ha devuelto
     en UNA respuesta. Es lo que evita casi todas las sondas, y la idea es más
     simple que el tope exacto: si alguna vez contestó 5,000 filas de golpe,
     entonces corta en 5,000 o más, y cualquier respuesta de menos de 5,000 no
     puede ser un corte —está completa—. No hace falta saber dónde corta: basta
     saber que corta más arriba.

     Sin esto la sonda no servía de nada en la práctica, porque solo se
     aprendía el tope cuando alguna tabla lo alcanzaba, y con el tope en 5,000
     ninguna lo alcanza. Resultado medido el 20/11: las veinte tablas pagaban
     sonda, hasta la de cuatro filas. */
  let pisoTope = 0;
  const primeraPagina = new Map();   // lo que dejó calibrar(), para no repetirlo
  const firma = (tabla, o) => JSON.stringify([tabla, o.select, o.order, o.igual]);

  /* ── COPIAS: refrescar trayendo solo lo que cambió ─────────────────────
     Cada consulta completa se guarda. La siguiente vez que el lector pide la
     misma consulta, si nadie avisó de cambios, se devuelve la copia sin ir a
     la base; si se avisó (anotarCambios, con lo que dice core.cambios_desde),
     se traen SOLO esas filas por su id y se mezclan.

     Dos casos no se pueden mezclar fila a fila, y se vuelven a pedir enteros:
       · la consulta no trae la columna id (feriados, validación de tarjeta:
         su identidad es la fecha) — son tablas pequeñas;
       · cambió una tabla que la consulta trae ANIDADA (propinas trae el
         nombre del empleado): no hay forma de saber qué filas la usan.

     Se devuelve una copia de cada fila: si un lector la retocara, la
     siguiente lectura partiría de un dato ya transformado. */
  const copias = new Map();
  const columnasRaiz = sel => {
    const cols = []; let prof = 0, actual = '';
    for (const ch of String(sel)) {
      if (ch === '(') prof++;
      if (ch === ')') prof--;
      if (ch === ',' && prof === 0) { cols.push(actual.trim()); actual = ''; continue; }
      actual += ch;
    }
    if (actual.trim()) cols.push(actual.trim());
    return cols;
  };
  const anidadas = sel => new Set([...String(sel).matchAll(/([a-z_]+)(?:![a-z_]+)?\(/g)].map(m => m[1]));
  const compara = order => {
    if (!order) return null;
    return (a, b) => {
      const x = a[order], y = b[order];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;        // como PostgreSQL: nulos al final
      if (y === null || y === undefined) return -1;
      if (typeof x === 'number' && typeof y === 'number') return x - y;
      return String(x) < String(y) ? -1 : 1;
    };
  };
  const copiaDeFilas = filas => filas.map(f => ({ ...f }));

  async function refrescarCopia(c){
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let nuevas = 0;
    for (const id of c.quitar) c.porId.delete(id);
    const ids = [...c.traer];
    for (let i = 0; i < ids.length; i += 100) {
      const tramo = ids.slice(i, i + 100);
      let q = sb.schema('core').from(c.tabla).select(c.select).in('id', tramo);
      if (c.igual) for (const [col, val] of Object.entries(c.igual)) q = q.eq(col, val);
      const r = await q;
      if (r.error) throw new Error(`${c.tabla}: ${r.error.message}`);
      const llegaron = new Set();
      for (const f of r.data) { if (!c.porId.has(f.id)) nuevas++; c.porId.set(f.id, f); llegaron.add(f.id); }
      // Pedida y no llegó: se borró, dejó de cumplir el filtro, o ya no se puede ver.
      for (const id of tramo) if (!llegaron.has(id)) c.porId.delete(id);
    }
    c.filas = [...c.porId.values()];
    if (nuevas && c.orden) {
      c.filas.sort(c.orden);                         // estable: lo que ya estaba conserva su orden
      c.porId = new Map(c.filas.map(f => [f.id, f])); // y el mapa sigue ese orden para la próxima vez
    }
    const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    console.log(`[Cambios] ${c.tabla}: ${c.traer.size} fila(s) traídas, ${c.quitar.size} quitada(s) · ${ms} ms`);
    c.traer.clear(); c.quitar.clear();
  }

  async function consultar(tabla, opciones = {}){
    const { select, order, igual } = opciones;
    const clave = firma(tabla, { select, order, igual });
    const c = copias.get(clave);
    if (c && !c.invalida) {
      if (c.traer.size || c.quitar.size) await refrescarCopia(c);
      return copiaDeFilas(c.filas);
    }
    const filas = await consultarTodo(tabla, opciones);
    copias.set(clave, nuevaCopia({ tabla, select, order, igual, filas }));
    return copiaDeFilas(filas);
  }
  function nuevaCopia({ tabla, select, order, igual, filas, traer = [], quitar = [], invalida = false }){
    const conId = columnasRaiz(select).includes('id');
    return {
      tabla, select, order, igual, orden: compara(order),
      filas, porId: conId ? new Map(filas.map(f => [f.id, f])) : null,
      depende: anidadas(select), traer: new Set(traer), quitar: new Set(quitar), invalida,
    };
  }

  /* Para guardar las copias en el navegador (etapa 2) y recuperarlas al
     abrir. Viajan las filas tal como vinieron de la base, más lo que haya
     anotado y todavía sin traer: así nada avisado se pierde por el camino. */
  consultar.exportarCopias = function exportarCopias(){
    return [...copias.values()].filter(c => !c.invalida).map(c => ({
      tabla: c.tabla, select: c.select, order: c.order, igual: c.igual, filas: c.filas,
      traer: [...c.traer], quitar: [...c.quitar],
    }));
  };
  consultar.importarCopias = function importarCopias(lista){
    copias.clear();
    for (const x of lista || []) {
      if (!x || !x.tabla || !Array.isArray(x.filas)) continue;
      copias.set(firma(x.tabla, x), nuevaCopia(x));
    }
    return copias.size;
  };

  /* cambios: [{ tabla, clave, accion: 'I'|'U'|'D' }], tal como los da
     core.cambios_desde. Solo anota; las filas se traen en la próxima lectura. */
  consultar.anotarCambios = function anotarCambios(cambios){
    for (const c of copias.values()) {
      if (c.invalida) continue;
      for (const x of cambios) {
        if (x.tabla === c.tabla) {
          if (!c.porId) { c.invalida = true; break; }
          if (x.accion === 'D') { c.quitar.add(x.clave); c.traer.delete(x.clave); }
          else { c.traer.add(x.clave); c.quitar.delete(x.clave); }
        } else if (c.depende.has(x.tabla)) { c.invalida = true; break; }
      }
      // Muchos a la vez: es más barato releerla entera que pedirlos de cien en cien.
      if (c.traer.size > 500) c.invalida = true;
    }
  };
  /* Olvida todo: la siguiente lectura va entera a la base. */
  consultar.olvidar = function olvidar(){ copias.clear(); primeraPagina.clear(); };

  async function consultarTodo(tabla, { select, order, igual } = {}){
    /* Traer una tabla que no cabe en una respuesta. Tres intentos hicieron
       falta para acertar, y la medición del 18/11 es la que lo decidió:

         marcaciones:  1,436 filas en 7 peticiones · 1,111 ms cada una
         produccion:   1,967 filas en 7 peticiones · 1,882 ms cada una
         propinas:     1,063 filas en 7 peticiones · 2,205 ms cada una

       Dos cosas saltan a la vista. La primera es que sobran peticiones: con
       1,436 filas bastaban dos, no siete. Las otras cinco eran el disparo
       especulativo del intento anterior, que pedía seis tramos a la vez y
       paraba al llegar uno corto —pero los seis ya habían salido—. La segunda
       es que el tiempo por petición SUBE cuanto más hay en vuelo: el servidor
       las encola. Paralelizar no acelera nada; solo reparte la misma espera.

       Así que la regla es pedir POCAS VECES, no pedir a la vez. Se empieza
       pidiendo tramos grandes. Si el servidor devuelve menos de lo pedido hay
       dos explicaciones posibles —se acabaron las filas, o el servidor tiene
       su propio tope— y confundirlas perdería datos en silencio, que es
       justo el fallo que ya nos costó una tarde. Así que se comprueba con una
       petición más: si viene vacía, se acabaron; si trae filas, era el tope y
       se adopta como tamaño de tramo. */
    const TRAMO_GRANDE = 5000;
    const pide = (desde, cuantas) => {
      let q = sb.schema('core').from(tabla).select(select);
      if(igual) for(const [col, val] of Object.entries(igual)) q = q.eq(col, val);
      if(order) q = q.order(order);
      return q.range(desde, desde + cuantas - 1);
    };

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let peticiones = 0;
    /* Aquí hubo un atajo que parecía limpio: PostgREST responde 206 cuando la
       respuesta se queda corta y 200 cuando está completa, así que bastaba
       mirar el código y la sonda sobraba.

       Es falso, y falso del peor modo. Supabase responde 200 AUNQUE haya
       cortado la lista por su tope de max-rows, así que el atajo paraba en mil
       filas y devolvía una sexta parte del inventario sin un solo error:
       6,012 conteos quedaron en 1,000 y el salón en 145 de 851. Datos
       incompletos que parecen completos es el fallo más caro que puede tener
       esto, porque nada lo denuncia.

       Tampoco sirve al revés —fiarse solo del 206 para saber que hay más—,
       porque entonces una respuesta completa que llegue con 206 se tomaría
       por un corte del servidor y se anunciaría un tope que no existe. Si el
       código no es de fiar en un sentido, no se usa en ninguno.

       Queda una sola regla, y no adivina nada: una respuesta más corta de lo
       pedido es ambigua —se acabaron las filas, o el servidor cortó— y una
       petición más lo aclara. El tope aprendido se guarda para toda la
       conexión, así que esa petición se paga una vez, no una por tabla. */
    const trae = async (desde, cuantas) => {
      peticiones++;
      const r = await pide(desde, cuantas);
      if(r.error) throw new Error(`${tabla}: ${r.error.message}`);
      if(r.data.length > pisoTope) pisoTope = r.data.length;
      return r.data;
    };
    const reporta = (n) => {
      const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
      console.log(`[Carga] ${tabla}: ${ms} ms · ${n} fila(s) · ${peticiones} petición(es)`);
    };

    let tramo = topeServidor || TRAMO_GRANDE;
    /* Si calibrar() ya trajo esta primera página, se usa y no se vuelve a
       pedir: la calibración no cuesta ninguna petición de más. */
    const clave = firma(tabla, { select, order, igual });
    const guardada = primeraPagina.get(clave);
    let filas, yaCompleta = false;
    if(guardada){
      primeraPagina.delete(clave);
      filas = guardada.filas.slice();
      peticiones += guardada.peticiones;
      yaCompleta = guardada.completa;
    } else {
      filas = await trae(0, tramo);
    }
    if(yaCompleta){ reporta(filas.length); return filas; }

    while(true){
      if(filas.length % tramo === 0 && filas.length > 0){
        // El último tramo vino lleno: puede quedar más.
        if(!order)
          throw new Error(`${tabla}: no cabe en una sola respuesta y hay que pedirla por `
            + 'tramos, pero no se pidió ningún orden. Sin un orden único la paginación '
            + 'se salta filas. Añade order a esta consulta.');
        const mas = await trae(filas.length, tramo);
        filas.push(...mas);
        if(mas.length < tramo) break;
        continue;
      }
      /* Vino corto. Si ya sabemos cuánto corta el servidor, no hay ambigüedad:
         corto significa que se acabaron las filas. */
      if(filas.length === 0) break;
      if(topeServidor && filas.length < topeServidor) break;
      /* Por debajo de lo que este servidor ya ha devuelto de una vez: no
         puede ser un corte suyo, así que se acabaron las filas. */
      if(filas.length < pisoTope) break;
      /* Todavía no lo sabemos: ¿se acabaron las filas o el servidor cortó?
         Una petición más lo aclara, y es barata comparada con perder datos.
         La respuesta se guarda para toda la sesión, así que esto se paga una
         sola vez y no una por tabla. */
      const sonda = await trae(filas.length, tramo);
      if(!sonda.length){
        /* Se acabaron. Y si pedimos menos de lo que cabía, no aprendimos
           ningún tope: el servidor nunca llegó a cortarnos. */
        break;
      }
      if(!order)
        throw new Error(`${tabla}: el servidor devuelve como mucho ${filas.length} filas `
          + 'por respuesta y hay que paginar, pero no se pidió ningún orden. '
          + 'Añade order a esta consulta.');
      tramo = filas.length;                     // ese era el tope del servidor
      if(!topeServidor){
        topeServidor = tramo;
        console.log(`[Carga] El servidor devuelve como mucho ${tramo} filas por respuesta.`
          + ' Se puede subir en Supabase: Settings → API → Max rows.');
      }
      filas.push(...sonda);
      if(sonda.length < tramo) break;
    }

    reporta(filas.length);
    return filas;
  }

  /* Trae la primera página de la tabla MÁS GRANDE y resuelve de una vez la
     ambigüedad de las respuestas cortas, dejando la cota puesta para todas las
     demás. Quien llame espera esto ANTES de lanzar el resto en paralelo.

     No gasta nada: esa página hacía falta igual, se guarda y la consulta de
     verdad la recoge. Lo único que se paga es que la tabla grande empiece
     sola, y es la que marca el tiempo de todos modos. */
  consultar.calibrar = async function calibrar(tabla, opciones = {}){
    const { select, order, igual } = opciones;
    // Con copia vigente no hay nada que calibrar: esa consulta no irá a la base.
    const copia = copias.get(firma(tabla, { select, order, igual }));
    if (copia && !copia.invalida) return;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let peticiones = 0;
    const pedir = async (desde, cuantas) => {
      peticiones++;
      let q = sb.schema('core').from(tabla).select(select);
      if(igual) for(const [col, val] of Object.entries(igual)) q = q.eq(col, val);
      if(order) q = q.order(order);
      const r = await q.range(desde, desde + cuantas - 1);
      if(r.error) throw new Error(`${tabla}: ${r.error.message}`);
      if(r.data.length > pisoTope) pisoTope = r.data.length;
      return r.data;
    };
    const tramo = topeServidor || 5000;
    const filas = await pedir(0, tramo);
    let completa = false;
    /* Vino corta y no hay con qué compararla: una petición más dice si se
       acabaron las filas o si el servidor cortó. Es la única sonda de toda la
       carga, y deja a las otras veinte sin pagarla. */
    if(filas.length > 0 && filas.length < tramo && filas.length >= pisoTope){
      const sonda = await pedir(filas.length, tramo);
      if(sonda.length){
        topeServidor = filas.length;
        console.log(`[Carga] El servidor devuelve como mucho ${topeServidor} filas por respuesta.`
          + ' Se puede subir en Supabase: Settings → API → Max rows.');
        filas.push(...sonda);
      } else {
        /* La sonda dijo que se acabaron. Se anota, porque si no la consulta de
           verdad vuelve a sondear: su regla es «corta = completa SI queda por
           debajo de la cota», y estas filas son justo la cota. */
        completa = true;
      }
    }
    primeraPagina.set(firma(tabla, { select, order, igual }), { filas, peticiones, completa });
    const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    console.log(`[Carga] calibrado con ${tabla}: ${ms} ms · ${peticiones} petición(es)`
      + ` · una respuesta cabe al menos ${pisoTope} fila(s)`);
  };

  return consultar;
}

/* ═══════════════════════════════════════════════════════════════════════════
   RESPALDO COMPLETO
   ---------------------------------------------------------------------------
   Copia de cada tabla TAL CUAL está en la base: todas las filas (también lo
   retirado y lo desactivado), con sus ids y versiones. A diferencia de la
   exportación con forma de hoja, con esto la base se reconstruye exacta
   (nucleo/restaurar-respaldo.py genera el SQL).

   · En el orden en que se restauran: primero lo que otros referencian.
   · Cada tabla se lee por páginas ordenadas por su clave primaria, y al final
     se cuenta en la base: si no coincide, se relee una vez y, si sigue sin
     coincidir, el respaldo FALLA. Un respaldo al que le faltan filas sin
     decirlo es peor que ninguno.
   · Las de administración y las de analítica (externo) son de referencia: si
     no se pueden leer se anota y se sigue; las de datos son obligatorias.
   ═══════════════════════════════════════════════════════════════════════════ */
export const TABLAS_RESPALDO = [
  // Administración: referencia (el esquema las vuelve a crear; los roles se reasignan por correo).
  { esquema: 'core', tabla: 'roles',        clave: ['id'], referencia: true },
  { esquema: 'core', tabla: 'permisos',     clave: ['id'], referencia: true },
  { esquema: 'core', tabla: 'rol_permiso',  clave: ['rol_id', 'permiso_id'], referencia: true },
  { esquema: 'core', tabla: 'usuarios',     clave: ['id'], referencia: true },
  { esquema: 'core', tabla: 'usuario_rol',  clave: ['usuario_id', 'rol_id'], referencia: true },
  // Planilla
  { esquema: 'core', tabla: 'empleados',              clave: ['id'] },
  { esquema: 'core', tabla: 'condiciones_laborales',  clave: ['id'] },
  { esquema: 'core', tabla: 'horarios',               clave: ['id'] },
  { esquema: 'core', tabla: 'marcaciones',            clave: ['id'] },
  { esquema: 'core', tabla: 'descuentos',             clave: ['id'] },
  { esquema: 'core', tabla: 'pagos_extra',            clave: ['id'] },
  { esquema: 'core', tabla: 'dias_libres',            clave: ['id'] },
  { esquema: 'core', tabla: 'feriados',               clave: ['fecha'] },
  { esquema: 'core', tabla: 'considerar_hora_extra',  clave: ['id'] },
  { esquema: 'core', tabla: 'exoneraciones_tardanza', clave: ['id'] },
  { esquema: 'core', tabla: 'quincenas_cierre',       clave: ['id'] },
  { esquema: 'core', tabla: 'propinas',               clave: ['id'] },
  { esquema: 'core', tabla: 'validacion_tarjeta',     clave: ['fecha'] },
  { esquema: 'core', tabla: 'efectivo_caja',          clave: ['id'] },
  // Inventario
  { esquema: 'core', tabla: 'insumos',      clave: ['id'] },
  { esquema: 'core', tabla: 'stock_diario', clave: ['id'] },
  { esquema: 'core', tabla: 'produccion',   clave: ['id'] },
  { esquema: 'core', tabla: 'articulos',    clave: ['id'] },
  { esquema: 'core', tabla: 'conteos',      clave: ['id'] },
  { esquema: 'core', tabla: 'movimientos',  clave: ['id'] },
  // Analítica: lo propio (la lista de platos, sus meses congelados y los contactos de remarketing).
  { esquema: 'core', tabla: 'platos',          clave: ['id'] },
  { esquema: 'core', tabla: 'platos_mes_fijo', clave: ['plato_id', 'mes'] },
  { esquema: 'core', tabla: 'remarketing',     clave: ['id'] },
  // Referencia (se puede volver a importar desde su hoja).
  { esquema: 'externo', tabla: 'caja_dia',        clave: ['fecha', 'fuente'], referencia: true },
  /* Las ventas de IDBI (externo.ventas_orden y ventas_producto) NO van en el
     respaldo diario: son ~40 000 filas y crecen cada día (el archivo pasaría
     de pocos MB a más de 60). Se pueden volver a traer de IDBI, y mientras el
     spreadsheet de Analítica siga vivo, también de él (cargar-analitica.js).
     Antes de retirar el spreadsheet se les dará un respaldo propio. */
];

export async function crearRespaldo(sb, { alAvanzar = () => {}, tablas = TABLAS_RESPALDO } = {}){
  const respaldo = { formato: 'wingsbox-respaldo', version: 1, generado: new Date().toISOString(),
                     tablas: {}, cuentas: {}, avisos: [] };
  const PAGINA = 1000;
  async function leer(t){
    const filas = [];
    for (let desde = 0; ; ) {
      let q = sb.schema(t.esquema).from(t.tabla).select('*');
      for (const c of t.clave) q = q.order(c, { ascending: true });
      const r = await q.range(desde, desde + PAGINA - 1);
      if (r.error) throw new Error(r.error.message);
      if (!r.data.length) break;
      filas.push(...r.data);
      desde += r.data.length;     // si la base corta antes de PAGINA, se sigue desde donde cortó
    }
    const c = await sb.schema(t.esquema).from(t.tabla).select('*', { count: 'exact', head: true });
    if (c.error) throw new Error(c.error.message);
    return { filas, cuenta: c.count };
  }
  for (const [i, t] of tablas.entries()) {
    const nombre = `${t.esquema}.${t.tabla}`;
    alAvanzar({ tabla: nombre, n: i + 1, de: tablas.length });
    try {
      let { filas, cuenta } = await leer(t);
      if (cuenta !== filas.length) ({ filas, cuenta } = await leer(t));   // alguien escribió mientras: otra vez
      if (cuenta !== filas.length)
        throw new Error(`se leyeron ${filas.length} filas y la base dice ${cuenta}`);
      respaldo.tablas[nombre] = filas;
      respaldo.cuentas[nombre] = filas.length;
    } catch (e) {
      if (!t.referencia) throw new Error(`Respaldo incompleto: ${nombre}: ${e.message}`);
      respaldo.avisos.push(`${nombre}: no se pudo leer (${e.message})`);
    }
  }
  return respaldo;
}
