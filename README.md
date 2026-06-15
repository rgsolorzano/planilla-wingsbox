# Sistema de Planilla Quincenal (WingsBox)

Aplicación de una sola página (`index.html`) para calcular planillas quincenales.
Los datos viven en `localStorage` del navegador y pueden:

- Exportarse / importarse como **Excel local** (módulo Administración), o
- Sincronizarse **online con Google Sheets** (login con Google).

La sincronización con Google Sheets es **opcional**: no reemplaza al Excel, es una
alternativa para guardar/cargar los datos online y usarlos desde otro dispositivo.

---

## Despliegue en GitHub Pages

La app está pensada para desplegarse en:

```
https://rgsolorzano.github.io/planilla-wingsbox/index.html
```

El archivo que se publica en GitHub Pages debe ser el `index.html` del repositorio
`planilla-wingsbox`. Si trabajas sobre `Nat/index.html`, copia su contenido al
`index.html` que publica GitHub Pages.

---

## Configuración de Google (una sola vez)

Para que funcione el login y la sincronización con Google Sheets necesitas un
**OAuth Client ID** de Google Cloud. El Client ID **no es secreto** y puede ir en el
frontend. **Nunca** pongas un *client secret* en el código público.

### 1. Crear / elegir un proyecto en Google Cloud Console
- Entra a https://console.cloud.google.com/ y crea (o selecciona) un proyecto.

### 2. Habilitar las APIs necesarias
En "APIs y servicios" → "Biblioteca", habilita:
- **Google Sheets API**
- **Google Drive API** (se usa solo para detectar/crear el spreadsheet por nombre)

### 3. Configurar la pantalla de consentimiento de OAuth
- "APIs y servicios" → "Pantalla de consentimiento de OAuth".
- Tipo de usuario: **Externo** (o Interno si es una organización Workspace).
- Completa nombre de la app, correo de soporte, etc.
- En **Scopes**, agrega:
  ```
  openid
  email
  profile
  https://www.googleapis.com/auth/drive.file
  ```
  `email`/`profile`/`openid` permiten identificar al usuario (login); `drive.file`
  da acceso solo a los archivos que crea esta app (no ve el resto de tu Drive).
- Si la app queda en estado **"Testing"**, agrega como **usuario de prueba** el
  correo autorizado (`multiboxes.peru@gmail.com`), o no podrá iniciar sesión.

### 4. Crear el OAuth Client ID
- "APIs y servicios" → "Credenciales" → "Crear credenciales" →
  **"ID de cliente de OAuth"**.
- Tipo de aplicación: **Aplicación web**.
- En **Orígenes autorizados de JavaScript** agrega:
  ```
  https://rgsolorzano.github.io
  ```
  Para pruebas locales agrega también el origen donde sirves la app, por ejemplo:
  ```
  http://localhost:5500
  ```
  > Importante: solo va el **origen** (esquema + dominio + puerto), sin rutas ni
  > `index.html`.

### 5. Pegar el Client ID en el código
En `index.html`, dentro del bloque "MÓDULO 12: SINCRONIZACIÓN CON GOOGLE SHEETS",
edita la constante:

```js
const GOOGLE_CLIENT_ID = 'TU_CLIENT_ID.apps.googleusercontent.com';
```

> Client ID ya configurado en este proyecto:
> `809499583884-4st99bjc39crnrbhuc1p2ncjp7dnnohp.apps.googleusercontent.com`

---

## Control de acceso (login restringido)

La aplicación está protegida por una pantalla de **login con Google**. Al abrir la
app solo se ve la pantalla "Acceso restringido"; el contenido principal permanece
oculto hasta iniciar sesión con la cuenta autorizada.

- El correo autorizado se define en `index.html`:
  ```js
  const GOOGLE_CLIENT_ID = "...apps.googleusercontent.com";
  const AUTHORIZED_EMAIL = "multiboxes.peru@gmail.com";
  ```
- Si el correo autenticado coincide con `AUTHORIZED_EMAIL`, se muestra la app y se
  habilitan guardar/cargar en Google Sheets.
- Si el correo no coincide, se muestra "Acceso denegado..." y la app queda oculta.
- "Cerrar sesión" revoca el token y vuelve a la pantalla de login.
- La sesión se reintenta de forma silenciosa al recargar (mientras Google la
  conserve). En `localStorage` solo se guarda el correo como pista (`pl_auth_email`),
  nunca contraseñas ni tokens.

> IMPORTANTE: al ser una app frontend estática, esta validación controla la
> **interfaz**. La seguridad REAL de los datos se logra compartiendo el Google
> Spreadsheet (y habilitando la cuenta) **solo** con `multiboxes.peru@gmail.com`.
> No se almacenan contraseñas ni *client secrets* en el código.

---

## Cómo funciona la sincronización

1. El usuario abre la app y va a **Administración**.
2. Pulsa **Iniciar sesión con Google** y autoriza el acceso.
3. La app busca un spreadsheet llamado **`WingsBox Planilla - Datos`**:
   - Si recuerda el ID (en `localStorage`, clave `pl_gsheetId`), lo reutiliza.
   - Si no, lo busca por nombre en Drive (también detecta el creado en otro dispositivo).
   - Si no existe, lo crea automáticamente.
4. **Guardar en Google Sheets**: vuelca todos los datos actuales a las hojas.
5. **Cargar desde Google Sheets**: reemplaza los datos locales con los últimos guardados.

Desde otro dispositivo: abre la misma URL, inicia sesión con la **misma cuenta de
Google** y pulsa **Cargar desde Google Sheets**.

### Datos que se sincronizan
Cada colección va en su propia hoja del spreadsheet:

| Hoja | Contenido |
|------|-----------|
| `Empleados` | Personal, tipo (Mesero/Cocina), esLibre y sueldos |
| `Horarios` | Horario por día de cada empleado |
| `Marcaciones` | Horas trabajadas (entrada/salida reales) |
| `Descuentos` | Descuentos manuales |
| `PagosExtra` | Bonos y pagos extra |
| `DiasLibres` | Días libres y vacaciones |
| `Propinas` | Propinas por mesero y día (efectivo, yape, plin, tarjeta) |
| `ValidacionTarjeta` | Montos Niubiz/Caja por día para la validación |
| `ConsiderarHoraExtra` | Preferencias de horas extra por día |
| `ExoneracionTardanza` | Exoneraciones de tardanza por empleado y día (activa, horas) |
| `Meta` | Metadatos (última sincronización) |

### Tardanzas, exoneración y bono de puntualidad

- En **Cálculo quincenal**, cada día con tardanza muestra un checkbox **"Exoneración de tardanza"** y un campo **"Horas de tardanza a exonerar"**. La tardanza neta es `max(0, tardanzaOriginal − horasExoneradas)` (nunca negativa y nunca mayor a la original). La exoneración aplica solo a ese empleado y día, afecta el descuento del día y el acumulado mensual, y se guarda automáticamente.
- **Bono de puntualidad (S/ 25):** se otorga solo en la **2ª quincena** si el retraso mensual neto (suma de tardanzas netas de ambas quincenas, en minutos = horas × 60) es **≤ 15 min**. Se muestra en una columna del Consolidado (con los minutos acumulados del mes) y se suma al total a pagar.
- **Descuentos:** al crear nuevos descuentos ya no aparecen los tipos "Falta" ni "No marcación"; los registros históricos con esos tipos se siguen mostrando y editando sin cambios.

---

## Notas de seguridad

- Se usa **Google Identity Services** con flujo de **token** en el navegador.
- El **access token** vive solo en memoria; nunca se guarda en disco/localStorage.
- Scope **mínimo** `drive.file`: la app solo accede a los archivos que ella crea.
- No hay secretos en el código público (solo el Client ID, que es público por diseño).
