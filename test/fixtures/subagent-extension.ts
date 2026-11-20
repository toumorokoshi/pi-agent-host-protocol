/**
 * Test-only pi extension for RPC mode: a `subagent` tool that behaves like
 * pi-subagents' async workflow, without running anything. It writes a run
 * directory with `status.json` (in `PI_AGENT_HOST_PROTOCOL_SUBAGENT_DIR`) and
 * a child session file next to the parent's session file, in the shapes
 * pi-subagents 0.84 writes, and returns the same tool result details.
 *
 * Tests then drive the run by rewriting the files (see `test/subagent-e2e.test.ts`).
 * `/subagent-notify` posts the completion notice pi-subagents adds when a
 * workflow finishes, which lists the children's run ids.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function subagentExtension(pi: ExtensionAPI): void {
	pi.registerCommand("subagent-notify", {
		description: "Post the latest run's completion notice",
		handler: async () => {
			const root = process.env.PI_AGENT_HOST_PROTOCOL_SUBAGENT_DIR ?? "";
			const { runId, steps } = JSON.parse(readFileSync(join(root, "latest.json"), "utf8")) as {
				runId: string;
				steps: { agent: string; workflowKey: string; runId: string }[];
			};
			pi.sendMessage(
				{
					customType: "subagent-notify",
					content: "Background task completed: **workflow**",
					display: true,
					details: {
						runs: [
							{
								agent: "workflow",
								status: "completed",
								runId,
								workflowRunId: runId,
								childRuns: steps.map((step) => ({
									runId: step.runId,
									workflowKey: step.workflowKey,
									agent: step.agent,
									status: "completed",
								})),
							},
						],
					},
				},
				{ triggerTurn: false },
			);
		},
	});
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Test subagent tool",
		parameters: Type.Object({
			workflow: Type.Optional(Type.String()),
			args: Type.Optional(Type.Any()),
			async: Type.Optional(Type.Boolean()),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const root = process.env.PI_AGENT_HOST_PROTOCOL_SUBAGENT_DIR ?? "";
			const runId = `run-${toolCallId}`;
			const asyncDir = join(root, runId);
			mkdirSync(asyncDir, { recursive: true });
			const parentFile = ctx.sessionManager.getSessionFile() ?? join(root, "parent.jsonl");
			const tasks = ((params.args as { tasks?: { agent: string; task: string }[] } | undefined)?.tasks ?? []).map(
				(task, index) => ({ ...task, key: `task-${index + 1}`, runId: `${runId}-child-${index + 1}` }),
			);
			const steps = tasks.map((task) => ({
				agent: task.agent,
				label: task.key,
				workflowKey: task.key,
				status: "running",
				startedAt: Date.now(),
				runId: task.runId,
				sessionFile: join(parentFile.replace(/\.jsonl$/, ""), task.runId, "run-0", "session.jsonl"),
			}));
			writeFileSync(
				join(asyncDir, "status.json"),
				JSON.stringify({ runId, toolCallId, mode: "workflow", state: "running", steps }),
			);
			// Where the test finds the files to drive.
			writeFileSync(join(root, "latest.json"), JSON.stringify({ runId, asyncDir, steps }));
			return {
				content: [{ type: "text", text: `Async workflow [${runId}]` }],
				details: { mode: "workflow", runId, asyncId: runId, asyncDir, toolCallId, results: [] },
			};
		},
	});
}
