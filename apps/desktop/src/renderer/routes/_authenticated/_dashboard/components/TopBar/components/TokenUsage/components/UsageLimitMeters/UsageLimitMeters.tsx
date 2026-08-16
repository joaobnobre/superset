import { cn } from "@superset/ui/lib/utils";
import { formatResetAt } from "../../formatters";
import type { UsageProvider, UsageWindow } from "../../types";

function usageTone(usedPercent: number, provider: UsageProvider): string {
	if (usedPercent >= 95) return "bg-destructive";
	if (usedPercent >= 80) return "bg-amber-500";
	return provider === "codex" ? "bg-sky-500" : "bg-orange-500";
}

export function UsageLimitMeters({
	provider,
	windows,
}: {
	provider: UsageProvider;
	windows: UsageWindow[];
}) {
	if (windows.length === 0) {
		return (
			<div className="rounded-md border border-dashed border-border/60 px-3 py-2.5 text-[11px] leading-4 text-muted-foreground">
				{provider === "claude"
					? "Claude Code does not persist account limits in local transcripts."
					: "No local account-limit snapshot yet."}
			</div>
		);
	}

	return (
		<div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-5 gap-y-3">
			{windows.map((window) => {
				const resetLabel = formatResetAt(window.resetsAt);
				return (
					<div key={window.id} className="space-y-1.5">
						<div className="flex items-baseline gap-2 text-[11px]">
							<span className="w-8 shrink-0 font-medium text-foreground">
								{window.label}
							</span>
							<span className="ml-auto font-mono tabular-nums text-foreground">
								{Math.round(window.usedPercent)}% used
							</span>
							{resetLabel && (
								<span className="text-[10px] tabular-nums text-muted-foreground">
									{resetLabel}
								</span>
							)}
						</div>
						<div
							className="h-1.5 overflow-hidden rounded-full bg-foreground/10 ring-1 ring-inset ring-foreground/10"
							role="progressbar"
							aria-label={`${window.label} ${provider} usage`}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={Math.round(window.usedPercent)}
						>
							<div
								className={cn(
									"h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
									usageTone(window.usedPercent, provider),
								)}
								style={{ width: `${window.usedPercent}%` }}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}
