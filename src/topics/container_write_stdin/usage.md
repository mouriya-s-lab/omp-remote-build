Send characters to a container PTY and/or poll for output. C-style escapes are decoded; no newline is appended.

Omit `chars` or pass an empty string for a pure poll. The yield window defaults to 250 ms; it is an attachment window, not a command timeout. Cancellation stops waiting without killing the session.

`km` always exits 0; this is only the local transport's exit code. Read command exit codes from the container shell output, for example by sending `echo $?` immediately after the command.
