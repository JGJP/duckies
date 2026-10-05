# duckies: signal `$command` completion to the controller from bash itself, instead
# of the controller appending a status-writing sentinel to each command. Sourced
# from ~/.bashrc but active only in a duckies shell window (DUCKIES_SHELL is set on
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
		cmd=$(HISTTIMEFORMAT= history 1)
		cmd="${cmd#"${cmd%%[![:space:]]*}"}" # ltrim
		cmd="${cmd#* }"                      # drop the leading history number
		cmd="${cmd#"${cmd%%[![:space:]]*}"}" # ltrim what's left
		[ -n "$cmd" ] && printf '%s\n' "$cmd" >>"$dir/$DUCKIES_LABEL$suffix.incmd"
	}
	# Prepend to PROMPT_COMMAND (runs after each command, before the next prompt) so
	# our handler captures $? before anything else in PROMPT_COMMAND can clobber it.
	case ";${PROMPT_COMMAND-};" in
		*";__duckies_cmd_done;"*) ;;
		*) PROMPT_COMMAND="__duckies_cmd_done${PROMPT_COMMAND:+;${PROMPT_COMMAND}}" ;;
	esac
fi
