/** Runs a binary with argv (no shell) and returns its exit code and output. */
export async function runResult(
	argv: readonly string[],
	options: { stdin?: Uint8Array } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([...argv], {
		stdin: options.stdin ?? "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

/** Runs a binary with argv (no shell); throws with stderr on non-zero exit. */
export async function run(argv: readonly string[], options: { stdin?: Uint8Array } = {}): Promise<string> {
	const { code, stdout, stderr } = await runResult(argv, options);
	if (code !== 0) {
		throw new Error(`${argv.slice(0, 3).join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`);
	}
	return stdout;
}
