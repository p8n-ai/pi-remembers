/**
 * Resolve the `pi` CLI binary for spawning sub-processes.
 *
 * Resolution order:
 *   1. process.argv[1] — the current pi entry point (most reliable)
 *   2. Package.json bin field from @mariozechner/pi-coding-agent
 *   3. "pi" from PATH (fallback)
 *
 * Adapted from pi-subagents (nicobailon/pi-subagents).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";

const require = createRequire(import.meta.url);

export interface PiSpawnCommand {
	command: string;
	args: string[];
}

function isRunnableNodeScript(filePath: string): boolean {
	if (!existsSync(filePath)) return false;
	return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function resolvePiPackageRoot(): string | undefined {
	try {
		const entry = process.argv[1];
		if (!entry) return undefined;
		let dir = dirname(realpathSync(entry));
		while (dir !== dirname(dir)) {
			try {
				const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
				if (pkg.name === "@mariozechner/pi-coding-agent") return dir;
			} catch {
				/* skip */
			}
			dir = dirname(dir);
		}
	} catch {
		/* skip */
	}
	return undefined;
}

function resolveCliScript(): string | undefined {
	// 1. Try process.argv[1] directly
	const argv1 = process.argv[1];
	if (argv1) {
		const argvPath = isAbsolute(argv1) ? argv1 : resolve(argv1);
		if (isRunnableNodeScript(argvPath)) return argvPath;
	}

	// 2. Try resolving from the pi package
	try {
		const root = resolvePiPackageRoot();
		const packageJsonPath = root
			? join(root, "package.json")
			: require.resolve("@mariozechner/pi-coding-agent/package.json");
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			bin?: string | Record<string, string>;
		};
		const binField = pkg.bin;
		const binPath =
			typeof binField === "string" ? binField : binField?.pi ?? Object.values(binField ?? {})[0];
		if (!binPath) return undefined;
		const candidate = resolve(dirname(packageJsonPath), binPath);
		if (isRunnableNodeScript(candidate)) return candidate;
	} catch {
		/* skip */
	}

	return undefined;
}

/**
 * Build the spawn command + args for invoking `pi`.
 * Returns { command, args } suitable for child_process.spawn().
 */
export function getPiSpawnCommand(args: string[]): PiSpawnCommand {
	const cliScript = resolveCliScript();
	if (cliScript) {
		return { command: process.execPath, args: [cliScript, ...args] };
	}
	// Fallback: rely on `pi` in PATH
	return { command: "pi", args };
}
