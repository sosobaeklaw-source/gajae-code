import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import {
	isContextOverflow,
	isUnrecoverableContextOverflow,
	parseContextOverflowLimits,
} from "@gajae-code/ai/utils/overflow";

function createErrorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("isContextOverflow - model_context_window_exceeded", () => {
	it("detects model_context_window_exceeded in finish_reason error message", () => {
		const message = createErrorMessage("Provider finish_reason: model_context_window_exceeded");
		expect(isContextOverflow(message)).toBe(true);
	});

	it("detects raw model_context_window_exceeded in error message", () => {
		const message = createErrorMessage("model_context_window_exceeded");
		expect(isContextOverflow(message)).toBe(true);
	});
});

describe("isContextOverflow - HTTP 413 variants", () => {
	it("detects generic 413 payload-too-large errors", () => {
		const message = createErrorMessage("413 Request Entity Too Large: payload too large for request body");
		expect(isContextOverflow(message)).toBe(true);
	});

	it("detects Anthropic request size overflow wording", () => {
		const message = createErrorMessage("Request exceeds the maximum size allowed by this model");
		expect(isContextOverflow(message)).toBe(true);
	});

	it("does not classify unrelated 413 errors as overflow", () => {
		const message = createErrorMessage("413 Forbidden");
		expect(isContextOverflow(message)).toBe(false);
	});
});

describe("isContextOverflow - 400/413 no-body (Cerebras, Mistral, proxy wrappers)", () => {
	it("detects bare '400 status code (no body)'", () => {
		expect(isContextOverflow(createErrorMessage("400 status code (no body)"))).toBe(true);
	});

	it("detects bare '413 status code (no body)'", () => {
		expect(isContextOverflow(createErrorMessage("413 status code (no body)"))).toBe(true);
	});

	it("detects '400 (no body)' without 'status code' word", () => {
		expect(isContextOverflow(createErrorMessage("400 (no body)"))).toBe(true);
	});

	// Regression: api.synthetic.new wraps upstream HF 400-no-body in a JSON envelope.
	// finalizeErrorMessage transforms the response to "400 status code: {JSON}" where
	// the JSON value contains the inner "400 status code (no body)" text.
	it('detects wrapped proxy envelope: \'400 status code: {"error":"... 400 status code (no body)"}\'', () => {
		const errorMessage = '400 status code: {"error":"Error from inference backend: 400 status code (no body)"}';
		expect(isContextOverflow(createErrorMessage(errorMessage))).toBe(true);
	});

	it("detects when status code phrase is embedded deeper in the message", () => {
		const errorMessage = "Upstream rejected request: 400 status code (no body)";
		expect(isContextOverflow(createErrorMessage(errorMessage))).toBe(true);
	});

	it("does not classify unrelated 400 errors as overflow", () => {
		expect(isContextOverflow(createErrorMessage("400 Bad Request: invalid API key"))).toBe(false);
	});

	it("does not classify 429 (rate limit) as overflow", () => {
		expect(isContextOverflow(createErrorMessage("429 status code (no body)"))).toBe(false);
	});
});

const N_KEEP_OVERFLOW =
	"The number of tokens to keep from the initial prompt is greater than the context length (n_keep: 36935>= n_ctx: 4096).";

describe("isUnrecoverableContextOverflow - llama.cpp / LM Studio n_keep >= n_ctx", () => {
	it("treats the n_keep prose message as unrecoverable", () => {
		const message = createErrorMessage(N_KEEP_OVERFLOW);
		expect(isContextOverflow(message)).toBe(true);
		expect(isUnrecoverableContextOverflow(message)).toBe(true);
	});

	it("detects the bare 'n_keep: X >= n_ctx' shape without spaces around >=", () => {
		expect(isUnrecoverableContextOverflow(createErrorMessage("n_keep: 36935>= n_ctx: 4096"))).toBe(true);
	});

	it("detects via parsed limits when keep tokens exceed the server window", () => {
		expect(isUnrecoverableContextOverflow(createErrorMessage("overflow n_ctx=4096 with n_keep=8000"))).toBe(true);
	});

	it("does not flag recoverable history overflow as unrecoverable", () => {
		const message = createErrorMessage("prompt is too long: 250000 tokens > 200000 maximum");
		expect(isContextOverflow(message)).toBe(true);
		expect(isUnrecoverableContextOverflow(message)).toBe(false);
	});

	it("does not flag non-error messages", () => {
		const ok = createErrorMessage(N_KEEP_OVERFLOW);
		ok.stopReason = "stop";
		expect(isUnrecoverableContextOverflow(ok)).toBe(false);
	});
});

describe("parseContextOverflowLimits", () => {
	it("extracts n_ctx and n_keep from the llama.cpp message", () => {
		expect(parseContextOverflowLimits(N_KEEP_OVERFLOW)).toEqual({ contextSize: 4096, keepTokens: 36935 });
	});

	it("extracts only n_ctx when n_keep is absent", () => {
		expect(parseContextOverflowLimits("the request exceeds n_ctx: 8192")).toEqual({ contextSize: 8192 });
	});

	it("extracts only n_keep when n_ctx is absent", () => {
		expect(parseContextOverflowLimits("the request exceeds n_keep=8000")).toEqual({ keepTokens: 8000 });
	});
	it("returns undefined when no numeric limits are present", () => {
		expect(parseContextOverflowLimits("prompt is too long")).toBeUndefined();
		expect(parseContextOverflowLimits(undefined)).toBeUndefined();
	});
});
