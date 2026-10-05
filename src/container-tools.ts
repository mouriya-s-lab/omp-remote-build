import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail, z } from "@oh-my-pi/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { startRateLimitedStream, waitForExitOrDeadline } from "omp-unified-exec/src/long-wait.ts";
import { sanitizeOutputText } from "omp-unified-exec/src/output-safety.ts";
import { getPtyLoadError, isPtyAvailable } from "omp-unified-exec/src/pty.ts";
import { ExecSession } from "omp-unified-exec/src/session.ts";
import { SessionStore } from "omp-unified-exec/src/session-store.ts";
import { unescapeChars } from "omp-unified-exec/src/unescape.ts";
import type { PreparedEnv } from "./types.ts";

const EXIT_NOTE = "km always exits 0; this is only the local transport's exit code. Read command exit codes from the container shell output, e.g. echo $? immediately after the command.";
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const yieldSchema = z.number().int().min(250).max(30_000).optional().describe("Attachment window in milliseconds, not a command timeout; 250–30000.");
const sessionIdSchema = z.number().int().positive().describe("Session ID returned by container_exec, scoped to the current environment.");
const execSchema = z.object({
	input: z.string().optional().describe("Optional initial shell input. C-style escapes are decoded, including \\n, \\x03 and \\x1b; no newline is appended."),
	yield_time_ms: yieldSchema,
});
const writeSchema = z.object({
	session_id: sessionIdSchema,
	chars: z.string().optional().describe("Input with C-style escapes (\\n, \\r, \\t, \\xHH, \\uHHHH, \\u{H…}, \\e, \\0, \\\\). Unknown escapes are preserved. Omit or pass empty string to poll."),
	yield_time_ms: yieldSchema,
});
const killSchema = z.object({ session_id: sessionIdSchema });
const listSchema = z.object({});

type TransportState =
	| { readonly status: "running" }
	| { readonly status: "exited"; readonly km_exit_code: number | null; readonly signal: NodeJS.Signals | null };

interface SessionDetails {
	readonly session_id: number;
	readonly transport: TransportState;
	readonly output: string;
	readonly log_path: string;
	readonly cwd: string;
	readonly command: string;
	readonly output_bytes_total: number;
	readonly omitted_bytes: number;
	readonly truncated: boolean;
	readonly failure_message: string | null;
	readonly note: string;
}

function transportState(session: ExecSession): TransportState {
	return session.hasExited
		? { status: "exited", km_exit_code: session.exitCode, signal: session.signal }
		: { status: "running" };
}

function sessionResult(session: ExecSession, bytes: Uint8Array, omittedBytes = 0): AgentToolResult<SessionDetails> {
	const truncated = truncateTail(sanitizeOutputText(decoder.decode(bytes)), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	const details: SessionDetails = {
		session_id: session.id,
		transport: transportState(session),
		output: truncated.content,
		log_path: session.logPath,
		cwd: session.cwd,
		command: sanitizeOutputText(session.displayCommand),
		output_bytes_total: session.totalBytesSeen,
		omitted_bytes: omittedBytes,
		truncated: truncated.truncated === true,
		failure_message: session.failureMessage,
		note: EXIT_NOTE,
	};
	const lines = [
		`[${details.transport.status}] session_id: ${session.id}`,
		`log_path: ${session.logPath}`,
		`note: ${EXIT_NOTE}`,
	];
	if (details.transport.status === "exited") {
		lines.push(`km_exit_code: ${details.transport.km_exit_code}`, `signal: ${details.transport.signal ?? "none"}`);
	}
	if (session.failureMessage) lines.push(`failure: ${sanitizeOutputText(session.failureMessage)}`);
	lines.push("---", details.output || "(no output)");
	if (truncated.truncated) lines.push(`\n[Output truncated to the last ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES} bytes. Full output: ${session.logPath}]`);
	return { content: [{ type: "text", text: lines.join("\n") }], details };
}

async function collectSession(
	session: ExecSession,
	yieldMs: number,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<SessionDetails> | undefined,
): Promise<AgentToolResult<SessionDetails>> {
	session.touch();
	const stream = onUpdate ? startRateLimitedStream({
		outputNotify: session.outputNotify,
		minIntervalMs: 250,
		emit: () => onUpdate(sessionResult(session, session.snapshotStreamTail())),
	}) : undefined;
	try {
		const collected = await session.collect({ deadlineMs: Date.now() + yieldMs, externalAbort: signal });
		return sessionResult(session, collected.bytes, collected.omittedBytes);
	} finally {
		stream?.stop();
	}
}

function sendInput(session: ExecSession, input: string | undefined): void {
	if (input && !session.write(encoder.encode(unescapeChars(input)))) {
		throw new Error(`Container session ${session.id} stdin is closed; poll without chars to read its final output.`);
	}
}

async function terminateSession(session: ExecSession): Promise<void> {
	session.terminate();
	await waitForExitOrDeadline({ exited: session.exited, durationMs: 2_000 });
	if (!session.hasExited) {
		session.kill("SIGKILL");
		await waitForExitOrDeadline({ exited: session.exited, durationMs: 500 });
	}
	if (!session.hasExited) throw new Error(`Container session ${session.id} km client is still running after SIGTERM and SIGKILL; the session remains available for another kill attempt.`);
}

/** Register one agent-session-owned PTY store on top of omp-unified-exec's PTY sessions. */
export function registerContainerTools(pi: ExtensionAPI, resolveEnv: (cwd: string) => Promise<PreparedEnv>): void {
	const store = new SessionStore({ maxSessions: 64, lruProtectedCount: 8 });
	let lifecycle: "active" | "shutdown" = "active";
	const getSession = (id: number, env: PreparedEnv): ExecSession => {
		const session = store.get(id);
		if (!session || session.cwd !== env.root) throw new Error(`Unknown container session ${id} in environment ${env.root}.`);
		return session;
	};

	pi.on("session_shutdown", async () => {
		lifecycle = "shutdown";
		// Keep ownership until each local transport confirms exit. Killing km may leave the remote shell alive.
		await Promise.all(store.values().map(async (session) => {
			await terminateSession(session);
			store.remove(session.id);
		}));
	});

	pi.registerTool({
		name: "container_exec",
		label: "Container exec",
		description: "Open an interactive PTY in the current remote-build container through Komodo, optionally sending initial input. Returns a session ID and output; drive it with container_write_stdin. The container working directory is set by deployment, not this tool. Komodo reuses the terminal named shell per container: reuse an existing session instead of opening competing clients. " + EXIT_NOTE,
		parameters: execSchema,
		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = execSchema.parse(rawParams);
			const env = await resolveEnv(ctx.cwd);
			if (lifecycle === "shutdown") throw new Error("Remote-build session is shutting down; no new container PTYs can be opened.");
			if (signal?.aborted) throw new Error("Container exec was cancelled before opening the PTY.");
			if (!isPtyAvailable()) throw new Error(`Container PTY unavailable: ${getPtyLoadError() ?? "native PTY provider failed to load"}. omp-unified-exec's PTY provider must load in this omp runtime; restart omp after fixing it.`);
			const session = ExecSession.spawn(store.allocateId(), {
				command: [env.host.bin.km, "-c", env.host.komodo.cliConfig, "-p", env.host.komodo.profile, "exec", "--server", env.host.komodo.server, env.container, env.config.shell],
				cwd: env.root,
				env: process.env,
				tty: true,
				cols: 120,
				rows: 30,
			});
			if (session.failureMessage) throw new Error(`Could not open container PTY: ${session.failureMessage}`);
			store.insert(session);
			sendInput(session, params.input);
			return collectSession(session, params.yield_time_ms ?? 10_000, signal, onUpdate);
		},
	});

	pi.registerTool({
		name: "container_write_stdin",
		label: "Container stdin",
		description: "Send characters (C-style escapes decoded) to a container PTY and/or poll for output. Omit chars for a pure poll. The yield window defaults to 250 ms; cancellation stops waiting without killing the session. " + EXIT_NOTE,
		parameters: writeSchema,
		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = writeSchema.parse(rawParams);
			const env = await resolveEnv(ctx.cwd);
			const session = getSession(params.session_id, env);
			sendInput(session, params.chars);
			const result = await collectSession(session, params.yield_time_ms ?? 250, signal, onUpdate);
			if (session.hasExited && session.outputClosed.isClosed) store.remove(session.id);
			return result;
		},
	});

	pi.registerTool({
		name: "container_list_sessions",
		label: "Container sessions",
		description: "List container PTY sessions for the current remote-build environment. Ended sessions remain listed until their final output is polled or they are killed. " + EXIT_NOTE,
		parameters: listSchema,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			listSchema.parse(rawParams);
			const env = await resolveEnv(ctx.cwd);
			const sessions = store.values().filter((session) => session.cwd === env.root).map((session) => ({
				session_id: session.id,
				transport: transportState(session),
				command: sanitizeOutputText(session.displayCommand),
				cwd: session.cwd,
				log_path: session.logPath,
				started_at_ms: session.startedAt,
				failure_message: session.failureMessage,
			}));
			return {
				content: [{ type: "text", text: `${JSON.stringify(sessions, null, 2)}\n${EXIT_NOTE}` }],
				details: { sessions },
			};
		},
	});

	pi.registerTool({
		name: "container_kill_session",
		label: "Kill container session",
		description: "Terminate the local km PTY client with SIGTERM, escalating to SIGKILL after two seconds. This does not stop or delete the container; the reused remote shell may remain alive. Prefer sending exit\\n to end the shell itself. " + EXIT_NOTE,
		parameters: killSchema,
		async execute(_toolCallId, rawParams, _signal, onUpdate, ctx) {
			const params = killSchema.parse(rawParams);
			const env = await resolveEnv(ctx.cwd);
			const session = getSession(params.session_id, env);
			await terminateSession(session);
			const result = await collectSession(session, 500, undefined, onUpdate);
			store.remove(session.id);
			return result;
		},
	});
}
