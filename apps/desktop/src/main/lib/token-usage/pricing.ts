export interface ModelPricing {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

const CACHE_WRITE_1H_INPUT_MULTIPLIER = 2;

/** Offline per-million-token list prices used by the local raw-cost view. */
const PRICING: Readonly<Record<string, ModelPricing>> = {
	"claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	"claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-8": {
		input: 5,
		output: 25,
		cacheRead: 0.5,
		cacheWrite: 6.25,
	},
	"claude-opus-4-7": {
		input: 5,
		output: 25,
		cacheRead: 0.5,
		cacheWrite: 6.25,
	},
	"claude-opus-4-6": {
		input: 5,
		output: 25,
		cacheRead: 0.5,
		cacheWrite: 6.25,
	},
	"claude-opus-4": {
		input: 15,
		output: 75,
		cacheRead: 1.5,
		cacheWrite: 18.75,
	},
	"claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	"claude-haiku-4": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	"claude-3-5-haiku": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
	"gpt-5.6-sol": {
		input: 5,
		output: 30,
		cacheRead: 0.5,
		cacheWrite: 6.25,
	},
	"gpt-5.6-terra": {
		input: 2,
		output: 12,
		cacheRead: 0.2,
		cacheWrite: 2.5,
	},
	"gpt-5.6-luna": {
		input: 0.2,
		output: 1.2,
		cacheRead: 0.02,
		cacheWrite: 0.25,
	},
	"gpt-5.6": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
	"gpt-5.5": {
		input: 5,
		output: 30,
		cacheRead: 0.5,
		cacheWrite: 5,
	},
	"gpt-5.4": {
		input: 2.5,
		output: 15,
		cacheRead: 0.25,
		cacheWrite: 2.5,
	},
	"gpt-5.3-codex": {
		input: 1.75,
		output: 14,
		cacheRead: 0.175,
		cacheWrite: 1.75,
	},
	"gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
	"kindle-alpha": {
		input: 1.25,
		output: 10,
		cacheRead: 0.125,
		cacheWrite: 0,
	},
	"codex-auto-review": {
		input: 1.25,
		output: 10,
		cacheRead: 0.125,
		cacheWrite: 0,
	},
};

const SLUGS_BY_LENGTH = Object.keys(PRICING).sort(
	(a, b) => b.length - a.length,
);

function matchesFamily(slug: string, family: string): boolean {
	return (
		slug.startsWith(family) &&
		(slug.length === family.length || /[-_@:.]/.test(slug[family.length] ?? ""))
	);
}

export function lookupPricing(model: string): ModelPricing | undefined {
	const normalized = model.trim().toLowerCase();
	const slug = normalized.slice(normalized.lastIndexOf("/") + 1);
	const direct = PRICING[slug];
	if (direct) return direct;
	const family = SLUGS_BY_LENGTH.find((candidate) =>
		matchesFamily(slug, candidate),
	);
	return family ? PRICING[family] : undefined;
}

export function calculateCostUsd(
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWrite5mTokens: number;
		cacheWrite1hTokens: number;
	},
	pricing: ModelPricing,
): number {
	const perMillion =
		usage.inputTokens * pricing.input +
		usage.outputTokens * pricing.output +
		usage.cacheReadTokens * pricing.cacheRead +
		usage.cacheWrite5mTokens * pricing.cacheWrite +
		usage.cacheWrite1hTokens * pricing.input * CACHE_WRITE_1H_INPUT_MULTIPLIER;
	return perMillion / 1_000_000;
}

export function calculateCacheSavingsUsd(
	cacheReadTokens: number,
	pricing: ModelPricing,
): number {
	return (
		(cacheReadTokens * Math.max(0, pricing.input - pricing.cacheRead)) /
		1_000_000
	);
}
