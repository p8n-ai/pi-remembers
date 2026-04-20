/**
 * Mock CloudflareApiClient for tests — no network, in-memory store per instance.
 */

import type { CloudflareApiClient, SearchChunk, ItemInfo } from "../src/cloudflare/api-client.ts";

interface StoredItem {
	id: string;
	key: string;
	content: string;
	metadata: Record<string, string>;
	timestamp: number;
}

export interface MockClient extends CloudflareApiClient {
	// Visibility for tests
	_instances: Map<string, StoredItem[]>;
	_calls: { name: string; args: unknown[] }[];
	/** Force recall to return specific chunks for a specific query on specific instances. */
	_mockRecall?: (instances: string[], query: string) => SearchChunk[];
}

export function makeMockClient(): MockClient {
	const store = new Map<string, StoredItem[]>();
	const calls: { name: string; args: unknown[] }[] = [];
	let seq = 0;

	function ensureInstance(id: string) {
		if (!store.has(id)) store.set(id, []);
	}

	const mock = {
		_instances: store,
		_calls: calls,
		_mockRecall: undefined as MockClient["_mockRecall"],

		async ensureInstance(id: string) {
			calls.push({ name: "ensureInstance", args: [id] });
			const created = !store.has(id);
			ensureInstance(id);
			return { created };
		},

		async validate() {
			return { valid: true };
		},

		async listInstances() {
			return {
				instances: [...store.keys()].map((id) => ({ id, status: "ready" })),
				total: store.size,
			};
		},

		async remember(instance: string, content: string, metadata?: Record<string, string>) {
			calls.push({ name: "remember", args: [instance, content, metadata] });
			ensureInstance(instance);
			const id = `doc_${++seq}`;
			const key = `memory-${Date.now()}-${seq}.md`;
			const item: StoredItem = {
				id,
				key,
				content,
				metadata: metadata ?? {},
				timestamp: Date.now(),
			};
			store.get(instance)!.push(item);
			return { id, key, status: "ready" };
		},

		async uploadFile(
			instance: string,
			filename: string,
			content: string,
			metadata?: Record<string, string>,
		) {
			calls.push({ name: "uploadFile", args: [instance, filename, content, metadata] });
			ensureInstance(instance);
			const id = `doc_${++seq}`;
			const item: StoredItem = {
				id,
				key: filename,
				content,
				metadata: metadata ?? {},
				timestamp: Date.now(),
			};
			store.get(instance)!.push(item);
			return { id, status: "ready" };
		},

		async recall(instances: string[], query: string) {
			calls.push({ name: "recall", args: [instances, query] });
			if (mock._mockRecall) {
				const chunks = mock._mockRecall(instances, query);
				return { chunks, count: chunks.length };
			}
			// Default: naive keyword match across instances.
			const chunks: SearchChunk[] = [];
			const q = query.toLowerCase();
			for (const inst of instances) {
				for (const item of store.get(inst) ?? []) {
					if (item.content.toLowerCase().includes(q)) {
						chunks.push({
							id: item.id,
							type: "chunk",
							score: 0.9,
							text: item.content,
							item: { key: item.key, timestamp: item.timestamp },
							instance_id: inst,
						});
					}
				}
			}
			return { chunks, count: chunks.length };
		},

		async listMemories(instance: string) {
			calls.push({ name: "listMemories", args: [instance] });
			const items: ItemInfo[] = (store.get(instance) ?? []).map((s) => ({
				id: s.id,
				key: s.key,
				status: "ready",
				timestamp: s.timestamp,
			}));
			return { items, count: items.length };
		},

		async forget(instance: string, id: string) {
			calls.push({ name: "forget", args: [instance, id] });
			const list = store.get(instance);
			if (!list) return;
			const i = list.findIndex((x) => x.id === id);
			if (i >= 0) list.splice(i, 1);
		},

		async search(instance: string, query: string) {
			return mock.recall([instance], query);
		},

		async listItems(instance: string) {
			return mock.listMemories(instance);
		},

		async deleteItem(instance: string, id: string) {
			return mock.forget(instance, id);
		},
	};

	return mock as unknown as MockClient;
}
