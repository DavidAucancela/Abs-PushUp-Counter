# Mejorar el encuadre: avatar 3D en vivo + fantasma de referencia + checklist accionable

## Contexto

En `web/template.html`, la tarjeta "Encuadre" (`#setupcard`) muestra 4 checks binarios
(`chk-body`, `chk-profile`, `chk-light`, `chk-stable`) que deben cumplirse TODOS a la vez
para habilitar "Iniciar prueba". Dos problemas reales detectados:

1. Encontrar la distancia/posición exacta a la que los 4 se cumplen simultáneamente es
   ensayo-y-error puro — el checklist solo dice ✓/✗, nunca QUÉ corregir ni CUÁNTO.
2. No queda claro CÓMO debe pararse/acostarse frente a la cámara — no hay ninguna
   referencia visual de la pose esperada, solo texto genérico (`$('status').textContent`).

Decisión ya tomada (confirmada con el usuario):
- Un **avatar 3D real** (Three.js) que replica su pose en vivo usando los `worldLandmarks`
  3D que ya entrega MediaPipe PoseLandmarker (no solo los 2D que ya se usan).
- Un **fantasma/silueta de referencia superpuesto directamente sobre su propio video**,
  mostrando dónde y de qué tamaño debe verse su cuerpo — ataca directo el problema de
  "a qué distancia pararme".
- Alcance: ambos ejercicios (`situp` y `pushup`), cada uno con su propia pose de referencia.
- El checklist deja de ser binario mudo: cada uno de los 4 ítems pasa a mostrar un mensaje
  específico y accionable, reutilizando las métricas que `runSetupChecks` ya calcula.

Todo el trabajo es en **un solo archivo fuente**: `web/template.html` (`abs-counter.html` es
generado por `npm run build` vía `scripts/build-web.mjs` — nunca se edita a mano). No toca
el núcleo TS (`src/*`) ni el pipeline de build, porque toda la Capa 3 (host) ya vive fuera
del bundle, cargando dependencias por CDN ESM (mismo patrón que ya usa MediaPipe).

## Adenda: orientación lateral izq/der inteligente (sin soporte frontal)

Feedback real del usuario tras usar la app: exigir "de perfil" sin más contexto es difícil
de cumplir a ciegas. Se evaluaron dos caminos:

- **Motor 3D invariante a la cámara** (recalcular el ángulo con `worldLandmarks` en vez de
  coordenadas 2D de pantalla): permitiría contar reps también de frente, pero rompe el
  contrato congelado de `src/types.ts` (`Keypoint` no tiene `z`), obliga a recalibrar todos
  los umbrales desde cero, e invalida las 5 sesiones ya grabadas en `resultados/` (no
  guardaron profundidad). Descartado por ahora — demasiado riesgo para un spike que ya tiene
  datos parcialmente calibrados.
- **Lateral izquierdo/derecho inteligente, sin frontal (elegido):** el motor de ángulos 2D
  no se toca. Se agrega una clasificación de orientación en la Capa 3 (`web/template.html`)
  que distingue perfil-izquierdo / perfil-derecho / de-frente, y usa esa clasificación tanto
  para los mensajes del checklist como para el avatar 3D y el fantasma — así cualquiera de
  los dos lados de perfil es válido (ya lo era implícitamente, el ratio hombros/torso no
  distingue lado), y de frente se avisa explícitamente que no cuenta reps en vez de
  intentarlo mal.

Esto se integra en el punto 5 (checklist accionable) del enfoque original, agregando:

- `computeOrientation(frame)`: usa el mismo ratio `dSh/torso` ya calculado en
  `runSetupChecks`, más un heurístico de lado (`(ls.score+lh.score)` vs `(rs.score+rh.score)`
  — el lado más visible/menos autoocluido es el que el usuario está mostrando a cámara) para
  devolver `{ kind: 'left' | 'right' | 'front' | 'unknown', ratio }`.
  - `ratio < 0.4` → perfil OK (el lado que sea).
  - `0.4 ≤ ratio < 0.7` → "girate un poco más de perfil (izquierdo/derecho)".
  - `ratio ≥ 0.7` → de frente, **bloqueado**: "de frente no cuenta reps — girate de costado".
- El avatar 3D (card nueva en `#panel`) muestra una etiqueta de estado corta junto al
  viewport (`#avatarState`), sincronizada con `computeOrientation`: "✓ perfil derecho",
  "de frente — girate", "casi, girate un poco más".
- El fantasma 2D (`projectGhost`/`chooseFacing` del punto 4) usa la misma clasificación: si
  `kind === 'front'`, no intenta espejar un esqueleto (no hay lado que copiar) — en su lugar
  dibuja un ícono de rotación simple sobre el video en vez del esqueleto fantasma.

## Enfoque

### 1. `toWorldPoints(result)` — paralelo a `toPoseFrame`, no lo reemplaza

`@mediapipe/tasks-vision@0.10.14` expone `result.worldLandmarks[0]` (33 puntos BlazePose,
3D métrico en metros, origen en el centro de caderas) con el mismo orden que
`result.landmarks[0]` (2D normalizado, ya usado por `toPoseFrame`, línea ~143). Se reutiliza
el `MP_MAP` existente (línea ~137) para mapear a los mismos 17 `KeypointName`, leyendo de
`worldLandmarks` en vez de `landmarks`:

```js
function toWorldPoints(result) {
  const lm = result.worldLandmarks && result.worldLandmarks[0];
  if (!lm) return null;
  const points = {};
  for (const [name, i] of Object.entries(MP_MAP)) {
    const p = lm[i];
    if (p) points[name] = { x: p.x, y: -p.y, z: -p.z, score: p.visibility ?? 1 };
  }
  return points;
}
```

El signo de `y`/`z` se invierte como punto de partida (MediaPipe: Y hacia abajo; Three.js:
Y hacia arriba) — **se confirma/ajusta al probar con cámara real**, es la única parte que no
se puede cerrar sin ejecutar en browser. `frame` (2D) sigue alimentando `window.AbsCounter`
sin cambios; `world` solo alimenta el visualizador 3D nuevo.

### 2. Panel 3D con Three.js

- Nueva card en `#panel` (antes de `#setupcard`, línea ~85) con
  `<canvas id="avatar3d" width="280" height="220">`.
- Import en el mismo `<script type="module">` que ya trae MediaPipe (línea ~122):
  `import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';`
  Solo core (`Scene`, `PerspectiveCamera`, `WebGLRenderer`, `LineSegments`,
  `BufferGeometry`, `InstancedMesh`, materiales básicos) — **sin `OrbitControls`** (evita
  import maps); cámara fija en 3/4 (`position.set(1.4, 0.9, 1.4); lookAt(0,0,0)`), que
  además da una pista extra: de frente el avatar se ve ancho/plano, de perfil se ve fino.
- Huesos: se reutiliza la lista `BONES` ya existente (línea ~386) para construir un
  `LineSegments` con `BufferAttribute` actualizado cada frame (`needsUpdate`, sin recrear
  geometría). Articulaciones: un solo `InstancedMesh` de 17 esferas, reposicionadas con
  `setMatrixAt`.
- Render: `renderer3d.render(scene3d, camera3d)` dentro del `loop(t)` existente (línea
  ~248), justo después de `toWorldPoints(result)` — sin loop paralelo, coste marginal.

### 3. Poses de referencia (fantasma) — parcialmente derivadas, no a ojo

`buildReferencePose(cfg)` en espacio local unitario (origen en el `vertex` del ángulo del
ejercicio, `cfg.angle` de `src/configs.ts`):

- El trío medido (`a`/`vertex`/`b`) se coloca geométricamente exacto usando `cfg.angle` y
  `cfg.thresholds.down` (el ángulo "listo para arrancar": 130° situp shoulder-hip-knee,
  160° pushup shoulder-elbow-wrist) — mismo criterio que `angleABC` en `src/geometry.ts`,
  aplicado a la inversa (fijar el ángulo, resolver la posición).
- El resto del esqueleto (tobillos, muñeca/codo o cadera restante, cabeza) se completa con
  proporciones antropométricas fijas razonables (torso≈1, brazo≈0.9, pierna≈0.9-1.0) —
  explícitamente aproximado, se afina visualmente al probar, no se valida contra el motor
  de conteo.
- Vive enteramente en `template.html`; lee `ABDOMINALES`/`FLEXIONES` ya expuestos en
  `window.AbsCounter` (línea ~125). No requiere tocar `src/configs.ts`.

### 4. Fantasma 2D superpuesto en `draw()`

Se extrae el bucle de `BONES` de `draw()` (líneas ~399-407) a un helper `drawSkeleton(points,
{color, dashed, alpha})` reutilizable. `draw(frame)` sigue dibujando el esqueleto real igual
que hoy, y agrega — **solo en `mode === 'setup' || 'calibrating'`** — el fantasma:

```js
if (mode === 'setup' || mode === 'calibrating') {
  const ghost = projectGhost(buildReferencePose(selectedConfig), canvas, chooseFacing(frame));
  drawSkeleton(ghost, { color: '#58a6ff', dashed: true, alpha: 0.4 });
}
```

- `projectGhost` escala/traslada la pose local a coordenadas normalizadas 0..1 con
  constantes de posición/tamaño objetivo (torso ≈ 30% del alto del canvas, centrado) —
  heurística fija (no hay calibración de intrínsecos de cámara), documentada como constante
  a ajustar tras pruebas físicas a 2–2.5 m.
- `chooseFacing(frame)` espeja el fantasma en x si hace falta, comparando `nose.x` contra el
  promedio de hombros del frame en vivo, para que mire hacia el mismo lado que ya muestra el
  usuario (evita un falso "no coincide" si el usuario simplemente se paró del otro lado).
- Estilo: línea punteada, color `#58a6ff` (no usado por `PHASE_COLOR`), alpha bajo — no se
  confunde con el esqueleto real a color de fase. Se oculta en `running`/`done`.

### 5. Checklist accionable — mismos 4 IDs, mismo gate

`runSetupChecks` (líneas ~273-305) se reescribe para calcular, junto al booleano de cada
check, un mensaje específico, reutilizando las mismas variables ya calculadas (`dSh`,
`torso`, `avgScore`, jitter de `hipHistory`):

- `chk-body`: falta `nose` → "acércate o mejora la luz"; nariz en el borde → "sube la
  cámara: se corta tu cabeza"; falta tobillo → "aléjate: no se ven tus pies".
- `chk-profile`: `dSh/torso > 0.7` → "estás de frente — gírate 90°"; entre 0.4 y 0.7 →
  "gírate un poco más de perfil".
- `chk-light`: `avgScore <= 0.6` → "mejora la luz (NN%)" con el score real; `kps.length < 12`
  → "acércate, faltan puntos por detectar".
- `chk-stable`: sin historial suficiente → "midiendo estabilidad…"; jitter alto → "quédate
  quieto un momento más".

`setCheck(id, ok, msg)` se extiende para setear `textContent` además del `classList.toggle`.
**No se agregan IDs nuevos ni se toca** `$('btn-start').disabled = !(body && profile &&
light && stable)` — el gate queda idéntico, solo se enriquece el texto.

### Impacto en el build

Ninguno. `scripts/build-web.mjs` solo empaqueta `dist/src/index.js` (Capa 1, TS puro) e
inyecta el bundle en `/*__CORE_BUNDLE__*/` (línea ~120); todo lo nuevo vive en el
`<script type="module">` de la Capa 3, que el build copia tal cual — mismo patrón que
MediaPipe: CDN ESM, sin dependencia nueva en `package.json`, sin import map.

## Archivos a modificar

- **`web/template.html`** (único archivo a tocar):
  - HTML: card nueva `#avatar3dcard` con `<canvas id="avatar3d">` en `#panel`.
  - CSS: estilos mínimos para esa card/canvas (reutiliza `.card`).
  - JS: import de Three.js; `toWorldPoints`; `initAvatar3D`/`updateAvatar3D`;
    `buildReferencePose`/`projectGhost`/`chooseFacing`; refactor de `draw()` →
    `drawSkeleton()` + llamada al fantasma; reescritura de `runSetupChecks`/`setCheck` con
    mensajes; llamada a `updateAvatar3D(toWorldPoints(result))` dentro de `loop(t)`.
- `scripts/build-web.mjs`, `src/configs.ts`, `src/types.ts` — sin cambios (se lee todo vía
  `window.AbsCounter`, nada nuevo que exportar del núcleo).

## Verificación end-to-end

1. `npm run build` (regenera `abs-counter.html`; el marcador `/*__CORE_BUNDLE__*/` queda
   vacío si se abre `template.html` suelto sin buildear).
2. Servir localmente (`npx serve .` o `python3 -m http.server 8080`) — `type="module"` sobre
   `file://` puede tener restricciones CORS.
3. Abrir `abs-counter.html`, conceder cámara, revisar devtools: sin 404 del import de
   Three.js, `toWorldPoints` devuelve `null` sin romper el loop si `worldLandmarks` viene
   `undefined`.
4. Moverse frente a la cámara (muy cerca/lejos, de frente, en penumbra, quieto) y confirmar
   que el texto de cada uno de los 4 checks cambia de forma específica, y que `btn-start` se
   habilita exactamente cuando los 4 están en verde (igual que antes).
5. Cambiar el selector de ejercicio y confirmar que el fantasma cambia de forma (acostado de
   lado vs. plancha) con escala/posición razonable a ~2–2.2 m; ajustar constantes de
   `projectGhost` si se ve mal.
6. Confirmar que el avatar 3D sigue movimientos grandes (brazo, rodillas) sin verse
   invertido/espejado; si sale mal, ajustar signos de `y`/`z` en `toWorldPoints`.
7. Completar una sesión real (calibración + conteo) y confirmar que el fantasma desaparece en
   `running`, que `replog`/exportación/telemetría siguen intactos y que el FPS (`#tfps`) no
   se degrada.
