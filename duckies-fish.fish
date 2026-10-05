# duckies: signal `$command` completion to the controller from fish itself,
# instead of the controller appending a status-writing sentinel to each command.
# Active only in a duckies shell window (DUCKIES_SHELL is set on that window at spawn),
# so it is a no-op in normal shells and in the claude window. The controller polls
# the .cmd file's mtime to know the command has actually exited.
function __duckies_cmd_done --on-event fish_postexec
	set -l st $status
	test -n "$DUCKIES_SHELL" -a -n "$DUCKIES_LABEL"; or return
	set -l dir $DUCKIES_STATE
	test -n "$dir"; or set dir "$HOME/_dev/duckies/state"
	# DUCKIES_PANE (set on numbered shells, `$2`/`$$` …) suffixes the done-file so each
	# lane's shell reports independently; lane 1 (unset) keeps the bare `<label>.cmd`.
	set -l suffix ""
	test -n "$DUCKIES_PANE"; and set suffix ".$DUCKIES_PANE"
	echo $st >"$dir/$DUCKIES_LABEL$suffix.cmd"
	# Also mirror the command line into the lane's capture log so the controller can add
	# manually-typed commands to the `.dk` file. It drops its own sends by matching the
	# text, so logging duckies's own `$command`s here is harmless. Skip a bare Enter.
	test -n "$argv[1]"; and printf '%s\n' $argv[1] >>"$dir/$DUCKIES_LABEL$suffix.incmd"
end
