import { describe, expect, test } from "bun:test";
import { getLinkedPresetAvailability } from "./linkedPresetAvailability";

function capability(health: {
	installed: boolean | null;
	auth?: "authenticated" | "unauthenticated" | "unknown";
	status?: "ready" | "unavailable" | "authentication_required" | "unknown";
}) {
	return {
		health: {
			auth: "unknown" as const,
			status: "unknown" as const,
			...health,
		},
	};
}

const agents = [{ id: "cfg-claude", presetId: "claude" }];

describe("getLinkedPresetAvailability", () => {
	test("leaves non-agent presets unchanged", () => {
		expect(getLinkedPresetAvailability({}, new Map())).toBe("unlinked");
	});

	test("hides a linked agent whose executable is missing", () => {
		expect(
			getLinkedPresetAvailability(
				{ agentId: "cfg-claude" },
				new Map([
					[
						"cfg-claude",
						capability({
							installed: false,
							status: "unavailable",
						}),
					],
				]),
				agents,
			),
		).toBe("hidden");
	});

	test("disables installed:null and auth-required linked agents", () => {
		expect(
			getLinkedPresetAvailability(
				{ agentId: "cfg-claude" },
				new Map([["cfg-claude", capability({ installed: null })]]),
				agents,
			),
		).toBe("disabled");
		expect(
			getLinkedPresetAvailability(
				{ agentId: "claude" },
				new Map([
					[
						"cfg-claude",
						capability({
							installed: true,
							auth: "unauthenticated",
							status: "authentication_required",
						}),
					],
				]),
				agents,
			),
		).toBe("disabled");
	});

	test("enables a ready authenticated linked agent", () => {
		expect(
			getLinkedPresetAvailability(
				{ agentId: "cfg-claude" },
				new Map([
					[
						"cfg-claude",
						capability({
							installed: true,
							auth: "authenticated",
							status: "ready",
						}),
					],
				]),
				agents,
			),
		).toBe("enabled");
	});
});
