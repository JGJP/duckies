" Vim/Neovim syntax for herald `.herald` control files. Grammar mirrors parse() in
" herald.ts and the Sublime grammar (herald.sublime-syntax): column-0 lines are session
" headers, `#` rows are comments, tab-indented lines are queue items (prompt / $command / show /
" [status marker]). Status markers are white-on-red (override with `hi heraldStatus …`).

if exists('b:current_syntax')
  finish
endif

" Comment: any row starting with `#` (at any indent, incl. column 0) is ignored.
syntax match heraldComment /^\s*#.*$/

" Macro call: a `@name [args]` line the controller expands to a reusable block. A name char
" must follow the `@`, so a `@@@…` body line never matches.
syntax match heraldMacro /^\s*@[0-9A-Za-z_-]\+\%(\s.*\)\?$/

" Session header: a column-0 (non-tab, non-`#`) line. A leading `!` = "show it now"
" (matched by heraldShowNow below).
syntax match heraldHeader /^[^\t#].*$/

" Note: a `-> …` line herald mirrors below a finished prompt (an inert one-line summary of
" the turn). Shown in yellow across the whole line (see the highlight below).
syntax match heraldNote /^\t\+ *->.*$/

" Worktree label: a tab-indented, non-sigil line (a git worktree of the enclosing repo).
" Mirrors parse()'s fallback branch; the lookahead skips comment/macro/prompt/command/
" show/marker/note rows so only true labels match. Styled like a header (Identifier); a
" leading `!` ("show now") is matched by heraldShowNow below.
syntax match heraldWorktree /\c^\t\+ *\%([#@:$[|]\|->\|!\s*$\|show\s*$\|prompt:\)\@!\S.*$/

" Prompt: `prompt:` or the `:` shorthand; `::`/`:2` select the lane. Only the sigil is
" highlighted (\zs starts the match after the indent); the text stays normal.
syntax match heraldPromptSigil /^\t\+ *\zs\c\%(prompt\)\?:\+\d*/

" Command: `$`/`$$`/`$2` sigil, then the shell command text.
syntax match heraldCommandSigil /^\t\+ *\zs\$\+\d*/ nextgroup=heraldCommandText
syntax match heraldCommandText /.*/ contained

" Multiline prompt body: a `|` line continues the prompt above it (YAML block-scalar style).
" Only the `|` sigil is highlighted; the body text stays normal, like a prompt.
syntax match heraldContSigil /^\t\+ *\zs|/

" Show item: a bare `show` (any case) or a bare `!`.
syntax match heraldShow /^\t\+ *\c\%(show\|!\)\s*$/

" Status markers (controller-written): [EXECUTING] [DONE] [NEEDS ATTENTION] [NO DIR …] …
syntax match heraldStatus /^\t\+ *\[[^\]]*\]\s*$/

" Show-now line: any line whose first non-tab char is `!` reveals its pane/session now. The
" whole line is flagged black-on-white, overriding the per-item rules above. Defined last so
" it wins over the same-length header/worktree/show matches it overlaps.
syntax match heraldShowNow /^\s*!.*$/

highlight default link heraldComment      Comment
highlight default link heraldHeader       Identifier
highlight default link heraldWorktree     Identifier
highlight default link heraldPromptSigil  Statement
highlight default link heraldContSigil    Statement
highlight default link heraldCommandSigil Operator
highlight default link heraldCommandText  String
highlight default link heraldShow         Keyword
" Orange across the whole line, matching the Sublime setup; `default` so a colorscheme can override.
highlight default heraldNote guifg=#FF791A ctermfg=208
" White on red, matching the Sublime setup; `default` so a colorscheme can override.
highlight default heraldStatus guifg=#ffffff guibg=#dc0404 ctermfg=15 ctermbg=196
" Black on white for a leading-`!` show-now line; `default` so a colorscheme can override.
highlight default heraldShowNow guifg=#000000 guibg=#ffffff ctermfg=0 ctermbg=15
" Macro calls: black on LINE green (#06C755); `default` so a colorscheme can override.
highlight default heraldMacro guifg=#000000 guibg=#06c755 ctermfg=black ctermbg=41

let b:current_syntax = 'herald'
