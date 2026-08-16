import { getAgentModeSupport } from "@superset/shared/agent-models";
import { useCallback, useEffect, useState } from "react";

function readStoredMap(storageKey: string): Record<string, string> {
	if (typeof window === "undefined") return {};
	try {
		const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}");
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed)
		) {
			return {};
		}
		return Object.fromEntries(
			Object.entries(parsed).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		);
	} catch {
		return {};
	}
}

function readStoredMode(
	storageKey: string,
	presetId: string | null,
): string | null {
	if (!presetId) return null;
	const support = getAgentModeSupport(presetId);
	const stored = readStoredMap(storageKey)[presetId];
	return support?.modes.some((mode) => mode.id === stored) ? stored : null;
}

export function useAgentModePreference(
	storageKey: string,
	presetId: string | null,
) {
	const [selectedMode, setSelectedModeState] = useState<string | null>(() =>
		readStoredMode(storageKey, presetId),
	);

	useEffect(() => {
		setSelectedModeState(readStoredMode(storageKey, presetId));
	}, [storageKey, presetId]);

	const setSelectedMode = useCallback(
		(mode: string | null) => {
			setSelectedModeState(mode);
			if (typeof window === "undefined" || !presetId) return;
			const map = readStoredMap(storageKey);
			if (mode) map[presetId] = mode;
			else delete map[presetId];
			try {
				window.localStorage.setItem(storageKey, JSON.stringify(map));
			} catch {
				// The active selection still applies when persistence is unavailable.
			}
		},
		[storageKey, presetId],
	);

	return { selectedMode, setSelectedMode };
}
