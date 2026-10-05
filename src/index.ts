import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { registerContainerTools } from "./container-tools.ts";
import { checkHost, envIdFor, prepareEnv, worktreeRoot } from "./environment.ts";
import { loadHost } from "./host.ts";
import { findSession, flush } from "./mutagen.ts";
import { run } from "./run.ts";
import type { EnvState, PreparedEnv, RemoteBuildConfig } from "./types.ts";

/** `/worktree [branch]` and its registered name `/wt`. */
const WORKTREE_COMMAND = /^\/(?:wt|worktree)(?:\s|$)/;

/** Upper bound for the native command to move the session into the new worktree. */
const MOVE_TIMEOUT_MS = 10 * 60 * 1000;

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
};

export default function remoteBuild(pi: ExtensionAPI) {
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

	const resolveEnv = async (cwd: string): Promise<PreparedEnv> => {
		const state = stateFor(cwd);
		if (state === undefined) throw new Error(`no remote-build environment for ${cwd}`);
		switch (state.kind) {
			case "ready":
				return state.env;
			case "preparing":
				return state.done;
			case "failed":
				throw new Error(`remote-build environment failed: ${state.error}`);
		}
	};

	registerContainerTools(pi, resolveEnv);

	// /worktree: check the build host before the native command runs, then wait for
	// the session to move into the new worktree and prepare its environment there.
	pi.on("input", async (event, ctx) => {
		if (!WORKTREE_COMMAND.test(event.text.trim())) return undefined;
		const source = await projectConfig(ctx.cwd);
		if (source === undefined) return undefined;
		try {
			await checkHost();
		} catch (error) {
			ctx.ui.notify(`remote-build: build host check failed, worktree not created: ${errorMessage(error)}`, "error");
			return { handled: true };
		}
		const before = ctx.sessionManager.getCwd();
		void waitForMove(ctx, before).then(
			async moved => {
				const root = await worktreeRoot(moved);
				ctx.ui.setStatus("remote-build", `remote-build: preparing ${root}`);
				try {
					const env = await begin(root, source.config);
					ctx.ui.notify(`remote-build: ready ${env.container} <- ${root}`, "info");
				} catch (error) {
					ctx.ui.notify(`remote-build: environment failed for ${root}: ${errorMessage(error)}`, "error");
				} finally {
					ctx.ui.setStatus("remote-build", undefined);
				}
			},
			(error: unknown) => ctx.ui.notify(`remote-build: ${errorMessage(error)}`, "warning"),
		);
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
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

async function projectConfig(cwd: string): Promise<{ root: string; config: RemoteBuildConfig } | undefined> {
	let root: string;
	try {
		root = await worktreeRoot(cwd);
	} catch {
		return undefined;
	}
	const config = await loadConfig(root);
	return config === undefined ? undefined : { root, config };
}

/** Main checkout of the repository containing `cwd` (parent of the common git dir). */
async function mainCheckout(cwd: string): Promise<string> {
	const common = (await run(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
	return common.replace(/\/\.git$/, "");
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
