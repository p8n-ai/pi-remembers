/**
 * Test helpers — isolated temp dirs, HOME override, deterministic setup.
 *
 * Each test sets `process.env.HOME` to a unique temp dir so global files
 * (pi-remembers.json, pi-remembers-projects.json, pi-remembers-dirty.json)
 * land inside the sandbox and don't leak between tests.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Sandbox {
	home: string;
	workspace: string;
	cleanup: () => void;
}

export function makeSandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "pi-remembers-test-"));
	const home = join(root, "home");
	const workspace = join(root, "work");
	mkdirSync(home, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	const prevHome = process.env.HOME;
	process.env.HOME = home;
	return {
		home,
		workspace,
		cleanup: () => {
			if (prevHome !== undefined) process.env.HOME = prevHome;
			else delete process.env.HOME;
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		},
	};
}

export function mkdir(path: string): string {
	mkdirSync(path, { recursive: true });
	return path;
}

export function writeGlobalConfig(home: string, data: unknown): void {
	mkdirSync(join(home, ".pi"), { recursive: true });
	writeFileSync(join(home, ".pi", "pi-remembers.json"), JSON.stringify(data, null, 2), "utf-8");
}

export function writeProjectMarker(root: string, data: unknown): void {
	mkdirSync(join(root, ".pi"), { recursive: true });
	writeFileSync(join(root, ".pi", "pi-remembers.json"), JSON.stringify(data, null, 2), "utf-8");
}

export function defaultGlobalConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		accountId: "acc_test",
		apiToken: "tok_test",
		namespace: "default",
		globalMemoryInstance: "pi-remembers-global",
		...overrides,
	};
}
