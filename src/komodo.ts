import type { ContainerSpec, HostConfig } from "./types.ts";

interface Endpoint {
	readonly host: string;
	readonly key: string;
	readonly secret: string;
}

/** Only the fields this plugin owns; Komodo owns the remaining defaults. */
interface ManagedConfig {
	readonly server_id: string;
	readonly swarm_id: string;
	readonly image: { readonly type: "Image"; readonly params: { readonly image: string } };
	readonly command: string;
	readonly volumes: string;
	readonly environment: string;
	readonly extra_args: readonly string[];
	readonly restart: "unless-stopped";
	readonly skip_secret_interp: true;
}

interface Deployment {
	readonly id: string;
	readonly name: string;
	readonly config: {
		readonly server: string;
		readonly swarm: string;
		readonly image: string | null;
		readonly command: string;
		readonly volumes: string;
		readonly environment: string;
		readonly extraArgs: readonly string[];
		readonly restart: string;
		readonly skipSecretInterp: boolean;
	};
}

type Request =
	| { readonly endpoint: "read"; readonly type: "ListServers"; readonly params: Record<string, never> }
	| { readonly endpoint: "read"; readonly type: "GetServer"; readonly params: { readonly server: string } }
	| { readonly endpoint: "read"; readonly type: "ListFullDeployments"; readonly params: { readonly query: { readonly names: readonly string[] } } }
	| { readonly endpoint: "read"; readonly type: "GetDeploymentContainer"; readonly params: { readonly deployment: string } }
	| { readonly endpoint: "read"; readonly type: "GetUpdate"; readonly params: { readonly id: string } }
	| { readonly endpoint: "write"; readonly type: "CreateDeployment"; readonly params: { readonly name: string; readonly config: ManagedConfig } }
	| { readonly endpoint: "write"; readonly type: "UpdateDeployment"; readonly params: { readonly id: string; readonly config: ManagedConfig } }
	| { readonly endpoint: "execute"; readonly type: "Deploy"; readonly params: { readonly deployment: string; readonly stop_signal: null; readonly stop_time: null } };

type Update =
	| { readonly id: string; readonly status: "Queued" | "InProgress" }
	| { readonly id: string; readonly status: "Complete"; readonly success: boolean };

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Invalid Komodo response: ${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`Invalid Komodo response: ${field} must be a string`);
	return value;
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new Error(`Invalid Komodo response: ${field} must be a boolean`);
	return value;
}

function array(value: unknown, field: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new Error(`Invalid Komodo response: ${field} must be an array`);
	return value;
}

function mongoId(value: unknown): string {
	return string(record(record(value, "resource")._id, "_id").$oid, "_id.$oid");
}

/** Core URL and API credentials of `host.komodo.profile`, read from the km CLI config so km and the API share one source. */
async function loadEndpoint(host: HostConfig): Promise<Endpoint> {
	const path = host.komodo.cliConfig;
	let parsed: unknown;
	try {
		parsed = Bun.TOML.parse(await Bun.file(path).text());
	} catch {
		// TOML diagnostics may contain the original line, including a credential.
		throw new Error(`Cannot read or parse km CLI config: ${path}`);
	}
	const profiles = array(record(parsed, "km CLI config").profile ?? [], "km CLI config [[profile]]").map((entry) => record(entry, "[[profile]]"));
	const fields = profiles.find((entry) => entry.name === host.komodo.profile
		|| (Array.isArray(entry.aliases) && entry.aliases.includes(host.komodo.profile)));
	if (fields === undefined) throw new Error(`km CLI config ${path} has no [[profile]] named "${host.komodo.profile}"`);
	const required = (name: "host" | "key" | "secret"): string => {
		const value = fields[name];
		if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) {
			throw new Error(`km CLI profile "${host.komodo.profile}" has an invalid ${name} field`);
		}
		return value;
	};
	const url = required("host");
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		throw new Error(`km CLI profile "${host.komodo.profile}" host must be an HTTP(S) URL`);
	}
	if ((parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
		throw new Error(`km CLI profile "${host.komodo.profile}" host must be an HTTP(S) URL without embedded credentials, query or fragment`);
	}
	return { host: url.replace(/\/+$/, ""), key: required("key"), secret: required("secret") };
}

async function request(endpoint: Endpoint, operation: Request): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(`${endpoint.host}/${operation.endpoint}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-api-key": endpoint.key, "x-api-secret": endpoint.secret },
			body: JSON.stringify({ type: operation.type, params: operation.params }),
			signal: AbortSignal.timeout(30_000),
		});
	} catch {
		throw new Error(`Komodo ${operation.type} could not reach Komodo Core ${endpoint.host} (network failure or 30s request timeout)`);
	}
	if (!response.ok) {
		// Error bodies and execution logs may echo environment values; never expose them.
		await response.body?.cancel();
		throw new Error(`Komodo ${operation.type} failed: HTTP ${response.status}${response.status === 401 || response.status === 403 ? " (authentication or authorization failed)" : ""}`);
	}
	try {
		return await response.json();
	} catch {
		throw new Error(`Komodo ${operation.type} returned invalid JSON`);
	}
}

function parseDeployment(value: unknown): Deployment {
	const resource = record(value, "Deployment");
	const config = record(resource.config, "Deployment.config");
	const image = record(config.image, "Deployment.config.image");
	let imageName: string | null;
	switch (image.type) {
		case "Image":
			imageName = string(record(image.params, "image.params").image, "image.params.image");
			break;
		case "Build":
			imageName = null;
			break;
		default:
			throw new Error("Invalid Komodo response: unknown Deployment image variant");
	}
	return {
		id: mongoId(resource),
		name: string(resource.name, "Deployment.name"),
		config: {
			server: string(config.server_id, "server_id"),
			swarm: string(config.swarm_id, "swarm_id"),
			image: imageName,
			command: string(config.command, "command"),
			volumes: string(config.volumes, "volumes"),
			environment: string(config.environment, "environment"),
			extraArgs: array(config.extra_args, "extra_args").map((arg) => string(arg, "extra_args entry")),
			restart: string(config.restart, "restart"),
			skipSecretInterp: boolean(config.skip_secret_interp, "skip_secret_interp"),
		},
	};
}

function parseUpdate(value: unknown): Update {
	const update = record(value, "Update");
	const id = mongoId(update);
	switch (update.status) {
		case "Queued":
		case "InProgress":
			return { id, status: update.status };
		case "Complete":
			return { id, status: "Complete", success: boolean(update.success, "Update.success") };
		default:
			throw new Error("Invalid Komodo response: unknown Update status");
	}
}

function shellWord(value: string): string {
	// Komodo v2.2 parses multiline key/value text, then concatenates it into a shell command.
	if (/[\r\n\0]/.test(value) || value.includes(" #")) {
		throw new Error("Komodo environment and volume values cannot contain CR, LF, NUL or the comment delimiter ' #' (Komodo key/value parser limitation)");
	}
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function managedConfig(spec: ContainerSpec, server: string): ManagedConfig {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(spec.name)) throw new Error("Invalid Komodo container name");
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]*$/.test(spec.image)) throw new Error("Invalid Komodo container image reference");
	if (!spec.hostPath.startsWith("/") || !spec.workdir.startsWith("/") || /[:=]/.test(spec.hostPath)) {
		throw new Error("Komodo hostPath and workdir must be absolute paths; hostPath cannot contain ':' or '='");
	}
	const volumes = [`${shellWord(spec.hostPath)}:${shellWord(spec.workdir)}`];
	for (const volume of spec.volumes) {
		const separator = volume.indexOf(":");
		if (separator <= 0 || separator === volume.length - 1 || volume.slice(0, separator).includes("=")) {
			throw new Error("Invalid Komodo volume: expected host-or-volume:container[:mode]");
		}
		volumes.push(`${shellWord(volume.slice(0, separator))}:${shellWord(volume.slice(separator + 1))}`);
	}
	const environment = Object.keys(spec.env).sort().map((name) => {
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error("Invalid Komodo environment variable name");
		return `${name}=${shellWord(spec.env[name]!)}`;
	}).join("\n");
	return {
		server_id: server,
		swarm_id: "",
		image: { type: "Image", params: { image: spec.image } },
		command: "sleep infinity",
		// Komodo v2.2's conversion/env deserializers append a trailing newline.
		volumes: `${volumes.join("\n")}\n`,
		environment: environment ? `${environment}\n` : "",
		extra_args: ["--workdir", shellWord(spec.workdir)],
		restart: "unless-stopped",
		skip_secret_interp: true,
	};
}

function matches(current: Deployment["config"], desired: ManagedConfig): boolean {
	return current.server === desired.server_id && current.swarm === desired.swarm_id
		&& current.image === desired.image.params.image && current.command === desired.command
		&& current.volumes === desired.volumes && current.environment === desired.environment
		&& current.restart === desired.restart && current.skipSecretInterp === desired.skip_secret_interp
		&& current.extraArgs.length === desired.extra_args.length
		&& current.extraArgs.every((arg, index) => arg === desired.extra_args[index]);
}

async function containerState(endpoint: Endpoint, deployment: string): Promise<string> {
	const response = record(await request(endpoint, { endpoint: "read", type: "GetDeploymentContainer", params: { deployment } }), "GetDeploymentContainer");
	return string(response.state, "GetDeploymentContainer.state");
}

async function waitForDeployment(endpoint: Endpoint, deployment: string): Promise<void> {
	let update = parseUpdate(await request(endpoint, {
		endpoint: "execute", type: "Deploy", params: { deployment, stop_signal: null, stop_time: null },
	}));
	const deadline = Date.now() + 10 * 60_000;
	while (update.status !== "Complete") {
		if (Date.now() >= deadline) throw new Error(`Komodo deployment ${deployment} timed out waiting for Update ${update.id}`);
		await Bun.sleep(1_000);
		update = parseUpdate(await request(endpoint, { endpoint: "read", type: "GetUpdate", params: { id: update.id } }));
	}
	if (!update.success) throw new Error(`Komodo deployment ${deployment} failed (Update ${update.id}); inspect the Update in Komodo Core`);
	const runningDeadline = Date.now() + 60_000;
	let state = await containerState(endpoint, deployment);
	while (state !== "running") {
		if (Date.now() >= runningDeadline) throw new Error(`Komodo deployment ${deployment} did not become running within 60s (last state: ${state})`);
		await Bun.sleep(1_000);
		state = await containerState(endpoint, deployment);
	}
}

/** Create/update the plugin-owned config, deploy, and wait for a successful running container. */
export async function ensureContainer(host: HostConfig, spec: ContainerSpec): Promise<void> {
	const endpoint = await loadEndpoint(host);
	const server = await request(endpoint, { endpoint: "read", type: "GetServer", params: { server: host.komodo.server } });
	const desired = managedConfig(spec, mongoId(server));
	const resources = array(await request(endpoint, {
		endpoint: "read", type: "ListFullDeployments", params: { query: { names: [spec.name] } },
	}), "ListFullDeployments").map(parseDeployment);
	const existing = resources.find((deployment) => deployment.name === spec.name);
	let deployment: Deployment;
	if (existing) {
		if (matches(existing.config, desired)) {
			// Core's periodically refreshed container state is the API's running-state contract.
			if (await containerState(endpoint, existing.id) === "running") return;
			deployment = existing;
		} else {
			deployment = parseDeployment(await request(endpoint, { endpoint: "write", type: "UpdateDeployment", params: { id: existing.id, config: desired } }));
		}
	} else {
		deployment = parseDeployment(await request(endpoint, { endpoint: "write", type: "CreateDeployment", params: { name: spec.name, config: desired } }));
	}
	await waitForDeployment(endpoint, deployment.id);
}

/** Cheap authenticated Core read; the km CLI config is read anew so credential rotation takes effect. */
export async function komodoReachable(host: HostConfig): Promise<void> {
	const endpoint = await loadEndpoint(host);
	array(await request(endpoint, { endpoint: "read", type: "ListServers", params: {} }), "ListServers");
}
