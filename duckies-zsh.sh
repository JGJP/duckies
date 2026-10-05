# duckies: signal `$command` completion to the controller from zsh itself, instead
# of the controller appending a status-writing sentinel to each command. Sourced
# from ~/.zshrc but active only in a duckies shell window (DUCKIES_SHELL is set on
# that window at spawn), so it is a no-op in normal shells and in the claude window.
# The controller polls the .cmd file's mtime to know the command has actually exited.
if [ -n "$DUCKIES_SHELL" ] && [ -n "$DUCKIES_LABEL" ]; then
	__duckies_cmd_done() {
		local st=$?
		local dir="${DUCKIES_STATE:-$HOME/_dev/duckies/state}"
		# DUCKIES_PANE (set on numbered shells, `$2`/`$$` …) suffixes the done-file so each
		# lane's shell reports independently; lane 1 (unset) keeps the bare `<label>.cmd`.
		local suffix="${DUCKIES_PANE:+.$DUCKIES_PANE}"
		echo "$st" >"$dir/$DUCKIES_LABEL$suffix.cmd"
		# Also mirror the command line into the lane's capture log so the controller can add
		# manually-typed commands to the `.dk` file (it drops its own sends by the text).
		local cmd
		cmd=$(fc -ln -1 2>/dev/null)
		cmd="${cmd#"${cmd%%[![:space:]]*}"}" # ltrim leading whitespace/tab
		[ -n "$cmd" ] && printf '%s\n' "$cmd" >>"$dir/$DUCKIES_LABEL$suffix.incmd"
	}
	# precmd runs before each prompt (i.e. after each command). Prepend ours so it
	# captures $? before any other precmd hook can change it.
	typeset -ga precmd_functions
	if (( ! ${precmd_functions[(Ie)__duckies_cmd_done]} )); then
		precmd_functions=(__duckies_cmd_done $precmd_functions)
	fi
fi
