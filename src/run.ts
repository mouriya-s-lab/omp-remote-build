/** Runs a binary with argv (no shell); throws with stderr on non-zero exit. */
export async function run(argv: readonly string[], options: { stdin?: Uint8Array } = {}): Promise<string> {
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
	if (code !== 0) {
		throw new Error(`${argv.slice(0, 3).join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`);
	}
	return stdout;
}
