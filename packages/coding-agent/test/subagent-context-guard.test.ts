import { describe, expect, test } from "bun:test";
import {
	estimateSubagentInitialPromptTokens,
	SUBAGENT_BASE_PROMPT_TOKEN_ESTIMATE,
	SUBAGENT_RESPONSE_RESERVE_TOKENS,
	subagentModelContextFits,
} from "../src/task/subagent-context-guard";

describe("estimateSubagentInitialPromptTokens", () => {
	test("baseline applies with no extra inputs", () => {
		expect(estimateSubagentInitialPromptTokens({})).toBe(SUBAGENT_BASE_PROMPT_TOKEN_ESTIMATE);
	});

	test("adds ~chars/4 for task, assignment, and context text", () => {
		const text = "x".repeat(400); // ~100 tokens
		expect(estimateSubagentInitialPromptTokens({ assignment: text })).toBe(SUBAGENT_BASE_PROMPT_TOKEN_ESTIMATE + 100);
		expect(estimateSubagentInitialPromptTokens({ task: text, assignment: text, context: text })).toBe(
			SUBAGENT_BASE_PROMPT_TOKEN_ESTIMATE + 300,
		);
	});

	test("adds forked snapshot tokens and clamps negatives", () => {
		expect(estimateSubagentInitialPromptTokens({ forkContextTokens: 5_000 })).toBe(
			SUBAGENT_BASE_PROMPT_TOKEN_ESTIMATE + 5_000,
		);
		expect(estimateSubagentInitialPromptTokens({ forkContextTokens: -10 })).toBe(SUBAGENT_BASE_PROMPT_TOKEN_ESTIMATE);
	});
});

describe("subagentModelContextFits", () => {
	test("treats unknown / non-positive windows as sufficient (no signal)", () => {
		expect(subagentModelContextFits(undefined, 50_000)).toBe(true);
		expect(subagentModelContextFits(0, 50_000)).toBe(true);
	});

	test("rejects a degenerate local window (the n_ctx 4096 regression)", () => {
		const need = estimateSubagentInitialPromptTokens({});
		expect(subagentModelContextFits(4_096, need)).toBe(false);
	});

	test("requires room for prompt plus the response reserve", () => {
		const need = 20_000;
		expect(subagentModelContextFits(need + SUBAGENT_RESPONSE_RESERVE_TOKENS - 1, need)).toBe(false);
		expect(subagentModelContextFits(need + SUBAGENT_RESPONSE_RESERVE_TOKENS, need)).toBe(true);
	});

	test("accepts large cloud windows for a forked council briefing", () => {
		const need = estimateSubagentInitialPromptTokens({
			assignment: "y".repeat(8_000),
			forkContextTokens: 30_000,
		});
		expect(subagentModelContextFits(200_000, need)).toBe(true);
		expect(subagentModelContextFits(4_096, need)).toBe(false);
	});
});
