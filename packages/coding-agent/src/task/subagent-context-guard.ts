/**
 * Context-window preflight for subagent dispatch.
 *
 * A subagent whose resolved model has a context window too small to hold even
 * its initial prompt (system prompt + tool schemas + assignment + any forked
 * parent context) fails on its very first request with a raw provider
 * context-overflow refusal (e.g. llama.cpp / LM Studio "tokens to keep from the
 * initial prompt is greater than the context length"). That failure is
 * unrecoverable from inside the child loop — compaction cannot shrink the
 * system prompt below the window — and aborts the whole council/batch.
 *
 * These pure helpers estimate the initial prompt size and decide whether a
 * resolved model can plausibly run, so the executor can auto-recover to the
 * parent's (larger) model or fail with a clear, actionable error BEFORE the
 * request is sent.
 */

/**
 * Heuristic baseline for the GJC subagent system prompt + tool schemas, in
 * tokens. Tool JSON schemas dominate; this is intentionally generous so the
 * guard catches degenerate windows (e.g. a local model loaded with n_ctx 4096)
 * without false-positiving on real, usable context windows.
 *
 * Calibrated 2026-06: system prompt ~8k tokens + tool JSON schemas ~4k with
 * ~50% margin for future growth. Recheck when tool schemas or system prompts
 * change significantly (e.g. new tools added, prompt restructuring).
 */
export const SUBAGENT_BASE_PROMPT_TOKEN_ESTIMATE = 12_000;

/** Reserve left for the subagent's first response so the request is not maximally tight. */
export const SUBAGENT_RESPONSE_RESERVE_TOKENS = 2_000;

/** Rough chars-per-token used across the codebase for cheap pre-send estimates. */
const CHARS_PER_TOKEN = 4;

function estimateTextTokens(text: string | undefined): number {
	if (!text) return 0;
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface SubagentPromptSizeInput {
	task?: string;
	assignment?: string;
	context?: string;
	/** Approximate tokens of any forked parent-conversation snapshot. */
	forkContextTokens?: number;
}

/**
 * Estimate the tokens of a subagent's initial prompt (baseline system/tools +
 * task/assignment/context text + forked snapshot).
 */
export function estimateSubagentInitialPromptTokens(input: SubagentPromptSizeInput): number {
	return (
		SUBAGENT_BASE_PROMPT_TOKEN_ESTIMATE +
		estimateTextTokens(input.task) +
		estimateTextTokens(input.assignment) +
		estimateTextTokens(input.context) +
		Math.max(0, input.forkContextTokens ?? 0)
	);
}

/**
 * Returns true when `contextWindow` can plausibly hold `estimatedPromptTokens`
 * plus a response reserve. An unknown / non-positive window carries no signal
 * and is treated as sufficient (the existing error paths still apply).
 */
export function subagentModelContextFits(contextWindow: number | undefined, estimatedPromptTokens: number): boolean {
	if (!contextWindow || contextWindow <= 0) return true;
	return contextWindow >= estimatedPromptTokens + SUBAGENT_RESPONSE_RESERVE_TOKENS;
}
