import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { TRPCError } from "@trpc/server";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { AgentCapabilitySnapshot } from "../../../../agent-capabilities/agent-capabilities";
import type { CapabilityRefreshService } from "../../../../agent-capabilities/capability-refresh-service";
import type { HostDb } from "../../../../db";
import * as schema from "../../../../db/schema";
import type { HostServiceContext } from "../../../../types";
import { workspacesRouter } from "../../workspaces/workspaces";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../../../../drizzle");
const CLAUDE_ID = "00000000-0000-0000-0000-00000000000a";
const CHECKED_AT = new Date().toISOString();

function createTestDb(): HostDb {
	const sqlite = new Database(":memory:");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	return db as unknown as HostDb;
}

function seedClaude(db: HostDb) {
	db.insert(schema.hostAgentConfigs)
		.values({
			id: CLAUDE_ID,
			presetId: "claude",
			label: "Claude",
			command: "claude",
			argsJson: "[]",
			promptTransport: "argv",
			promptArgsJson: "[]",
			resumeArgsJson: "[]",
			envJson: "{}",
			capabilityRevision: 1,
			displayOrder: 0,
		})
		.run();
}

function readySnapshot(): AgentCapabilitySnapshot {
	return {
		agentId: CLAUDE_ID,
		presetId: "claude",
		status: "ready",
		installed: true,
		auth: "authenticated",
		version: "1.0.0",
		modelSource: "runtime",
		models: [
			{
				id: "claude-opus-5",
				label: "Opus 5",
				reasoning: { state: "unknown" },
			},
		],
		message: null,
		checkedAt: CHECKED_AT,
		inventoryCheckedAt: CHECKED_AT,
	};
}

function createCaller(
	db: HostDb,
	snapshot: AgentCapabilitySnapshot = readySnapshot(),
) {
	const ctx = {
		db,
		isAuthenticated: true,
		organizationId: "org-1",
		capabilityRefresh: {
			ensureFreshCapability: async () => snapshot,
		} as unknown as CapabilityRefreshService,
	} as HostServiceContext;
	return workspacesRouter.createCaller(ctx);
}

describe("createSession launch contract", () => {
	it("rejects a retired model before creating a session folder", async () => {
		const db = createTestDb();
		seedClaude(db);
		const caller = createCaller(db);
		try {
			await caller.createSession({
				agents: [
					{
						agent: "claude",
						prompt: "do the thing",
						model: "retired-model",
					},
				],
			});
			throw new Error("Expected createSession to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).cause).toMatchObject({
				kind: "retired_model",
			});
		}
		expect(db.select().from(schema.workspaces).all()).toEqual([]);
	});
});
