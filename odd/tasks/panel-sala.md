# panel-sala: del panel que observa al panel que pone repos en condiciones y trabaja con sala

Serie RP8 a RP14 de `docs/ROADMAP.md`. Rama base: `main`. Código y README en inglés; este documento en español porque cita a la persona. Una rama y un PR por unidad, siempre por `/flow-commit` y `/flow-pr` (nunca commits a mano ni en `main`).

## Specs

Las citas son textuales de la persona (ver `## Log`). No se resumen ni se agregan requisitos.

- **S1. Botón que escribe en la sesión abierta.** «ejecutar mis comandos, prompts, skills, /flow-commit con un boton desde el navegador, pero que ejecute dentro de la sesion abierta del repositorio». *(RP8, hecho: `POST /api/pi`, falla cerrado.)*
- **S2. Botón `/flow-pr`.** «cuando un repo este esa columna [COMMITTED] que habilite el boton de PR para ejecutar /flow-pr». COMMITTED hoy es «sin cambios sin commitear y con commits sin push». Se oculta en ramas `stale` y fuera de la rama base. Sin PR, solo si no existe ya uno abierto de esa rama.
- **S3. Acción manual.** «commits directamente en main esta prohibido o protegido por /flow-commit y actualmente como regla no se hace commit manualmente, solo se hace con flow-commit.» y «si se hace cualquier cosa a mano y que no esta en coordinacion o manejable por el panel, que se muestre un aviso que ese repo necesita accion manual.»
- **S4. Trabajo a medias.** «cualquier cambio que se haga en el repo dejara en estado changes listo para commitear. pero si todavia no se haya terminado el trabajo, esperando un input manual? como manejamos esa situacion para no mostrar aun el boton de comitear.» Dirección acordada: cada acción del agente termina con **una línea con el paso siguiente** (y detalle opcional) y el agente escribe un **archivo de estado** `{ state: working | needs-input | ready-to-commit | ready-to-pr | blocked, next, detail, at }` en una carpeta del repo con la palabra `panel` (ej. `./.panel/`), ignorada por `.git/info/exclude` o `.gitignore`, «como convenga mas». El botón de commit se oculta si el estado declarado no es `ready-to-commit` o la sesión está ocupada; el archivo se ignora si es más viejo que el último cambio del repo. La línea de «qué hacer ahora» debe ser «bien entendible».
- **S5. Veredicto tras `/flow-commit`.** «como sabemos que se termino y que hizo bien los commits sin problemas y que esta listo para hacerse /flow-pr, siempre tiene estar limpio todo commiteado sin olidar ningunarchivo y no hay que haber diff». Se juzga desde Git (árbol limpio incluido sin seguimiento, `HEAD` cambió, rama de tarea, commits por entregar, sin PR abierto), nunca desde el texto de la terminal; si algo falla, «requiere atención» con el motivo y sin habilitar `/flow-pr`. El panel no juzga la calidad de los commits.
- **S6. Principio.** «simpre y cuando sea posible debemos resolver las cosas dentro del panel sin depender mucho de herramientas externas como orca, pi y demas. si es posible con lineas de comandos o comandos de git como gh, pero esa condicion es como primera opcion nomas, no debemos perder funcionalidad y efectividad por causa de eso».
- **S7. Lista de requisitos.** «crear una lista de requisitos de archivos, condiciones, e implementaciones necesarias que debe cumplir una repo para mostrarse bien en el panel» en un archivo de la carpeta del panel. Repo nuevo que no cumple: aviso, ocultable, con funciones básicas. Botón «ponerse en condiciones/instalar lo necesario» (oculto en «más opciones» mientras falte algo) que manda una orden a la sesión activa para que el agente lea el archivo y lo implemente. «todo esto se debe instalar con una ia, nada manual completamente» (conflictos de reglas con un `AGENTS.md` existente: corregir o decidir con la persona; bloque «reglas para panel»). Un `install.sh` solo sería ejecutor para la IA, nunca manual. Al agregar un repo con sesión abierta de pi, mostrar el aviso.
- **S8. Detectar vs aplicar.** El panel detecta los requisitos por su cuenta (determinista) y solo la IA los aplica; el panel no edita archivos de otros repos; esos cambios pasan por `/flow-commit` y `/flow-pr`.
- **S9. Comprobaciones.** Tres categorías: **Verificable** (el panel decide, puede mostrar verde), **Parcial** (muestra evidencia, la persona confirma), **Criterio** (nunca verde, solo recuerda). Nunca afirmar conformidad de lo que no se verificó.
- **S10. Skills.** «como tratamos a los skills necesarios como flow-commit, flow-pr, flow-branch, si copiamos dentro del proyecto o seguimos utilizando de la carpeta flow-skills y que sean referencias de implementacion necesaria como pi, gentle shell y orca.» Recomendado: referenciar `flow-skills` y declarar `pi`, Gentle Shell y Orca como prerrequisitos con comprobación (a verificar si `flow-skills` está registrado globalmente en pi).
- **S11. `implementation-guides`.** «quiero que sea como tu recomendacion de que solo de referencia del panel, y que todo haga panel ya y elimines todo lo necesario de este tema de la implementation-guides, que solo quede la referencia de instalar panel opcional.» La fuente única de lo que el panel exige es el archivo de requisitos del panel. Es otro proyecto de la persona: las ediciones allí se hacen con su autorización y por su propio ciclo.
- **S12. Repartir `server.js`.** «me parece ideal ya repartir server.js para estar preparado al crecimiento». Sin cambio de comportamiento, protegido por los tests.
- **S13. Sala.** «cumplir con las condiciones de sala y mostrar en el panel en cada tarjeta o repo a que sala esta incluida y si la sala esta activa o no», poder «elegir cual es la carpeta de la sala», varias salas posibles (ej. grupo H2O, grupo TOOLS) y condiciones que debe cumplir una carpeta/repo para ser sala y para integrarse. Referencia: `upen-ceo`. Hallazgos: la sala no tiene marcador formal ni los repos declaran a qué sala pertenecen (solo `ENLACES.md` sección 2, `proyectos.conf` o listas fijas); los repos de `upen` usan un bloque viejo sin versión; `repo-panel` está fuera de la sala de UPEN por diseño. La pertenencia la declara la configuración del panel y se contrasta con `ENLACES.md`. «Sala abierta» = hay una terminal `π` en su carpeta (Orca); «sala atrasada» = último barrido anterior a PR fusionados (parcial, markdown libre).
- **S14. Chat de la sala.** «lo ideal seria tener la conversacion del chat de la sala en el panel, pero eso no se todavia si es factible o conveniente.» Hallazgo: factible (JSONL de pi) pero privado y sin verificar el esquema; recomendado: no mostrarlo y ofrecer un botón que lleve a la terminal de la sala. Decisión pendiente de la persona; es la última unidad y opcional.
- **S15. Sin base de datos.** «no necesitamos de historial de ejecuciones, cola, caché, eventos, consultas sobre historial, escrituras desde varios procesos a la vez (panel y agentes) o garantías de atomicidad.» Todo en archivos, sin dependencias, Node sin compilar.
- **S16. Nombre.** Se mantiene `repo-panel` por ahora; revisar cuando la sala esté integrada, con un identificador interno estable.
- **S17. Idea futura de la persona.** Una sola sesión de pi como sala que orquesta los repos integrados, pudiendo abrir una sesión en un repo sin actividad según su estado (limpio o no), y la persona solo presiona: commitear, hacer PR, confirmar el PR en GitHub, volver a la base actualizada y limpia, nuevo ciclo. La persona ampliará la idea más adelante; no implementar sin su detalle.

## Tasks

| ID | Specs | Ruta | Commit |
| --- | --- | --- | --- |
| RP8 | S1, S6 | inline; fusionado en PR #24 | `e0295a7`, `be39369` |
| RP9 | S12 | worker acotado; 10 módulos en `server/` (errors, exec, config, local, github, roadmap, repos, pi, queue, http); hecho y verificado | pendiente de commit |
| RP10a | S7, S8, S9, S10 | worker acotado; `requirements.json`, `checks.js`, `server/requirements.js`, lector `remoteFile`, rutas `/api/requirements` y `/api/prerequisites`, cajón de Conformity; fusionado en PR #26 | `9aadd01` |
| RP10b | S7, S8, S9 | worker acotado; aviso y menú, `put-in-conditions`, `requirements/`, `dismissed`, arreglo de `remoteFile`; fusionado en PR #27; falta probar la orden con una sesión real | `c419df0` |
| RP11a | S13 | worker acotado; `rooms` en la configuración, requisitos de sala y de miembro, `server/rooms.js`, `GET /api/rooms`, etiqueta y sección Rooms; hecho y verificado | pendiente de commit |
| RP11b | S13 | diálogo para crear la sala y elegir su carpeta, y ítem «⋯» para asignar un repo | — |
| RP12 | S2, S3, S4, S5 | archivo de estado, veredicto desde Git, botón `/flow-pr`, aviso de acción manual | — |
| RP13 | S11 | cierre de la dependencia de `implementation-guides` (otro proyecto, con autorización) | — |
| RP14 | S14, S17 | opcional: botón hacia la terminal de la sala; chat solo si la persona lo decide | — |

Orden: RP8 → RP9 → RP10a → RP10b → prueba con sesión real → RP11a → RP11b → RP12 → RP13 → RP14. RP12 puede ir antes de RP11 si la persona lo prefiere.

## Sin verificar (heredado del análisis)

- Si `upen-ceo` tiene un `proyectos.conf`.
- El esquema interno de los JSONL de sesiones de pi y si se escriben en vivo.
- Si los repos `upen-core` y `upen-erp` tienen el bloque de Orquestación nuevo.
- Cómo detecta pi una sesión «reciente» (ENL-7).
- Si pi acepta una extensión al terminar cada turno y cómo carga un `AGENTS.md` global.
- Comportamiento del botón en el navegador (RP8 se probó contra Orca real, no en pantalla).

## Log

**L1.** Mensaje original de la persona (inicio de esta línea de trabajo):

> tengo una consulta, como podemos ejecutar solicitudes a una sesion de pi o gentle shell en este caso desde lineas de comandos? asi si desde el panel html podemo ejecutar comandos de pi?

**L2.**

> estaba pensando para ejecutar mis comandos, prompts, skills, /flow-commit con un boton desde el navegador, pero que ejecute dentro de la sesion abierta del repositorio. se podria hacer eso?

**L3.**

> como aseguramos que no de error o conflicto con mas de una terminal o sesion abierta?

**L4.** (probar con sesión real)

> podemos probar con upe-pages

**L5.**

> podemos probar con el flow-commit ya para aprender mas, ese repo esta como para ser commiteado luego

*Resultado: `/flow-commit` enviado con Enter a la sesión de `upen-pages`, `confirmed: true`.*

**L6.**

> una consulta, como podemos saber que se ejecuto correctamente el /flow-commit, porque demora unos minutos para terminar ese proceso? como sabemos que se termino y que hizo bien los commits sin problemas y que esta listo para hacerse /flow-pr, siempre tiene estar limpio todo commiteado sin olidar ningunarchivo y no hay que haber diff para hacer /flow-pr. y si algo salio mal debemos mostrar que requiere atencion y no habilitar el boton del siguiente paso que es /flow-pr?

**L7.**

> no olvides lo que conversamos, pero ahora que lo pienso; como funciona el panel cuando muetra el repo en la columna COMMITTED? ya no es suficiente validacion que cuando un repo este esa columna que habilite el boton de PR para ejecutar /flow-pr?

**L8.**

> - commits directamente en main esta prohibido o protegido por /flow-commit y actualmente como regla no se hace commit manualmente, solo se hace con flow-commit.
> - si se hace cualquier cosa a mano y que no esta en coordinacion o manejable por el panel, que se muestre un aviso que ese repo necesita accion manual.
> - tambien otra duda, cualquier cambio que se haga en el repo dejara en estado changes listo para commitear. pero si todavia no se haya terminado el trabajo, esperando un input manual? como manejamos esa situacion para no mostrar aun el boton de comitear. podriamos hacer que se guarde en el agents.md de la repo que cada vez que haga una escritura ya sea de implementacion, correcciones, cualquier cosa, que de en una linea el paso siguiente? seria util esa linea final despues de cada accion para que sepamos que hacer despues. porque yo mismo muchas veces estoy enla sesion trabajando, me muevo a otra sesion, despues vuelvo mas tarde a la sesion que requiere mi atencion y ya me olvide que se estaba haciendo y leyendo el resultado a veces no entiendo que hacer como siguiente paso. y con una linea bien entendible que diga que hacer ahora. eso nos serviria si tenemos como leer la ultima linea de resultado. que me dices sobre eso. seria factible leer una linea u una descripcion detallada de que hacer como siguiente paso?

**L9.**

> espera que, no te olvides de nada de lo que vamos hablando porque vamos madurando la idea. te comento algunas cosas mas que me vienen a la idea:
> - simpre y cuando sea posible debemos resolver las cosas dentro del panel sin depender mucho de herramientas externas como orca, pi y demas. si es posible con lineas de comandos o comandos de git como gh, pero esa condicion es como primera opcion nomas, no debemos perder funcionalidad y efectividad por causa de eso, si necesitamos de las herramientas externas para hacer mejor y mas efectiva, recurramos a las externas. ejemplo este de escribir y leer los estados del repo con un *.json me parece interesante, y esta en una carpeta ignorada por git como ./panel*.
> - ya estamos haciendo crecer el proyecto y ya existen varias condiciones que deben cumplir una repo para mostrase bien en el panel, creo que seria mejor crear una lista de requisitos de archivos, condiciones, e implementaciones necesarias que debe cumplir una repo para mostrarse bien en el panel, entonces para cuando agregamos un repo totalmente nueva al panel que muestre con una advertencia o aviso de que no cumple con ciertas condiciones de mostrar bien su avance en el panel y que permita implementar todo lo necesario ejemplo con un install.sh ejecutado dentro del repo para copiar todo lo necesario de los requerimeintos del panel, tanto que agregue los archivos agents.md si no tienen o que agregue todo lo necesario de reglas y condiciones que se deba agregar a un agents.md de un proyecto existente, puede adicionar en un bloque que diga reglas para panel o algo, todo esto se debe instalar con una ia, nada manual completamente, porque puede que haya condiciones que se deban tratar como por ejemplo que el agents.md del repo tenga un conflicto de reglas con los que el panel necesita, y en ese caso debe corregirse o decidir que hacer, y el install.sh por ejemplo es solo un ejecutor para instalar con la ia, no es para ejecutar manual.
> - como poner en condiciones una repo nueva que se agrega al panel? pienso asi; que al agregar una repo nueva y la repo tiene alguna sesion abierta en pi, que muestre un aviso de que se necesita instalar lo necesario para que la repo trabaje bien, ese aviso se puede ocultar y dejar la repo sin todoas las funcionalidades avanzadas que necesita para trabajar bien con el panel y solo mantenerle en el panel con las funcionalidades basicas. despues siempre hay que poder volver a retomar la coniguracion de repo para ponerse en condisiones con el panel, cuando se presiona el boton de ponerse en condiciones/instalar lo necesario, que mando una orden en la sesion activa para que leas las instruciones necesarias de como ponerse apta para el panel desde un archivo de lista a implementar que se encuentra en la carpeta del panel, con eso el agente en la sesion activa se pondra a leer las insruciones y condiciones y hacer lo necesario para cumplir con todos, y siempre y cuando no se cumpla con todos los requisitos que esa opcion del boton de instalar este disponible pero oculto en botones de mas opciones en la tarjeta del panel.
> - tambien podemos pensar como trataos a los skills necesarios como flow-commit, flow-pr, flow-branch, si copiamos dentro del proyecto o seguimos utilizando de la carpeta flow-skills y que sean referencias de implementacion necesaria como pi, gentle shell y orca.
> - tambien tenemos reglas, condiciones y archivos que se indican como necesarios dentro del proyecto de implementation-guides y me parece que ya no deberiamos depender de ese proyecto o guia de implementacion, debemos depender ya de lo que dice el archivo del panel de la lista de reglas, condiciones y archivos necesarios que se indique con el instalador de repo que se usa del panel mismo.
> - que me dices de toda esta idea? es cambio total de enfoque creo, que panel sea una herramienta completa y sin dependencias instalcion o colocacion en marcha de un repo.

**L10.**

> - esta esa opcion tambien que olvide de pedir como resolver. sobre cuando no se tiene una sesion iniciada en el repo y si necesitamso iniciar por alguna razon, todavia no se en que caso porque la mayoria de las veces yo iniciare la sesion manualmente en orca y pi. pero mas adelante tengo una idea que quiero comentarte y puede que necesite que abramos una sesion en el proyecto caso sea necesario. pero esa idea te cuento mas tarde para no ensuciar o crear ruido sobre la idea que vamos avanzando.
> - sobre el archivo ./panel* como di de ejemplo, te decia dentro de la carpeta mismo del repo, solo agregue la palabra panel como para saber que es una carpeta que le pertenece a panel, y que se ignore con .git/info/exclude o .gitignore, como convenga mas.
> - sobre la implementation-guides quiero que sea como tu recomendacion de que solo de referencia del panel, y que todo haga panel ya y elimines todo lo necesario de este tema de la implementation-guides, que solo quede la referencia de instalar panel opcional. solo que muchas cosas de como trabaja panel traba 'sala/direccion' y eso es de lo que queria habalarte a futuro, traer la funcionalidad de sala al panel con todos los requisitos y funcioanlidades que tiene. eso si daria mas sentido y funcionalidad increible al panel, mas todvia que se pueda iniciar una sesion en el repo sin actividad y dependiendo de su estado limpio o no se pueda trabajar sonbre esa repo, entonces pordiamos tener una sola sesion en pi como sala y que este haciendo toda la orquestacion con los repos necesarios e integrados al panel y sala, e ir solo presionando botones de comitear, hacer pr, confirmada la pr en github, vovlerse a la rama base actualizada y limpia para iniciar un nuevo cliclo. con eso seria genial.
> - pensando en todo eso y todo lo que tiene que hacer el panel me surgen mas observaciones como; 1. puede que el nombre ya no sea correcto repo-panel o sigue siendo correcto? 2. como ya tendremos funcionalidades avanzados, logicas avanzadas y datos que tenemos que retener, no seria mejor madurar el proyecto a manejar base de datos uno mas recmendado para el proyecto, seguir con node que se ejecuta de la manera que se hace actualente o hacer compilado?
> - el resto me parece todo bien.

**L11.**

> - no necesitamos de historial de ejecuciones, cola, caché, eventos, consultas sobre historial, escrituras desde varios procesos a la vez (panel y agentes) o garantías de atomicidad.
> - que tanto de trabajo seria incluir ya sala en panel, y que se incluiria realmente? que valores o funciones adicionales tendriamos? desde mi punto de vista es solamente cumplir con las condiciones de sala y mostrar en el panel en cada tarjeta o repo a que sala esta incluida y si la sala esta activa o no. lo ideal seria tener la conversacion del chat de la sala en el panel, pero eso no s todavia si es factible o conveniente.
> - me parece ideal ya repartir server.js para estar preparado al crecimiento, porque este proyecto de panel se esta poniendo interesante. principalmente por poner en condiciones tanto los agents.md como la manera de segir el ciclo de una tarea con sus listas de hechos, haciendo, y falta hacer que tenemos con los tableros, roadmaps y task odd.
> - cual es la duda sobre sala referente a comprobaciones automáticas y cuáles siguen siendo criterio humano? podemos definir esos pendientes?
> - lo de sala ya te conte todo, quisiera que analises todo que hace sala, para que sirve y como podemos integrarle a este proyecto, principalmete que los repos esten aptos para trabajar con salsa y poder definir a que sala pertenenece, asi tambien poder elegir cual es la carpeta de la sala, porque sala normalmente es una carpeta de conversaion y guadado de archivos de lo que se decidio y demas cosas, entonces deberiamos de tener unas condiciones que debe cumplir una carpeta que debe ser repo para sala de unos repos que se integraran en el; ejemplo de sala es el repo upen-ceo que podes leer, porque lo que puedo querer mas adelante es una sala para el grupo de proyecto de H2O y otro para los TOOLS, entonces debemos saler como funciona la sala, que es y que necesita, como se integran los repos a la sala.
> - si se puede avanzar ya con la idea de la sala si es que es mejor aprovechar todo estas ideas y cambios que queremos hacer y madurar evolucionar de una vez este proyecto a eso seria genial, si te parece mejor hacer un nuevo proyecto y dejar este como esta para no perder lo que ya funciona y copiamos todo lo necesario para el nuevo proyecto con todo lo necesario?

**L12.**

> - pefco, me gusta todo, y no quiero que pierdas ingundetalle de lo acordado y planificado. guarda todo y empecemos paso a apaso con el trabajo hasta dejar todo listo y funcionando con sala incluido. vamos!

*Decisiones de la persona incorporadas: se evoluciona este mismo proyecto (no un proyecto nuevo); sin base de datos; sin compilar; se parte `server.js` primero.*

**L13.** Decisiones de la persona para RP10 (respuestas a tres preguntas):

> 1. ¿El bloque de Ciclo (orquestacion:ciclo) es requerido para todos los repos o solo recomendado? — Solo recomendado (Recomendado)
> 2. Los repos de upen tienen una sección '## Orquestación' vieja, sin marcador ni versión. ¿Cómo la tratamos? — Pide actualizar (Recomendado)
> 3. ¿Cómo entregamos RP10? — Dos PR: RP10a y RP10b (Recomendado)

*Aplicado: Ciclo recomendado (requerido solo al pertenecer a una sala, RP11); la sección vieja es «desactualizada»; RP10 se parte en RP10a y RP10b.*

**L14.** Decisiones de la persona para RP11 (respuestas a tres preguntas):

> 1. ¿Cómo se declara a qué sala pertenece cada repo y dónde está la carpeta de la sala? — Config + pantalla para elegir (Recomendado)
> 2. ¿Qué significa 'sala activa' en esta primera versión? — Sesión abierta + último commit (Recomendado)
> 3. ¿Cómo entregamos RP11? — Dos PR: RP11a y RP11b (Recomendado)

*Aplicado: la pertenencia se guarda en `config.json` y habrá pantalla para crear la sala y asignar repos (RP11b); «sala activa» = sesión de pi abierta en su carpeta (libre, ociosa u ocupada) más la fecha de su último commit; «sala atrasada» (último barrido frente a PR fusionados) queda fuera de esta versión; RP11 se parte en RP11a y RP11b. No se evalúa «el repo figura en `ENLACES.md`» porque es markdown libre y no se puede verificar sin falsos positivos.*
