import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { BASE_IMAGE } from "./project.ts";
import type { PreparedEnv } from "./types.ts";

/** Agent definition name of the preparer subagent; `ctx.agent.name` in its session. */
export const PREPARER_AGENT_NAME = "remote-env-preparer";

const PREPARER_PROMPT = `You prepare a reusable build/test environment image for one software project. The project's files are on the local disk; inspect them with read, grep and glob and never modify them. They are mirrored one-way into a remote Docker container and mounted at its working directory. Run commands in that container with container_exec and container_write_stdin.

Goal: a project-level image that holds every dependency needed to build, test and run the project, and none of its code; the code always comes from the mount. Every worktree of the project reuses the image.

Image rules
1. The final stage of your Dockerfile must start with \`FROM rb-base-archlinux:latest\`: Arch Linux with base-devel, git, sudo and paru. The user \`builder\` has passwordless sudo and exists only to build AUR packages; the container runs as root.
2. Start with \`RUN pacman -Syu --noconfirm\`. Official packages: \`pacman -S --needed --noconfirm <pkgs>\`.
3. AUR packages: \`sudo -u builder paru -S --needed --noconfirm <pkgs>\`. Whenever a prebuilt \`-bin\` variant exists, install the \`-bin\` variant. Compile from source only when neither an official package nor a \`-bin\` variant exists, and state the reason in your report. Check candidates with \`pacman -Ss\` and \`paru -Ss\` in the container.
4. Prefer official or \`-bin\` toolchain packages over installers that compile.
5. The build context is empty: no COPY or ADD of project files.
6. Install only outside the working directory: system packages, toolchains, global tools, caches. Anything a dependency manager puts inside the project directory (node_modules, .venv, vendor directories, build outputs) belongs in the bootstrap command, because the mount hides image content at that path.
7. The bootstrap command is a single idempotent shell line (chain with &&). It runs with \`<shell> -c\` in the working directory of a fresh container after every deployment. Use an empty string when nothing is needed.

Workflow
1. Read the project: README and contributing docs, manifests and lockfiles, toolchain pins (rust-toolchain, .nvmrc, .python-version, go.mod, .tool-versions), CI workflows, Makefile or justfile. Determine the build, test and run commands.
2. The container currently runs rb-base-archlinux:latest. Try installs and commands there with container_exec; nothing there persists.
3. Call remote_env_build_image with the complete Dockerfile and the bootstrap command. It builds the image, recreates the container from it, runs the bootstrap command and returns the output. On failure, fix and call it again.
4. After a successful call, open a new container_exec session (earlier sessions ended when the container was recreated). Run the project's build, then its tests or main run command, and read every exit code with \`echo $?\`. If something is missing, change the Dockerfile or bootstrap and call remote_env_build_image again.
5. You are done only when, in the container created by your last successful remote_env_build_image call, the build and the tests (or the main run command when there are no tests) exit 0. If a command cannot pass for a reason outside the environment (secrets, external services, tests failing in the code itself), stop and report the exact reason with its output.

Final answer
Another agent reads your final answer. Use exactly these lines:
result: success | partial | failed
toolchain: <languages and versions>
packages: official: <list>; aur -bin: <list>; compiled from source: <package: reason> | none
bootstrap: <command> | none
verified: one line per command run in the final container: \`<command>\` -> exit <code> (<one-line observation>)
how_to: build: <command>; test: <command>; run: <command> (n/a when not applicable)
caveats: <services, environment variables, slow steps, known failing tests> | none`;

/**
 * Runs the preparer subagent to completion in worktree `env.root` and returns its final
 * answer. It loads exactly this plugin, so it gets the container tools and
 * `remote_env_build_image` regardless of the user's installed plugins. Throws unless it
 * finished cleanly.
 */
export async function runPreparer(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	env: PreparedEnv,
	image: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const envNames = Object.keys(env.config.env);
	const task = [
		`Prepare the environment image for the project in worktree ${env.root}.`,
		`- Container: ${env.container} on the remote build host; working directory ${env.config.workdir}; shell ${env.config.shell}; it currently runs ${BASE_IMAGE}.`,
		`- Container environment variables from the project config: ${envNames.length > 0 ? envNames.join(", ") : "none"}.`,
		`- Extra volumes: ${env.config.volumes.length > 0 ? env.config.volumes.join(", ") : "none"}.`,
		`- remote_env_build_image produces ${image}.`,
	].join("\n");
	const result = await pi.pi.runSubprocess({
		cwd: env.root,
		agent: {
			name: PREPARER_AGENT_NAME,
			description: "Prepares a reusable project environment image for remote-build",
			systemPrompt: PREPARER_PROMPT,
			tools: ["read", "grep", "glob", "web_search"],
			source: "bundled",
		},
		task,
		assignment: task,
		description: "remote-env preparer",
		index: 0,
		id: `rb-prep-${env.id}-${Date.now().toString(36)}`,
		modelOverride: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		modelRegistry: ctx.modelRegistry,
		settings: pi.pi.Settings.instance,
		parentAgentId: ctx.agent.id,
		taskDepth: ctx.agent.depth,
		keepAlive: false,
		enableLsp: false,
		preloadedExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
		signal,
	});
	if (result.exitCode !== 0 || result.error || result.aborted) {
		throw new Error(`preparer failed: ${result.error ?? result.stderr}`);
	}
	// The subagent finishes through `yield`, whose default payload is `{ "report": "<final answer>" }`.
	let payload: unknown;
	try {
		payload = JSON.parse(result.output);
	} catch {
		return result.output;
	}
	return typeof payload === "object" && payload !== null && "report" in payload && typeof payload.report === "string"
		? payload.report
		: result.output;
}
