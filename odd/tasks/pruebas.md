# Pruebas por riesgo (RP253)

Entregar más rápido sin perder la seguridad crítica. Rama base: main. Una tarea = un PR.

## Specs

- **S1. El costo.** La persona dice que las pruebas frenan un producto que cambia todo el tiempo: cada cambio rompe pruebas, se corrige una, se corre todo y falla otra. Pide medir si compensan. (2026-11-19)
- **S2. Velocidad.** «quiero hacelerar a lo maximo la entrega sin perder la seguridad critica. que me recomiendas?» (2026-11-19)
- **S3. Todo.** Respuesta de la persona a la propuesta: «Yes, do all of it» (2026-11-19).

## Tasks

- [x] **T1. RP253:** la política en AGENTS.md, con la zona crítica, la lógica fuera de ella, las pantallas y el ciclo de trabajo.
- [x] **T2.** Absorbida por RP253: las pruebas de texto se borran cuando fallan. Ya no es una fila propia (RP254 nunca se entregó).

## Log

- **L1.** Lo que se midió el 2026-11-19 sobre main (9f799e3):
  - 18.600 líneas de código contra 56.300 de pruebas;
  - en los últimos 60 PR fusionados, 3.644 líneas de código cambiadas contra 10.040 de pruebas, o sea 2,75 por cada una;
  - 3.905 pruebas que corren en 248 s en local;
  - 126 de los 256 archivos de prueba leen `public/` como texto, con 567 aserciones de ese tipo.

  Ejemplos: RP214 cambió 2 líneas de CSS con 52 de pruebas, y RP228 cambió 74 de código con 449 de pruebas. De las 65 filas pendientes, unas 50 son el rediseño, que reescribe justamente `public/`.
- **L2.** El agente propuso tres opciones:
  - A, dejarlo como está;
  - B, una política por niveles;
  - C, sacar las pruebas, que desaconsejó.

  Después precisó B con una zona crítica cerrada y una limpieza única. La persona aceptó todo (S3).

  RP253 reemplazó la sección «Verificación liviana» de AGENTS.md. No tocó los bloques administrados: la sección nueva dice en qué prevalece.

  RP254 queda antes del resto del motor y del rediseño. Su clasificación archivo por archivo se prepara con una lectura sin cambios: borrar, conservar o partir, y ante la duda se conserva.
- **L3.** La clasificación de solo lectura de los 126 archivos que leen `public/` como texto dio:
  - 2 archivos para borrar enteros;
  - 15 para conservar: la bandeja, comportamiento en `vm` o el servidor;
  - 109 mixtos, con unas 307 pruebas de texto para sacar (unas 2.400 líneas, el 16% de las pruebas).

  El agente corrigió su estimación anterior: no es «más de la mitad», y borrar esas pruebas no acelera mucho la suite, porque el tiempo lo ponen las pruebas que lanzan `git` y el servidor.

  La persona eligió «Delete on failure»: la regla se sumó a RP253 y la fila RP254 se quitó antes de entregarla.
