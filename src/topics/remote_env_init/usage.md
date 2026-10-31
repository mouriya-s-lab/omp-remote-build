Prepare this worktree's remote build container and return a report for the agent.

Resolve the project image from the configured image, the worktree's Dockerfile, or an Arch Linux image prepared by a subagent and published to `.omp/remote-build.Dockerfile` and `.omp/remote-build.json`. Images are cached on the build host per Dockerfile content. Recreate the container from the resolved image and run the project's bootstrap command.

Call before the first `container_exec` in a worktree whose container is not running, and after dependency changes. Recreating the container ends open container sessions.

Omit `rebuild` to reuse the image. `rebuild: "image"` rebuilds the project image from the worktree Dockerfile even if cached. `rebuild: "prepare"` reruns the preparer and publishes a new `.omp/remote-build.Dockerfile`; it is only allowed without a hand-written Dockerfile.
