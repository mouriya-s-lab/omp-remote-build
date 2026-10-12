import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { truncateTail } from "@oh-my-pi/pi-coding-agent";
import { CONFIG_PATH } from "./config.ts";
import { buildImage, imageExists } from "./komodo.ts";
import { readRemoteFile, writeRemoteFile } from "./remote-files.ts";
import type { HostConfig, ImageSource, ProjectId, ProjectImageSource, ProjectRecord } from "./types.ts";

/** Plugin-provided base of every generated project image: Arch Linux with base-devel, git, sudo and paru. */
export const BASE_IMAGE = "rb-base-archlinux:latest";

/** Worktree Dockerfiles probed when the config names neither `image` nor `dockerfile`, in order. */
export const DOCKERFILE_CANDIDATES = [".devcontainer/Dockerfile", "Dockerfile"] as const;

/** Upper bound of one image build. */
export const BUILD_TIMEOUT_MS = 60 * 60_000;

/** Tag of the project image shared by every worktree of the project. */
export function projectImage(id: ProjectId): string {
	return `rb-project-${id}:latest`;
}

/** Build-host directory holding the project record and the generated Dockerfile. Env ids end in `-<hash>`, so `projects` cannot collide with a replica. */
export function projectDir(host: HostConfig, id: ProjectId): string {
	return `${host.remoteRoot}/projects/${id}`;
}

/** Hex sha256 of `content`. */
export function sha256(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Last output lines of a build or command, for reports. */
export function outputTail(text: string): string {
	return truncateTail(text, { maxLines: 80, maxBytes: 8192 }).content;
}

/** The project record, or `undefined` before the first build. */
export async function readRecord(host: HostConfig, id: ProjectId): Promise<ProjectRecord | undefined> {
	const path = `${projectDir(host, id)}/project.json`;
	const text = await readRemoteFile(host, path);
	if (text === undefined) return undefined;
	const invalid = (field: string): never => {
		throw new Error(`invalid project record ${path}: ${field}`);
	};
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return invalid("not JSON");
	}
	const object = (value: unknown, field: string): Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : invalid(field);
	const str = (value: unknown, field: string): string => (typeof value === "string" ? value : invalid(field));
	const nullableStr = (value: unknown, field: string): string | null => (value === null ? null : str(value, field));
	const obj = object(raw, "record");
	if (obj.version !== 1) invalid("version");
	const src = object(obj.source, "source");
	let source: ProjectImageSource;
	switch (src.kind) {
		case "dockerfile":
			source = { kind: "dockerfile", path: str(src.path, "source.path"), sha256: str(src.sha256, "source.sha256") };
			break;
		case "generated":
			source = { kind: "generated", sha256: str(src.sha256, "source.sha256") };
			break;
		default:
			return invalid("source.kind");
	}
	const builtAt = str(obj.builtAt, "builtAt");
	if (Number.isNaN(Date.parse(builtAt))) invalid("builtAt");
	return {
		image: str(obj.image, "image"),
		source,
		bootstrap: nullableStr(obj.bootstrap, "bootstrap"),
		builtAt,
		preparerReport: nullableStr(obj.preparerReport, "preparerReport"),
	};
}

export async function writeRecord(host: HostConfig, id: ProjectId, record: ProjectRecord): Promise<void> {
	await writeRemoteFile(host, `${projectDir(host, id)}/project.json`, `${JSON.stringify({ version: 1, ...record }, null, 2)}\n`);
}

/** The worktree Dockerfile the image source points at, with its content hash; `undefined` when there is none. */
export async function resolveDockerfile(root: string, source: ImageSource): Promise<{ path: string; sha256: string } | undefined> {
	const hashed = async (path: string) => ({ path, sha256: sha256(await Bun.file(join(root, path)).bytes()) });
	switch (source.kind) {
		case "configured":
			return undefined;
		case "dockerfile":
			if (!(await isFile(join(root, source.path)))) throw new Error(`${CONFIG_PATH}: dockerfile ${source.path} not found in ${root}`);
			return hashed(source.path);
		case "detect":
			for (const candidate of DOCKERFILE_CANDIDATES) {
				if (await isFile(join(root, candidate))) return hashed(candidate);
			}
			return undefined;
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

/** Base image of the final build stage of `dockerfile`. */
export function finalStageBase(dockerfile: string): string | undefined {
	let base: string | undefined;
	for (const match of dockerfile.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)) base = match[1];
	return base;
}

/** Builds `BASE_IMAGE` on the build host unless it exists. */
export async function ensureBaseImage(
	host: HostConfig,
	signal: AbortSignal | undefined,
): Promise<{ readonly kind: "present" } | { readonly kind: "built"; readonly output: string }> {
	if (await imageExists(host, BASE_IMAGE)) return { kind: "present" };
	const contextPath = `${host.remoteRoot}/base/archlinux`;
	const dockerfile = await Bun.file(new URL("../images/archlinux.Dockerfile", import.meta.url)).text();
	await writeRemoteFile(host, `${contextPath}/Dockerfile`, dockerfile);
	const result = await buildImage(
		host,
		{ name: "rb-build-base-archlinux", image: BASE_IMAGE, contextPath, dockerfile: "Dockerfile" },
		{ timeoutMs: BUILD_TIMEOUT_MS, signal },
	);
	if (result.exitCode !== 0) throw new Error(`base image build failed (exit ${result.exitCode})\n${outputTail(result.output)}`);
	return { kind: "built", output: result.output };
}
