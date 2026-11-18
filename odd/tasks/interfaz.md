# Interfaz nueva de Kletus.dev (UI0a a UI8b)

Rediseño completo de la interfaz y de sus funciones, organizado por decisión y no por repo. Rama base: main. Una tarea = un PR.
Las maquetas aprobadas viven en `docs/DISENO-interfaz.html`, y cada fila enlaza la que la define. El análisis de lo que la app tiene y de lo que le falta está en las secciones 2 y 3 de esa página.

## Specs

- **S1. Rediseñar todo.** «Quiero que nos enfoquemos a toda la interfaz y funcionalidades de la app. Sin importar lo que yo haya pedido o dejado como regla, quiero que analices todo el proyecto y entiendas y saques tu conclusiones de cuál es su objetivo… No quiero que te aferres al diseño que ya tenemos… Todo todo hasta los mínimos detalles. Quiero un rediseño completo de ui/ux con las mejoras y propuestas adicionales también.»
- **S2. En inglés.** «podemos hacer todo en ingles»
- **S3. Ramas, worktrees y sesiones.** «Ver lista de ramas locales de los repos: con la posibilidad de poder eliminar las ramas seleccionadas, ya sean las que estan ya mergeadas al remoto o ramas que quedaron sin uso.» / «poder crear worktrees para crear sesiones o trabajos en paralelos. poder ver la lista de worktrees, eliminar si ya no estan en uso.» / «Ver lista de sesiones iniciadas y poder eliminar las seleccionadas.»
- **S4. Alcance de S3.** «las sesiones tambien se pueden cerrar la actual y abrir cualquier otra de la lista?» / «worktrees podemos esperar lo de crear nuevo, mejor va a ser solo ver y eliminar.» / «agrega los stashes, clean up, Cuánto pesan las sesiones de cada repo, en Health, Procesos pi huérfanos.»
- **S5. Sin romper lo aprobado.** «no quiero que desordene todo lo que ya aceptamos, que si la gregue o reordene lo necesario y de la mejor manera… solo no quiero que se rompa con algo que no tiene nada que ver, quiero que se haga bien»
- **S6. Un nombre por pestaña.** «“CI” en vez de “PR & CI” podes unificar»
- **S7. Registrar y ordenar.** «crear todas las tareas, reordenar las tareas en orden de utilidad e impacto considerable al panel. tambien que no se pierda nada de los diseños aprobados, que se utilice los ventanas de ejemplos que aprobamos.»

## Reglas de la serie

1. **La maqueta manda.** Antes de escribir una pantalla, abrí el ancla que dice su fila en `docs/DISENO-interfaz.html` y hacé lo que muestra. Si algo no se puede hacer como está, o conviene otra cosa, decilo en el reporte de la unidad y preguntá antes de cambiarlo. Nunca lo cambies en silencio.
2. **Todo en inglés en la pantalla** (S2), con un nombre por cosa: Repos, Health, Inspector, PR & CI. Las fichas y el roadmap siguen en español.
3. **El teléfono no se rompe en ninguna fila.** Cada fila que toca una pantalla la deja funcionando en el iPhone al menos como hoy. UI6d hace el ajuste fino.
4. **Qué reemplaza esta serie de `odd/tasks/rediseno-interfaz.md`.** Lo pidió la persona en S1:
   - S1: la pestaña Sessions pasa a ser Repos, en el riel.
   - S2: el tablero Work se saca (UI0g).
   - S3: las pestañas de arriba pasan a ser el riel (UI1b).

   El resto de esas specs sigue valiendo, salvo que la maqueta muestre otra cosa, y la fila lo dice. Lo resuelto para iOS (S16, S17, RP205 y RP206) se conserva.
5. **Tamaño.** Menos de 450 líneas de código por fila. En los refactors (UI0e y UI0f), el código movido se informa aparte del código nuevo.
6. **Lo de siempre.** Las pruebas se escriben primero y se las ve fallar. La persona aprueba cada pantalla mirándola. Las filas de RIESGO ALTO van en un PR propio, con una prueba que reproduzca el abuso y una verificación independiente.

## Orden (el de la tabla y el de `siguiente`)

Primero va lo que más cambia el día a día, con sus requisitos antes:

1. **Terminar el motor:** RP237 a RP240, RP215, RP215b y RP227. Sin el motor estable, la interfaz nueva se apoya en arena.
2. **UI0, cimientos:** tokens y temas, diálogo propio, componentes, inglés desde el servidor, partir `resumen.js` y sacar Work.
3. **UI1, riel, lista y línea de entrega:** es el esqueleto sobre el que entra todo lo demás.
4. **UI2 For you, UI3 sesión y UI4 Review y PR & CI:** el ciclo diario de decidir, escribir y revisar. Es donde más tiempo pasa la persona.
5. **UI7, ramas, stashes, worktrees y sesiones:** la limpieza de todos los días, de riesgo acotado. Va antes que la sala porque la usan todos los repos.
6. **La sala:**
   - primero sus guardas del servidor (RP229, RP221, RP221b, RP244 y RP223);
   - después su pantalla (UI5a, UI5c y UI5b);
   - y al final RP225.
7. **UI6:** Ctrl K, Activity, Health, el ajuste del teléfono y el teclado.
8. **UI8:** limpieza en Health.
9. **RP243:** MCP, que es configuración de la persona.

## Tasks

- [ ] **E0. UI0a a UI0g:** cimientos. Maqueta: secciones 9 y 10 de la página.
- [ ] **E1. UI1a a UI1f:** seis estados, riel, lista, línea de entrega, inspector con Task y New task. Maqueta 7.1.
- [ ] **E2. UI2a a UI2c:** registro de lo resuelto y bandeja For you. Maqueta 7.2.
- [ ] **E3. UI3a a UI3f:** cabecera de la sesión, compositor, herramientas agrupadas, imágenes, bandeja de subagentes (absorbe RP241) y autocompletado. Maqueta 7.1 y sección 8.
- [ ] **E4. UI4a a UI4d:** comentarios en el diff, Request changes y Approve, log del check rojo y la pestaña PR & CI. Maqueta 7.3.
- [ ] **E7. UI7a a UI7h:**
  - la pestaña Git: ramas, stashes y worktrees (ver y quitar);
  - el selector de sesión: Switch to y la papelera;
  - Clean up.

  Maqueta: sección 12.
- [ ] **E5. UI5a a UI5c:** pantalla Rooms, Orders con aprobación (absorbe RP222), Log y Setup. Maqueta 7.4.
- [ ] **E6. UI6a a UI6e:** Ctrl K, Activity, Health, teléfono, teclado y accesibilidad. Maqueta 7.5 y secciones 8 y 10.
- [ ] **E8. UI8a y UI8b:** Housekeeping y peso de sesiones en Health, y procesos pi huérfanos. Maqueta: sección 12.2.

## Log

- **L1.** La persona pidió el rediseño (S1) el 2026-11-18. El agente analizó todo el proyecto: dos revisiones de solo lectura más un recorrido por la interfaz en vivo. Publicó la página con el análisis y las maquetas, y la persona la revisó por versiones.
- **L2.** La persona decidió que toda la interfaz sea en inglés (S2). Mientras revisaba el diseño, siguió con la serie del motor: RP234 a RP236b se fusionaron en los PR #293 a #297.
- **L3.** La persona sumó ramas, worktrees y sesiones (S3) y definió su alcance (S4):
  - worktrees: solo ver y quitar; crearlos queda fuera;
  - cambiar de sesión en un paso;
  - stashes, Clean up, peso de las sesiones y procesos huérfanos.

  Ante S5, el agente revisó la sección nueva contra lo aprobado y corrigió tres choques:
  - la maqueta reemplazaba las pestañas del inspector;
  - la tabla de ramas ocupaba la columna de la sesión;
  - había una pestaña llamada Sessions.

  Git quedó como sexta pestaña, las ramas como una hoja sobre la sesión y las sesiones en el selector de la cabecera. La tabla 12.0 de la página dice dónde vive cada pieza nueva. Con S6, la pestaña del teléfono quedó como PR & CI.
- **L4.** Con S7, el agente registró la serie UI0a a UI8b (44 filas) tras pasar la puerta: main limpio, sin stash e igual al remoto en 10c60bd. Reordenó la parte pendiente de la tabla según el orden de arriba:
  - RP227 sube junto al motor;
  - RP242 queda después de UI3e;
  - la sala va después de UI7;
  - RP243 va al final.

  RP241 y RP222 pasan a `Bloqueada`, absorbidas por UI3e y UI5b. Por eso RP242 depende ahora de UI3e y RP225 de UI5b. La página aprobada se copió a `docs/DISENO-interfaz.html`, con anclas por pantalla y sin cambiar su contenido. Las filas de las etapas E7 y E8 se renombraron de E7a… a UI7a… para que sigan la regla de los IDs.

  Tamaño: este PR pasa las 600 líneas. Las razones:
  - las 1051 líneas de la página de referencia;
  - las 44 filas;
  - esta ficha.

  No es código.
- **L5.** La persona eligió entregarlo en un solo PR, con esta nota de tamaño («One PR with a note», 2026-11-18). Excepción explícita al tope de 600 líneas: casi todo el exceso son las 1050 líneas de `docs/DISENO-interfaz.html`, una página de referencia que no es código.
