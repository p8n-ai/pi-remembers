/**
 * Minimal mock ExtensionAPI — captures registered tools/commands/hooks and lets
 * tests invoke `execute()` directly without booting the real agent.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface MockAPI extends ExtensionAPI {
	_tools: Map<string, any>;
	_commands: Map<string, any>;
	_hooks: Map<string, Function[]>;
	invoke(name: string, params: unknown): Promise<any>;
	trigger(event: string, payload: unknown, ctx?: any): Promise<any[]>;
}

export function makeMockAPI(): MockAPI {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const hooks = new Map<string, Function[]>();

	const api: any = {
		_tools: tools,
		_commands: commands,
		_hooks: hooks,
		registerTool(def: any) {
			tools.set(def.name, def);
		},
		registerCommand(name: string, def: any) {
			commands.set(name, def);
		},
		on(event: string, handler: Function) {
			if (!hooks.has(event)) hooks.set(event, []);
			hooks.get(event)!.push(handler);
		},
		async invoke(name: string, params: unknown) {
			const def = tools.get(name);
			if (!def) throw new Error(`No such tool: ${name}`);
			return def.execute("test-call-id", params, undefined);
		},
		async trigger(event: string, payload: unknown, ctx?: any) {
			const fns = hooks.get(event) ?? [];
			const results = [];
			for (const fn of fns) results.push(await fn(payload, ctx ?? {}));
			return results;
		},
	};
	return api as MockAPI;
}
