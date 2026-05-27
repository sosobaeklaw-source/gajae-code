import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	claimGjcTeamTask,
	listGjcTeams,
	parseTeamLaunchArgs,
	readGjcTeamSnapshot,
	resolveGjcWorkerCommand,
	shutdownGjcTeam,
	startGjcTeam,
	transitionGjcTeamTask,
} from "../../src/gjc-runtime/team-runtime";

let cleanupRoot: string | undefined;
function runGit(cwd: string, args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString() || `git ${args.join(" ")} failed`);
}

async function createFakeTmuxBin(
	root: string,
	options: { failDisplay?: boolean; failSplit?: boolean } = {},
): Promise<string> {
	const binDir = path.join(root, ".test-bin");
	await fs.mkdir(binDir, { recursive: true });
	const logPath = path.join(root, "tmux.log");
	const script = `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(logPath)}
case "$1" in
  display-message)
    ${
			options.failDisplay
				? "echo no current tmux >&2; exit 1"
				: `
    target=""
    for ((i=1; i<=$#; i++)); do
      if [ "\${!i}" = "-t" ]; then
        next=$((i + 1))
        target="\${!next}"
      fi
    done
    case "$target" in
      %2) echo "test-session:0 %2" ;;
      %9) echo "other-session:0 %9" ;;
      %1) echo "test-session:0 %1" ;;
      *) echo "test-session:0 %1" ;;
    esac
    `
}
    ;;
  split-window)
    ${options.failSplit ? "echo split failed >&2; exit 1" : ""}
    count_file=${JSON.stringify(path.join(root, "tmux-split-count"))}
    count=0
    if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
    count=$((count + 1))
    echo "$count" > "$count_file"
    echo "%$((count + 1))"
    ;;
  select-layout|kill-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
	await Bun.write(path.join(binDir, "tmux"), script);
	await fs.chmod(path.join(binDir, "tmux"), 0o755);
	return path.join(binDir, "tmux");
}

async function createGitRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-git-"));
	runGit(repo, ["init"]);
	runGit(repo, ["config", "user.email", "gjc@example.test"]);
	runGit(repo, ["config", "user.name", "GJC Test"]);
	await Bun.write(path.join(repo, "README.md"), "# test\n");
	runGit(repo, ["add", "README.md"]);
	runGit(repo, ["commit", "-m", "initial"]);
	return repo;
}

afterEach(async () => {
	if (cleanupRoot) {
		for (const session of [
			"gjc-worktree-team",
			"gjc-fail-team",
			"gjc-split-fail-team",
			"gjc-named-team",
			"gjc-cleanup-team",
			"gjc-dirty-cleanup-team",
		]) {
			Bun.spawnSync(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
		}
		await fs.rm(cleanupRoot, { recursive: true, force: true });
		cleanupRoot = undefined;
	}
});

describe("native gjc team runtime", () => {
	it("creates GJC-scoped team state, task mailboxes, and telemetry without delegating to legacy runtimes", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Implement the approved plan",
			teamName: "demo-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});

		expect(snapshot.team_name).toBe("demo-team");
		expect(snapshot.phase).toBe("running");
		expect(snapshot.state_dir).toContain(path.join(".gjc", "state", "team", "demo-team"));
		expect(snapshot.task_counts.pending).toBe(1);
		expect(snapshot.workers).toHaveLength(1);
		expect(snapshot.tmux_target).toBe("dry-run:0");
		expect(snapshot.workers[0]?.pane_id).toBe("%dry-run-worker-01");

		const telemetry = await Bun.file(path.join(snapshot.state_dir, "telemetry.jsonl")).text();
		expect(telemetry).toContain("Native gjc team runtime initialized");
	});

	it("persists the active worker command so tmux workers use the same gjc entrypoint", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Use local entrypoint",
			teamName: "entrypoint-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "", GJC_TEAM_WORKER_COMMAND: "bun ./packages/coding-agent/src/cli.ts" },
		});

		const config = await Bun.file(path.join(snapshot.state_dir, "config.json")).json();
		const manifest = await Bun.file(path.join(snapshot.state_dir, "manifest.v2.json")).json();
		const telemetry = await Bun.file(path.join(snapshot.state_dir, "telemetry.jsonl")).text();

		expect(config.worker_command).toBe("bun ./packages/coding-agent/src/cli.ts");
		expect(manifest.worker_command).toBe("bun ./packages/coding-agent/src/cli.ts");
		expect(telemetry).toContain("bun ./packages/coding-agent/src/cli.ts");
		expect(resolveGjcWorkerCommand(cleanupRoot, { GJC_TEAM_WORKER_COMMAND: "gjc-dev" })).toBe("gjc-dev");
	});

	it("parses team starts with automatic detached worktrees and legacy --worktree stripping", () => {
		const defaultStart = parseTeamLaunchArgs(["executor", "build", "feature"]);
		expect(defaultStart.worktreeMode).toEqual({ enabled: true, detached: true, name: null });
		expect(defaultStart.workerCount).toBe(1);
		expect(defaultStart.task).toBe("build feature");

		expect(() => parseTeamLaunchArgs(["2:executor", "build", "feature"])).toThrow(/unsupported_team_worker_count/);
		expect(() => parseTeamLaunchArgs(["--worktree", "3:debugger", "fix", "bug"])).toThrow(
			/unsupported_team_worker_count/,
		);

		const explicitDetached = parseTeamLaunchArgs(["--worktree", "1:debugger", "fix", "bug"]);
		expect(explicitDetached.worktreeMode).toEqual({ enabled: true, detached: true, name: null });
		expect(explicitDetached.workerCount).toBe(1);
		expect(explicitDetached.agentType).toBe("debugger");
		expect(explicitDetached.task).toBe("fix bug");

		const named = parseTeamLaunchArgs(["--worktree=feature/demo", "1:executor", "ship", "it"]);
		expect(named.worktreeMode).toEqual({ enabled: true, detached: false, name: "feature/demo" });
		expect(named.task).toBe("ship it");

		const separatedLong = parseTeamLaunchArgs(["--worktree", "feature/demo", "1:executor", "ship", "it"]);
		expect(separatedLong.worktreeMode).toEqual({ enabled: true, detached: false, name: "feature/demo" });
		expect(separatedLong.task).toBe("ship it");

		const separatedShort = parseTeamLaunchArgs(["-w", "feature/demo", "1:executor", "ship", "it"]);
		expect(separatedShort.worktreeMode).toEqual({ enabled: true, detached: false, name: "feature/demo" });
		expect(separatedShort.task).toBe("ship it");
	});

	it("creates worker worktrees by default for the tmux launch path", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Use worker worktrees",
			teamName: "worktree-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});

		const config = await Bun.file(path.join(snapshot.state_dir, "config.json")).json();
		const manifest = await Bun.file(path.join(snapshot.state_dir, "manifest.v2.json")).json();

		expect(config.workspace_mode).toBe("worktree");
		expect(config.tmux_target).toBe("test-session:0");
		expect(config.tmux_session_name).toBe("test-session");
		expect(config.tmux_session).toBe("test-session");
		expect(config.leader.pane_id).toBe("%1");
		expect(manifest.workspace_mode).toBe("worktree");
		expect(manifest.tmux_target).toBe("test-session:0");
		expect(snapshot.tmux_target).toBe("test-session:0");
		expect(snapshot.workers).toHaveLength(1);
		for (const worker of snapshot.workers) {
			expect(worker.pane_id?.startsWith("%")).toBe(true);
			expect(worker.worktree_detached).toBe(true);
			expect(worker.worktree_base_ref).toBeTruthy();
			expect(worker.worktree_path).toContain(path.join(".gjc", "state", "team", "worktree-team", "worktrees"));
			const gitFile = await Bun.file(path.join(worker.worktree_path ?? "", ".git")).text();
			expect(gitFile).toContain("gitdir:");
		}
		const tmuxLog = await Bun.file(path.join(cleanupRoot, "tmux.log")).text();
		expect(tmuxLog).toContain("display-message -p #S:#I #{pane_id}");
		expect(tmuxLog).toContain("split-window -h -t %1 -d -P -F #{pane_id}");
		expect(tmuxLog).toContain("select-layout -t test-session:0 main-vertical");
		expect(tmuxLog).not.toContain("new-session");
		expect(tmuxLog).not.toContain("kill-session");
	});

	it("rejects unsupported runtime worker counts before tmux or state mutation", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);

		await expect(
			startGjcTeam({
				workerCount: 2,
				agentType: "executor",
				task: "Reject multi worker",
				teamName: "reject-team",
				cwd: cleanupRoot,
				env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
			}),
		).rejects.toThrow(/unsupported_team_worker_count/);

		expect(await Bun.file(path.join(cleanupRoot, "tmux.log")).exists()).toBe(false);
		expect(
			await Bun.file(path.join(cleanupRoot, ".gjc", "state", "team", "reject-team", "config.json")).exists(),
		).toBe(false);
	});

	it("fails outside current tmux before creating team state or worktrees", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot, { failDisplay: true });

		await expect(
			startGjcTeam({
				workerCount: 1,
				agentType: "executor",
				task: "Fail loudly",
				teamName: "fail-team",
				cwd: cleanupRoot,
				env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
			}),
		).rejects.toThrow(/no current tmux|team_requires_current_tmux_context/);

		expect(await Bun.file(path.join(cleanupRoot, ".gjc", "state", "team", "fail-team", "phase.json")).exists()).toBe(
			false,
		);
		expect(
			await Bun.file(
				path.join(cleanupRoot, ".gjc", "state", "team", "fail-team", "worktrees", "worker-01", ".git"),
			).exists(),
		).toBe(false);
	});

	it("cleans partial worker worktrees without killing the leader session when pane startup fails", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot, { failSplit: true });

		await expect(
			startGjcTeam({
				workerCount: 1,
				agentType: "executor",
				task: "Fail split",
				teamName: "split-fail-team",
				cwd: cleanupRoot,
				env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
			}),
		).rejects.toThrow(/split failed|tmux_split_failed/);

		const tmuxLog = await Bun.file(path.join(cleanupRoot, "tmux.log")).text();
		expect(tmuxLog).not.toContain("new-session");
		expect(tmuxLog).toContain("split-window");
		expect(tmuxLog).not.toContain("kill-session");
		await expect(
			Bun.file(
				path.join(cleanupRoot, ".gjc", "state", "team", "split-fail-team", "worktrees", "worker-01", ".git"),
			).text(),
		).rejects.toThrow();
	});

	it("creates named worker branches for legacy --worktree=<name> mode", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Named worktree",
			teamName: "named-team",
			worktreeMode: { enabled: true, detached: false, name: "feature/demo" },
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});

		expect(snapshot.workers[0]?.worktree_branch).toBe("feature/demo/named-team/worker-01");
		expect(snapshot.workers[0]?.worktree_detached).toBe(false);
		expect(
			Bun.spawnSync(["git", "branch", "--show-current"], { cwd: snapshot.workers[0]?.worktree_path, stdout: "pipe" })
				.stdout.toString()
				.trim(),
		).toBe("feature/demo/named-team/worker-01");
	});

	it("removes clean created worker worktrees on normal shutdown", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Clean shutdown",
			teamName: "cleanup-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const worktreePath = snapshot.workers[0]?.worktree_path ?? "";
		expect(await Bun.file(path.join(worktreePath, ".git")).exists()).toBe(true);

		const stopped = await shutdownGjcTeam("cleanup-team", cleanupRoot, { PATH: process.env.PATH ?? "" });

		expect(stopped.phase).toBe("complete");
		expect(await Bun.file(path.join(worktreePath, ".git")).exists()).toBe(false);
		const tmuxLog = await Bun.file(path.join(cleanupRoot, "tmux.log")).text();
		expect(tmuxLog).toContain("display-message -p -t %2 #S:#I #{pane_id}");
		expect(tmuxLog).toContain("kill-pane -t %2");
		expect(tmuxLog).not.toContain("kill-session");
	});

	it("does not kill stale or leader pane ids during shutdown", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Stale pane shutdown",
			teamName: "stale-pane-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const configPath = path.join(snapshot.state_dir, "config.json");
		const config = await Bun.file(configPath).json();
		await Bun.write(
			configPath,
			`${JSON.stringify({ ...config, workers: [{ ...config.workers[0], pane_id: "%9" }] }, null, 2)}\n`,
		);

		await shutdownGjcTeam("stale-pane-team", cleanupRoot, {
			PATH: process.env.PATH ?? "",
			GJC_TEAM_TMUX_COMMAND: fakeTmux,
		});

		const tmuxLog = await Bun.file(path.join(cleanupRoot, "tmux.log")).text();
		expect(tmuxLog).toContain("display-message -p -t %9 #S:#I #{pane_id}");
		expect(tmuxLog).not.toContain("kill-pane -t %9");
	});

	it("preserves dirty worker worktrees on normal shutdown", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Preserve dirty shutdown",
			teamName: "dirty-cleanup-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const worktreePath = snapshot.workers[0]?.worktree_path ?? "";
		await Bun.write(path.join(worktreePath, "worker-change.txt"), "keep me\n");

		const stopped = await shutdownGjcTeam("dirty-cleanup-team", cleanupRoot, { PATH: process.env.PATH ?? "" });

		expect(stopped.phase).toBe("complete");
		expect(await Bun.file(path.join(worktreePath, "worker-change.txt")).text()).toBe("keep me\n");
	});

	it("supports task claim, transition, list, status, and shutdown lifecycle operations", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Ship lifecycle",
			teamName: "life-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});

		const claim = await claimGjcTeamTask("life-team", "worker-01", cleanupRoot, { PATH: "" });
		expect(claim.ok).toBe(true);
		expect(claim.task?.status).toBe("in_progress");
		const task = await transitionGjcTeamTask("life-team", "task-001", "complete", cleanupRoot, { PATH: "" });
		expect(task.status).toBe("complete");

		const status = await readGjcTeamSnapshot("life-team", cleanupRoot, { PATH: "" });
		expect(status.task_counts.complete).toBe(1);
		expect(await listGjcTeams(cleanupRoot, { PATH: "" })).toHaveLength(1);

		const stopped = await shutdownGjcTeam("life-team", cleanupRoot, { PATH: "" });
		expect(stopped.phase).toBe("complete");
		expect(stopped.workers[0]?.status).toBe("stopped");
	});
});
