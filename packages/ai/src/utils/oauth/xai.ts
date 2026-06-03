/** xAI login flow (API key paste against https://api.x.ai/v1). */
import { createApiKeyLogin } from "./api-key-login";

export const loginXai = createApiKeyLogin({
	providerLabel: "xAI",
	authUrl: "https://console.x.ai/team/default/api-keys",
	instructions: "Create or copy your xAI API key",
	promptMessage: "Paste your xAI API key",
	placeholder: "xai-...",
	validation: {
		kind: "models-endpoint",
		provider: "xAI",
		modelsUrl: "https://api.x.ai/v1/models",
	},
});
