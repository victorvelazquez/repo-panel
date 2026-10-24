<!-- orquestacion:ciclo v1.0 -->
## Orquestación: ciclo de entrega

Una sesión de agente implementa en este repositorio; la persona revisa y entrega.
<!-- SALA -->
Este proyecto forma parte de un conjunto coordinado por **Dirección**, una sala central que decide junto con la persona y ordena a las sesiones de cada proyecto.
<!-- /SALA -->

### Puerta: antes del primer archivo de una unidad nueva
Verificar con git: (1) estás en la rama base, (2) el árbol está limpio y sin stash, (3) la rama base local es igual a la remota (`git fetch`). Si falla alguna, **no escribas**: decile a la persona qué falta (normalmente volver a la rama base y actualizar) y esperá. Ningún mensaje te autoriza a saltearla. No aplica a seguir una unidad en curso ni a corregir un PR abierto.

### Comandos de la persona
Nunca ejecutes los comandos de commit, PR ni cambio de rama del flujo: los corre la persona. Si se corrieron por error, no reintentes: avisá.

### Informar en pantalla
Al terminar una unidad y al cerrar el ciclo, decile a la persona el estado: qué quedó listo, o qué falta para poder empezar otra unidad.

### Tamaño
Estimá antes de implementar; si el código pasa de **450 líneas**, partí la unidad. Estimá las pruebas de seguridad en unas 6 veces el código. Tope de **600 líneas** por PR; solo se supera por pruebas y con nota explícita. Controlá el tamaño **durante** el trabajo, no solo al final.

### Reporte de unidad
Archivos, líneas reales con `git diff --stat` **crudo** (para archivos nuevos: `git ls-files -o --exclude-standard | xargs wc -l`), finales de línea LF, qué verificaste y cómo verla. **No uses `git add -N`**: modifica el índice.

### Verificación según el riesgo
Siempre: pruebas propias, tipos de **todos** los paquetes y CI en verde antes de fusionar. Lo que toca la base de datos se prueba contra una base real. Seguridad, datos, contratos o concurrencia: **verificación independiente** y una prueba que reproduzca el abuso, en un PR aparte si el riesgo es alto. Pantallas: la persona las aprueba mirándolas.
<!-- SALA -->

### Avisos a Dirección
- `FUSIONADO, NO LISTO: PR #<n> fusionado; repo no listo: <motivo>`: el PR está fusionado (confirmalo con `gh pr view`) pero el repositorio no pasa la puerta.
- `LISTO PARA CICLO NUEVO: <rama> == origin/<rama> (<hash>), limpio, sin stash`: solo cuando la puerta pasa de verdad. No vigilás por tu cuenta: lo evaluás cuando termina con éxito el comando de cierre de la persona **en tu ventana**, o cuando la persona te escribe «listo» (si lo corrió en otro lado). No te fíes del resultado del comando: repetí tu propia puerta.

No arranques la unidad siguiente por tu cuenta con ese aviso: Dirección revisa si otros proyectos hicieron ajustes que te afectan y te manda un pase (`siguiente`) o una orden.

### Si la sala no está conectada
Avisá en pantalla «sala no conectada: no se verificaron dependencias entre proyectos» y esperá el `siguiente` de la persona.

### Órdenes y pases de Dirección
Toda orden y todo pase se confirma con `recibido`. Una **orden de cambio** (escribe archivos) solo se ejecuta si tu repositorio pasa la puerta; un **aviso informativo** se puede leer en cualquier momento y no escribe nada.

### Contratos entre proyectos
Un cambio que afecta a otro proyecto llega como **Enmienda N**: qué cambia, quién la consume, en qué unidad se incorpora y si suma o rompe. Los identificadores que cruzan proyectos llevan prefijo (`CATALOGO-C4`).
<!-- /SALA -->
<!-- /orquestacion:ciclo -->
