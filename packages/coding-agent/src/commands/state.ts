import { Command } from "@gajae-code/utils/cli";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncSkillActiveState, type WorkflowHudSummary } from "../skill-state/active-state";
import {
	buildWorkflowStateReceipt,
	canonicalWorkflowSkill,
	describeWorkflowStateContract,
	workflowStateStoragePath,
	type WorkflowStateReceipt,
} from "../skill-state/workflow-state-contract";
import { runBridgedRuntimeEndpoint } from "./gjc-runtime-bridge";

interface ParsedStateArgs {
	skill?: string;
	action?: string;
	input?: string;
	json: boolean;
	sessionId?: string;
	threadId?: string;
	turnId?: string;
}

interface WorkflowStatePayload {
	active?: boolean;
	phase?: string;
	hud?: WorkflowHudSummary;
	state?: Record<string, unknown>;
}

function parseStateArgs(argv: string[]): ParsedStateArgs {
	const parsed: ParsedStateArgs = { json: false };
	const positional: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") {
			parsed.json = true;
			continue;
		}
		if (arg === "--input") {
			parsed.input = argv[index + 1];
			index += 1;
			continue;
		}
		if (arg === "--session-id") {
			parsed.sessionId = argv[index + 1];
			index += 1;
			continue;
		}
		if (arg === "--thread-id") {
			parsed.threadId = argv[index + 1];
			index += 1;
			continue;
		}
		if (arg === "--turn-id") {
			parsed.turnId = argv[index + 1];
			index += 1;
			continue;
		}
		positional.push(arg);
	}
	parsed.skill = positional[0];
	parsed.action = positional[1];
	return parsed;
}

function readInputPayload(input: string | undefined): WorkflowStatePayload {
	if (!input) return {};
	const parsed = JSON.parse(input) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	return parsed as WorkflowStatePayload;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const parsed = JSON.parse(await Bun.file(filePath).text()) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeOutput(value: unknown, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
		return;
	}
	if (value && typeof value === "object" && "receipt" in value) {
		const receipt = (value as { receipt: WorkflowStateReceipt }).receipt;
		process.stdout.write([
			`Updated ${receipt.skill} workflow state`,
			`state: ${receipt.state_path}`,
			`storage: ${receipt.storage_path}`,
			`receipt: ${receipt.status} until ${receipt.fresh_until}`,
			`command: ${receipt.command}`,
		].join("\n") + "\n");
		return;
	}
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runNativeWorkflowStateCommand(argv: string[]): Promise<boolean> {
	const args = parseStateArgs(argv);
	const skill = args.skill ? canonicalWorkflowSkill(args.skill) : null;
	if (!skill) return false;
	const action = args.action ?? "read";
	const cwd = process.cwd();
	const storagePath = workflowStateStoragePath(cwd, skill, args.sessionId);
	if (action === "contract") {
		writeOutput({ skill, contract: describeWorkflowStateContract(skill) }, args.json);
		return true;
	}
	if (action === "read") {
		writeOutput({ skill, state: await readJsonFile(storagePath), storage_path: storagePath }, args.json);
		return true;
	}
	if (action !== "write") return false;
	const payload = readInputPayload(args.input);
	const nowIso = new Date().toISOString();
	const receipt = buildWorkflowStateReceipt({
		cwd,
		skill,
		owner: "gjc-state-cli",
		command: `gjc state ${skill} write`,
		sessionId: args.sessionId,
		nowIso,
	});
	const existing = (await readJsonFile(storagePath)) ?? {};
	const nextState = {
		...existing,
		...(payload.state ?? {}),
		version: typeof existing.version === "number" ? existing.version : 1,
		skill,
		active: payload.active ?? existing.active ?? true,
		current_phase: payload.phase ?? existing.current_phase ?? payload.state?.current_phase ?? "active",
		updated_at: nowIso,
		receipt,
	};
	await writeJsonFile(storagePath, nextState);
	await syncSkillActiveState({
		cwd,
		skill,
		active: Boolean(nextState.active),
		phase: String(nextState.current_phase),
		sessionId: args.sessionId,
		threadId: args.threadId,
		turnId: args.turnId,
		nowIso,
		source: "gjc-state-cli",
		hud: payload.hud,
		receipt,
	});
	writeOutput({ skill, state: nextState, receipt }, args.json);
	return true;
}

export default class State extends Command {
	static description = "Read or update private GJC workflow state through the bridge (requires GJC_RUNTIME_BINARY)";
	static strict = false;
	static examples = [
		'$ GJC_RUNTIME_BINARY=/path/to/private-runtime gjc state read --input \'{"mode":"team"}\' --json',
		"$ gjc state deep-interview read --json",
		'$ gjc state ralplan write --input \'{"phase":"approval","active":true}\' --json',
		"$ gjc state team contract",
	];

	async run(): Promise<void> {
		try {
			if (await runNativeWorkflowStateCommand(this.argv)) return;
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
			return;
		}
		await runBridgedRuntimeEndpoint("state", this.argv);
	}
}
