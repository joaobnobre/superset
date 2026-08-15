import { describe, expect, it } from "bun:test";
import {
	automationAgentLaunch,
	createFreshAutomationWorkspace,
	pickLaunchedAutomationAgent,
} from "./dispatch-fresh-workspace";
import { RelayDispatchError } from "./relay-client";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

function capabilityError(
	procedure: string,
	kind: "retired_model" | "authentication_required",
	message: string,
) {
	return new RelayDispatchError(
		`${procedure}: ${message}`,
		412,
		JSON.stringify({
			error: {
				json: {
					message,
					data: { agentLaunchCapability: { kind } },
				},
			},
		}),
	);
}

describe("automation fresh-workspace launch contract", () => {
	it("passes automation.agent into workspaces.create before any later host mutation", async () => {
		const calls: Array<{ procedure: string; input: unknown }> = [];
		await expect(
			createFreshAutomationWorkspace({
				relayUrl: "https://relay.test",
				hostId: "org:host",
				jwt: "jwt",
				projectId: PROJECT_ID,
				automation: {
					name: "Nightly",
					agent: "claude",
					prompt: "do the thing",
				},
				mutate: async (_options, procedure, input) => {
					calls.push({ procedure, input });
					throw capabilityError(
						procedure,
						"retired_model",
						'Model "retired-model" is not available for Claude.',
					);
				},
			}),
		).rejects.toBeInstanceOf(RelayDispatchError);

		expect(calls.map((call) => call.procedure)).toEqual(["workspaces.create"]);
		expect(calls[0]?.input).toMatchObject({
			projectId: PROJECT_ID,
			agents: [{ agent: "claude", prompt: "do the thing" }],
		});
	});

	it("passes automation.agent into createSession and treats auth failure as no workspace", async () => {
		const calls: Array<{ procedure: string; input: unknown }> = [];
		let created = false;
		await expect(
			createFreshAutomationWorkspace({
				relayUrl: "https://relay.test",
				hostId: "org:host",
				jwt: "jwt",
				projectId: null,
				automation: {
					name: "Session job",
					agent: "codex",
					prompt: "review diffs",
				},
				mutate: async (_options, procedure, input) => {
					calls.push({ procedure, input });
					const agents = (
						input as { agents?: Array<{ agent: string; prompt: string }> }
					).agents;
					if (!agents?.length) {
						created = true;
						return { workspace: { id: "should-not-create" } };
					}
					throw capabilityError(
						procedure,
						"authentication_required",
						"Codex requires authentication before launch.",
					);
				},
			}),
		).rejects.toMatchObject({
			message: expect.stringContaining("authentication"),
		});

		expect(created).toBe(false);
		expect(calls).toEqual([
			{
				procedure: "workspaces.createSession",
				input: {
					name: "Session job",
					agents: [{ agent: "codex", prompt: "review diffs" }],
				},
			},
		]);
	});

	it("returns the agent launched by create and does not invent a second run", async () => {
		const calls: string[] = [];
		const created = await createFreshAutomationWorkspace({
			relayUrl: "https://relay.test",
			hostId: "org:host",
			jwt: "jwt",
			projectId: PROJECT_ID,
			automation: {
				name: "Nightly",
				agent: "claude",
				prompt: "do the thing",
			},
			mutate: async (_options, procedure, input) => {
				calls.push(procedure);
				expect(input).toMatchObject({
					agents: [
						automationAgentLaunch({ agent: "claude", prompt: "do the thing" }),
					],
				});
				return {
					workspace: {
						id: "ws-1",
						projectId: PROJECT_ID,
						name: "Nightly",
						branch: "main",
					},
					agents: [
						{
							ok: true as const,
							kind: "terminal" as const,
							sessionId: "term-1",
							label: "Claude",
						},
					],
					terminals: [],
					alreadyExists: false,
				};
			},
		});

		expect(calls).toEqual(["workspaces.create"]);
		expect(created).toEqual({
			workspaceId: "ws-1",
			launchedAgent: {
				kind: "terminal",
				sessionId: "term-1",
				label: "Claude",
			},
		});
	});

	it("surfaces a swallowed create-time agent failure instead of treating it as success", () => {
		expect(() =>
			pickLaunchedAutomationAgent([
				{ ok: false, error: "Claude requires authentication before launch." },
			]),
		).toThrow("Claude requires authentication before launch.");
	});
});
