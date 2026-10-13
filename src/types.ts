/**
 * Domain types shared by every module of the remote-build plugin.
 *
 * A remote-build environment exists for exactly one local worktree root:
 * a Mutagen one-way-replica session (local -> build host) plus one Komodo
 * Deployment container on the build host that bind-mounts the replica.
 */

/** Parsed user-level host config (`<omp agent dir>/remote-build.json`). */
export interface HostConfig {
	/** SSH destination of the build host (an OpenSSH alias or `user@host`); used by ssh and as the Mutagen beta host. */
	readonly ssh: string;
	/** Absolute replica root on the build host; one subdirectory per environment. */
	readonly remoteRoot: string;
	readonly komodo: {
		/** `[[profile]]` name or alias in `cliConfig`; supplies the Core URL and API credentials. */
		readonly profile: string;
		/** Komodo Server (Periphery) name of the build host. */
		readonly server: string;
		/** Absolute path of the km CLI config file holding `profile`. */
		readonly cliConfig: string;
	};
	/** Executables; bare names are resolved through PATH. */
	readonly bin: {
		readonly km: string;
		readonly mutagen: string;
	};
}

/**
 * Where the project image comes from.
 * `configured`: a ready image named in the config; deployed automatically.
 * `dockerfile`: a repo-relative Dockerfile named in the config (a prepared image publishes `.omp/remote-build.Dockerfile` here), built by `remote_env_init`.
 * `detect`: `remote_env_init` probes for a Dockerfile, else a subagent prepares one and publishes it.
 */
export type ImageSource =
	| { readonly kind: "configured"; readonly image: string }
	| { readonly kind: "dockerfile"; readonly path: string }
	| { readonly kind: "detect" };

/** Parsed `.omp/remote-build.json` at a worktree root. Presence opts the project in. */
export interface RemoteBuildConfig {
	readonly imageSource: ImageSource;
	/** One-line shell command run with `<shell> -c` in the workdir of a fresh container after each init deployment. */
	readonly bootstrap: string | null;
	/** Mount point of the synced tree inside the container; also the container working dir. */
	readonly workdir: string;
	/** Shell started by the PTY tool inside the container. */
	readonly shell: string;
	/** Extra Mutagen ignore patterns (Mutagen syntax, relative to the sync root), on top of git ignores. */
	readonly ignore: readonly string[];
	/** Repo-relative paths that git ignores but must still be synced. */
	readonly include: readonly string[];
	/**
	 * Container-only files: target path in the remote tree (repo-relative) ->
	 * local source path (repo-relative). Targets are excluded from sync and
	 * uploaded separately, so they exist only on the remote side.
	 */
	readonly containerFiles: Readonly<Record<string, string>>;
	/** Extra `docker run -v` specs, e.g. named cache volumes. */
	readonly volumes: readonly string[];
	/** Extra container environment variables. */
	readonly env: Readonly<Record<string, string>>;
}

/** Stable identity of one environment; derived from the absolute worktree root. */
export type EnvId = string & { readonly __brand: "EnvId" };

/** Stable identity of one project (all worktrees of one repository); derived from the absolute main checkout root. */
export type ProjectId = string & { readonly __brand: "ProjectId" };

/** A worktree Dockerfile and its content hash, which keys the project image tag. */
export interface DockerfileRef {
	/** Repo-relative path. */
	readonly path: string;
	readonly sha256: string;
	readonly text: string;
}

/** Everything needed to reach one environment once it is prepared. */
export interface PreparedEnv {
	readonly id: EnvId;
	/** Absolute local worktree root (Mutagen alpha). */
	readonly root: string;
	/** Absolute replica path on the build host (Mutagen beta, bind-mounted into the container). */
	readonly remotePath: string;
	/** Mutagen session identifier (full id, used for flush). */
	readonly mutagenSession: string;
	/** Komodo Deployment name == container name. */
	readonly container: string;
	readonly config: RemoteBuildConfig;
	/** Host config the environment was prepared with. */
	readonly host: HostConfig;
}

/** State of the environment for a worktree root within this plugin instance. */
export type EnvState =
	| { readonly kind: "preparing"; readonly done: Promise<PreparedEnv> }
	| { readonly kind: "ready"; readonly env: PreparedEnv }
	| { readonly kind: "failed"; readonly error: string };

/** Mutagen ignore rules derived for one session, in evaluation order. */
export interface MutagenIgnoreRules {
	/** Patterns passed as repeated `--ignore` (Mutagen syntax, `!` negations allowed). */
	readonly patterns: readonly string[];
}

/** Container to run through the container backend. */
export interface ContainerSpec {
	/** Komodo Deployment name and docker container name. */
	readonly name: string;
	readonly image: string;
	/** Container working directory; `null` keeps the image default. */
	readonly workdir: string | null;
	/** `docker run -v` specs, `host-or-volume:container[:mode]`. */
	readonly mounts: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

/** Outcome of a one-shot container run. */
export interface OnceResult {
	readonly exitCode: number;
	/** Tail of stdout, then stderr after a `[stderr]` marker. */
	readonly output: string;
}

/** Image build through the container backend. */
export interface ImageBuildSpec {
	/** Name of the helper container that runs the build. */
	readonly name: string;
	/** Tag to produce. */
	readonly image: string;
	/** Absolute build-context directory on the build host. */
	readonly contextPath: string;
	/** Dockerfile path relative to the context. */
	readonly dockerfile: string;
}
