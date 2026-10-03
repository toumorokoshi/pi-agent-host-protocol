/**
 * Test-only pi extension for RPC mode. It registers pi's faux provider in the
 * `pi --mode rpc` child and fetches every scripted response from the test
 * process over HTTP (`PI_AGENT_HOST_FAUX_URL`), so tests can keep scripting
 * responses, including factories, the same way in both modes.
 */
import { type AssistantMessage, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

const RESPONSES = 1000;

export default function fauxExtension(pi: { registerProvider(provider: unknown): void }): void {
	const url = process.env.PI_AGENT_HOST_FAUX_URL;
	if (!url) return;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux One" }], tokensPerSecond: 2000 });
	const remote = async (context: unknown): Promise<AssistantMessage> => {
		try {
			const response = await fetch(url, { method: "POST", body: JSON.stringify(context) });
			const message = (await response.json()) as AssistantMessage & { exitProcess?: number };
			// Lets tests simulate pi crashing mid-turn.
			if (message.exitProcess !== undefined) process.exit(message.exitProcess);
			return message;
		} catch (error) {
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: String(error) });
		}
	};
	faux.setResponses(Array.from({ length: RESPONSES }, () => remote));
	pi.registerProvider(faux.provider);
}
