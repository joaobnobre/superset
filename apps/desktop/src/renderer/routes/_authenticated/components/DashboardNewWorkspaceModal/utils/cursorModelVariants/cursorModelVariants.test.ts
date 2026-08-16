import { describe, expect, test } from "bun:test";
import type { AgentModelSupport } from "@superset/shared/agent-models";
import {
	buildCursorModelSupport,
	buildCursorVariantSupports,
	type CursorRuntimeModel,
	resolveCursorVariant,
} from "./cursorModelVariants";

const transport: AgentModelSupport = {
	presetId: "cursor-agent",
	modelFlag: "--model",
	models: [],
};

const models: CursorRuntimeModel[] = [
	{
		id: "gpt-5.6-sol-medium",
		label: "GPT-5.6 Sol 1M",
		provider: "OpenAI",
		variant: {
			familyId: "gpt-5.6-sol",
			familyLabel: "GPT-5.6 Sol",
			effort: "medium",
			speed: "standard",
			mode: "standard",
			contextWindow: "1m",
		},
	},
	{
		id: "gpt-5.6-sol-medium-fast",
		label: "GPT-5.6 Sol Fast",
		provider: "OpenAI",
		variant: {
			familyId: "gpt-5.6-sol",
			familyLabel: "GPT-5.6 Sol",
			effort: "medium",
			speed: "fast",
			mode: "standard",
			contextWindow: "default",
		},
	},
	{
		id: "gpt-5.6-sol-high",
		label: "GPT-5.6 Sol 1M High",
		provider: "OpenAI",
		variant: {
			familyId: "gpt-5.6-sol",
			familyLabel: "GPT-5.6 Sol",
			effort: "high",
			speed: "standard",
			mode: "standard",
			contextWindow: "1m",
		},
	},
	{
		id: "composer-2.5",
		label: "Composer 2.5",
		provider: "Cursor",
		variant: {
			familyId: "composer-2.5",
			familyLabel: "Composer 2.5",
			effort: "default",
			speed: "standard",
			mode: "standard",
			contextWindow: "default",
		},
	},
];

describe("Cursor model variants", () => {
	test("collapses exact ids into provider-grouped model families", () => {
		expect(buildCursorModelSupport(transport, models)).toMatchObject({
			defaultModelId: "gpt-5.6-sol",
			models: [
				{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "OpenAI" },
				{ id: "composer-2.5", label: "Composer 2.5", provider: "Cursor" },
			],
		});
		expect(
			buildCursorModelSupport(transport, models).modelAliases?.[
				"gpt-5.6-sol-medium-fast"
			],
		).toBe("gpt-5.6-sol");
	});

	test("derives only dimensions with multiple account-available choices", () => {
		const supports = buildCursorVariantSupports(models.slice(0, 3));
		expect(supports.effort?.efforts.map((option) => option.id)).toEqual([
			"medium",
			"high",
		]);
		expect(supports.speed?.speeds.map((option) => option.id)).toEqual([
			"standard",
			"fast",
		]);
		expect(
			supports.contextWindow?.contextWindows.map((option) => option.id),
		).toEqual(["default", "1m"]);
		expect(supports.mode).toBeUndefined();
	});

	test("prioritizes the changed dimension without inventing a combination", () => {
		expect(
			resolveCursorVariant(
				models.slice(0, 3),
				{
					effort: "medium",
					speed: "fast",
					contextWindow: "1m",
				},
				"speed",
			)?.id,
		).toBe("gpt-5.6-sol-medium-fast");
	});

	test("keeps an unsuffixed runtime id as an explicit default effort", () => {
		const defaultModels: CursorRuntimeModel[] = [
			{
				id: "gpt-5.2-low",
				label: "GPT-5.2 Low",
				variant: {
					familyId: "gpt-5.2",
					familyLabel: "GPT-5.2",
					effort: "low",
					speed: "standard",
					mode: "standard",
					contextWindow: "default",
				},
			},
			{
				id: "gpt-5.2",
				label: "GPT-5.2",
				variant: {
					familyId: "gpt-5.2",
					familyLabel: "GPT-5.2",
					effort: "default",
					speed: "standard",
					mode: "standard",
					contextWindow: "default",
				},
			},
			{
				id: "gpt-5.2-high",
				label: "GPT-5.2 High",
				variant: {
					familyId: "gpt-5.2",
					familyLabel: "GPT-5.2",
					effort: "high",
					speed: "standard",
					mode: "standard",
					contextWindow: "default",
				},
			},
		];

		expect(buildCursorVariantSupports(defaultModels).effort).toMatchObject({
			defaultEffortId: "default",
			efforts: [
				{ id: "default", label: "Default" },
				{ id: "low", label: "Low" },
				{ id: "high", label: "High" },
			],
		});
		expect(
			resolveCursorVariant(
				defaultModels,
				{
					effort: "default",
					speed: "standard",
					mode: "standard",
					contextWindow: "default",
				},
				"effort",
			)?.id,
		).toBe("gpt-5.2");
	});

	test("selects a runtime default effort without treating it as absent", () => {
		const grokModels: CursorRuntimeModel[] = [
			{
				id: "cursor-grok-4.6-high-fast",
				label: "Cursor Grok 4.6 Fast",
				variant: {
					familyId: "cursor-grok-4.6",
					familyLabel: "Cursor Grok 4.6",
					effort: "high",
					speed: "fast",
					mode: "standard",
					contextWindow: "default",
				},
			},
			{
				id: "cursor-grok-4.6-low",
				label: "Cursor Grok 4.6 Low",
				variant: {
					familyId: "cursor-grok-4.6",
					familyLabel: "Cursor Grok 4.6",
					effort: "low",
					speed: "standard",
					mode: "standard",
					contextWindow: "default",
				},
			},
			{
				id: "cursor-grok-4.6-high",
				label: "Cursor Grok 4.6",
				variant: {
					familyId: "cursor-grok-4.6",
					familyLabel: "Cursor Grok 4.6",
					effort: "high",
					speed: "standard",
					mode: "standard",
					contextWindow: "default",
				},
			},
		];

		expect(buildCursorVariantSupports(grokModels).speed).toMatchObject({
			defaultSpeedId: "standard",
		});
		expect(
			resolveCursorVariant(
				grokModels,
				{
					effort: "high",
					speed: "standard",
					mode: "standard",
					contextWindow: "default",
				},
				"effort",
			)?.id,
		).toBe("cursor-grok-4.6-high");
	});
});
