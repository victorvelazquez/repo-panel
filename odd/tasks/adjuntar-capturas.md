Poder adjuntar imágenes y capturas en el chat del panel y mandárselas a la sesión. Rama base: main. Una tarea = un PR.
Riesgo ALTO de seguridad (subida de archivos al servidor): se planea y se decide antes de tocar código. Estado: sin planear; la fila RP215 está Pendiente.

## Specs

- **S1. Adjuntar capturas.** «No tengo como pasar captura porque nuestro chat del panel no tiene todavía la capacidad de pasarle captura. Creo que debemos planear esa posibilidad de agregar esa capacidad al panel.»

## Tasks

- [ ] **T1. RP215** — S1. Adjuntar imágenes y capturas en el chat. Ruta: por decidir; primero un plan que resuelva las decisiones (a) a (e) de la fila, con verificación independiente y una prueba que reproduzca el abuso. Commit: —

## Log

- **L1.** Mensaje de la persona (2026-11-15), tal cual: «No tengo como pasar captura porque nuestro chat del panel no tiene todavía la capacidad de pasarle captura. Creo que debemos planear esa posibilidad de agregar esa capacidad al panel.» Motivo concreto: no pudo mandar una captura del difuminado de iOS (RP205). Hasta ahora estaba solo en la memoria del agente, sin fila.
- **L2.** Mensaje de la persona (2026-11-16), tal cual, al listar sus pendientes: «La idea guardada de adjuntar capturas en el chat (riesgo alto de seguridad): sigue sin fila.» y «no quiero que me pidas mas». El agente lo tomó como pedido de resolver esos pendientes por su cuenta; para esta idea lo único seguro es registrarla: creó la fila RP215 como Pendiente y esta ficha, sin decidir nada del diseño. Las decisiones (a) a (e) de la fila siguen abiertas y son de la persona; por ser de riesgo alto, `siguiente` debe detenerse ahí y mostrarle un resumen.
