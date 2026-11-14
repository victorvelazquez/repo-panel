# Ícono K con punto azul (RP185 a RP187)

Usar el K-icon de la persona en la pestaña, el iPhone, la app instalada, los avisos, la bandeja y la cabecera móvil. Rama base: main. Una tarea = un PR. Orden: RP185, RP186, RP187.
La base es `public/K-icon.svg` (copia del archivo de la persona: la K blanca y un punto azul, sin fondo). El punto azul es el de «Kletus.dev».

## Specs

- **S1. El pedido.** «tenemos eso icono que movimos en la carpeta temp. k-icon creo que se llama. eso icono quiero que usemos para el icono de la app. tanto para el icono de la pestaña del navegador como para el icono de acceso directo agregado al escritorio de la pc y app de iphone. tambien si podemos usar ese icono en el gestor de tareas o no se como se llama donde le damos clic derecho para 'Restart panel'. tambien ese icono quiero que useme como el logo de kletus.dev que esta en la parte superior izquierda del panel cuando se esta en modo pantalla movil. y solo en modo escritorio mantener el logo actual que es mas grande.»
- **S2. Fondo e iPhone.** «el svg que tenemos en temp es una base de cual partir para las necesidades. Y si debemos crearle el cuadrado oscuro para el fondo.» / «el icono para la app del iPhone si tenes cómo crear partiendo de la base.»
- **S3. Bandeja.** «para la bandeja me parece bien tu recomendación. Justamente esa es la idea que el botón azul indique activo. Y el punto gris claro que indique inactivo. Si tenemos cómo cambiar también el fondo del negro a un gris oscuro y el punto que quede más claro que el fondo gris?»
- **S4. Aclaración de la bandeja.** «creo que te pase mal el detalle como queria el El ícono junto al reloj es ahora la K blanca sobre un cuadrado con puntas levemente redondeadas acorde al panel y el fondo oscuro como el panel con el punto azul cuando esta activo. y cuando esta inactivo el punto puede mostrar en gris claro o rojo suave.»

## Tasks

- [x] T1 · S1-S2 · pruebas del padre, implementación delegada · RP185 ícono web, iPhone, app instalada y avisos · commit: pendiente
- [x] T2 · S1 · inline · RP186 logo móvil de la cabecera · commit: pendiente
- [x] T3 · S1, S3 · inline · RP187 ícono de la bandeja con el punto de estado · commit: pendiente

## Log

- **L1.** S1, S2 y S3 son mensajes de la persona (ver arriba), en ese orden.
- **L2.** Nota del agente: quedaron sin contestar dos decisiones, que no frenan el código. (a) Si el acceso directo de la PC es la app instalada desde Edge o un acceso directo hecho a mano: RP185 cubre las dos cosas (PNG en el manifiesto y un `favicon.ico` que se puede asignar a mano). (b) Si acepta reinstalar la app en el iPhone para ver el ícono: hace falta quitarla y volver a agregarla, y pierde la sesión y el push de esa app.
- **L3.** Nota del agente: la K del `icon.svg` actual y la del K-icon son la misma figura con otro origen vertical (1,8 unidades). `icon.svg` conserva su K sin tocar porque `rp102-logo` la compara con la del logo y `rp102-tray` lee el primer `d=`; el punto se agrega después con su posición en esas unidades.
- **L4.** Nota del agente: la copia `public/K-icon.svg` es idéntica byte a byte al archivo de la persona (391 bytes, finales LF). Antes dije por error que el original tenía finales de Windows: lo había medido con un contador que coincidía con todas las líneas.
- **L5.** Nota del agente: RP185 se cerró tras corregir dos defectos que ninguna prueba vio y salieron de mirar los PNG y de medir: la K tenía dos mellas (relleno par-impar en lugar de enrollado distinto de cero) y las pruebas tardaban 93 s. Quedan RP186 y RP187.
- **L6.** Nota del agente: RP186 hecha. El `h1` de la cabecera es un `<picture>`: la K con el punto azul por debajo de 760 px (el corte angosto del panel) y el logo grande de ahí para arriba. Falta que la persona la apruebe mirándola en el iPhone. Queda RP187.
- **L7.** Nota del agente: RP187 hecha y con ella la serie del ícono K. La bandeja dibuja la K y el punto sobre un cuadrado gris oscuro; el punto dice el estado. El punto va 1,4 veces más grande que el de `K-icon.svg` para que se vea a 16 px, y es la constante `$dotBoost` si se lo quiere fiel al archivo. Falta que la persona la apruebe mirándola junto al reloj, después de salir de la bandeja y abrirla de nuevo.
- **L8.** S4 es un mensaje de la persona, que corrige lo que entendió el agente de S3. Nota del agente: el agente había puesto un gris oscuro (52, 56, 64), esquinas con el 22 por ciento de la altura y un punto gris claro sin mostrar la otra opción. Ahora la bandeja usa el oscuro del panel (15, 18, 22), esquinas con el 14 por ciento y el rojo suave por defecto, con el gris claro como opción que se cambia en una línea. Pasa por el PR #253, todavía abierto.
