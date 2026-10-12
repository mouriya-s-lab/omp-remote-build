import { z } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CONFIG_PATH } from "./config.ts";
import { envContainerSpec, mainCheckout, projectIdFor } from "./environment.ts";
import { buildImage, ensureContainer, imageExists, runOnce } from "./komodo.ts";
import { flush } from "./mutagen.ts";
import { PREPARER_AGENT_NAME, runPreparer } from "./preparer.ts";
import {
	BASE_IMAGE,
	BUILD_TIMEOUT_MS,
	ensureBaseImage,
	finalStageBase,
	outputTail,
	projectDir,
	projectImage,
	readRecord,
	resolveDockerfile,
	sha256,
	writeRecord,
} from "./project.ts";
import { writeRemoteFile } from "./remote-files.ts";
import type { ImageSource, OnceResult, PreparedEnv, ProjectRecord } from "./types.ts";

const BOOTSTRAP_TIMEOUT_MS = 30 * 60_000;

const initSchema = z.object({
	rebuild: z
		.boolean()
		.optional()
		.describe("Rebuild the project image (Dockerfile: rebuild it; no Dockerfile: run the preparer subagent again) instead of reusing it."),
});

const buildSchema = z.object({
	dockerfile: z.string().describe("Complete Dockerfile text; final stage FROM rb-base-archlinux:latest; empty build context."),
	bootstrap: z
		.string()
		.describe("One-line idempotent shell command run in the working directory after each container deployment; empty string for none."),
});

/** How `remote_env_init` obtains the project image. */
type ImagePlan =
	| { readonly kind: "configured"; readonly image: string }
	| { readonly kind: "reuse"; readonly record: ProjectRecord }
	| { readonly kind: "build-dockerfile"; readonly path: string; readonly sha256: string }
	| { readonly kind: "rebuild-generated"; readonly record: ProjectRecord }
	| { readonly kind: "prepare" };

/** What the build host and worktree hold for the project image. */
interface ImageInventory {
	readonly record: ProjectRecord | undefined;
	readonly exists: boolean;
	readonly dockerfile: { readonly path: string; readonly sha256: string } | undefined;
}

function planImage(source: ImageSource, rebuild: boolean, inventory: ImageInventory): ImagePlan {
	if (source.kind === "configured") return { kind: "configured", image: source.image };
	const { record, exists, dockerfile } = inventory;
	if (!rebuild && record !== undefined && exists) return { kind: "reuse", record };
	if (dockerfile !== undefined) return { kind: "build-dockerfile", ...dockerfile };
	if (!rebuild && record?.source.kind === "generated") return { kind: "rebuild-generated", record };
	return { kind: "prepare" };
}

function assertNever(value: never): never {
	throw new Error(`unhandled variant ${JSON.stringify(value)}`);
}

/** Report fields in output order. */
const REPORT_KEYS = [
	"worktree",
	"project",
	"container",
	"image",
	"image_source",
	"base_image",
	"note",
	"build_output_tail",
	"bootstrap",
	"bootstrap_exit_code",
	"bootstrap_output_tail",
	"preparer_report",
	"usage",
] as const;

type ReportField =
	| { readonly kind: "line"; readonly value: string }
	| { readonly kind: "tail"; readonly text: string }
	| { readonly kind: "verbatim"; readonly text: string };

type Report = Partial<Record<(typeof REPORT_KEYS)[number], ReportField>>;

/** `key:` followed by the output tail in a fence longer than any backtick run inside it. */
function tailBlock(key: string, text: string): string {
	const tail = outputTail(text);
	const longest = Math.max(0, ...Array.from(tail.matchAll(/`+/g), match => match[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${key}:\n${fence}\n${tail}\n${fence}`;
}

function renderReport(status: "ready" | "failed", report: Report, error?: string): string {
	const lines = [`status: ${status}`];
	for (const key of REPORT_KEYS) {
		const field = report[key];
		if (field === undefined) continue;
		switch (field.kind) {
			case "line":
				lines.push(`${key}: ${field.value}`);
				break;
			case "tail":
				lines.push(tailBlock(key, field.text));
				break;
			case "verbatim":
				lines.push(`${key}:\n${field.text}`);
				break;
			default:
				assertNever(field);
		}
	}
	if (error !== undefined) lines.push(`error: ${error}`);
	return lines.join("\n");
}

/** Recreates the worktree container from `image`, then runs `bootstrap` once in a fresh container with the same mounts. */
async function deployAndBootstrap(
	env: PreparedEnv,
	image: string,
	bootstrap: string | null,
	signal: AbortSignal | undefined,
): Promise<OnceResult | null> {
	const spec = envContainerSpec(env, image);
	await ensureContainer(env.host, spec, "redeploy");
	if (bootstrap === null) return null;
	return runOnce(
		env.host,
		{ ...spec, name: `rb-boot-${env.id}` },
		{ entrypoint: null, argv: [env.config.shell, "-c", bootstrap] },
		{ timeoutMs: BOOTSTRAP_TIMEOUT_MS, signal },
	);
}

/** Resolves the project image, recreates the worktree container from it and runs bootstrap; returns the report, or throws it on failure. */
async function initEnvironment(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	env: PreparedEnv,
	rebuild: boolean,
	signal: AbortSignal | undefined,
): Promise<string> {
	const { host, config } = env;
	const report: Report = { worktree: { kind: "line", value: env.root } };
	const phase = (name: string) => ctx.ui.setStatus("remote-build", `remote-build: init ${name}`);
	try {
		phase("sync");
		await flush(host, env.mutagenSession);
		const mainRoot = await mainCheckout(env.root);
		const pid = projectIdFor(mainRoot);
		report.project = { kind: "line", value: `${pid} (main checkout ${mainRoot})` };
		report.container = {
			kind: "line",
			value: `${env.container} on server ${host.komodo.server}; workdir ${config.workdir}; shell ${config.shell}`,
		};

		const source = config.imageSource;
		phase("inspect");
		const inventory: ImageInventory =
			source.kind === "configured"
				? { record: undefined, exists: false, dockerfile: undefined }
				: await Promise.all([
						readRecord(host, pid),
						imageExists(host, projectImage(pid)),
						resolveDockerfile(env.root, source),
					]).then(([record, exists, dockerfile]) => ({ record, exists, dockerfile }));
		const plan = planImage(source, rebuild, inventory);
		const image = plan.kind === "configured" ? plan.image : projectImage(pid);
		report.image = { kind: "line", value: image };

		let record: ProjectRecord | undefined;
		switch (plan.kind) {
			case "configured":
				report.image_source = { kind: "line", value: "configured image" };
				record = undefined;
				break;
			case "reuse": {
				record = plan.record;
				const from = record.source.kind === "dockerfile" ? `worktree Dockerfile ${record.source.path}` : "generated Dockerfile";
				report.image_source = { kind: "line", value: `reused (built ${record.builtAt} from ${from})` };
				const current = inventory.dockerfile;
				if (
					current !== undefined &&
					(record.source.kind !== "dockerfile" || record.source.path !== current.path || record.source.sha256 !== current.sha256)
				) {
					report.note = {
						kind: "line",
						value: `worktree Dockerfile ${current.path} differs from the image source; call remote_env_init with rebuild=true to rebuild`,
					};
				}
				break;
			}
			case "build-dockerfile": {
				report.image_source = { kind: "line", value: `built from worktree Dockerfile ${plan.path}` };
				phase("build");
				const build = await buildImage(
					host,
					{ name: `rb-build-project-${pid}`, image, contextPath: env.remotePath, dockerfile: plan.path },
					{ timeoutMs: BUILD_TIMEOUT_MS, signal },
				);
				report.build_output_tail = { kind: "tail", text: build.output };
				if (build.exitCode !== 0) throw new Error(`image build failed (exit ${build.exitCode})`);
				record = {
					image,
					source: { kind: "dockerfile", path: plan.path, sha256: plan.sha256 },
					bootstrap: null,
					builtAt: new Date().toISOString(),
					preparerReport: null,
				};
				await writeRecord(host, pid, record);
				break;
			}
			case "rebuild-generated": {
				report.image_source = { kind: "line", value: "rebuilt from stored generated Dockerfile" };
				phase("base image");
				const base = await ensureBaseImage(host, signal);
				report.base_image = { kind: "line", value: `${BASE_IMAGE} (${base.kind === "present" ? "present" : "built now"})` };
				phase("build");
				const build = await buildImage(
					host,
					{ name: `rb-build-project-${pid}`, image, contextPath: projectDir(host, pid), dockerfile: "Dockerfile" },
					{ timeoutMs: BUILD_TIMEOUT_MS, signal },
				);
				report.build_output_tail = { kind: "tail", text: build.output };
				if (build.exitCode !== 0) throw new Error(`image build failed (exit ${build.exitCode})`);
				record = { ...plan.record, builtAt: new Date().toISOString() };
				await writeRecord(host, pid, record);
				break;
			}
			case "prepare": {
				report.image_source = { kind: "line", value: "prepared by subagent" };
				phase("base image");
				const base = await ensureBaseImage(host, signal);
				report.base_image = { kind: "line", value: `${BASE_IMAGE} (${base.kind === "present" ? "present" : "built now"})` };
				phase("preparer");
				await ensureContainer(host, envContainerSpec(env, BASE_IMAGE), "redeploy");
				const started = Date.now();
				const answer = await runPreparer(pi, ctx, env, image, signal);
				report.preparer_report = { kind: "verbatim", text: answer };
				const built = await readRecord(host, pid);
				if (built?.source.kind !== "generated" || Date.parse(built.builtAt) < started || !(await imageExists(host, image))) {
					throw new Error("preparer finished without a successful remote_env_build_image");
				}
				record = { ...built, preparerReport: answer };
				await writeRecord(host, pid, record);
				break;
			}
			default:
				assertNever(plan);
		}
		if (record?.preparerReport != null) report.preparer_report = { kind: "verbatim", text: record.preparerReport };

		const bootstrap = config.bootstrap ?? record?.bootstrap ?? null;
		report.bootstrap = { kind: "line", value: bootstrap ?? "none" };
		phase(bootstrap === null ? "deploy" : "deploy and bootstrap");
		const boot = await deployAndBootstrap(env, image, bootstrap, signal);
		if (boot !== null) {
			report.bootstrap_exit_code = { kind: "line", value: String(boot.exitCode) };
			report.bootstrap_output_tail = { kind: "tail", text: boot.output };
			if (boot.exitCode !== 0) throw new Error(`bootstrap exited ${boot.exitCode}`);
		}
		report.usage = {
			kind: "line",
			value: `run project commands with container_exec in ${env.container}; local edits sync one-way into ${config.workdir} after each tool call; files created in the container are not copied back; call remote_env_init with rebuild=true after dependency changes (it recreates the container and ends open container sessions)`,
		};
		return renderReport("ready", report);
	} catch (error) {
		throw new Error(renderReport("failed", report, error instanceof Error ? error.message : String(error)));
	} finally {
		ctx.ui.setStatus("remote-build", undefined);
	}
}

/** Registers `remote_env_init` (agents) and `remote_env_build_image` (the preparer subagent only). */
export function registerInitTools(pi: ExtensionAPI, ensureEnv: (cwd: string) => Promise<PreparedEnv>): void {
	pi.registerTool({
		name: "remote_env_init",
		label: "Remote env init",
		description:
			"Prepare this worktree's remote build container and return a report for the agent: resolve the project image (configured image, the worktree's Dockerfile, or an Arch Linux image prepared by a subagent; built once per project and reused by every worktree), recreate the container from it, and run the project's bootstrap command. Call it before the first container_exec in a worktree whose container is not running, and with rebuild=true after dependency changes. Recreating the container ends open container sessions.",
		parameters: initSchema,
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
			const params = initSchema.parse(rawParams);
			if (ctx.agent.name === PREPARER_AGENT_NAME) {
				throw new Error("remote_env_init is not available to the preparer; use remote_env_build_image");
			}
			const env = await ensureEnv(ctx.cwd);
			const report = await initEnvironment(pi, ctx, env, params.rebuild ?? false, signal);
			return { content: [{ type: "text", text: report }], details: { report } };
		},
	});

	pi.registerTool({
		name: "remote_env_build_image",
		label: "Remote env build image",
		description:
			"Preparer-only: build the project image from a Dockerfile, recreate this worktree's container from it, and run the bootstrap command. Returns the build and bootstrap output.",
		parameters: buildSchema,
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
			const params = buildSchema.parse(rawParams);
			if (ctx.agent.name !== PREPARER_AGENT_NAME) {
				throw new Error("remote_env_build_image is only available to the remote-env-preparer agent; call remote_env_init");
			}
			const env = await ensureEnv(ctx.cwd);
			if (env.config.imageSource.kind === "configured") {
				throw new Error(`${CONFIG_PATH} names an image; remote_env_build_image only builds generated project images`);
			}
			if (finalStageBase(params.dockerfile) !== BASE_IMAGE) throw new Error(`final stage must be FROM ${BASE_IMAGE}`);
			if (/[\r\n\0]/.test(params.bootstrap)) throw new Error("bootstrap must be a single line");
			const pid = projectIdFor(await mainCheckout(env.root));
			const image = projectImage(pid);
			const dir = projectDir(env.host, pid);
			await writeRemoteFile(env.host, `${dir}/Dockerfile`, params.dockerfile);
			const build = await buildImage(
				env.host,
				{ name: `rb-build-project-${pid}`, image, contextPath: dir, dockerfile: "Dockerfile" },
				{ timeoutMs: BUILD_TIMEOUT_MS, signal },
			);
			const lines = [
				`image: ${image} ${build.exitCode === 0 ? "built" : `build failed (exit ${build.exitCode})`}`,
				tailBlock("build_output_tail", build.output),
			];
			if (build.exitCode !== 0) throw new Error(lines.join("\n"));
			const bootstrap = params.bootstrap.trim() || null;
			await writeRecord(env.host, pid, {
				image,
				source: { kind: "generated", sha256: sha256(params.dockerfile) },
				bootstrap,
				builtAt: new Date().toISOString(),
				preparerReport: null,
			});
			const boot = await deployAndBootstrap(env, image, bootstrap, signal);
			lines.push(`container: ${env.container} recreated from ${image}; earlier container sessions have ended`);
			if (boot === null) {
				lines.push("bootstrap: none");
			} else {
				lines.push(`bootstrap: ${bootstrap} exit ${boot.exitCode}`, tailBlock("bootstrap_output_tail", boot.output));
				if (boot.exitCode !== 0) throw new Error(lines.join("\n"));
			}
			const text = lines.join("\n");
			return { content: [{ type: "text", text }], details: { report: text } };
		},
	});
}
