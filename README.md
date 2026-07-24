# @diacero/rep-counter — Contador de Repeticiones por Visión

Spike de 2 semanas del plan **abs-counter** (v1.0, julio 2026), extendido a **abdominales +
flexiones de pecho**: mismo núcleo, un `ExerciseConfig` distinto por ejercicio — es literalmente
el mismo objeto con otros números, tal como anticipa el plan. El entregable es la **librería**
(Capa 1), no la pantalla: TypeScript puro, cero dependencias de runtime, portable a React
Native cambiando solo el adaptador de pose.

## Arquitectura

| Capa | Qué es | Dónde vive |
|---|---|---|
| 3 — UI/Host (desechable) | cámara, overlay, voz, botones, selector de ejercicio | `web/template.html` |
| 2 — Adaptador de pose | MediaPipe BlazePose 33 → `PoseFrame` 17 puntos | función `toPoseFrame` dentro del host |
| 1 — Núcleo (**el activo**) | ángulos, suavizado, máquina de estados, validadores, calibración | `src/` |

**Regla dura:** la Capa 1 nunca importa MediaPipe ni TFLite. El contrato de entrada es
`PoseFrame` (`src/types.ts`) y el de salida `RepEvent`/`CounterState`. Ese archivo es el
documento de contrato congelado para el port.

## Comandos

```bash
npm install
npm test           # compila + 25 tests con secuencias sintéticas (node:test)
npm run build      # compila y genera abs-counter.html (un solo archivo)
npm run eval -- <sesiones...>   # suite de evaluación contra el dataset
```

## App de prueba

`npm run build` produce **`abs-counter.html`**: ábrelo en Chrome (doble clic, sin servidor;
necesita red para el modelo de MediaPipe en CDN y permiso de cámara).

Flujo: elegir ejercicio (abdominales / flexiones) → validación de encuadre (cuerpo completo,
perfil, luz, estabilidad) → calibración de reposo 3 s (§3.4, ver umbrales calibrados abajo) →
cuenta regresiva por voz → conteo hablado. Al terminar, **Exportar sesión** descarga el log
de keypoints (sin video, con el `exerciseId` embebido) listo para la suite de evaluación.

## Ejercicios soportados (`src/configs.ts`)

| | Abdominales (`situp`) | Flexiones (`pushup`) |
|---|---|---|
| Ángulo contado | hombro–cadera–rodilla | hombro–codo–muñeca |
| Umbrales de fábrica | down 130° / up 80° | down 160° / up 90° |
| Calibración (reposo → down) | `min(130, reposo−15)` | `min(160, reposo−10)` |
| Anti-trampa específico | `noArmAssist` (no impulsarse con brazos) | `hipAligned` (no dejar caer/levantar la cadera) |
| Validadores comunes | `duration`, `confidence`, `depth`, `fullReturn`, `feetAnchored` | mismos |

Los mensajes de aviso (`formHint`) son por-ejercicio (`ExerciseConfig.hints`) porque el
sentido de "sube"/"baja" se invierte: en abdominales el esfuerzo es subir, en flexiones es
bajar — usar el mismo texto genérico habría quedado literalmente al revés.

Sumar un tercer ejercicio (sentadillas) es otro objeto igual de chico en `configs.ts`.

## Protocolo de dataset (§5 del plan)

1. Graba 12 sesiones por ejercicio con la diversidad forzada del plan (cuerpos, ropa, luz,
   piso, ~1/3 con trampa deliberada). Por cada una: video de referencia + JSON exportado.
2. Cuenta las reps del video a mano y edita el JSON: `"human": { "validReps": N, "cheatReps": M }`.
3. Corre la suite (detecta el ejercicio de cada sesión automáticamente vía `log.exerciseId`,
   así que abdominales y flexiones pueden convivir en la misma carpeta):

```bash
npm run eval -- sessions/                    # umbrales de fábrica por ejercicio
npm run eval -- sessions/ --calibrate        # usa los primeros 3 s de cada sesión como reposo
npm run eval -- sessions/ --down 125 --up 75 # iterar umbrales sin volver a grabar
npm run eval -- sessions/ --holdout s10,s11,s12  # reservadas contra sobreajuste
```

El reporte imprime la tabla por sesión y el veredicto del gate **separado por ejercicio**:
precisión ≥ 95 %, cero sesiones con error > 2, detección de trampa ≥ 80 %. Mezclar la
precisión de abdominales y flexiones en un solo número no diría nada útil si difieren mucho.
FPS (≥ 15) y falsos positivos en reposo (60 s = 0 reps) se verifican en vivo en la app.

Nota: `--down`/`--up` aplican el mismo par de umbrales a **todas** las sesiones del run
sin importar el ejercicio — útil para un barrido rápido dentro de un solo ejercicio, no
para ajustar ambos a la vez.

## Decisiones del algoritmo (resumen §3)

- Ángulo principal del **lado visible** (fijado en los primeros 30 frames).
- Mediana móvil de 5 frames sobre el ángulo; frames con score < 0.5 se marcan degradados y
  no rompen el conteo; > 15 seguidos → `IDLE` + "no te veo bien".
- Histéresis por ejercicio + confirmación de 2 frames por cruce.
- **La rep cuenta al completar el retorno**, no al llegar al extremo. El rebote a medio
  camino emite `no_return` y abre un segmento nuevo.
- Validadores de forma con referencia fijada en reposo, no recalculada cuadro a cuadro: la
  dirección "hacia los pies" (`noArmAssist`) y el ancla del tobillo (`feetAnchored`) se miden
  como promedio suavizado durante la fase DOWN, porque recomputarlas por frame es demasiado
  ruidoso en video real (la diferencia entre dos keypoints cercanos puede cambiar de signo
  solo por jitter). Las inválidas se muestran en gris con razón — nunca se descartan en silencio.

## Estructura

```
src/            núcleo (types, geometry, smoothing, angle-engine, counter, calibration, configs)
test/           25 tests con secuencias sintéticas parametrizadas por ángulo real (situp + pushup)
web/template.html   host de la app (el bundle del núcleo se inyecta al hacer build)
scripts/build-web.mjs   genera abs-counter.html autocontenido
eval/evaluate.mjs       suite de evaluación / gate, por ejercicio
abs-counter.html        generado — la app lista para usar
```
