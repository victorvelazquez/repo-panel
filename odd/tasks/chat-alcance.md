# Chat: más alcance y subagentes (RP104 a RP110)

Series that widens what the panel chat shows and studies how to use subagents, up to a room Director. Status of each task lives only in `docs/ROADMAP.md`.

## Specs

- S1. Chat history reads more than the last 64 KB of the session file: a 512 KB window, hard cap 1 MB (RP104).
- S2. «No es necesario mostrar todo el bloque de thinking. pero que muestre por lo menos el texto 'thinking...'.» Only the block type travels, never the text (RP104).
- S3. The tool chip shows ✓/✗, duration and a one-line argument of at most 80 characters, always visible, with secrets redacted; tests prove a secret does not leave the server (RP105).
- S4. Tool results are folded and truncated, opt-in, in their own PR; edits show only «edited X +12 −3», never a diff (RP106).
- S5. Studies RP107 and RP108 write no code; each ends in a short document with `path:line` evidence.
- S6. Room Director (RP109): «el Director lanza y ordena». Repo agents report to the Director; the Director resolves by itself only technical, reversible matters inside the already authorized scope, and ALWAYS asks the person for any decision («las deciciones debe preguntarme siempre que yo las decida»). When in doubt it asks. What it resolved alone is logged and visible. Agents leave work at `ready-to-commit`; delivery stays with the person.
- S7. «analiza si el repo panel al usar gentle shell o pi en el chat si igual les funciona engram? y las otras conexiones mcps?» (RP110, prerequisite of RP109).
- S8. «no podemos hacer que se muestre todo el mensaje para estos casos y despues hacer la pregunta?» y «quiero que hagas el Estudio opcional tambien» (RP122): study of why the approval questions arrive cut and whether the panel can show the whole command first; it writes no code.
- S9. «el input del chat sigue teniendo este mensaje:» (con la captura del chip rojo «memory error» junto al estado de la sesión, después de que el servicio de Engram ya se había arreglado) (RP123).
- S10. «podemos mejorar cuando se muestra una tabla en el chat? porque se ve mal, no estructurada:» (con la captura de una tabla de Markdown dibujada como líneas con barras verticales) (RP124).

## Tasks

- RP104 (S1, S2) · RP105 (S3) · RP106 (S4) · RP107 (S5) · RP108 (S5) · RP109 (S5, S6) · RP110 (S7) · RP122 (S8) · RP123 (S9) · RP124 (S10)

## Log

- L1. User: «que tanto mostramos en el chat lo que se muestra en la terminal con pi?» … list of what is and is not shown; then asked for a longer history, «thinking...», and more functional chat; agreed the 3-step plan, argument visible with redaction; added subagent studies, the room Director, the Director/orchestrator naming (Director chosen) and the Engram/MCP parity check.

- L2. RP104 closed: `CHAT_WINDOW` = 512 KB in `readChat`; `thinking: true` on assistant items; live flag `thinking` in `rpcReduce`; tests `test/rp104-chat-reach.test.js`. S1 and S2 covered. Closed in the same diff as the row.

- L3. RP105 closed (split: turn marks and compaction lines moved to RP105b). Independent verification took three rounds because a pattern-based redaction of shell commands leaked (23, then 12 forms): the design became a closed vocabulary in `server/redact.js`; accepted limits are in the README. S3 covered; tests `test/rp105-tool-chips.test.js`, `test/rp105-allowlist.test.js`.

- L4. RP105b closed: `stop` on assistant items and a `system`/`compaction` item in `readChat`, notes in the page; retry has no record in the session file and moved to RP105c. Tests `test/rp105b-turn-marks.test.js`.

- L5. RP105c closed, live only: pi emits `auto_retry_start`/`auto_retry_end` and the RPC mode forwards them; the history file keeps no retry. Whitelist keeps numbers and the verdict, never the error texts; the page shows «Retrying…» in the live tail. Tests `test/rp105c-retry.test.js`.

- L6. RP106 closed, split by the person: numbers only (`size`, and `add`/`del` for edits from `details.patch`). The text of a result moved to RP106b (privacy, free text, on demand, independent verification). Tests `test/rp106-edit-summary.test.js`.

- L7. RP106b closed with the switch OFF by default (decision of the person: «podemos empezar con apagado»). Route `GET /api/chat/result`, `chat.showResults` in config.json (kept by loadConfig), cleaning in `server/redact.js` (`redactText`, `resultText`), refusal of file readers by name (`isFileReader`). Three rounds of independent verification; the accepted limits are in the README. RP111 (Settings tab) added to show the switch. Tests `test/rp106b-results.test.js`, `test/rp106b-hardening.test.js`.

- L8. RP111 closed as DESIGN only (split by the person: «Empezar por el diseño de Settings»): `design/settings/` with artboards `01-lista-agrupada.html`, `02-indice-y-panel.html` and `03-tarjetas-por-alcance.html` (A, B, C); the implementation is RP111b and waits for the person to choose one artboard on the canvas. The others are alternatives. `design/system.md` is older than `public/style.css` but its tokens match the live `:root`.

- L9. RP111b started: the person chose artboard A (`design/settings/01-lista-agrupada.html`) and confirmed the scope («Arrancar RP111b con este alcance»): a Settings tab with `GET`/`POST /api/settings` over a closed list (today `chat.showResults`), «pi to use» through the existing `POST /api/pi-runtime`, browser preferences through the existing mechanism, planned options disabled. Handoff reported as in progress.

- L10. RP111b closed: tab Settings from artboard `01-lista-agrupada.html` (chosen; the other two artboards are alternatives), closed list of options in `server/settings.js` and `GET`/`POST /api/settings`; the independent check found one real defect (`S.backTab` could be `settings`), fixed test-first. Handoff reported as implemented. Tests `test/rp111b-settings.test.js`, `test/rp111b-page.test.js`.

- L11. RP107 closed: `docs/ESTUDIO-subagentes.md`. Each subagent has its own session file under `gentle-agents/sessions`; the link is `parentSessionId` of `gentle-agents/tasks/<id>.json` (one file per FINISHED task) and the live state is in `gentle-agents/presence`; a child cannot start subagents (flat model), which constrains RP109. Measured on 200 tasks and 15 parent files.

- L12. User, after reading the RP107 study: «si, la idea es luego que el director mande orden de abrir sesion en cada repo y cada repo debe tener su agente principal.» Confirms the architecture of RP109: the Director orders a session to be opened in each repo and every repo has its own main agent (a top-level pi session over RPC, which may have its own subagents). Recorded in `docs/ESTUDIO-subagentes.md` and in the notes of RP109.

- L13. RP108 sources for the previous terminal and worktree tool (named here because the repository does not name it outside the history, test `rpc4-no-trace`): the public guides `orca-cli.md` and `orchestration.md` of the GitHub repository `stablyai/orca` and the site onorca.dev, read through an exploration (the local skills are only a stub that points to the program's own `orca skills get` command, which was not run). `docs/ESTUDIO-usos-subagentes.md` calls it «la herramienta anterior».

- L14. RP108 closed: `docs/ESTUDIO-usos-subagentes.md`. Claude Code allows nested subagents (3 levels) and Gentle Pi does not, which fits the confirmed Director design (one top-level session per repo). Nine possibilities ranked; six rows proposed (RP112 to RP117) and NOT added to the roadmap, the person decides. The study does not name the previous tool (test `rpc4-no-trace`): see L13.

- L15. RP110 closed as an INVESTIGATION only (split by the person: «Partir: RP110 investigación ahora, arreglo en RP110b»): `docs/INFORME-entorno-chat.md`. The scrub of PI_*, GENTLE_* and ENGRAM_* is neutral today (the launcher recomputes them and the person defines none at user or machine level); Engram loads the same in the panel and in the terminal; no MCP tools load anywhere (`-builtin:mcp` is disabled and no adapter is installed). Security note outside the panel: the agent's `mcp.json` keeps an API key in plain text (value not reproduced). RP110b was narrowed to a memory-status indicator and, only if needed, an allow-list behind Settings.

- L16. RP109 closed: `docs/ESTUDIO-director.md`. Recommended architecture C (the panel is the mechanical Director with a fixed order vocabulary; an optional model assistant only reads and proposes). The escalation list of what the Director may resolve alone STARTS EMPTY and only the person changes it. The Director cannot chain tasks inside a repo (the gate of AGENTS.md needs the person's delivery) and keeps a log, never a parallel state (AGENTS.md forbids it). Eight stages proposed (D1 to D8) and NOT added to the roadmap: the person decides.

- L17. RP110b closed, split by the person («Partir: indicador ahora, lista de variables en RP110c»): the memory-status chip. The RPC client keeps only the `setStatus` notice of the key `engram` (its last 200 characters); the host reduces it to one category of a closed list (`ready`, `offline`, `disabled`, `error`) and publishes only changes; the text never leaves the server. RP110c (allow-list of environment variables) is `Bloqueada` until the person defines own variables. Read in code, not live: the plugin emits `ready`/`offline` (`index.ts:2519`) and `memory disabled` (`:2450`). Tests `test/rp110b-memory.test.js`.
- L18. RP122 closed: `docs/ESTUDIO-preguntas-cortadas.md`. The cut is made by gentle-pi (`guardedCommandPreview`, 180 columns, `extensions/gentle-ai.ts:1698`) before the question reaches the panel; the question carries no tool-call id; pairing it with the call by order is a guess and showing the whole command goes against RP105. Recommendation: keep cut questions Deny-only and ask gentle-pi for the whole message or a `toolCallId`. The person authorized reading outside the repo (gentle-pi, pi, session history). Pending decision of the person: whether to ask upstream.
- L19. The person approved option A of RP122 («la opcion A esta bien entonces»: ask gentle-pi to send the whole command in RPC mode; a request text was drafted in the chat and nothing was filed). Two visual points came with it. RP123 (the memory chip stays on «memory error» after Engram works again) is taken now: it is the limit RP110b wrote down, seen for real. RP124 (Markdown tables in the chat) is registered `Pendiente`, a separate PR.
- L20. RP123 done: the chip of the memory recovers. The plugin writes `· ✓ <result>` after a call that went well and `· ✗ <text>` after one that failed; `memoryOf` now reads them (`ready` and `error`) and the chip no longer stays on `memory error` once Engram works again. Only the category travels. The limit that stays: the chip shows the LAST thing the plugin said. Not seen in a real session yet.
- L21. RP124 done: the chat draws Markdown tables as tables. `mdBlocks` had no case for them, so the lines with bars fell into a paragraph glued with `<br>`. A table is a header line, a separator line with the same number of cells and the rows; cells go through `mdInline` (escaped, no HTML), alignment is a class, columns and rows are capped (30 and 300) and what is over the cap is drawn as text. Compared with the renderer of the previous commit, only valid tables differ (2 of 17 samples). Not seen in the real chat yet: the person approves how it looks.
