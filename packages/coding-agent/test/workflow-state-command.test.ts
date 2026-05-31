import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

describe("gjc state workflow command", () => {
	it("writes readable canonical state and receipt for workflow skills", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-command-"));
		try {
			const result = Bun.spawnSync(
				[
					"bun",
					cliEntry,
					"state",
					"deep-interview",
					"write",
					"--session-id",
					"session-1",
					"--input",
					JSON.stringify({
						phase: "interviewing",
						active: true,
						hud: {
							version: 1,
							chips: [{ label: "gate", value: "approval-required", priority: 5, severity: "warning" }],
						},
						state: { blocked_reason: "execution approval missing" },
					}),
					"--json",
				],
				{ cwd, stderr: "pipe", stdout: "pipe", env: { ...process.env, GJC_RUNTIME_BINARY: "" } },
			);
			expect(result.exitCode, result.stderr.toString()).toBe(0);
			const stdout = result.stdout.toString();
			expect(stdout).toContain("\n  \"receipt\": {");
			const payload = JSON.parse(stdout) as { receipt: { skill: string; owner: string; status: string } };
			expect(payload.receipt).toMatchObject({ skill: "deep-interview", owner: "gjc-state-cli", status: "fresh" });

			const modeState = await Bun.file(
				path.join(cwd, ".gjc", "state", "sessions", "session-1", "deep-interview-state.json"),
			).json();
			expect(modeState).toMatchObject({
				skill: "deep-interview",
				current_phase: "interviewing",
				blocked_reason: "execution approval missing",
			});
			expect(modeState.receipt.command).toBe("gjc state deep-interview write");

			const activeState = await Bun.file(
				path.join(cwd, ".gjc", "state", "sessions", "session-1", "skill-active-state.json"),
			).json();
			expect(activeState.active_skills[0]).toMatchObject({
				skill: "deep-interview",
				phase: "interviewing",
				receipt: { owner: "gjc-state-cli" },
			});
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 15_000);
});
