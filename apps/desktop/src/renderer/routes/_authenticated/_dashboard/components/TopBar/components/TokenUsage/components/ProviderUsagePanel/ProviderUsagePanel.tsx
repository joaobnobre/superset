import { useState } from "react";
import {
	formatActivityAge,
	formatPercent,
	formatTokens,
	formatUsd,
} from "../../formatters";
import type { ProviderUsage } from "../../types";
import { DayUsageList } from "../DayUsageList";
import { ModelUsageList } from "../ModelUsageList";
import { UsageLimitMeters } from "../UsageLimitMeters";

export function ProviderUsagePanel({
	usage,
	periodLabel,
}: {
	usage: ProviderUsage;
	periodLabel: string;
}) {
	const [breakdown, setBreakdown] = useState<"model" | "day">("model");
	const observedInput = usage.tokens.inputTokens + usage.tokens.cacheReadTokens;
	const cachedShare =
		observedInput > 0 ? usage.tokens.cacheReadTokens / observedInput : 0;
	const savingsRatio =
		usage.costUsd > 0 ? usage.cacheSavingsUsd / usage.costUsd : 0;
	const perActiveDay =
		usage.activeDays > 0 ? usage.totalTokens / usage.activeDays : 0;
	const metrics = [
		{
			label: "Processed tokens",
			value: formatTokens(usage.totalTokens),
			detail: `${formatTokens(perActiveDay)} per active day`,
		},
		{
			label: "Cached input",
			value: formatTokens(usage.tokens.cacheReadTokens),
			detail: `${formatPercent(cachedShare)} of observed input`,
		},
		{
			label: "Uncached input",
			value: formatTokens(usage.tokens.inputTokens),
			detail: `${formatTokens(usage.tokens.cacheWriteTokens)} cache writes`,
		},
		{
			label: "Output",
			value: formatTokens(usage.tokens.outputTokens),
			detail: `includes ${formatTokens(usage.tokens.reasoningTokens)} reasoning`,
		},
		{
			label: "Cache savings",
			value: formatUsd(usage.cacheSavingsUsd),
			detail:
				usage.costUsd > 0
					? `${savingsRatio.toFixed(1)}x the raw token cost`
					: "vs full input rates",
		},
	];

	return (
		<div className="max-h-[72vh] overflow-y-auto">
			{!usage.available ? (
				<div className="border-b border-border/60 bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
					No local {usage.provider === "codex" ? "Codex" : "Claude Code"}{" "}
					transcripts found.
				</div>
			) : null}

			<div className="grid grid-cols-[13rem_minmax(0,1fr)] border-b border-border/70">
				<div className="flex flex-col justify-center px-4 py-3">
					<div>
						<span className="block text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
							Raw token cost
						</span>
						<span className="mt-0.5 block text-3xl font-semibold tracking-tight text-foreground tabular-nums">
							{formatUsd(usage.costUsd)}*
						</span>
						<div className="mt-1 text-[10px] leading-4 text-muted-foreground/70">
							If billed at full API rate · {periodLabel.toLowerCase()}
							<br />
							{usage.sessions.toLocaleString()} sessions ·{" "}
							{formatActivityAge(usage.latestActivityAt)}
						</div>
					</div>
				</div>
				<div className="border-l border-border/50 px-4 py-3">
					<div className="mb-2 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
						Account limits
					</div>
					<UsageLimitMeters provider={usage.provider} windows={usage.windows} />
				</div>
			</div>

			<div className="grid grid-cols-5 gap-px border-b border-border/70 bg-border/70">
				{metrics.map((metric) => (
					<div key={metric.label} className="min-w-0 bg-popover px-3 py-3">
						<div className="text-[10px] leading-3 text-muted-foreground">
							{metric.label}
						</div>
						<div className="mt-1 text-base text-foreground tabular-nums">
							{metric.value}
						</div>
						<div className="mt-0.5 min-h-7 text-[10px] leading-3.5 text-muted-foreground/75">
							{metric.detail}
						</div>
					</div>
				))}
			</div>

			<section className="px-4 py-4">
				<div className="mb-2 flex items-center justify-between">
					<h5 className="text-[12px] font-medium text-foreground">Breakdown</h5>
					<div className="flex overflow-hidden rounded-md border border-border text-[9px] uppercase tracking-wide">
						{(["model", "day"] as const).map((option) => (
							<button
								key={option}
								type="button"
								onClick={() => setBreakdown(option)}
								className={
									breakdown === option
										? "bg-muted px-2.5 py-1 text-foreground"
										: "px-2.5 py-1 text-muted-foreground hover:text-foreground"
								}
							>
								{option}
							</button>
						))}
					</div>
				</div>
				{breakdown === "model" ? (
					<ModelUsageList
						models={usage.models}
						provider={usage.provider}
						totalCostUsd={usage.costUsd}
					/>
				) : (
					<DayUsageList days={usage.days} totalCostUsd={usage.costUsd} />
				)}
			</section>
		</div>
	);
}
