export function isAgentChoiceVisible<
	TView extends {
		health: { installed: boolean | null };
	},
>(capability: TView | undefined): boolean {
	return capability?.health.installed !== false;
}

export function isAgentChoiceEnabled<
	TView extends {
		health: {
			installed: boolean | null;
			auth: "authenticated" | "unauthenticated" | "unknown";
			status: "ready" | "unavailable" | "authentication_required" | "unknown";
		};
	},
>(capability: TView | undefined): boolean {
	return (
		capability?.health.installed === true &&
		capability.health.auth === "authenticated" &&
		capability.health.status === "ready"
	);
}

export function getCapabilityDisplayInventory<TInventory>(
	capability:
		| {
				inventory: TInventory;
				health: { installed: boolean | null };
		  }
		| undefined,
): TInventory | null {
	if (!capability || capability.health.installed === false) return null;
	return capability.inventory;
}
