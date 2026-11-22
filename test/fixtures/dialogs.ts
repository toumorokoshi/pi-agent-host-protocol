/**
 * Test-only pi extension for RPC mode, so tests can follow an extension dialog
 * from pi to the client and back:
 *
 * - `/dialog <kind> [timeoutMs]` opens one dialog and notifies what it resolved with.
 * - `/dialog later <kind>` opens it shortly after the command returns, outside the turn.
 * - `/dialog last` notifies what the latest dialog resolved with.
 * - `/dialog run <prompt>` starts a run of its own, as `/plan <prompt>` does, and a
 *   `pick_color` tool opens a select in it, as plan mode's question tool does.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

async function open(ctx: ExtensionCommandContext, kind: string | undefined, timeout: string | undefined) {
	const options = timeout ? { timeout: Number(timeout) } : undefined;
	switch (kind) {
		case "select":
			return ctx.ui.select("Pick a color", ["red", "green"], options);
		case "confirm":
			return ctx.ui.confirm("Proceed?", "This continues the plan.", options);
		case "input":
			return ctx.ui.input("Your name", "first name", options);
		case "editor":
			return ctx.ui.editor("Edit the draft", "draft");
		default:
			throw new Error(`unknown dialog: ${kind}`);
	}
}

export default function dialogsExtension(pi: ExtensionAPI): void {
	let last: unknown = "none";
	pi.registerTool({
		name: "pick_color",
		label: "Pick a color",
		description: "Ask the user to pick a color",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const answer = await ctx.ui.select("Pick a color", ["red", "green"]);
			last = answer ?? null;
			return { content: [{ type: "text", text: `picked: ${JSON.stringify(last)}` }], details: {} };
		},
	});
	pi.registerCommand("dialog", {
		description: "Open a test dialog",
		handler: async (args, ctx) => {
			const [first, second] = args.trim().split(/\s+/);
			if (first === "run") {
				// The command returns first ("handled"); the run it starts is not one the host started.
				pi.sendUserMessage(args.trim().slice("run".length).trim() || "go");
			} else if (first === "last") {
				ctx.ui.notify(`last: ${JSON.stringify(last)}`, "info");
			} else if (first === "later") {
				setTimeout(() => {
					void open(ctx, second, undefined).then((result) => {
						last = result ?? null;
					});
				}, 50);
			} else {
				last = (await open(ctx, first, second)) ?? null;
				ctx.ui.notify(`answer: ${JSON.stringify(last)}`, "warning");
			}
		},
	});
}
