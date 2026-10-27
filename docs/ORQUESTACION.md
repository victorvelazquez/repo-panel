# Orquestación en repo-panel

Registro de qué se adoptó y qué se desvió. Lo lee `verificar-adopcion.sh`.

- **Fecha de adopción:** 2026-10-23
- **Perfil:** compatible con panel
- **Bloque Registro en `AGENTS.md`:** versión 1.0
- **Bloque Ciclo en `AGENTS.md`:** versión 1.0 (sin las regiones `SALA`)
- **Bloques del panel en `AGENTS.md`:** `tareas` 1.1, `entrega` 1.0 y `estado` 1.0
- **Métodos adoptados:** Registro, Ciclo
- **Padrón del panel:** 1.1

El control de adopción compara las versiones con las vigentes mirando los marcadores `orquestacion:registro` y `orquestacion:ciclo` de `AGENTS.md`; este registro es para las personas.

## Reglas no adoptadas o cambiadas

| Regla | Qué se hizo en su lugar | Por qué | Quién lo decidió | Fecha |
| --- | --- | --- | --- | --- |
| Método Ciclo (`SHOULD` en este perfil) | Se adoptó el bloque, sin las regiones `SALA` | El panel lo pide en la orden de «Put in conditions» (padrón 1.0) y este repositorio no pertenece a ninguna sala; el 2026-10-23 se había decidido no adoptarlo | Victor | 2026-10-26 |

## Herramientas en uso

| Herramienta | Versión o ruta | Nota |
| --- | --- | --- |
| Git y `gh` | | |
| `verificar-adopcion.sh` | 1.0, ejecutado desde fuera del repositorio | No se copia al repositorio |
