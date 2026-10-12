import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageSource, RemoteBuildConfig } from "./types.ts";

/** Path of the opt-in config, relative to a worktree root. */
export const CONFIG_PATH = ".omp/remote-build.json";

/**
 * Reads `.omp/remote-build.json` at `root`.
 * Returns `undefined` when the file does not exist (project not opted in);
 * throws when it exists but is invalid.
 */
export async function loadConfig(root: string): Promise<RemoteBuildConfig | undefined> {
	let text: string;
	try {
		text = await readFile(join(root, CONFIG_PATH), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	return parseConfig(JSON.parse(text) as unknown);
}

type ConfigField = "image" | "dockerfile" | "workdir" | "shell" | "ignore" | "include" | "containerFiles" | "volumes" | "env" | "bootstrap";

const KNOWN_FIELDS: Record<ConfigField, true> = {
	image: true,
	dockerfile: true,
	workdir: true,
	shell: true,
	ignore: true,
	include: true,
	containerFiles: true,
	volumes: true,
	env: true,
	bootstrap: true,
};

function parseConfig(raw: unknown): RemoteBuildConfig {
	const obj = record(raw, "config");
	for (const key of Object.keys(obj)) {
		if (!(key in KNOWN_FIELDS)) throw new Error(`${CONFIG_PATH}: unknown field "${key}"`);
	}
	return {
		imageSource: imageSource(obj.image, obj.dockerfile),
		bootstrap: bootstrap(obj.bootstrap),
		workdir: absolutePath(obj.workdir ?? "/workspace", "workdir"),
		shell: nonEmptyString(obj.shell ?? "bash", "shell"),
		ignore: stringArray(obj.ignore ?? [], "ignore"),
		include: stringArray(obj.include ?? [], "include").map(p => relativePath(p, "include")),
		containerFiles: containerFiles(obj.containerFiles ?? {}),
		volumes: stringArray(obj.volumes ?? [], "volumes"),
		env: stringRecord(obj.env ?? {}, "env"),
	};
}

function imageSource(image: unknown, dockerfile: unknown): ImageSource {
	if (image !== undefined && dockerfile !== undefined) {
		throw new Error(`${CONFIG_PATH}: set at most one of "image" and "dockerfile"`);
	}
	if (image !== undefined) return { kind: "configured", image: nonEmptyString(image, "image") };
	if (dockerfile !== undefined) return { kind: "dockerfile", path: relativePath(nonEmptyString(dockerfile, "dockerfile"), "dockerfile") };
	return { kind: "detect" };
}

function bootstrap(value: unknown): string | null {
	if (value === undefined) return null;
	const command = nonEmptyString(value, "bootstrap");
	if (/[\r\n\0]/.test(command)) throw new Error(`${CONFIG_PATH}: bootstrap must be a single line`);
	return command;
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${CONFIG_PATH}: ${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${CONFIG_PATH}: ${field} must be a non-empty string`);
	}
	return value;
}

function absolutePath(value: unknown, field: string): string {
	const s = nonEmptyString(value, field);
	if (!s.startsWith("/")) throw new Error(`${CONFIG_PATH}: ${field} must be an absolute path`);
	return s;
}

function relativePath(value: string, field: string): string {
	if (value.startsWith("/") || value.split("/").includes("..")) {
		throw new Error(`${CONFIG_PATH}: ${field} entries must be repo-relative paths without "..": ${value}`);
	}
	return value.replace(/\/+$/, "");
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${CONFIG_PATH}: ${field} must be an array of strings`);
	return value.map((item, i) => nonEmptyString(item, `${field}[${i}]`));
}

function stringRecord(value: unknown, field: string): Record<string, string> {
	const obj = record(value, field);
	return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, nonEmptyString(v, `${field}.${k}`)]));
}

function containerFiles(value: unknown): Record<string, string> {
	const obj = stringRecord(value, "containerFiles");
	return Object.fromEntries(
		Object.entries(obj).map(([target, source]) => [
			relativePath(target, "containerFiles target"),
			relativePath(source, "containerFiles source"),
		]),
	);
}
