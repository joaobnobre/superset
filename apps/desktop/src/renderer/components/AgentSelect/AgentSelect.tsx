import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { cn } from "@superset/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import {
	getPresetIcon,
	useIsDarkTheme,
} from "renderer/assets/app-icons/preset-icons";

const CONFIGURE_AGENTS_VALUE = "__configure_agents__";

// v1 callers' `id` doubles as the icon key. v2 ids are UUIDs, so v2 callers
// pass `iconId: presetId` to keep the preset-keyed icon lookup working.
export interface AgentSelectAgent {
	id: string;
	label: string;
	iconId?: string;
	disabled?: boolean;
	/** Host preset slug ("claude", "custom", …) — stable across hosts and DB re-seeds, unlike `id`. */
	presetId?: string;
}

interface AgentSelectProps<T extends string> {
	agents: AgentSelectAgent[];
	value?: T;
	placeholder: string;
	onValueChange: (value: T) => void;
	onBeforeConfigureAgents?: () => void;
	disabled?: boolean;
	triggerClassName?: string;
	contentClassName?: string;
	iconClassName?: string;
	allowNone?: boolean;
	noneLabel?: string;
	noneValue?: T;
}

export function AgentSelect<T extends string>({
	agents,
	value,
	placeholder,
	onValueChange,
	onBeforeConfigureAgents,
	disabled,
	triggerClassName,
	contentClassName,
	iconClassName = "size-3.5 object-contain",
	allowNone = false,
	noneLabel = "No agent",
	noneValue,
}: AgentSelectProps<T>) {
	const navigate = useNavigate();
	const isDark = useIsDarkTheme();
	const selectableIds = new Set<string>(
		agents.filter((agent) => !agent.disabled).map((agent) => agent.id),
	);
	const selectedValue =
		value != null &&
		((allowNone && value === noneValue) || selectableIds.has(value))
			? value
			: undefined;
	const showSeparator = (allowNone || agents.length > 0) && !disabled;

	const handleValueChange = (nextValue: string) => {
		if (nextValue === CONFIGURE_AGENTS_VALUE) {
			onBeforeConfigureAgents?.();
			void navigate({ to: "/settings/agents" });
			return;
		}

		onValueChange(nextValue as T);
	};

	return (
		<Select
			value={selectedValue ?? ""}
			onValueChange={handleValueChange}
			disabled={disabled}
		>
			<SelectTrigger className={triggerClassName}>
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent className={contentClassName} collisionPadding={48}>
				{allowNone && noneValue != null && (
					<SelectItem value={noneValue}>{noneLabel}</SelectItem>
				)}
				{agents.map((agent) => {
					const iconId = agent.iconId ?? agent.id;
					const icon = getPresetIcon(iconId, isDark);
					return (
						<SelectItem
							key={agent.id}
							value={agent.id}
							disabled={agent.disabled}
						>
							<span className="flex items-center gap-2">
								{icon && (
									<img
										src={icon}
										alt=""
										className={cn(
											iconClassName,
											iconId === "codex" && "scale-[1.35]",
										)}
									/>
								)}
								{agent.label}
							</span>
						</SelectItem>
					);
				})}
				{showSeparator && <SelectSeparator />}
				<SelectItem value={CONFIGURE_AGENTS_VALUE}>
					Configure agents...
				</SelectItem>
			</SelectContent>
		</Select>
	);
}
