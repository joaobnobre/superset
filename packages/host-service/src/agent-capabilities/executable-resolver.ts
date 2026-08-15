import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
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

async function isPackageManagerWrapper(path: string): Promise<boolean> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		const buffer = Buffer.alloc(8 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const source = buffer.subarray(0, bytesRead).toString("utf8");
		return (
			/^package="[^"]+"$/m.test(source) && /^command="[^"]+"$/m.test(source)
		);
	} catch {
		return false;
	} finally {
		await handle?.close();
	}
}

const MACH_O_AND_FAT_MAGICS = new Set([
	0xcafebabe, // FAT_MAGIC
	0xbebafeca, // FAT_CIGAM
	0xcafebabf, // FAT_MAGIC_64
	0xbfbafeca, // FAT_CIGAM_64
	0xfeedface, // MH_MAGIC
	0xcefaedfe, // MH_CIGAM
	0xfeedfacf, // MH_MAGIC_64
	0xcffaedfe, // MH_CIGAM_64
]);

export function isNativeExecutableMagic(bytes: Uint8Array): boolean {
	if (
		bytes.length >= 4 &&
		bytes[0] === 0x7f &&
		bytes[1] === 0x45 &&
		bytes[2] === 0x4c &&
		bytes[3] === 0x46
	) {
		return true;
	}
	if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return true;
	if (bytes.length < 4) return false;
	return MACH_O_AND_FAT_MAGICS.has(
		Buffer.from(bytes.subarray(0, 4)).readUInt32BE(0),
	);
}

async function isNativeExecutable(path: string): Promise<boolean> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		const bytes = Buffer.alloc(4);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		return isNativeExecutableMagic(bytes.subarray(0, bytesRead));
	} catch {
		return false;
	} finally {
		await handle?.close();
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
	const executableCandidates: string[] = [];
	for (const candidate of candidates) {
		if (await isExecutable(candidate)) executableCandidates.push(candidate);
	}
	if (executableCandidates.length === 0) return null;

	const firstCandidate = executableCandidates[0];
	if (!firstCandidate) return null;
	if (explicit) {
		return { path: firstCandidate, source: "explicit" };
	}
	if (await isNativeExecutable(firstCandidate)) {
		return { path: firstCandidate, source: "path" };
	}
	if (!(await isPackageManagerWrapper(firstCandidate))) {
		return { path: firstCandidate, source: "path" };
	}

	for (const candidate of executableCandidates.slice(1)) {
		if (await isNativeExecutable(candidate)) {
			return { path: candidate, source: "path" };
		}
	}
	return { path: firstCandidate, source: "wrapper" };
}
