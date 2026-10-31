List container PTY sessions for the current remote-build environment.

Ended sessions remain listed until their final output is polled with `container_write_stdin` or they are killed with `container_kill_session`.

`km` always exits 0; this is only the local transport's exit code. Read command exit codes from the container shell output, for example by sending `echo $?` immediately after the command. A transport exit does not establish the container command's exit status.
