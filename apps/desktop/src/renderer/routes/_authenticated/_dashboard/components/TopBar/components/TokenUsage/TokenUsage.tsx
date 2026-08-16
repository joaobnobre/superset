import { Button } from "@superset/ui/button";
import {
	claudeIcon,
	codexIcon,
	codexWhiteIcon,
} from "@superset/ui/icons/preset-icons";
import { cn } from "@superset/ui/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@superset/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@superset/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useState } from "react";
import { HiOutlineArrowPath, HiOutlineChartBar } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { ProviderUsagePanel } from "./components/ProviderUsagePanel";
import { formatUsagePeriod } from "./formatters";

export function TokenUsage() {
	const [open, setOpen] = useState(false);
	const { data, isFetching, isError, refetch } =
		electronTrpc.tokenUsage.getSnapshot.useQuery(undefined, {
			enabled: open,
			refetchInterval: open ? 60_000 : false,
		});
	const refresh = electronTrpc.tokenUsage.refreshSnapshot.useMutation({
		onSuccess: () => void refetch(),
	});
	const codex = data?.providers.find(
		(provider) => provider.provider === "codex",
	);
	const claude = data?.providers.find(
		(provider) => provider.provider === "claude",
	);
	const loading = isFetching || refresh.isPending;
	const periodText = data
		? `${data.period.label} · ${formatUsagePeriod(data.period.startAt, data.period.endAt)}`
		: "Last 7 days";

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip delayDuration={150}>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="AI usage"
							className="no-drag relative text-muted-foreground hover:text-foreground"
						>
							<HiOutlineChartBar className="size-3.5" />
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent side="bottom" sideOffset={6}>
					Usage
				</TooltipContent>
			</Tooltip>

			<PopoverContent
				align="start"
				className="w-[42rem] max-w-[calc(100vw-2rem)] overflow-hidden p-0"
			>
				<div className="flex items-center justify-between border-b border-border/60 px-3.5 py-3">
					<div>
						<h4 className="text-[13px] font-medium tracking-tight text-foreground">
							Usage
						</h4>
						<p className="mt-0.5 text-[11px] text-muted-foreground">
							Local agent activity · {periodText}
						</p>
					</div>
					<button
						type="button"
						onClick={() => void refresh.mutateAsync()}
						disabled={loading}
						className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
						aria-label="Refresh usage"
					>
						<HiOutlineArrowPath
							className={cn("size-3.5", loading && "animate-spin")}
						/>
					</button>
				</div>

				{!data && !isError ? (
					<div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
						<HiOutlineArrowPath className="size-4 animate-spin" />
						<span className="text-[11px]">Scanning local transcripts…</span>
					</div>
				) : null}
				{isError ? (
					<div className="flex h-32 items-center justify-center px-6 text-center text-[11px] text-muted-foreground">
						Usage data could not be read. Try refreshing.
					</div>
				) : null}

				{data && codex && claude ? (
					<Tabs defaultValue="codex">
						<TabsList className="grid h-9 w-full grid-cols-2 gap-0 rounded-none border-b border-border/60 bg-transparent p-0">
							<TabsTrigger
								value="codex"
								className="h-full gap-2 rounded-none border-b-2 border-transparent text-[11px] data-[state=active]:border-sky-500 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
							>
								<span className="relative inline-flex size-4">
									<img alt="" src={codexIcon} className="size-4 dark:hidden" />
									<img
										alt=""
										src={codexWhiteIcon}
										className="hidden size-4 dark:block"
									/>
								</span>
								Codex
							</TabsTrigger>
							<TabsTrigger
								value="claude"
								className="h-full gap-2 rounded-none border-b-2 border-transparent text-[11px] data-[state=active]:border-orange-500 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
							>
								<img alt="" src={claudeIcon} className="size-4" />
								Claude Code
							</TabsTrigger>
						</TabsList>
						<TabsContent value="codex" className="mt-0">
							<ProviderUsagePanel
								usage={codex}
								periodLabel={data.period.label}
							/>
						</TabsContent>
						<TabsContent value="claude" className="mt-0">
							<ProviderUsagePanel
								usage={claude}
								periodLabel={data.period.label}
							/>
						</TabsContent>
					</Tabs>
				) : null}
			</PopoverContent>
		</Popover>
	);
}
