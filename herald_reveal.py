"""Sublime command: mark the current herald line for reveal, then save.

Prepends a `!` to each selected line — right after its leading tabs, where parse() in
herald.ts looks for the sigil — and saves the file. On the next tick the supervisor
switches the attached tmux client to that item's pane (the shell for a `$command`, the
claude pane for a prompt, the session for a header/worktree), then strips the `!` itself,
so the mark is self-consuming. Idempotent: a line that already carries a leading `!` is
left untouched, and saving still re-fires the reveal.

Installed into Packages/User by setup.ts (alongside herald.sublime-syntax); Sublime
auto-loads any *.py there. The command palette entry lives in herald.sublime-commands.
"""

import sublime
import sublime_plugin


def _is_herald(view):
    # Only offer the command in `.herald` buffers. Prefer the ST4 syntax scope; fall back
    # to the settings string so it still works on older builds / unassigned syntaxes.
    syntax = view.syntax() if hasattr(view, "syntax") else None
    if syntax is not None:
        return syntax.scope == "source.herald"
    return (view.settings().get("syntax") or "").lower().endswith("herald.sublime-syntax")


class HeraldRevealCommand(sublime_plugin.TextCommand):
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
        return _is_herald(self.view)

    def is_visible(self):
        return _is_herald(self.view)
