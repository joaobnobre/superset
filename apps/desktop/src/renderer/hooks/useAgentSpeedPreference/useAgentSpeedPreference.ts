import { getAgentSpeedSupport } from "@superset/shared/agent-models";
import { useCallback, useEffect, useState } from "react";

function readStoredMap(storageKey: string): Record<string, string> {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.localStorage.getItem(storageKey);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
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

function readStoredSpeed(
	storageKey: string,
	presetId: string | null,
	model: string | null,
): string | null {
	if (!presetId) return null;
	const support = getAgentSpeedSupport(presetId, model);
	if (!support) return null;
	const preferenceKey = model ? `${presetId}:${model}` : presetId;
	const stored =
		readStoredMap(storageKey)[preferenceKey] ?? support.defaultSpeedId;
	return support.speeds.some((speed) => speed.id === stored)
		? (stored ?? null)
		: (support.defaultSpeedId ?? null);
}

export function useAgentSpeedPreference(
	storageKey: string,
	presetId: string | null,
	model: string | null,
) {
	const [selectedSpeed, setSelectedSpeedState] = useState<string | null>(() =>
		readStoredSpeed(storageKey, presetId, model),
	);

	useEffect(() => {
		setSelectedSpeedState(readStoredSpeed(storageKey, presetId, model));
	}, [storageKey, presetId, model]);

	const setSelectedSpeed = useCallback(
		(speed: string | null) => {
			setSelectedSpeedState(speed);
			if (typeof window === "undefined" || !presetId || !speed) return;
			const map = readStoredMap(storageKey);
			const preferenceKey = model ? `${presetId}:${model}` : presetId;
			map[preferenceKey] = speed;
			try {
				window.localStorage.setItem(storageKey, JSON.stringify(map));
			} catch {
				// The active selection still applies when persistence is unavailable.
			}
		},
		[storageKey, presetId, model],
	);

	return { selectedSpeed, setSelectedSpeed };
}
