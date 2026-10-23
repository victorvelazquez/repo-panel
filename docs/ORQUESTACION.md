# Orquestación en repo-panel

Registro de qué se adoptó y qué se desvió. Lo lee `verificar-adopcion.sh`.

- **Fecha de adopción:** 2026-10-23
- **Perfil:** compatible con panel
- **Bloque Registro en `AGENTS.md`:** versión 1.0
- **Bloque Ciclo en `AGENTS.md`:** no adoptado
- **Métodos adoptados:** Registro

El control de adopción compara las versiones con las vigentes mirando el marcador `orquestacion:registro` de `AGENTS.md`; este registro es para las personas.

## Reglas no adoptadas o cambiadas

| Regla | Qué se hizo en su lugar | Por qué | Quién lo decidió | Fecha |
| --- | --- | --- | --- | --- |
| Método Ciclo (`SHOULD` en este perfil) | No se adoptó el bloque | El ciclo de entrega ya lo llevan `/flow-branch`, `/flow-commit` y `/flow-pr` | Victor | 2026-10-23 |

## Herramientas en uso

| Herramienta | Versión o ruta | Nota |
| --- | --- | --- |
| Git y `gh` | | |
| `verificar-adopcion.sh` | 1.0, ejecutado desde fuera del repositorio | No se copia al repositorio |
