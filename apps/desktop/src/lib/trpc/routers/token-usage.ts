import { getTokenUsageSnapshot } from "main/lib/token-usage";
import { z } from "zod";
import { publicProcedure, router } from "..";

const nonNegativeNumber = z.number().finite().nonnegative();

const tokenTotalsSchema = z.object({
	inputTokens: nonNegativeNumber,
	outputTokens: nonNegativeNumber,
	cacheReadTokens: nonNegativeNumber,
	cacheWriteTokens: nonNegativeNumber,
	reasoningTokens: nonNegativeNumber,
});

const tokenUsageWindowSchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1),
	windowMinutes: nonNegativeNumber.nullable(),
	usedPercent: z.number().finite().min(0).max(100),
	resetsAt: z.number().int().nonnegative().nullable(),
});

const tokenUsageModelSchema = tokenTotalsSchema.extend({
	model: z.string().min(1),
	totalTokens: nonNegativeNumber,
	costUsd: nonNegativeNumber,
	messages: z.number().int().nonnegative(),
	pricingKnown: z.boolean(),
});

const tokenUsageDaySchema = z.object({
	day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	costUsd: nonNegativeNumber,
	totalTokens: nonNegativeNumber,
});

const providerTokenUsageSchema = z.object({
	provider: z.enum(["codex", "claude"]),
	available: z.boolean(),
	windows: z.array(tokenUsageWindowSchema),
	costUsd: nonNegativeNumber,
	cacheSavingsUsd: nonNegativeNumber,
	totalTokens: nonNegativeNumber,
	tokens: tokenTotalsSchema,
	messages: z.number().int().nonnegative(),
	sessions: z.number().int().nonnegative(),
	activeDays: z.number().int().nonnegative(),
	models: z.array(tokenUsageModelSchema),
	days: z.array(tokenUsageDaySchema),
	latestActivityAt: z.number().int().nonnegative().nullable(),
});

const tokenUsageSnapshotSchema = z.object({
	providers: z.array(providerTokenUsageSchema).length(2),
	period: z.object({
		startAt: z.number().int().nonnegative(),
		endAt: z.number().int().nonnegative(),
		label: z.string().min(1),
		resetBased: z.boolean(),
	}),
	collectedAt: z.number().int().nonnegative(),
});

export const createTokenUsageRouter = () => {
	return router({
		getSnapshot: publicProcedure
			.output(tokenUsageSnapshotSchema)
			.query(() => getTokenUsageSnapshot()),
		refreshSnapshot: publicProcedure
			.output(tokenUsageSnapshotSchema)
			.mutation(() => getTokenUsageSnapshot({ force: true })),
	});
};
