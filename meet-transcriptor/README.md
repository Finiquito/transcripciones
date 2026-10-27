# Meet Transcriptor

Extensión de Chrome (Manifest V3) para uso personal. Captura los **subtítulos en vivo de Google Meet** y los guarda como transcripción: hablante, texto y hora. JavaScript puro, sin frameworks ni build.

> Úsala respetando a los demás participantes: avísales que estás transcribiendo la reunión.

## Cómo cargarla en Chrome

1. Abre `chrome://extensions`.
2. Activa **Modo de desarrollador** (arriba a la derecha).
3. Haz clic en **Cargar descomprimida** y elige la carpeta `meet-transcriptor/`.
4. (Opcional) Ancla la extensión con el ícono del puzzle para tener el botón a mano.

Requiere Chrome 114 o superior (por `chrome.sidePanel`). La extensión no trae íconos propios: Chrome muestra una letra por defecto.

Si editas algún archivo, vuelve a `chrome://extensions`, pulsa el botón de recargar de la extensión y **recarga la pestaña de Meet** (los content scripts solo se inyectan al cargar la página).

## Cómo usarla

1. Entra a una reunión en `https://meet.google.com/…`.
2. Activa los subtítulos en Meet (botón **CC**).
3. Haz clic en el ícono de la extensión: se abre el **side panel**.
4. La transcripción aparece en vivo. El texto en gris cursiva es lo que aún se está diciendo; cuando se estabiliza pasa a ser una intervención guardada.

Barra de estado del panel: te dice si hay una reunión abierta y si se detectaron los subtítulos.

### Side panel

| Elemento | Qué hace |
|---|---|
| Selector de reunión | Por defecto muestra la última. Puedes elegir reuniones anteriores. |
| **Copiar** | Copia al portapapeles `[hh:mm:ss] Nombre: texto`, una línea por intervención. |
| **Exportar .md** | Descarga `meet-<código>-<fecha>.md` con cabecera (fecha, código) y la transcripción. |
| **Eliminar** | Borra la reunión mostrada (pide confirmación). |
| Ocultar subtítulos en Meet | Los oculta con CSS (`opacity: 0`) **sin desactivarlos**, así Meet sigue generándolos y la extensión sigue leyéndolos. |
| Modo debug | Imprime en la consola de Meet los nodos candidatos (ver más abajo). |
| Estabilizar tras (ms) | Cuánto debe quedar quieto un texto para guardarlo. Por defecto 1500. |

### Cómo se evitan los duplicados

Meet reescribe el subtítulo mientras la persona habla, así que no se guarda en cada cambio. Un bloque se guarda cuando:

- su texto lleva `stabilizeMs` sin cambiar, o
- cambia el hablante del bloque, o
- Meet quita el bloque de pantalla.

Si el hablante sigue en el mismo bloque, la intervención ya guardada **se actualiza** en vez de duplicarse (incluso cuando Meet recorta el inicio de un bloque muy largo).

### Dónde se guardan los datos

En **IndexedDB** de la extensión (base `meet-transcriptor`, almacén `meetings`). Un registro por código de reunión y día:

```json
{ "id": "abc-defg-hij_2026-10-27", "code": "abc-defg-hij", "date": "2026-10-27T14:49:39.077Z",
  "entries": [{ "id": "…", "speaker": "Ana", "text": "Hola a todos", "time": "2026-10-27T14:49:39.077Z" }] }
```

Todo es local: la extensión no hace ninguna petición de red. Se puede inspeccionar en DevTools del service worker (`chrome://extensions` → *service worker* → Application → IndexedDB).

## Estructura

```
meet-transcriptor/
├── manifest.json     MV3: content script, service worker, side panel
├── selectors.js      TODOS los selectores del DOM de Meet  ← lo que tocarás si Meet cambia
├── content.js        MutationObserver, lectura de bloques, estabilización
├── debug.js          modo debug (candidatos y nodos "calientes" en consola)
├── background.js     service worker: abre el panel y guarda en IndexedDB
├── db.js             acceso a IndexedDB (compartido por background y panel)
└── sidepanel.*       interfaz del side panel
```

## Cómo ajustar `selectors.js` si deja de funcionar

Meet cambia su DOM sin avisar. Los síntomas típicos: el panel dice **"esperando subtítulos"** aunque el CC esté activo, o se capturan nombres/textos mezclados.

### 1. Activa el modo debug

Abre el side panel → **Ajustes** → marca **Modo debug**. Luego abre la consola de la pestaña de Meet (`F12` → *Console*; el contexto debe ser `top`). Verás:

- **"N nodo(s) candidato(s) a contenedor de subtítulos"**: tabla con etiqueta, `role`, `aria-label`, `aria-live`, texto y ruta CSS. Los nodos se dibujan en la página con contorno **magenta discontinuo**.
- **"Nodos con más cambios de texto"** (cada 3 s): los subtítulos en vivo son los nodos que más se reescriben; suelen salir arriba y se marcan con contorno **naranja**.
- Cada bloque leído (`bloque Ana → texto…`) y cada intervención guardada.

En la consola, haz clic derecho sobre un nodo impreso → *Reveal in Elements panel* para inspeccionarlo.

### 2. Corrige el selector que corresponda

| Problema | Qué editar en `selectors.js` |
|---|---|
| Nunca detecta los subtítulos (estado "esperando subtítulos") | `captionsRegion`: pon primero un selector para el contenedor que viste en debug. Ejemplo: `'[role="region"][aria-label="Subtítulos"]'`. Ojo con el idioma de la interfaz: el `aria-label` está traducido. |
| Detecta la región pero mezcla a varios hablantes en un solo texto | `block`: selector de cada bloque de hablante, relativo a la región. Ejemplo: `':scope > div > div'`. |
| El nombre sale mal (o incluye texto extra) | `speaker`: selector del nombre **dentro** del bloque. |
| El texto sale mal | `text`: selector del texto **dentro** del bloque. |
| Aparece texto basura (botones, íconos) | Añade el selector a `ignore`. |
| El código de reunión sale como `sin-codigo` | Revisa la expresión `meetingCode`. |

Reglas de oro:

- **Prioriza `role` y `aria-*`** sobre clases. Las clases de Meet están ofuscadas y cambian seguido.
- Cada lista se prueba **en orden**; gana el primer selector que encuentre algo. Un selector inválido se ignora sin romper nada.
- `block`, `speaker` y `text` son opcionales: vacíos, `content.js` usa heurísticas (por avatar `<img>` y estructura del DOM). Solo defínelos si la heurística falla.
- La lista `captionsRegion` también se usa para generar el CSS de "ocultar subtítulos".

### 3. Recarga y prueba

`chrome://extensions` → recargar la extensión → recargar la pestaña de Meet → revisar que la consola muestre `región de subtítulos detectada`.

## Limitaciones conocidas

- Los selectores por defecto se escribieron a partir de la estructura típica de Meet (región con `aria-label` de "Subtítulos" y un bloque por hablante con avatar), **sin poder probarlos contra el Meet real**. Si no funcionan a la primera, el modo debug está hecho justo para eso. La lógica de captura se verificó contra una página de prueba que simula ese DOM.
- La transcripción es tan buena como los subtítulos de Meet: idioma, nombres y puntuación dependen de Google.
- Solo se capturan los subtítulos mientras la pestaña de Meet está abierta con CC activo. Lo dicho antes de activarlos no queda registrado.
- Si dos reuniones distintas usan el mismo código el mismo día, se guardan juntas en un mismo registro.
