<!-- panel:estado v1.0 -->
## Panel: estado del trabajo

Después de CADA acción que escriba archivos, corrija o implemente algo, o cuando necesites una decisión de la persona:

1. Escribí `.panel/state.json` (creá la carpeta si falta) con la hora real, por ejemplo la de `node -p "new Date().toISOString()"`:
   `{"state": "...", "next": "una línea clara: qué debe hacer la persona ahora", "detail": "texto largo opcional", "at": "2026-01-31T12:00:00Z"}`
2. Terminá tu respuesta con UNA línea: `Siguiente: <el mismo paso siguiente>`.
3. Nunca commitees `.panel/`. Si Git no la ignora, agregá `.panel/` a `.git/info/exclude` (creá el archivo si falta). No la agregues a `.gitignore`.

Valores de `state`:
- `working`: seguís trabajando.
- `needs-input`: esperás una decisión de la persona.
- `ready-to-commit`: el trabajo está terminado y verificado; se pueden commitear los archivos.
- `ready-to-pr`: ya está commiteado y listo para un pull request.
- `blocked`: no podés seguir; explicá por qué en `detail`.

Ejemplo, al esperar una decisión:
`{"state": "needs-input", "next": "Elegí si el informe va en PDF o en HTML y avisame.", "at": "2026-01-31T12:00:00Z"}`
y la última línea de la respuesta: `Siguiente: Elegí si el informe va en PDF o en HTML y avisame.`
<!-- /panel:estado -->
