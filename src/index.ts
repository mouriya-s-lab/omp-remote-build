import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CONFIG_PATH, loadConfig } from "./config.ts";
import { registerContainerTools } from "./container-tools.ts";
import { checkHost, envIdFor, mainCheckout, prepareEnv, worktreeRoot } from "./environment.ts";
import { loadHost } from "./host.ts";
import { registerInitTools } from "./init.ts";
import { PREPARER_AGENT_NAME } from "./preparer.ts";
import { findSession, flush } from "./mutagen.ts";
import type { EnvState, PreparedEnv, RemoteBuildConfig } from "./types.ts";
import { setupI18n, tr } from "./i18n.ts";

/** `/worktree [branch]` and its registered name `/wt`. */
const WORKTREE_COMMAND = /^\/(?:wt|worktree)(?:\s|$)/;

/** Upper bound for the native command to move the session into the new worktree. */
const MOVE_TIMEOUT_MS = 10 * 60 * 1000;

const OMOMP_FILENAMES = ["omomp.yml", "omomp.yaml", "omomp.json", "omomp.toml"] as const;

/** Reads the OMP-only `omomp-lang.language` setting without making i18n depend on the host. */
function readOmompLanguage(agentDir: string): unknown {
	const paths = OMOMP_FILENAMES.map(filename => ({ filename, path: join(agentDir, filename) }));
	const existing = paths.filter(({ path }) => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	});
	if (existing.length !== 1) return undefined;
	const { filename, path } = existing[0]!;
	try {
		const text = readFileSync(path, "utf8");
		const parsed = filename.endsWith(".json")
			? JSON.parse(text)
			: filename.endsWith(".toml")
				? Bun.TOML.parse(text)
				: Bun.YAML.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const section = (parsed as Record<string, unknown>)["omomp-lang"];
		if (typeof section !== "object" || section === null || Array.isArray(section)) return undefined;
		return (section as Record<string, unknown>).language;
	} catch {
		return undefined;
	}
}

/** Registers the OMP-side config reader before any labels or statuses are translated. */
function setupLanguageReader(): void {
	setupI18n(() => readOmompLanguage(getAgentDir()));
}

/**
 * Tools that cannot change files in the worktree. Every other tool call is treated
 * as a write (edit/write by definition; eval, exec_command, bash, task, ... because
 * their side effects are unknown) and is followed by a Mutagen flush.
 */
const NON_WRITING_TOOLS: Record<string, true> = {
	read: true,
	grep: true,
	glob: true,
	ast_grep: true,
	web_search: true,
	todo: true,
	ask: true,
	ctx: true,
	wait: true,
	container_exec: true,
	container_write_stdin: true,
	container_list_sessions: true,
	container_kill_session: true,
	// Builds candidates on the build host only; never writes local files.
	remote_env_build_image: true,
};

const CONTAINER_TOOLS = ["container_exec", "container_write_stdin", "container_list_sessions", "container_kill_session"];

/** Every tool this plugin registers. All are registered inactive; {@link activeToolsFor} decides which are shown. */
const PLUGIN_TOOLS: Record<string, true> = {
	container_exec: true,
	container_write_stdin: true,
	container_list_sessions: true,
	container_kill_session: true,
	remote_env_init: true,
	remote_env_build_image: true,
};

export default function remoteBuild(pi: ExtensionAPI) {
	setupLanguageReader();
	/** Environment state per worktree root, for this agent session. */
	const envs = new Map<string, EnvState>();

	const begin = (root: string, config: RemoteBuildConfig): Promise<PreparedEnv> => {
		const done = prepareEnv(root, config).then(
			env => {
				envs.set(root, { kind: "ready", env });
				return env;
			},
			(error: unknown) => {
				envs.set(root, { kind: "failed", error: errorMessage(error) });
				throw error;
			},
		);
		done.catch(() => {});
		envs.set(root, { kind: "preparing", done });
		return done;
	};

	const stateFor = (cwd: string): EnvState | undefined => {
		// ctx.cwd may differ in letter case from git's root on case-insensitive file systems.
		const real = realpathSync.native(cwd);
		for (const [root, state] of envs) {
			if (real === root || real.startsWith(`${root}/`)) return state;
		}
		return undefined;
	};

	/** The environment of the worktree containing `cwd`, prepared on demand inside a remote-build git worktree. */
	const ensureEnv = async (cwd: string): Promise<PreparedEnv> => {
		const state = stateFor(cwd);
		if (state === undefined) {
			const project = await projectConfig(cwd);
			if (project === undefined) throw new Error(`${cwd} is not in a remote-build project (no ${CONFIG_PATH})`);
			if (project.root === (await mainCheckout(project.root))) {
				throw new Error(`remote-build environments exist only in git worktrees; ${project.root} is the main checkout`);
			}
			return begin(project.root, project.config);
		}
		switch (state.kind) {
			case "ready":
				return state.env;
			case "preparing":
				return state.done;
			case "failed":
				throw new Error(`remote-build environment failed: ${state.error}`);
		}
	};

	registerContainerTools(pi, ensureEnv);
	registerInitTools(pi, ensureEnv);

	/**
	 * Shows this plugin's tools only where `ensureEnv` would accept them, for the session's role,
	 * and leaves every other tool's activation as it is. OMP has no event for a session moving to
	 * another directory, so this runs at session start/switch, on every input (a human move command
	 * is followed by the next input), after `/worktree` has moved the session, and before every agent
	 * start (moves made by tools are followed by an agent start without an input).
	 */
	const syncActiveTools = async (ctx: ExtensionContext): Promise<void> => {
		const wanted = await activeToolsFor(ctx);
		const current = pi.getActiveTools();
		const kept = current.filter(name => !(name in PLUGIN_TOOLS));
		if (kept.length + wanted.length === current.length && wanted.every(name => current.includes(name))) return;
		await pi.setActiveTools([...kept, ...wanted]);
	};
	const syncActiveToolsLogged = (ctx: ExtensionContext): Promise<void> =>
		syncActiveTools(ctx).catch((error: unknown) => {
			ctx.ui.notify(`${tr("remote-build: updating tools failed: ", "remote-build：更新工具失败：")}${errorMessage(error)}`, "warning");
		});

	pi.on("session_switch", async (_event, ctx) => {
		await syncActiveToolsLogged(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await syncActiveToolsLogged(ctx);
		return undefined;
	});

	// /worktree: check the build host before the native command runs, then wait for
	// the session to move into the new worktree and prepare its environment there.
	pi.on("input", async (event, ctx) => {
		await syncActiveToolsLogged(ctx);
		if (!WORKTREE_COMMAND.test(event.text.trim())) return undefined;
		const source = await projectConfig(ctx.cwd);
		if (source === undefined) return undefined;
		try {
			await checkHost();
		} catch (error) {
			ctx.ui.notify(`${tr("remote-build: build host check failed, worktree not created: ", "remote-build：构建主机检查失败，未创建 worktree：")}${errorMessage(error)}`, "error");
			return { handled: true };
		}
		const before = ctx.sessionManager.getCwd();
		void waitForMove(ctx, before).then(
			async moved => {
				await syncActiveToolsLogged(ctx);
				const root = await worktreeRoot(moved);
				ctx.ui.setStatus("remote-build", `${tr("remote-build: preparing ", "remote-build：正在准备 ")}${root}`);
				try {
					const env = await begin(root, source.config);
					ctx.ui.notify(`${tr("remote-build: ready ", "remote-build：已就绪 ")}${env.container} <- ${root}`, "info");
				} catch (error) {
					ctx.ui.notify(`${tr("remote-build: environment failed for ", "remote-build：环境失败：")}${root}: ${errorMessage(error)}`, "error");
				} finally {
					ctx.ui.setStatus("remote-build", undefined);
				}
			},
			(error: unknown) => ctx.ui.notify(`${tr("remote-build: ", "remote-build：")}${errorMessage(error)}`, "warning"),
		);
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		await syncActiveToolsLogged(ctx);
		const project = await projectConfig(ctx.cwd);
		if (project === undefined) return;
		if (ctx.agent.kind === "sub" && isIsolatedSubagent(ctx)) {
			// Isolated subagent: its own workspace gets its own environment.
			void begin(project.root, project.config).catch(() => {});
		} else if (project.root !== (await mainCheckout(project.root)) && (await findSession(await loadHost(), envIdFor(project.root)))) {
			// Session (re)opened inside a worktree whose environment already exists.
			void begin(project.root, project.config).catch(() => {});
		}
	});

	// No tool runs in a worktree whose environment is still preparing or failed.
	pi.on("tool_call", async (_event, ctx) => {
		const state = stateFor(ctx.cwd);
		if (state === undefined || state.kind === "ready") return undefined;
		if (state.kind === "failed") return { block: true, reason: `remote-build environment failed: ${state.error}` };
		try {
			await state.done;
			return undefined;
		} catch (error) {
			return { block: true, reason: `remote-build environment failed: ${errorMessage(error)}` };
		}
	});

	// Implicit flush after every write-class tool call.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName in NON_WRITING_TOOLS) return undefined;
		const state = stateFor(ctx.cwd);
		if (state?.kind !== "ready") return undefined;
		await flush(state.env.host, state.env.mutagenSession);
		return undefined;
	});
}

/** An opted-in worktree: its canonical root and the config read from it. */
interface Project {
	readonly root: string;
	readonly config: RemoteBuildConfig;
}

async function projectConfig(cwd: string): Promise<Project | undefined> {
	let root: string;
	try {
		root = await worktreeRoot(cwd);
	} catch {
		return undefined;
	}
	const config = await loadConfig(root);
	return config === undefined ? undefined : { root, config };
}

/**
 * The plugin tools to show in `ctx`'s session: none unless `ctx.cwd` is in a linked worktree whose root
 * has a valid `.omp/remote-build.json` (the conditions `ensureEnv` enforces); then the container tools
 * plus `remote_env_build_image` for the preparer or `remote_env_init` for every other agent.
 */
async function activeToolsFor(ctx: ExtensionContext): Promise<string[]> {
	let project: Project | undefined;
	try {
		project = await projectConfig(ctx.cwd);
	} catch {
		return []; // invalid config: ensureEnv would reject every call
	}
	if (project === undefined || project.root === (await mainCheckout(project.root))) return [];
	return [...CONTAINER_TOOLS, ctx.agent.name === PREPARER_AGENT_NAME ? "remote_env_build_image" : "remote_env_init"];
}

function isIsolatedSubagent(ctx: ExtensionContext): boolean {
	return ctx.sessionManager
		.getEntries()
		.some(entry => entry.type === "session_init" && "isolated" in entry && entry.isolated === true);
}

/** Resolves with the session cwd once the native command has moved the session away from `before`. */
function waitForMove(ctx: ExtensionContext, before: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const deadline = Date.now() + MOVE_TIMEOUT_MS;
	const tick = () => {
		const now = ctx.sessionManager.getCwd();
		if (now !== before) return resolve(now);
		if (Date.now() > deadline) return reject(new Error("/worktree did not move the session; no environment prepared"));
		setTimeout(tick, 100);
	};
	setTimeout(tick, 100);
	return promise;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
