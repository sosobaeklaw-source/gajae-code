import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { getOAuthProviders, refreshOAuthToken } from "../src/utils/oauth";
import type { OAuthController, OAuthCredentials } from "../src/utils/oauth/types";
import { loginXai } from "../src/utils/oauth/xai";
import { withEnv } from "./helpers";

const originalFetch = global.fetch;
const SUPPRESS_XAI_ENV = { XAI_API_KEY: undefined } as const;

function makeController(paste: string): OAuthController {
	return {
		onAuth: () => {},
		onPrompt: async () => paste,
	};
}

describe("xAI OAuth login provider", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-xai-oauth-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("registers xAI as an available login provider", () => {
		expect(getOAuthProviders().find(provider => provider.id === "xai")).toEqual({
			id: "xai",
			name: "xAI",
			available: true,
		});
	});

	it("validates against GET /v1/models and returns the trimmed key on 200", async () => {
		const calls: Array<{ url: string; method?: string; auth?: string | null }> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const headers = new Headers(init?.headers ?? {});
			calls.push({ url, method: init?.method, auth: headers.get("authorization") });
			return new Response(JSON.stringify({ object: "list", data: [{ id: "grok-4", object: "model" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const key = await loginXai(makeController("  xai-valid-key  "));

		expect(key).toBe("xai-valid-key");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(calls[0]?.url).toBe("https://api.x.ai/v1/models");
		expect(calls[0]?.method ?? "GET").toBe("GET");
		expect(calls[0]?.auth).toBe("Bearer xai-valid-key");
	});

	it("rejects an empty paste before touching the network", async () => {
		const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(loginXai(makeController("   "))).rejects.toThrow(/API key is required/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("throws a validation error when /v1/models returns 401", async () => {
		const fetchMock = vi.fn(
			async () => new Response("invalid api key", { status: 401, headers: { "Content-Type": "text/plain" } }),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(loginXai(makeController("xai-bad-key"))).rejects.toThrow(/xAI.*401.*invalid api key/i);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("stores xAI login credentials as a reusable api-key credential", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }));
		global.fetch = fetchMock as unknown as typeof fetch;

		await authStorage.login("xai", {
			onAuth: () => {},
			onPrompt: async () => "  xai-stored-key  ",
		});

		const credentials = store.listAuthCredentials("xai");
		expect(credentials).toHaveLength(1);
		expect(credentials[0]?.credential).toEqual({ type: "api_key", key: "xai-stored-key" });
		expect(store.getApiKey("xai")).toBe("xai-stored-key");
		await withEnv(SUPPRESS_XAI_ENV, async () => {
			expect(await authStorage?.getApiKey("xai", "session-xai-login")).toBe("xai-stored-key");
		});
	});

	it("treats xAI OAuth-shaped credentials as static bearer credentials during refresh", async () => {
		const credentials: OAuthCredentials = {
			access: "xai-access",
			refresh: "xai-refresh",
			expires: Date.now() + 60_000,
		};

		await expect(refreshOAuthToken("xai", credentials)).resolves.toBe(credentials);
	});
});
