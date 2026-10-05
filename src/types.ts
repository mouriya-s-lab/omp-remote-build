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

/** Parsed `.omp/remote-build.json` at a worktree root. Presence opts the project in. */
export interface RemoteBuildConfig {
	/** Container image for the build/test container. */
	readonly image: string;
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

/** Container to run for one environment. */
export interface ContainerSpec {
	/** Komodo Deployment name and docker container name. */
	readonly name: string;
	readonly image: string;
	/** Host path on the build host bind-mounted at `workdir`. */
	readonly hostPath: string;
	readonly workdir: string;
	readonly volumes: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}
