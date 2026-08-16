import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { TRPCError } from "@trpc/server";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { HostDb } from "../../../../db";
import * as schema from "../../../../db/schema";
import type { HostServiceContext } from "../../../../types";
import { workspacesRouter } from "../../workspaces/workspaces";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../../../../drizzle");
const CLAUDE_ID = "00000000-0000-0000-0000-00000000000a";

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

function createCaller(db: HostDb) {
	const ctx = {
		db,
		isAuthenticated: true,
		organizationId: "org-1",
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
