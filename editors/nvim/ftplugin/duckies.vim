" duckies control files are tab-indented (the supervisor writes real tabs); keep them so
" edits round-trip. `#` starts a comment line, so use it as the comment leader.
setlocal noexpandtab tabstop=4 shiftwidth=4 softtabstop=0
setlocal commentstring=#\ %s
