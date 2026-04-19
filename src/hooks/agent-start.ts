/**
 * Agent start hook — Recall relevant memories before each LLM turn.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";

export function registerAgentStartHook(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
) {
	let lastRecallQuery: string | null = null;
	let cachedRecall: string | null = null;
	let lastRecallTime = 0;
	const RECALL_CACHE_TTL = 60_000;

	pi.on("before_agent_start", async (_event, ctx) => {
		const client = getClient();
		const config = getConfig();
		if (!client || !config || !config.hooks.autoRecall) return;

		// Extract latest user message as recall query
		const entries = ctx.sessionManager.getBranch();
		const lastUser = [...entries]
			.reverse()
			.find((e) => e.type === "message" && e.message.role === "user");

		if (!lastUser || lastUser.type !== "message") return;
		const msg = lastUser.message;
		if (msg.role !== "user" || !("content" in msg)) return;

		const userContent = msg.content;
		let queryText: string;
		if (typeof userContent === "string") {
			queryText = userContent;
		} else if (Array.isArray(userContent)) {
			queryText = userContent
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join(" ");
		} else {
			return;
		}

		if (queryText.length < 10) return;

		const now = Date.now();
		if (queryText === lastRecallQuery && cachedRecall && now - lastRecallTime < RECALL_CACHE_TTL) {
			return {
				message: { customType: "memory-context", content: cachedRecall, display: false },
			};
		}

		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5000);

			const result = await client.recall(
				[config.projectMemoryInstance, config.globalMemoryInstance],
				queryText,
				controller.signal,
			);
			clearTimeout(timeout);

			if (result.count === 0) return;

			const parts: string[] = ["[Recalled from persistent memory]"];
			for (const chunk of result.chunks.slice(0, 5)) {
				parts.push(`• ${chunk.text.slice(0, 300)}`);
			}

			const recallContent = parts.join("\n");
			lastRecallQuery = queryText;
			cachedRecall = recallContent;
			lastRecallTime = now;

			return {
				message: { customType: "memory-context", content: recallContent, display: false },
			};
		} catch {
			return;
		}
	});
}
