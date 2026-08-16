import { constants } from "node:fs";
import { access } from "node:fs/promises";
import {
	extname,
	isAbsolute,
	join,
	resolve,
	delimiter as systemPathDelimiter,
} from "node:path";

export type AgentExecutableSource = "explicit" | "path" | "wrapper";

export interface ResolvedAgentExecutable {
	path: string;
	source: AgentExecutableSource;
}

interface ResolveAgentExecutableOptions {
	pathDelimiter?: string;
	platform?: NodeJS.Platform;
}

function executableNames(
	command: string,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
): string[] {
	if (platform !== "win32" || extname(command) !== "") return [command];
	const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.filter(Boolean);
	return [command, ...extensions.map((extension) => `${command}${extension}`)];
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export async function resolveAgentExecutable(
	command: string,
	env: NodeJS.ProcessEnv,
	options: ResolveAgentExecutableOptions = {},
): Promise<ResolvedAgentExecutable | null> {
	const platform = options.platform ?? process.platform;
	const pathDelimiter = options.pathDelimiter ?? systemPathDelimiter;
	const explicit =
		isAbsolute(command) || command.includes("/") || command.includes("\\");
	const names = executableNames(command, env, platform);
	const candidates = explicit
		? names.map((name) => resolve(name))
		: (env.PATH ?? "")
				.split(pathDelimiter)
				.filter(Boolean)
				.flatMap((directory) => names.map((name) => join(directory, name)));
	if (explicit) {
		for (const candidate of candidates) {
			if (await isExecutable(candidate)) {
				return { path: candidate, source: "explicit" };
			}
		}
		return null;
	}

	for (const candidate of candidates) {
		if (await isExecutable(candidate))
			return { path: candidate, source: "path" };
	}
	return null;
}
