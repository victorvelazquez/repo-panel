# Design system — repo-panel (synced from `public/style.css`)

Dark, dense, GitHub-like. System fonts only. No framework.

## Colors (source: `public/style.css` `:root`)
| Token | Value | Usage |
| --- | --- | --- |
| `--bg` | `#0f1216` | page background |
| `--panel` | `#171b21` | header, columns, repo blocks |
| `--panel2` | `#1e242c` | cards, buttons, inputs |
| `--line` | `#2a323c` | borders, counters |
| `--text` | `#d7dde5` | body text |
| `--muted` | `#8b96a3` | secondary text, branch names |
| `--green` | `#3fb950` | ok / clean |
| `--red` | `#f85149` | error / attention |
| `--yellow` | `#d29922` | warning / changes |
| `--blue` | `#58a6ff` | links, focus, committed |
| `--gray` | `#6e7681` | neutral |
| `--purple` | `#a371f7` | merged |
| `--orange` | `#db6d28` | reserved |
| primary button | `#1f6feb` | main action (`button.primary`) |
| merge button | `#238636` | merge (`button.merge`) |
| active filter bg | `#12253d` | selected filter |
| chip tints | green `#0f2416`/`#1d4a28`, red `#2a1213`/`#5a1f1c`, yellow `#251d08`/`#53410f`, blue `#0f1d30`/`#1d3a5f` | chip background / border |

## Typography
- Body: `14px/1.45 system-ui, "Segoe UI", sans-serif`.
- Mono (branches, file lists): `ui-monospace, Consolas, monospace`, 12px.
- Header title 16px; repo name 15px/600; section headings 13–14px uppercase, letter-spacing `.06em`, muted.

## Spacing and radius
- Gaps 6, 8, 10px; paddings 4×10 (buttons), 10×12 (rows), 12 (cards), 16 (main).
- Radius: 6px (buttons, inputs), 8px (cards, columns), 10px (chips, counters).
- Content max width 1200px (the Resumen mockups use wider boards on purpose).

## Components
- **Button**: `--panel2` bg, 1px `--line` border, radius 6; hover border `--blue`; disabled opacity .45. Variants `primary` (#1f6feb), `merge` (#238636).
- **Chip**: 12px, radius 10, tinted by color (green, red, yellow, blue, gray).
- **Column**: `--panel`, 1px line border, 3px colored top border, radius 8; head with uppercase title and counter pill.
- **Card**: `--panel2`, line border, radius 8, padding 12.
- Motion: respect `prefers-reduced-motion`.
