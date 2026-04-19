/**
 * memory_remember tool — Store an important fact, decision, or preference.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";

export function registerRememberTool(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
) {
	pi.registerTool({
		name: "memory_remember",
		label: "Memory Remember",
		description:
			"Store an important fact, decision, preference, or instruction as a persistent memory for future sessions.",
		promptSnippet: "Store a fact, decision, or preference as a persistent memory",
		promptGuidelines: [
			"Use memory_remember when the user states a preference or makes an important decision.",
			"Use memory_remember for architectural decisions, coding conventions, or project patterns.",
			"Store memories as clear, atomic statements.",
		],
		parameters: Type.Object({
			content: Type.String({
				description: "The memory to store — a clear, self-contained statement",
			}),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("global")], {
					description: "'project' (default) or 'global' (user-wide preference)",
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const client = getClient();
			const config = getConfig();
			if (!client || !config) throw new Error("Not configured. Run /memory-setup first.");

			const scope = params.scope ?? "project";
			const instance = scope === "global" ? config.globalMemoryInstance : config.projectMemoryInstance;

			const res = await client.remember(instance, params.content, { scope }, signal);

			return {
				content: [{ type: "text", text: `✓ Remembered (${scope}): ${params.content}` }],
				details: { content: params.content, scope, id: res.id } as Record<string, unknown>,
			};
		},
	});
}
