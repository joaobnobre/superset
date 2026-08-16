export function formatTokens(value: number): string {
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
	if (value >= 100_000_000) return `${(value / 1_000_000).toFixed(0)}M`;
	if (value >= 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
	if (value >= 100_000) return `${(value / 1_000).toFixed(0)}K`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return Math.round(value).toLocaleString();
}

export function formatUsd(value: number): string {
	if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

export function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

export function formatUsagePeriod(startAt: number, endAt: number): string {
	const formatter = new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
	});
	return `${formatter.format(startAt)}–${formatter.format(endAt)}`;
}

export function formatResetAt(resetsAt: number | null): string | null {
	if (resetsAt === null) return null;
	const remainingMs = resetsAt - Date.now();
	if (remainingMs <= 0) return "resets soon";
	const remainingMinutes = Math.ceil(remainingMs / 60_000);
	if (remainingMinutes < 60) return `in ${remainingMinutes}m`;
	const remainingHours = Math.ceil(remainingMinutes / 60);
	if (remainingHours < 48) return `in ${remainingHours}h`;
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
	}).format(resetsAt);
}

export function formatActivityAge(timestamp: number | null): string {
	if (timestamp === null) return "No activity";
	const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
	if (minutes < 1) return "Active now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}
