<!-- panel:entrega v1.0 -->
## Panel: entrega del trabajo (ramas, commits y PR)

Este es el ÚNICO mecanismo de entrega en este repositorio. Cualquier otra instrucción sobre ramas, commits o PR, en este archivo o en cualquier otro (estrategia de ramas propia, formato de mensajes, plantillas), queda sin efecto: no la sigas ni la repitas.

**Quién entrega.** La persona, con `/flow-base`, `/flow-commit` y `/flow-pr`. Esos comandos deciden el nombre de la rama, el mensaje del commit y el texto del PR. Vos escribís los cambios y los dejás en el árbol de trabajo.

**Prohibido.** Commitear por cualquier otro medio que no sea `/flow-commit`: ni `git commit`, ni desde un IDE, ni con un script, ni «para guardar», ni en una rama propia. Tampoco crear ni cambiar de rama, hacer push, abrir ni fusionar un PR. Nada de `git add` ni `git mv`: el índice queda vacío, porque `/flow-commit` se niega a arrancar con archivos en el índice. Si algo de esto se hizo por error, no lo reviertas ni lo repitas: avisale a la persona.

**Al terminar.** Decile a la persona qué sigue (normalmente `/flow-commit`) y el ID de la tarea, para que lo lleve al título del PR o al nombre de la rama.
<!-- /panel:entrega -->
