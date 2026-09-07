---
name: herald-highlighting
description: How to add or change syntax highlighting for `.herald` control-file constructs (a new sigil/line type, a marker color, a background). Use whenever asked to highlight/recolor something in `.herald` files, add a color for a new line type, or debug "the highlighting change isn't showing in Sublime". Covers the four grammars that must stay in sync, how Sublime actually loads the files (copies, not the repo), and where the colors that the user actually sees really live.
---

# Highlighting `.herald` files

Highlighting a `.herald` construct is TWO things: a **grammar rule** that tags the text with a
TextMate-style **scope** (e.g. `markup.other.clear.herald`), and a **color rule** in the active
color scheme that paints that scope. Getting a change to actually show has bitten us twice, so
follow all the steps — a change that looks done in the repo often isn't visible yet.

## 1. Add the grammar rule in ALL FOUR grammars (keep them in sync)

Every editor has its own copy of the grammar; they all mirror `parse()` in `herald.ts` and match
in the same order. Add/adjust the rule in each, before the worktree/header fallback so a new sigil
isn't swallowed as a label:

- `herald.sublime-syntax` — Sublime. Add a `- match:` block with `captures: { 1: <scope> }`.
- `tui.ts` — the built-in `pnpm herald` editor. Add a branch in `colorsFor()` and, if it needs a
  new color, an entry in the `C` palette (ANSI escape; use `48;2;R;G;B` for a truecolor bg).
- `editors/nvim/syntax/herald.vim` — add a `syntax match herald<Name>` + a `highlight default
  herald<Name>` line, and add the sigil char to the `heraldWorktree` exclusion lookahead so the
  fallback doesn't grab it.
- `editors/vscode/syntaxes/herald.tmLanguage.json` — add a pattern with `captures.1.name: <scope>`;
  put the color in `editors/vscode/package.json` under `configurationDefaults.textMateRules`.

Scope convention: action-marker lines use `markup.other.<name>.herald` (that's how `shownow` and
`clear` are done). If you reuse a standard TextMate scope (`markup.inserted`, `invalid.deprecated`,
`constant.language`, …) the base scheme colors it for free; a **custom `*.herald` scope needs an
explicit color rule** (step 3).

After editing `tui.ts`, run `nr type-check`.

## 2. Deploy the Sublime syntax — it loads a COPY, not the repo

`setup.ts` **copies** `herald.sublime-*` into Sublime's user dir (Sublime won't follow symlinks), so
**editing the repo file changes nothing until you redeploy**. A stale copy is the #1 reason "my
highlighting change isn't showing." Redeploy with either:

```sh
nr setup   # does everything (also re-touches Claude/shell hooks — heavier)
# …or copy just the changed files (minimal, same effect for highlighting):
cp herald.sublime-syntax herald.sublime-color-scheme \
   "$HOME/Library/Application Support/Sublime Text/Packages/User/"
```

## 3. Put the color where the user ACTUALLY sees it — the active scheme, not the repo file

The repo's `herald.sublime-color-scheme` is a **separate scheme named "herald"** and only applies if
that scheme is selected. The user's active scheme is **J Dark Matrix**, and Sublime only merges a
`.sublime-color-scheme` whose **filename matches the active scheme**. So the herald color rules that
actually paint the user's editor live in:

```
~/Library/Application Support/Sublime Text/Packages/User/J Dark Matrix.sublime-color-scheme
```

Add the rule there, under `"rules"`, mirroring the existing herald entries (it's JSON-with-comments,
`var(...)` color vars + hex allowed):

```json
{ "name": "herald clear line (black on yellow)", "scope": "markup.other.clear.herald",
  "foreground": "var(black)", "background": "#ffe600" }
```

Also update the repo `herald.sublime-color-scheme` (and vscode `package.json`) to match, for
consistency and other setups — but know that editing only the repo file will **not** show for this
user. This file is not tracked by `setup`, so it must be edited by hand.

## 4. Verify with the sublime-mcp

- `get_setting color_scheme` → the active scheme filename = the file to put the color rule in.
- Open a `.herald` file, move the cursor **onto the sigil character** (not the leading tab), then
  `get_scope_at_cursor` → the result must include your `<name>.herald` scope. If it doesn't, the
  grammar rule didn't match or the deployed copy is stale (step 2).
- `get_console_log` → after editing the scheme, confirm it reloaded with no JSON parse error.

Sublime hot-reloads `Packages/User` changes; if a repaint lags, reopen the `.herald` file.
