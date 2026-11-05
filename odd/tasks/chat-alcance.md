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

## Tasks

- RP104 (S1, S2) · RP105 (S3) · RP106 (S4) · RP107 (S5) · RP108 (S5) · RP109 (S5, S6) · RP110 (S7)

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
