import { beforeAll, describe, expect, it } from "bun:test";
import { getOAuthProviders } from "@gajae-code/ai/utils/oauth";
import { LoginDialogComponent } from "@gajae-code/coding-agent/modes/components/login-dialog";
import { OAuthSelectorComponent } from "@gajae-code/coding-agent/modes/components/oauth-selector";
import { ProviderOnboardingSelectorComponent } from "@gajae-code/coding-agent/modes/components/provider-onboarding-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import type { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { type Component, Container, type TUI } from "@gajae-code/tui";

const fakeTui = { requestRender: () => undefined } as unknown as TUI;
const fakeAuthStorage = { hasAuth: () => false } as unknown as AuthStorage;

beforeAll(async () => {
	await initTheme(false);
});

describe("provider registration flow", () => {
	it("lets every OAuth provider row be selected from the login selector", () => {
		const providers = getOAuthProviders();
		expect(providers.length).toBeGreaterThan(0);

		for (let index = 0; index < providers.length; index++) {
			let selectedProvider: string | undefined;
			const selector = new OAuthSelectorComponent(
				"login",
				fakeAuthStorage,
				providerId => {
					selectedProvider = providerId;
				},
				() => undefined,
			);
			for (let i = 0; i < index; i++) selector.handleInput("\u001b[B");
			selector.handleInput("\n");
			selector.stopValidation();
			expect(selectedProvider).toBe(providers[index]?.id);
		}
	});

	it("routes both provider onboarding choices", () => {
		const actions: string[] = [];
		const selector = new ProviderOnboardingSelectorComponent(
			action => actions.push(action),
			() => actions.push("cancel"),
		);

		selector.handleInput("\n");
		selector.handleInput("\u001b[B");
		selector.handleInput("\n");

		expect(actions).toEqual(["oauth-login", "api-guide"]);
	});

	it("shows login as an explicit dialog action instead of dumping or auto-opening a raw URL", () => {
		const dialog = new LoginDialogComponent(fakeTui, "google-antigravity", () => undefined);
		const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&response_type=code";

		dialog.showAuth(url, "Follow the provider sign-in flow.");
		const rendered = Bun.stripANSI(dialog.render(100).join("\n"));

		expect(rendered).toContain("Sign in required");
		expect(rendered).toContain("Open login");
		expect(rendered).toContain("Enter/o: open");
		expect(rendered).not.toContain("accounts.google.com/o/oauth2/v2/auth");
	});

	it("shows progress immediately while provider login prepares network auth", () => {
		const dialog = new LoginDialogComponent(fakeTui, "cursor", () => undefined);
		const rendered = Bun.stripANSI(dialog.render(100).join("\n"));

		expect(rendered).toContain("Preparing sign-in");
		expect(rendered).toContain("Esc: cancel");
	});

	it("does not block the CLI while a chosen provider login remains pending", async () => {
		let rejectLogin!: (error: Error) => void;
		let overlayShown = false;
		let focusedComponent: Component | null = null;
		const ctx = {
			editor: {} as Component,
			editorContainer: new Container(),
			chatContainer: new Container(),
			ui: {
				showOverlay: () => {
					overlayShown = true;
					return { hide: () => undefined, setHidden: () => undefined };
				},
				setFocus: (component: Component | null) => {
					focusedComponent = component;
				},
				requestRender: () => undefined,
			},
			showStatus: () => undefined,
			showError: () => undefined,
			session: {
				sessionId: "test-session",
				modelRegistry: {
					authStorage: {
						login: () =>
							new Promise<void>((_resolve, reject) => {
								rejectLogin = reject;
							}),
					},
					refresh: async () => undefined,
				},
			},
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		const outcome = await Promise.race([
			controller.showOAuthSelector("login", "kagi").then(() => "returned"),
			Bun.sleep(50).then(() => "timeout"),
		]);

		expect(outcome).toBe("returned");
		expect(overlayShown).toBe(true);
		expect(focusedComponent).not.toBeNull();

		rejectLogin(new Error("stop test login"));
		await Bun.sleep(0);
	});
});
