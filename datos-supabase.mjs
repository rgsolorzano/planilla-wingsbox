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
    const hojas = {};

    /* ── Empleados ─────────────────────────────────────────────────────────
       Las columnas sueltas son la condición VIGENTE; la columna 'condiciones'
       lleva el histórico completo en JSON. Así lo guarda hoy la app. */
    const condiciones = await consultar('condiciones_laborales', {
      select: 'id_externo, desde, hasta, puesto, sueldo_quincenal, sueldo_planilla, ' +
              'sueldo_hora, afp_comision, ajuste_planilla, horas_cierre, es_libre, ' +
              'empleados!inner(id_externo)',
    });
    const porEmpleado = new Map();
    for(const c of condiciones.sort(porClaves(r => r.empleados.id_externo, r => r.desde))){
      const lista = porEmpleado.get(c.empleados.id_externo) || [];
      lista.push({
        id: c.id_externo, desde: c.desde, hasta: c.hasta || null, tipo: c.puesto,
        sueldoQuincenal: num(c.sueldo_quincenal), sueldoPlanilla: num(c.sueldo_planilla),
        sueldoHora: num(c.sueldo_hora), afpComision: num(c.afp_comision),
        ajustePlanilla: num(c.ajuste_planilla), horasCierre: num(c.horas_cierre),
        esLibre: c.es_libre === true || c.es_libre === 't',
      });
      porEmpleado.set(c.empleados.id_externo, lista);
    }

    const empleados = await consultar('empleados', {
      select: 'id_externo, nombre, documento, fecha_ingreso, activo, visible',
      order: 'nombre',          // lo ordena PostgreSQL, con su propia colación
    });
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
    }

    /* ── Horarios ──────────────────────────────────────────────────────── */
    const horarios = await consultar('horarios', {
      select: 'dia_semana, libre, entrada, salida, orden, ' +
              'empleados!inner(id_externo), condiciones_laborales(id_externo)',
      order: 'orden',
    });
    hojas.Horarios = [['empleadoId','dia','libre','entrada','salida','condicionId']];
    for(const h of horarios){
      hojas.Horarios.push([
        h.empleados.id_externo, Number(h.dia_semana), b01(h.libre),
        hm(h.entrada), hm(h.salida), t(h.condiciones_laborales?.id_externo),
      ]);
    }

    /* ── Marcaciones ───────────────────────────────────────────────────── */
    const marcaciones = (await consultar('marcaciones', {
      select: 'id, fecha, entrada_real, salida_real, origen, origen_entrada, origen_salida, ' +
              'empleados!inner(id_externo)',
    })).sort(porClaves(r => r.fecha, r => r.empleados.id_externo));
    hojas.Marcaciones = [['id','empleadoId','fecha','entradaReal','salidaReal','origen','origenEntrada','origenSalida']];
    for(const m of marcaciones){
      hojas.Marcaciones.push([
        m.id, m.empleados.id_externo, m.fecha, hm(m.entrada_real), hm(m.salida_real),
        m.origen, t(m.origen_entrada), t(m.origen_salida),
      ]);
    }

    /* ── Descuentos y pagos extra ──────────────────────────────────────────
       id_externo desempata: conserva el orden en que se escribieron en la
       hoja. No afecta ningún importe, pero sin él dos descuentos del mismo
       empleado y día salen en orden arbitrario. */
    for(const [hoja, tabla] of [['Descuentos','descuentos'], ['PagosExtra','pagos_extra']]){
      const filas = (await consultar(tabla, {
        select: 'id, id_externo, fecha, tipo, monto, detalle, empleados!inner(id_externo)',
      })).sort(porClaves(r => r.fecha, r => r.empleados.id_externo, r => r.id_externo));
      hojas[hoja] = [['id','empleadoId','fecha','tipo','monto','detalle']];
      for(const d of filas){
        hojas[hoja].push([d.id_externo || d.id, d.empleados.id_externo, d.fecha,
                          d.tipo, num(d.monto), t(d.detalle)]);
      }
    }

    /* ── Días libres, con los feriados devueltos a su forma de hoja ──────── */
    const libres = (await consultar('dias_libres', {
      select: 'id, fecha, tipo, detalle, empleados!inner(id_externo)',
    })).sort(porClaves(r => r.fecha, r => r.empleados.id_externo));
    hojas.DiasLibres = [['id','empleadoId','fecha','tipo','comentario']];
    for(const d of libres){
      hojas.DiasLibres.push([d.id, d.empleados.id_externo, d.fecha, d.tipo, t(d.detalle)]);
    }
    // Los feriados valen para toda la casa: en la hoja llevan empleadoId '*'.
    const feriados = await consultar('feriados', { select: 'fecha, nombre', order: 'fecha' });
    for(const f of feriados) hojas.DiasLibres.push(['', '*', f.fecha, 'Feriado', t(f.nombre)]);

    /* ── Interruptores por día ─────────────────────────────────────────── */
    const extras = (await consultar('considerar_hora_extra', {
      select: 'fecha, considerar, empleados!inner(id_externo)',
    })).sort(porClaves(r => r.fecha, r => r.empleados.id_externo));
    hojas.ConsiderarHoraExtra = [['empleadoId','fecha','considerar']];
    for(const c of extras) hojas.ConsiderarHoraExtra.push([c.empleados.id_externo, c.fecha, b01(c.considerar)]);

    const exos = (await consultar('exoneraciones_tardanza', {
      select: 'fecha, activa, horas, empleados!inner(id_externo)',
    })).sort(porClaves(r => r.fecha, r => r.empleados.id_externo));
    hojas.ExoneracionTardanza = [['empleadoId','fecha','activa','horas']];
    for(const x of exos) hojas.ExoneracionTardanza.push([x.empleados.id_externo, x.fecha, b01(x.activa), num(x.horas)]);

    /* ── Conciliación de tarjeta ───────────────────────────────────────── */
    const vt = await consultar('validacion_tarjeta', { select: 'fecha, niubiz, caja', order: 'fecha' });
    hojas.ValidacionTarjeta = [['fecha','niubiz','caja']];
    for(const v of vt) hojas.ValidacionTarjeta.push([v.fecha, num(v.niubiz), num(v.caja)]);

    /* ── Propinas: vive en inventario, pero la app la lee en ambos ─────── */
    /* id_externo desempata, igual que en los descuentos: una misma persona
       puede tener varias propinas el mismo día (una por medio de pago, y a
       veces varias del mismo medio). Sin el desempate salen en orden
       arbitrario y dos lecturas seguidas pueden diferir. */
    const propinas = (await consultar('propinas', {
      select: 'id, id_externo, fecha, medio, monto, ov, empleados!inner(id_externo)',
    })).sort(porClaves(r => r.fecha, r => r.empleados.id_externo, r => r.id_externo));
    hojas.Propinas = [['id','empleadoId','fecha','tipo','monto','ov']];
    for(const p of propinas){
      hojas.Propinas.push([p.id_externo || p.id, p.empleados.id_externo, p.fecha,
                           p.medio, num(p.monto), t(p.ov)]);
    }

    /* ── Meseros: quien tenga alguna condición con ese puesto ──────────── */
    const meseros = await consultar('condiciones_laborales', {
      select: 'puesto, empleados!inner(id_externo, nombre)',
      igual: { puesto: 'Mesero' },
    });
    const vistos = new Map();
    for(const m of meseros) vistos.set(m.empleados.id_externo, m.empleados.nombre);
    hojas.Meseros = [['id','nombre']];
    for(const [id, nombre] of [...vistos].sort(porClaves(r => r[1]))) hojas.Meseros.push([id, nombre]);

    // Meta es configuración de la app, no datos de negocio: no vive en la base.
    hojas.Meta = [['clave','valor'], ['app','WingsBox Planilla']];

    return hojas;
  }

  return { leerPlanilla };
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

  return { guardarConteo, explicar };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Implementación para el navegador, sobre supabase-js.
   Se pasa el cliente ya creado para que esta pieza no decida credenciales.
   ═══════════════════════════════════════════════════════════════════════════ */
export function consultarConSupabase(sb){
  return async function consultar(tabla, { select, order, igual } = {}){
    let q = sb.schema('core').from(tabla).select(select);
    if(igual) for(const [col, val] of Object.entries(igual)) q = q.eq(col, val);
    if(order) q = q.order(order);
    // PostgREST pagina a 1,000 filas por defecto y las marcaciones ya pasan de
    // eso. Sin paginar, la app recibiría una planilla incompleta sin avisar.
    const filas = [];
    const TRAMO = 1000;
    for(let desde = 0; ; desde += TRAMO){
      const { data, error } = await q.range(desde, desde + TRAMO - 1);
      if(error) throw new Error(`${tabla}: ${error.message}`);
      filas.push(...data);
      if(data.length < TRAMO) break;
    }
    return filas;
  };
}
