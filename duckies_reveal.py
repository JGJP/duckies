"""Sublime command: mark the current duckies line for reveal, then save.

Prepends a `!` to each selected line — right after its leading tabs, where parse() in
duckies.ts looks for the sigil — and saves the file. On the next tick the supervisor
switches the attached tmux client to that item's pane (the shell for a `$command`, the
claude pane for a prompt, the session for a header/worktree), then strips the `!` itself,
so the mark is self-consuming. Idempotent: a line that already carries a leading `!` is
left untouched, and saving still re-fires the reveal.

Installed into Packages/User by setup.ts (alongside duckies.sublime-syntax); Sublime
auto-loads any *.py there. The command palette entry lives in duckies.sublime-commands.
"""

import sublime
import sublime_plugin


def _is_duckies(view):
    # Only offer the command in `.dk` buffers. Prefer the ST4 syntax scope; fall back
    # to the settings string so it still works on older builds / unassigned syntaxes.
    syntax = view.syntax() if hasattr(view, "syntax") else None
    if syntax is not None:
        return syntax.scope == "source.duckies"
    return (view.settings().get("syntax") or "").lower().endswith("duckies.sublime-syntax")


_saved_caret = {}
_reloading = set()


class DuckiesPreserveCaret(sublime_plugin.EventListener):
    """Keep the caret and scroll put when the supervisor rewrites a `.dk` file.

    duckies saves via atomic rename (write a temp, rename it over the file), which swaps
    the file's inode; Sublime sees that as an external change and reloads the clean
    buffer, and the reload yanks the caret away (to the top, or some fixed line) rather
    than leaving it where the user had it. Sublime exposes no pre-reload hook, so we can't
    snapshot right before — instead we remember the caret on every real cursor move and
    restore it after the reload, so an edit duckies makes doesn't move the user's cursor.

    The reload both empties the buffer (a selection change to (0, 0)) and then repositions
    the caret itself (more selection changes) — all of which would overwrite the position
    we want to keep. So while a reload is in flight we stop tracking (the `_reloading`
    gate) and restore from the last position the user actually set.

    Position is kept by row/col (not raw offset): if the supervisor inserts/removes a
    status line, the caret stays on the same screen row rather than sliding with the text.
    """

    def _track(self, view):
        # size 0 is the buffer-clear Sublime does at the very start of a reload, before
        # on_reload fires the `_reloading` gate — guard it explicitly so the clear's
        # jump to (0, 0) can't overwrite the position we're about to put back.
        if not _is_duckies(view) or view.id() in _reloading or view.size() == 0 or view.is_loading():
            return
        _saved_caret[view.id()] = (
            [(view.rowcol(r.a), view.rowcol(r.b)) for r in view.sel()],
            view.viewport_position(),
        )

    def _restore(self, view):
        vid = view.id()
        state = _saved_caret.get(vid)
        if state is None or not _is_duckies(view):
            return
        regions, viewport = state
        # Ignore the reload's own caret moves until it settles, then resume tracking.
        _reloading.add(vid)

        def apply():
            sel = view.sel()
            sel.clear()
            for (row_a, col_a), (row_b, col_b) in regions:
                sel.add(sublime.Region(view.text_point(row_a, col_a), view.text_point(row_b, col_b)))
            view.set_viewport_position(viewport, False)

        # Defer: the reload repositions the caret itself, so an inline restore gets
        # overridden — running on the next tick (and once more after) lets ours win.
        sublime.set_timeout(apply, 0)
        sublime.set_timeout(apply, 30)
        sublime.set_timeout(lambda: _reloading.discard(vid), 100)

    def on_close(self, view):
        _saved_caret.pop(view.id(), None)
        _reloading.discard(view.id())

    on_selection_modified = _track
    # External-change reloads fire on_reload; a user-invoked revert fires on_revert.
    on_reload = _restore
    on_revert = _restore


class DuckiesRevealCommand(sublime_plugin.TextCommand):
    def run(self, edit):
        view = self.view
        # The insert column for each line touched by a selection: just past its leading
        # tab run. Dedupe (multi-cursor on one line) and skip lines already marked.
        cols = set()
        for region in view.sel():
            for line in view.lines(region):
                text = view.substr(line)
                tabs = len(text) - len(text.lstrip("\t"))
                col = line.begin() + tabs
                if view.substr(sublime.Region(col, col + 1)) != "!":
                    cols.add(col)
        # Insert bottom-to-top so earlier inserts don't shift later columns.
        for col in sorted(cols, reverse=True):
            view.insert(edit, col, "!")
        # Save once, after this edit is committed, to trigger the supervisor.
        sublime.set_timeout(lambda: view.run_command("save"), 0)

    def is_enabled(self):
        return _is_duckies(self.view)

    def is_visible(self):
        return _is_duckies(self.view)
