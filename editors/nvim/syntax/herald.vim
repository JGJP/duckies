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

" Session header: a column-0 (non-tab, non-`#`) line. A trailing `!` = "show it now".
syntax match heraldHeader /^[^\t#].*$/ contains=heraldBang

" Worktree label: a tab-indented, non-sigil line (a git worktree of the enclosing repo).
" Mirrors parse()'s fallback branch; the lookahead skips comment/macro/prompt/command/
" show/marker rows so only true labels match. Styled like a header (Identifier), and a
" trailing `!` ("show now") gets the same accent.
syntax match heraldWorktree /\c^\t\+ *\%([#@:$[|]\|!\s*$\|show\s*$\|prompt:\)\@!\S.*$/ contains=heraldBang

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
" A trailing `!` means "reveal now".
syntax match heraldStatus /^\t\+ *\[[^\]]*\]!\=\s*$/ contains=heraldBang

" A trailing `!` reveal/show-now marker, highlighted within a header or status line.
syntax match heraldBang /!/ contained

highlight default link heraldComment      Comment
highlight default link heraldHeader       Identifier
highlight default link heraldWorktree     Identifier
highlight default link heraldPromptSigil  Statement
highlight default link heraldContSigil    Statement
highlight default link heraldCommandSigil Operator
highlight default link heraldCommandText  String
highlight default link heraldShow         Keyword
highlight default link heraldBang         Special
" White on red, matching the Sublime setup; `default` so a colorscheme can override.
highlight default heraldStatus guifg=#ffffff guibg=#dc0404 ctermfg=15 ctermbg=196
" Macro calls: black on LINE green (#06C755); `default` so a colorscheme can override.
highlight default heraldMacro guifg=#000000 guibg=#06c755 ctermfg=black ctermbg=41

let b:current_syntax = 'herald'
