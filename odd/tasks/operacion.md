# Mejoras de operación (RP199 a RP201)

Que el panel y la bandeja no se queden viejos sin avisar, y pulir el ícono de la bandeja. Rama base: main. Una tarea = un PR. Orden: RP199, RP201, RP200 (antes de RP198 de la serie del rediseño).
Origen: el 14 de noviembre el logo del celular daba 404 y el ícono de la bandeja no cambiaba, por la misma causa: el servidor y la bandeja cargan su código al arrancar y no se enteran de que el disco cambió.

## Specs

- **S1. Ícono de la bandeja.** «tambien podemos hacer que el icono de la bandeja tenga esa linea fina que sugeriste, tambien que la K no se vea muy apretada en su caja, que respire un poco mas, igual si achicamos la K.» Sobre el color del estado detenido: «se ve bien el color rojo suave» (se queda el rojo; el gris claro queda descartado).
- **S2. Restart tray y aviso de servidor desactualizado.** «podemos hacer eso del Restart tray y aviso de «servidor desactualizado».»
- **S3. Lo que NO se hace.** «mejor no hacer lo del Botón «Restart server» en Settings, para reiniciar desde el celular. no es muy urgente para arriesgar lo que ya funciona bien». El pedido original que lo motivó: «puede que suceda que yo este pidiendo cambios al backend del panel y este desde el movil remotamente y no tendre como hacer en la compu que se reinicie el servidor para actualizar, en ese caso creo que seria util un boton de reiniciar o actualizar servidor con un boton que este en la ventana de settings». Sigue siendo útil el aviso de RP201: dice que falta reiniciar, aunque el reinicio lo haga la persona en la PC.

## Tasks

- [x] **T1. RP199** — S1. Ícono de la bandeja con línea fina y la K más chica. Ruta: en línea, en la conversación (`/flow-next` no delega). Commit: lo crea `/flow-commit` (pendiente al escribir esto)
- [ ] **T2. RP201** — S2. Aviso de servidor desactualizado (huella del contenido de `server/`). Ruta: por decidir. Commit: —
- [ ] **T3. RP200** — S2. Restart tray en el menú de la bandeja. Ruta: por decidir. Commit: —

## Log

- **L1.** Mensaje de la persona (2026-11-14), tal cual: «se ve bien el color rojo suave, pero que crees que deberiamos mejorar? cual es tu propuesta?»
- **L2.** Mensaje de la persona, tal cual: «podemos hacer eso del Restart tray y aviso de «servidor desactualizado». tambien puede que suceda que yo este pidiendo cambios al backend del panel y este desde el movil remotamente y no tendre como hacer en la compu que se reinicie el servidor para actualizar, en ese caso creo que seria util un boton de reiniciar o actualizar servidor con un boton que este en la ventana de settings. tambien podemos hacer que el icono de la bandeja tenga esa linea fina que sugeriste, tambien que la K no se vea muy apretada en su caja, que respire un poco mas, igual si achicamos la K.»
- **L3.** Mensaje de la persona, tal cual: «mejor no hacer lo del Botón «Restart server» en Settings, para reiniciar desde el celular. no es muy urgente para arriesgar lo que ya funciona bien»
- **L4.** Decisión del agente al arrancar: `/flow-next RP199` encontró que la fila no existía (el flujo manda detenerse si no existe); `AGENTS.md` manda agregar la fila antes de trabajar en algo nuevo y la persona había pedido la unidad por su nombre, así que se agregaron las tres filas (RP199, RP201 y RP200) en el diff de RP199, antes de RP198, para que `siguiente` las tome en este orden. Las dependencias de las tres son ninguna.
- **L5.** T1 (RP199) cerrada. Cubrió S1. Decisiones del agente: la línea es el `--line` del panel (no el gris más claro D, que sostenía mejor el cuadrado sobre un fondo casi negro pero no es un color del panel; si en la barra real se pierde, es cambiar un número); la K al 72 % y el punto ×1,6, elegidos comparando cinco variantes en una imagen. Errores míos corregidos en el camino: (1) el README de RP187 decía que el ícono nuevo se ve al salir con Quit tray y volver a abrirla, y eso no se puede; (2) mis pruebas medían la K solo con los píxeles pintados al 100 %, y con la K más chica a 16 px casi no hay, así que veían una K más corta de lo que es. Lección de proceso: una prueba de píxeles tiene que medir lo que se dibuja, antialiasing incluido; y al pedirle al sistema que corra un script recién escrito, la escritura y la ejecución van en llamadas separadas. Para ver: relanzar la bandeja (cerrar el PowerShell viejo de `scripts/tray.ps1` y `Start-ScheduledTask repo-panel-tray`) y mirar el ícono en la barra de tareas oscura.
