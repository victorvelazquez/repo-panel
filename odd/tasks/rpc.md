# rpc: reemplazar Orca por pi en modo RPC

Serie RPC1a a RPC4 de `docs/ROADMAP.md`. Rama base: `main`. Código y README en inglés; este documento en español porque cita a la persona. Una rama y un PR por unidad, siempre por `/flow-commit` y `/flow-pr`. Primero se termina RP93b (pestaña Notas); la serie arranca después. Regla de limpieza: lo que una unidad reemplaza se borra en ESA misma unidad, no al final.

## Specs

Las citas son textuales de la persona. No se resumen ni se agregan requisitos.

- **S1. Sin Orca, solo Node, Git, gh y pi.** «lo que quiero es dejar de usar orca y costruir nuestro panel personalizado asi como lo venimos haciendo. quiero reemplazar orca y usar asi como te planteo, mobilidad, portabilidad, commodidad, sin muchas dependencias. podemos empezar directo y puro con node, git, gh y pi»
- **S2. Gentle Shell es transparente.** «lo de gentle shell lo le instalare al pi como algo adicional y es transparente para el panel, entoncves podemos enfocar en usar solo en pi puramente y todo lo que se necesite para pi yo le instalare desde la terminal.»
- **S3. Layout.** «quiero ya usar el panel la ventana de summary, para ver la lista de repos en una columna izquierda, el chat en el centro y el resto de las opciiones como ver archivos, diffs, tareas, notas en la columna derecha.»
- **S4. Work.** «la ventana de work podemos eliminar o agregar como una segunda opcion de visualizacion en vez de ver en columnas los repos ver en formato de kamban, pero no es muy necesario eso, solo si sera facil y sin duplicar mucho funcioanlidad o codigo.»
- **S5. Primero en Windows, sin VPS.** «si vamos a poder usar ya aqui en el windows mismo sin complicarnos con todo esos problemas de login y demas, estaria bueno hacer ya aca y despues vemos los otros problemas para solucionar en el futuro cuando querramos subir ya a un vps.»
- **S6. Retirar Orca y los parsers por completo.** «del repo-panel podemos retirar totalmente orca y los parses de pantalla, limpiar totalmente, porque por el momento estoy usando orca luego directamente sin repo-panel.»
- **S7. Notas.** «notas = notas libres por repo.»
- **S8. Sin basura ni ataduras.** «solo tengo un miedo, de a causa de ir mutado de idea sobre el proyecto dejar mucha basura o seguir atado a algo que ya no necesitemos mas.»
- **S9. Plan confirmado.** «te confirmo el plan totalmente, con todas las mejoras y que podamos iniciar usando ya.»
- **S10. Futuro, FUERA de esta serie.** «quiero subir todos mis repos a un servidor en las nubes, ahi instalar pi con gentle-shell, mis skill y repo panel, de ahi utilizar repo panel como servicio aacediendo desde una ip publica»; «abril el repo-panel en telefonos mobiles como en iphone desde cualuier lugar para trabajar en remoto»; «un inicio de secion con usuario y contrasena y que se guarde la sesion en cookies en el navegador». Después: VPS, login (más segundo factor), capa móvil, notificaciones, y un posible cambio de nombre. No se implementa aquí.
- **S11. Elegir el pi.** «mi idea era poder usar una u otra en el futuro. que se pueda seleccionar la carpeta en donde esta instalado pi, ya sea la carpeta original o la carpeta de gentle-sell, o mejor aun que el panel detecte las dos instalaciones y se elija gentle-shell por default y si solo se tiene una que elija la que tiene? se puede eso? que el panel pueda elegir?» Antes: «mi preferencia es usar el ultimo C:\Users\victor\.gentle-shell»; hay otro pi en `C:\Users\victor\.pi`.

## Tasks

- [ ] **RP93b** · S3, S7 · inline · pestaña Notas (ver `panel-layout.md`)
- [ ] **RPC1a** · S1, S2, S11 · escritor con verificación independiente (riesgo: seguridad) · elegir el pi: `server/piruntime.js` detecta Gentle Shell y el pi original, elige `auto` (Gentle Shell primero), entorno aislado por runtime, saludo RPC, se muestra en los prerrequisitos
- [ ] **RPC1b** · S1, S2 · escritor con verificación independiente (riesgo: seguridad) · cliente RPC y anfitrión de sesiones: `server/rpc.js`, el runtime elegido con `--mode rpc` por repo, eventos al hub SSE, rutas de iniciar, `prompt`, `steer`, `abort`, estado y responder diálogos
- [ ] **RPC2** · S1, S6, S8 · inline o escritor · chat en vivo y botones `/flow-*` por `prompt`; borra `chatsend.js` y `dialoganswer.js`
- [ ] **RPC2b** · S1, S6, S8 · inline o escritor · estado de sesión de tarjetas y salas desde RPC; borra `livewarm.js`, `vigia.js`, `casos.js` y el estado por pantalla
- [ ] **RPC3** · S3, S4 · inline · tres columnas con la interfaz en módulos (sin `app.js` monolítico); Work detrás de un selector sin inversión nueva
- [ ] **RPC4** · S6, S8 · inline · cierre: nada de Orca ni parsers, README, prueba que falla si reaparecen; absorbe RP95

Estimar el tamaño antes de cada unidad: si el código pasa de 450 líneas, partirla.

## Log

- **L1.** Pedido original, verbatim: «una consulta, quiero que analises todo de lo que dependemos de orca, estoy queriendo analizar la posibilidad de no depender de orca y quisera que analises todo lo que hoy nos tiene atado a orca y traigas en una lista y despues analisemos si tenemos posibilidad de salir de esa dependencia, de cual laternativas tenemos para trabar sin orca. que nos limita y que podriamos hacer? porque te comento la idea, quiero subir todos mis repos a un servidor en las nubes, ahi instalar pi con gentle-shell, mis skill y repo panel, de ahi utilizar repo panel como servicio aacediendo desde una ip publica que tendra el servidor en las nuebes, el problema de orca es que necesita de entorno grafico y nuestro servidor en las nubes sera acceso solo por lineas de comando porque ser una vps creo.»
- **L2.** Evidencia: la dependencia de Orca está en un solo punto, `orcaTerminal` de `server/pi.js`, con 5 operaciones (`list`, `show`, `read --screen`, `send`, `create`). Una prueba de `pi --mode rpc` en esta máquina respondió `get_state` y `get_commands` (58 comandos, con `flow-commit`, `flow-pr`, `flow-base`, `flow-next` y `flow-avance`) sin llamar a un modelo; Gentle Shell carga solo. Sin verificar: un diálogo real por `select` o `confirm` y un `prompt` que llame al modelo (el modelo sale por `claude-bridge`).
- **L3.** Decisión: seguir con este repositorio y recortar, no empezar uno nuevo (la parte atada a Orca son unas 900 de 3.300 líneas del servidor; Git, `gh`, roadmap y requisitos no la tocan). Descartes: RP57 (dependía de leer pantallas) queda `Bloqueada`; RP95 la absorbe RPC4; RP66 y RP86b esperan a RPC3.
- **L4.** Aprobación de la persona: «te confirmo el plan totalmente, con todas las mejoras y que podamos iniciar usando ya.» La persona crea el tag `pre-rpc` antes de RPC1.
- **L5.** Hallazgo: hay dos pi en la máquina: el de npm (1.2.0, datos en `~\.pi\agent`, el que resuelve `pi` en el PATH) y el de Gentle Shell (1.4.0 con su Node 24, datos en `~\.gentle-shell\agent`, lanzador `gentle-shell`). La prueba de L2 corrió el de npm dentro de una sesión de Gentle Shell, con sus variables heredadas (`PI_CODING_AGENT_DIR`, `GENTLE_SHELL_CHILD_PACKAGE_INJECTION`), así que no probó `gentle-shell --mode rpc`; el reintento con entorno limpio quedó inconcluso (sin respuesta en 9 s; el segundo intento lo bloqueó el sistema con `spawn EPERM`). Se repite en RPC1a.
- **L6.** Pedido de la persona (S11): que el panel detecte las dos instalaciones y elija Gentle Shell por defecto, o la única que haya. Se parte RPC1 en RPC1a (elegir y validar el pi) y RPC1b (cliente y anfitrión). Elegir se hace por id de un candidato detectado; un `command` o carpeta propios solo desde `config.json`.
