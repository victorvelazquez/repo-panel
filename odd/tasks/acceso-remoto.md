# Acceso remoto y avisos (RP177–RP179)

Usar el panel desde el iPhone por Tailscale, con login una sola vez, y recibir avisos (visuales y sonoros) en el teléfono y en la PC cuando una acción queda lista.
Rama base: main. Una tarea = un PR. Orden: RP177 → RP178 → RP179.

## Specs

- **S1. Objetivo.** «poder usar en el teléfono móvil corriendo remotamente el servidor»; el servidor corre en esta misma PC por ahora (más adelante, una NUC propia en casa).
- **S2. Control total.** «actuar totalmente desde el teléfono.»
- **S3. Sin fricción.** «no quiero que me pida ninguna confirmacion para las acciones irreversibles, quiero usar como si fuera que estoy en la compu, lo que quiero es facilidad y practicidad.» Sin auditoría («no es necesario una auditoria»). Orca queda fuera del diseño.
- **S4. RP177, acceso (las tres piezas).** «rm1 va con las tres piezas (host, login con cookie, Origin)». (a) `remote.host` en `config.json` se acepta como Host además de `127.0.0.1` y `localhost`; sin ese campo, nada cambia; el servidor sigue escuchando solo en `127.0.0.1` (Tailscale Serve hace de puente con HTTPS). (b) Con `remote.secret` configurado, quien entra por el host remoto se loguea una vez con ese secreto y recibe una cookie `HttpOnly; SameSite=Strict` (`Secure` si llega por HTTPS) de larga duración, sin estado en el servidor (firmada con el secreto: sobrevive a reinicios y cambiar el secreto cierra todas las sesiones); límite de intentos fallidos. El acceso por `127.0.0.1` sigue sin login. (c) Todo POST con encabezado `Origin` de otro host se rechaza.
- **S5. RP178, detector de eventos.** «quiero implementar notificaciones tanto para el telefono como para la pc, que llegue notificaciones visuales y auditivas de cada vez que termina un proceso como por ejemplo termino el working y pasa a habilitar el boton de /flow-ship que notifique y cuando termine esa ejecucion que notifique la habilitacion del merge y que notifique la habilitacion del ciclo limpio para nueva ejecucion de /flow-next, en sintesis, cualquier accion que requiera que llegue una notificacion, asi me servira como aviso para desbloquear el telefono y realizar la siguiente accion.» Avisos por CAMBIO de lo que el repo espera de la persona: pregunta del agente, listo para /flow-ship (`deliver`), PR listo para fusionar (`merge`), ciclo limpio listo para /flow-next (`start`), CI fallando. Nada al arrancar el servidor; nada repetido sin cambio; nada si hay un panel a la vista; cada tipo se puede apagar; tocar el aviso abre ese repo. En esta unidad: aviso en pantalla y sonido con la página abierta.
- **S6. RP179, Web Push.** «vamos con todos, rm1, rm2 y rm3». Los mismos avisos llegan con la página cerrada o el teléfono bloqueado, por Web Push con service worker (iPhone con la app instalada en la pantalla de inicio; PC por Edge/Chrome). Sin dependencias: VAPID y firma con `node:crypto`, push sin datos y el service worker pide el texto al servidor con la cookie. Se verifica en el iPhone real.
- **S7. RP180, pantalla estable en el teléfono.** «Lo primero que podemos ajustar es el zoom o que se mueve mucho la dimensión o la pantalla misma en el teléfono. A veces se redimensiona el input del chat. Creo que primero debemos ajustar eso y después avanzamos con los otros.» Los campos no hacen zoom al tocarlos, la pantalla no se mueve al salir el teclado y el cuadro del chat no cambia de tamaño por eso. Va antes de RP178 y RP179.

## Tasks

- [x] T1 · S1-S4 · inline · RP177 acceso remoto · commit: pendiente (lo entrega la persona con /flow-commit)
- [x] T0 · S7 · inline · RP180 pantalla estable en el teléfono · commit: pendiente
- [ ] T2 · S5 · inline · RP178 detector de eventos y avisos con la página abierta · commit: pendiente
- [ ] T3 · S6 · inline · RP179 Web Push · commit: pendiente

## Log

- **L1.** «tenemos una tarea muy importante ahora, quiero que analicemos la posibilidad de lograr usar el panel en el teléfono móvil, el objetivo principal es de poder usar en el teléfono móvil corriendo remotamente el servidor. pensemos en las distintas alternativas y posibilidades que tenemos. dame tus opiniones y propuestas de que podemos hacer y vamos a ir profundizando en la idea hasta lograr el objetivo de la mejor manera posible»
- **L2.** «1. actuar totalmente desde el teléfono. 2. estoy de acuerdo. [Tailscale] 3. inicialmente si, mas adelante voy a querer en un servidor en las nubes.»
- **L3.** «mas adelante muy probable realmente no sea un servidor en las nubes, mas seguro que sea una nuc en mi casa ... no hay tanto drama con el teléfono móvil porque es un iphone y tiene bloque de pantalla. no es necesario una auditoria ... lo de ui movil mejorare con el uso. orca ya no usamos directamente para el panel ... no quiero que me pida ninguna confirmacion para las acciones irreversibles ... por el momento usare esta pc mismo»
- **L4.** «si confirmo, RM1 va con las tres piezas (host, login con cookie, Origin) y una cosa mas, quiero implementar notificaciones ...» (texto completo en S5)
- **L5.** «peerfecto, vamos con todos, rm1, rm2 y rm3»
- **L7.** «Ya estoy usando desde el teléfono. ... Ya instale en la pantalla de inicio. Lo primero que podemos ajustar es el zoom o que se mueve mucho la dimensión o la pantalla misma en el teléfono. A veces se redimensiona el input del chat. Creo que primero debemos ajustar eso y después avanzamos con los otros.»
- **L6.** Nota del agente: los IDs «RM1/RM2/RM3» de la conversación son RP177/RP178/RP179 en el roadmap.
