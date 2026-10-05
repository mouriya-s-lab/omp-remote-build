import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { loadHost } from "./host.ts";
import { deriveIgnoreRules } from "./ignores.ts";
import { ensureContainer, komodoReachable } from "./komodo.ts";
import { createSession, findSession, flush } from "./mutagen.ts";
import { run } from "./run.ts";
import type { EnvId, HostConfig, PreparedEnv, RemoteBuildConfig } from "./types.ts";

/** Git worktree root containing `cwd`, in canonical letter case (one identity per root on case-insensitive file systems). */
export async function worktreeRoot(cwd: string): Promise<string> {
	return realpathSync.native((await run(["git", "-C", cwd, "rev-parse", "--show-toplevel"])).trim());
}

/** `<slug>-<hash>`: readable, unique per absolute root, valid as Mutagen label value and docker name. */
export function envIdFor(root: string): EnvId {
	const slug = basename(root)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	const hash = createHash("sha256").update(root).digest("hex").slice(0, 10);
	return `${slug || "wt"}-${hash}` as EnvId;
}

/** Loads the host config; throws unless the build host answers SSH and its Komodo Core answers the API. */
export async function checkHost(): Promise<HostConfig> {
	const host = await loadHost();
	await run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host.ssh, "true"]);
	await komodoReachable(host);
	return host;
}

/**
 * Brings up the environment for worktree `root`: Mutagen replica, container-only
 * files, and the Komodo container. Idempotent; an existing session is reused.
 */
export async function prepareEnv(root: string, config: RemoteBuildConfig): Promise<PreparedEnv> {
	const host = await checkHost();
	const id = envIdFor(root);
	const remotePath = `${host.remoteRoot}/${id}`;
	const session =
		(await findSession(host, id)) ?? (await createSession(host, id, root, remotePath, await deriveIgnoreRules(root, config)));
	await flush(host, session);
	await uploadContainerFiles(host, root, remotePath, config);
	const container = `rb-${id}`;
	await ensureContainer(host, {
		name: container,
		image: config.image,
		hostPath: remotePath,
		workdir: config.workdir,
		volumes: config.volumes,
		env: config.env,
	});
	return { id, root, remotePath, mutagenSession: session, container, config, host };
}

async function uploadContainerFiles(host: HostConfig, root: string, remotePath: string, config: RemoteBuildConfig): Promise<void> {
	for (const [target, source] of Object.entries(config.containerFiles)) {
		const content = await readFile(join(root, source));
		const dest = `${remotePath}/${target}`;
		await run(["ssh", host.ssh, `mkdir -p ${shQuote(dirname(dest))} && cat > ${shQuote(dest)}`], {
			stdin: content,
		});
	}
}

function shQuote(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}
