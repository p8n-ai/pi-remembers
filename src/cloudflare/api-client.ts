/**
 * Cloudflare AI Search REST API client.
 */

export interface ApiClientConfig {
	accountId: string;
	apiToken: string;
	namespace: string;
}

export interface SearchChunk {
	id: string;
	type: string;
	score: number;
	text: string;
	item: { key: string; timestamp?: number };
	instance_id?: string;
}

export interface ItemInfo {
	id: string;
	key: string;
	status: string;
	timestamp?: number;
}

interface ApiResponse<T = unknown> {
	success: boolean;
	result: T;
	errors: Array<{ code: number; message: string }>;
	result_info?: { total_count: number };
}

export class CloudflareApiClient {
	private accountId: string;
	private apiToken: string;
	private namespace: string;
	private base: string;

	constructor(config: ApiClientConfig) {
		this.accountId = config.accountId;
		this.apiToken = config.apiToken;
		this.namespace = config.namespace;
		this.base = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai-search`;
	}

	private headers(contentType?: string): Record<string, string> {
		const h: Record<string, string> = { Authorization: `Bearer ${this.apiToken}` };
		if (contentType) h["Content-Type"] = contentType;
		return h;
	}

	private nsPath(instance?: string): string {
		const base = `${this.base}/namespaces/${encodeURIComponent(this.namespace)}`;
		return instance ? `${base}/instances/${encodeURIComponent(instance)}` : base;
	}

	private async request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<ApiResponse<T>> {
		const res = await fetch(url, {
			method,
			headers: this.headers(body ? "application/json" : undefined),
			body: body ? JSON.stringify(body) : undefined,
			signal,
		});
		return (await res.json()) as ApiResponse<T>;
	}

	// ── Health / validation ──

	async validate(signal?: AbortSignal): Promise<{ valid: boolean; error?: string }> {
		try {
			const res = await this.request<unknown[]>("GET", `${this.base}/instances`, undefined, signal);
			return res.success ? { valid: true } : { valid: false, error: res.errors?.[0]?.message };
		} catch (e) {
			return { valid: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	// ── Instances ──

	async ensureInstance(id: string, signal?: AbortSignal): Promise<{ created: boolean }> {
		try {
			const res = await this.request<{ id: string }>(
				"POST",
				`${this.nsPath()}/instances`,
				{ id, index_method: { keyword: true, vector: true } },
				signal,
			);
			if (res.success) return { created: true };
			// Already exists
			return { created: false };
		} catch {
			return { created: false };
		}
	}

	async listInstances(signal?: AbortSignal): Promise<{ instances: Array<{ id: string; status: string }>; total: number }> {
		const res = await this.request<Array<{ id: string; status: string }>>(
			"GET",
			`${this.nsPath()}/instances`,
			undefined,
			signal,
		);
		if (!res.success) throw new Error(res.errors?.[0]?.message ?? "Failed to list instances");
		return { instances: res.result, total: res.result_info?.total_count ?? res.result.length };
	}

	// ── Memory (stored as docs in AI Search instances) ──

	async remember(
		instance: string,
		content: string,
		metadata?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<{ id: string; key: string; status: string }> {
		const url = `${this.nsPath(instance)}/items`;
		const ts = new Date().toISOString();
		const filename = `memory-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.md`;

		const formData = new FormData();
		formData.append("file", new Blob([content], { type: "text/plain" }), filename);
		if (metadata) {
			formData.append("metadata", JSON.stringify({ ...metadata, type: "memory", created_at: ts }));
		}

		const res = await fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.apiToken}` },
			body: formData,
			signal,
		});
		const data = (await res.json()) as ApiResponse<{ id: string; status: string }>;
		if (!data.success) throw new Error(data.errors?.[0]?.message ?? "Failed to store memory");
		return { id: data.result.id, key: filename, status: data.result.status };
	}

	async recall(
		instances: string[],
		query: string,
		signal?: AbortSignal,
	): Promise<{ chunks: SearchChunk[]; count: number }> {
		// Cross-instance search via namespace endpoint
		const url = `${this.nsPath()}/search`;
		const res = await this.request<{ chunks?: SearchChunk[] }>(
			"POST",
			url,
			{
				messages: [{ role: "user", content: query }],
				ai_search_options: { instance_ids: instances },
			},
			signal,
		);
		if (!res.success) throw new Error(res.errors?.[0]?.message ?? "Recall failed");
		const chunks = res.result?.chunks ?? [];
		return { chunks, count: chunks.length };
	}

	async listMemories(instance: string, signal?: AbortSignal): Promise<{ items: ItemInfo[]; count: number }> {
		const res = await this.request<ItemInfo[]>(
			"GET",
			`${this.nsPath(instance)}/items`,
			undefined,
			signal,
		);
		if (!res.success) throw new Error(res.errors?.[0]?.message ?? "Failed to list memories");
		return { items: res.result, count: res.result.length };
	}

	async forget(instance: string, id: string, signal?: AbortSignal): Promise<void> {
		await this.request("DELETE", `${this.nsPath(instance)}/items/${encodeURIComponent(id)}`, undefined, signal);
	}

	// ── Search (project files) ──

	async search(
		instance: string,
		query: string,
		signal?: AbortSignal,
	): Promise<{ chunks: SearchChunk[]; count: number }> {
		const res = await this.request<{ chunks?: SearchChunk[] }>(
			"POST",
			`${this.nsPath(instance)}/search`,
			{ messages: [{ role: "user", content: query }] },
			signal,
		);
		if (!res.success) throw new Error(res.errors?.[0]?.message ?? "Search failed");
		const chunks = res.result?.chunks ?? [];
		return { chunks, count: chunks.length };
	}

	async uploadFile(
		instance: string,
		filename: string,
		content: string,
		metadata?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<{ id: string; status: string }> {
		const url = `${this.nsPath(instance)}/items`;
		const formData = new FormData();
		formData.append("file", new Blob([content], { type: "text/plain" }), filename);
		if (metadata) {
			formData.append("metadata", JSON.stringify(metadata));
		}

		const res = await fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.apiToken}` },
			body: formData,
			signal,
		});
		const data = (await res.json()) as ApiResponse<{ id: string; status: string }>;
		if (!data.success) throw new Error(data.errors?.[0]?.message ?? "Upload failed");
		return { id: data.result.id, status: data.result.status };
	}

	async listItems(instance: string, signal?: AbortSignal): Promise<{ items: ItemInfo[]; count: number }> {
		return this.listMemories(instance, signal);
	}

	async deleteItem(instance: string, id: string, signal?: AbortSignal): Promise<void> {
		return this.forget(instance, id, signal);
	}
}
