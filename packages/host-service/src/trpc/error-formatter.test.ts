import { describe, expect, it } from "bun:test";
import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import type { HostServiceContext } from "../types";
import { protectedProcedure, router } from "./index";
import { AgentLaunchCapabilityError } from "./router/agents/agents";

const probeRouter = router({
	fail: protectedProcedure.mutation(() => {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: 'Model "retired-model" is not available for Claude.',
			cause: new AgentLaunchCapabilityError(
				"retired_model",
				'Model "retired-model" is not available for Claude.',
			),
		});
	}),
});

describe("tRPC agentLaunchCapability wire shape", () => {
	it("serializes the sanitized launch kind for renderer query invalidation", async () => {
		const response = await fetchRequestHandler({
			endpoint: "/trpc",
			req: new Request("http://localhost/trpc/fail", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(superjson.serialize(undefined)),
			}),
			router: probeRouter,
			createContext: () =>
				({ isAuthenticated: true }) as unknown as HostServiceContext,
		});
		const body = (await response.json()) as {
			error?: {
				json?: { data?: { agentLaunchCapability?: { kind?: string } } };
			};
		};
		expect(body.error?.json?.data?.agentLaunchCapability).toEqual({
			kind: "retired_model",
		});
	});
});
