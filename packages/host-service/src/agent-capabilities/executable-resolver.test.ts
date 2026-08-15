import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	isNativeExecutableMagic,
	resolveAgentExecutable,
} from "./executable-resolver";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "superset-resolver-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeExecutable(
	path: string,
	contents: string | Uint8Array = "#!/bin/sh\nexit 0\n",
) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, contents);
	await chmod(path, 0o755);
}

describe("resolveAgentExecutable", () => {
	test("resolves an explicit executable path containing spaces", async () => {
		const directory = await createTemporaryDirectory();
		const executable = join(directory, "agent tools", "my agent");
		await writeExecutable(executable);

		await expect(resolveAgentExecutable(executable, {})).resolves.toEqual({
			path: executable,
			source: "explicit",
		});
	});

	test("resolves commands from PATH", async () => {
		const directory = await createTemporaryDirectory();
		const executable = join(directory, "agent");
		await writeExecutable(executable);

		await expect(
			resolveAgentExecutable("agent", { PATH: directory }),
		).resolves.toEqual({ path: executable, source: "path" });
	});

	test("identifies a Linux Omarchy package wrapper", async () => {
		const directory = await createTemporaryDirectory();
		const wrapper = join(directory, "pi");
		await writeExecutable(
			wrapper,
			'#!/bin/sh\npackage="@mariozechner/pi-coding-agent"\ncommand="pi"\n',
		);

		await expect(
			resolveAgentExecutable(
				"pi",
				{ PATH: directory },
				{ pathDelimiter: ":", platform: "linux" },
			),
		).resolves.toEqual({ path: wrapper, source: "wrapper" });
	});

	test("recognizes ELF, PE, and both-endian Mach-O and fat magics", () => {
		expect(isNativeExecutableMagic(Uint8Array.of(0x7f, 0x45, 0x4c, 0x46))).toBe(
			true,
		);
		expect(isNativeExecutableMagic(Uint8Array.of(0x4d, 0x5a, 0x90, 0x00))).toBe(
			true,
		);
		expect(isNativeExecutableMagic(Uint8Array.of(0xfe, 0xed, 0xfa, 0xce))).toBe(
			true,
		);
		expect(isNativeExecutableMagic(Uint8Array.of(0xfe, 0xed, 0xfa, 0xcf))).toBe(
			true,
		);
		expect(isNativeExecutableMagic(Uint8Array.of(0xce, 0xfa, 0xed, 0xfe))).toBe(
			true,
		);
		expect(isNativeExecutableMagic(Uint8Array.of(0xcf, 0xfa, 0xed, 0xfe))).toBe(
			true,
		);
		expect(isNativeExecutableMagic(Uint8Array.of(0xca, 0xfe, 0xba, 0xbe))).toBe(
			true,
		);
		expect(isNativeExecutableMagic(Uint8Array.of(0xbe, 0xba, 0xfe, 0xca))).toBe(
			true,
		);
		expect(isNativeExecutableMagic(Uint8Array.of(0xca, 0xfe, 0xba, 0xbf))).toBe(
			true,
		);
		expect(isNativeExecutableMagic(Uint8Array.of(0xbf, 0xba, 0xfe, 0xca))).toBe(
			true,
		);
		expect(isNativeExecutableMagic(Uint8Array.of(0x23, 0x21, 0x2f, 0x62))).toBe(
			false,
		);
	});

	test("uses the first native PATH candidate before a later wrapper", async () => {
		const directory = await createTemporaryDirectory();
		const nativeDirectory = join(directory, "native");
		const wrapperDirectory = join(directory, "wrapper");
		const native = join(nativeDirectory, "agent");
		const wrapper = join(wrapperDirectory, "agent");
		await writeExecutable(native, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
		await writeExecutable(
			wrapper,
			'#!/bin/sh\npackage="@example/agent"\ncommand="agent"\n',
		);

		await expect(
			resolveAgentExecutable(
				"agent",
				{ PATH: `${nativeDirectory}:${wrapperDirectory}` },
				{ pathDelimiter: ":", platform: "darwin" },
			),
		).resolves.toEqual({ path: native, source: "path" });
	});

	test("skips a recognized wrapper only for a later native executable", async () => {
		const directory = await createTemporaryDirectory();
		const wrapperDirectory = join(directory, "wrapper");
		const nativeDirectory = join(directory, "native");
		const wrapper = join(wrapperDirectory, "agent");
		const native = join(nativeDirectory, "agent");
		await writeExecutable(
			wrapper,
			'#!/bin/sh\npackage="@example/agent"\ncommand="agent"\n',
		);
		await writeExecutable(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));

		await expect(
			resolveAgentExecutable(
				"agent",
				{ PATH: `${wrapperDirectory}:${nativeDirectory}` },
				{ pathDelimiter: ":", platform: "linux" },
			),
		).resolves.toEqual({ path: native, source: "path" });
	});

	test("does not prefer a later native over an earlier ordinary script", async () => {
		const directory = await createTemporaryDirectory();
		const scriptDirectory = join(directory, "script");
		const nativeDirectory = join(directory, "native");
		const script = join(scriptDirectory, "agent");
		const native = join(nativeDirectory, "agent");
		await writeExecutable(script, "#!/bin/sh\nexit 0\n");
		await writeExecutable(native, Buffer.from([0xfe, 0xed, 0xfa, 0xcf]));

		await expect(
			resolveAgentExecutable(
				"agent",
				{ PATH: `${scriptDirectory}:${nativeDirectory}` },
				{ pathDelimiter: ":", platform: "darwin" },
			),
		).resolves.toEqual({ path: script, source: "path" });
	});

	test("keeps a recognized wrapper when no later native exists", async () => {
		const directory = await createTemporaryDirectory();
		const wrapperDirectory = join(directory, "wrapper");
		const scriptDirectory = join(directory, "script");
		const wrapper = join(wrapperDirectory, "agent");
		const script = join(scriptDirectory, "agent");
		await writeExecutable(
			wrapper,
			'#!/bin/sh\npackage="@example/agent"\ncommand="agent"\n',
		);
		await writeExecutable(script, "#!/bin/sh\nexit 0\n");

		await expect(
			resolveAgentExecutable(
				"agent",
				{ PATH: `${wrapperDirectory}:${scriptDirectory}` },
				{ pathDelimiter: ":", platform: "linux" },
			),
		).resolves.toEqual({ path: wrapper, source: "wrapper" });
	});

	test("finds Windows cmd shims through PATHEXT", async () => {
		const directory = await createTemporaryDirectory();
		const executable = join(directory, "agent.CMD");
		await writeExecutable(executable);

		await expect(
			resolveAgentExecutable(
				"agent",
				{ PATH: directory, PATHEXT: ".CMD" },
				{ pathDelimiter: ";", platform: "win32" },
			),
		).resolves.toEqual({ path: executable, source: "path" });
	});

	test("skips a Windows CMD wrapper only for a later native PE binary", async () => {
		const directory = await createTemporaryDirectory();
		const wrapperDirectory = join(directory, "wrapper");
		const nativeDirectory = join(directory, "native");
		const wrapper = join(wrapperDirectory, "agent.CMD");
		const native = join(nativeDirectory, "agent.CMD");
		await writeExecutable(
			wrapper,
			'@echo off\npackage="@example/agent"\ncommand="agent"\n',
		);
		await writeExecutable(native, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));

		await expect(
			resolveAgentExecutable(
				"agent",
				{ PATH: `${wrapperDirectory};${nativeDirectory}`, PATHEXT: ".CMD" },
				{ pathDelimiter: ";", platform: "win32" },
			),
		).resolves.toEqual({ path: native, source: "path" });
	});
});
