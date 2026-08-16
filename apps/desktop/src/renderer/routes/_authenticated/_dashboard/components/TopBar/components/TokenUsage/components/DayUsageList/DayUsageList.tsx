import { formatPercent, formatTokens, formatUsd } from "../../formatters";
import type { UsageDay } from "../../types";

export function DayUsageList({
	days,
	totalCostUsd,
}: {
	days: UsageDay[];
	totalCostUsd: number;
}) {
	const dateFormatter = new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
	});

	return (
		<table className="w-full table-fixed text-[11px]">
			<thead>
				<tr className="border-b border-border/70 text-left text-muted-foreground">
					<th className="w-auto py-2 font-normal">Day</th>
					<th className="w-24 py-2 text-right font-normal">Cost</th>
					<th className="w-20 py-2 text-right font-normal">Share</th>
					<th className="w-20 py-2 text-right font-normal">Tokens</th>
				</tr>
			</thead>
			<tbody>
				{days.length === 0 ? (
					<tr>
						<td colSpan={4} className="py-6 text-center text-muted-foreground">
							No activity in this window.
						</td>
					</tr>
				) : (
					days.map((day) => (
						<tr
							key={day.day}
							className="border-b border-border/40 last:border-0"
						>
							<td className="py-2 text-foreground">
								{dateFormatter.format(new Date(`${day.day}T12:00:00`))}
							</td>
							<td className="py-2 text-right text-foreground tabular-nums">
								{formatUsd(day.costUsd)}
							</td>
							<td className="py-2 text-right text-muted-foreground tabular-nums">
								{formatPercent(
									totalCostUsd > 0 ? day.costUsd / totalCostUsd : 0,
								)}
							</td>
							<td className="py-2 text-right text-muted-foreground tabular-nums">
								{formatTokens(day.totalTokens)}
							</td>
						</tr>
					))
				)}
			</tbody>
		</table>
	);
}
