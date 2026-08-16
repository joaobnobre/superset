export type UsageProvider = "codex" | "claude";

export interface UsageWindow {
	id: string;
	label: string;
	windowMinutes: number | null;
	usedPercent: number;
	resetsAt: number | null;
}

export interface UsageModel {
	model: string;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	costUsd: number;
	messages: number;
	pricingKnown: boolean;
}

export interface UsageDay {
	day: string;
	costUsd: number;
	totalTokens: number;
}

export interface ProviderUsage {
	provider: UsageProvider;
	available: boolean;
	windows: UsageWindow[];
	costUsd: number;
	cacheSavingsUsd: number;
	totalTokens: number;
	tokens: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		reasoningTokens: number;
	};
	messages: number;
	sessions: number;
	activeDays: number;
	models: UsageModel[];
	days: UsageDay[];
	latestActivityAt: number | null;
}
