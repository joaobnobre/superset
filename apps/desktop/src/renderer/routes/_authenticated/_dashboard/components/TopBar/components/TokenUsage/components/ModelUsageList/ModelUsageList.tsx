import {
	claudeIcon,
	codexIcon,
	codexWhiteIcon,
} from "@superset/ui/icons/preset-icons";
import { cn } from "@superset/ui/lib/utils";
import { formatPercent, formatTokens, formatUsd } from "../../formatters";
import type { UsageModel, UsageProvider } from "../../types";

export function ModelUsageList({
	models,
	provider,
	totalCostUsd,
}: {
	models: UsageModel[];
	provider: UsageProvider;
	totalCostUsd: number;
}) {
	return (
		<table className="w-full table-fixed text-[11px]">
			<thead>
				<tr className="border-b border-border/70 text-left text-muted-foreground">
					<th className="w-auto py-2 font-normal">Model</th>
					<th className="w-24 py-2 text-right font-normal">Cost</th>
					<th className="w-20 py-2 text-right font-normal">Share</th>
					<th className="w-20 py-2 text-right font-normal">Tokens</th>
				</tr>
			</thead>
			<tbody>
				{models.length === 0 ? (
					<tr>
						<td colSpan={4} className="py-6 text-center text-muted-foreground">
							No activity in this window.
						</td>
					</tr>
				) : (
					models.map((model) => (
						<tr
							key={model.model}
							className="border-b border-border/40 last:border-0"
						>
							<td className="min-w-0 py-2 text-foreground">
								<span className="flex min-w-0 items-center gap-2">
									{provider === "codex" ? (
										<span className="relative inline-flex size-3.5 shrink-0">
											<img
												alt=""
												src={codexIcon}
												className="size-3.5 dark:hidden"
											/>
											<img
												alt=""
												src={codexWhiteIcon}
												className="hidden size-3.5 dark:block"
											/>
										</span>
									) : (
										<img
											alt=""
											src={claudeIcon}
											className="size-3.5 shrink-0"
										/>
									)}
									<span className="truncate">{model.model}</span>
								</span>
							</td>
							<td
								className={cn(
									"py-2 text-right tabular-nums",
									model.pricingKnown
										? "text-foreground"
										: "text-muted-foreground",
								)}
							>
								{model.pricingKnown ? formatUsd(model.costUsd) : "$0.00"}
							</td>
							<td className="py-2 text-right text-muted-foreground tabular-nums">
								{formatPercent(
									totalCostUsd > 0 ? model.costUsd / totalCostUsd : 0,
								)}
							</td>
							<td className="py-2 text-right text-muted-foreground tabular-nums">
								{formatTokens(model.totalTokens)}
							</td>
						</tr>
					))
				)}
			</tbody>
		</table>
	);
}
