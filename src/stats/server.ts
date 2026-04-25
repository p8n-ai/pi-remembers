/**
 * Stats HTTP server — serves the dashboard and API endpoints.
 *
 * Binds to 127.0.0.1 on a random port. Serves:
 *   GET  /                  → HTML dashboard
 *   GET  /api/summary       → aggregate stats
 *   GET  /api/operations    → paginated list (?type=&status=&limit=&offset=)
 *   GET  /api/operations/:id → operation + steps detail
 *   GET  /api/memories      → live memory store listing
 *   GET  /api/config        → sanitized config
 *   POST /api/shutdown      → gracefully stop the server
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { StatsLogger } from "./logger.js";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";
import { getDashboardHtml } from "./dashboard.html.js";

export interface StatsServer {
	server: Server;
	port: number;
	url: string;
	close: () => Promise<void>;
}

export function startStatsServer(
	logger: StatsLogger,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
): Promise<StatsServer> {
	return new Promise((resolve, reject) => {
		const server = createServer(async (req, res) => {
			try {
				await handleRequest(req, res, logger, getClient, getConfig, () => {
					server.close(() => {});
				});
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }));
			}
		});

		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("Failed to get server address"));
				return;
			}
			const port = addr.port;
			const url = `http://127.0.0.1:${port}`;

			const result: StatsServer = {
				server,
				port,
				url,
				close: () =>
					new Promise<void>((res) => {
						server.close(() => res());
					}),
			};
			resolve(result);
		});

		server.on("error", reject);
	});
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	logger: StatsLogger,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
	shutdownFn: () => void,
) {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const path = url.pathname;
	const method = req.method ?? "GET";

	// CORS headers for localhost
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");

	if (method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	// Routes
	if (method === "GET" && path === "/") {
		const addr = res.socket?.localPort ?? 0;
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(getDashboardHtml(addr));
		return;
	}

	if (method === "GET" && path === "/api/summary") {
		const projectId = url.searchParams.get("project") ?? undefined;
		const summary = logger.getSummary(projectId);
		jsonResponse(res, summary);
		return;
	}

	if (method === "GET" && path === "/api/projects") {
		const projects = logger.getDistinctProjects();
		jsonResponse(res, { projects });
		return;
	}

	if (method === "GET" && path === "/api/operations") {
		const type = url.searchParams.get("type") ?? undefined;
		const status = url.searchParams.get("status") ?? undefined;
		const projectId = url.searchParams.get("project") ?? undefined;
		const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
		const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
		const ops = logger.listOperations({ type, status, projectId, limit, offset });
		const total = logger.getOperationCount({ type, status, projectId });
		jsonResponse(res, { operations: ops, total, limit, offset });
		return;
	}

	if (method === "GET" && path.startsWith("/api/operations/")) {
		const id = path.slice("/api/operations/".length);
		if (!id) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Missing operation ID" }));
			return;
		}
		const op = logger.getOperation(id);
		if (!op) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Operation not found" }));
			return;
		}
		jsonResponse(res, op);
		return;
	}

	if (method === "GET" && path === "/api/memories") {
		const client = getClient();
		const config = getConfig();
		if (!client || !config) {
			jsonResponse(res, { error: "Not configured", project: [], global: [] });
			return;
		}
		const result: Record<string, unknown> = {};
		try {
			const proj = await client.listMemories(config.projectMemoryInstance);
			result.project = proj.items;
			result.projectCount = proj.count;
			result.projectInstance = config.projectMemoryInstance;
		} catch {
			result.project = [];
			result.projectError = "Failed to fetch";
		}
		try {
			const glob = await client.listMemories(config.globalMemoryInstance);
			result.global = glob.items;
			result.globalCount = glob.count;
			result.globalInstance = config.globalMemoryInstance;
		} catch {
			result.global = [];
			result.globalError = "Failed to fetch";
		}
		jsonResponse(res, result);
		return;
	}

	if (method === "GET" && path === "/api/config") {
		const config = getConfig();
		if (!config) {
			jsonResponse(res, { error: "Not configured" });
			return;
		}
		// Sanitize — never leak secrets
		const sanitized = {
			accountId: config.accountId.slice(0, 8) + "...",
			apiToken: "***",
			namespace: config.namespace,
			globalMemoryInstance: config.globalMemoryInstance,
			projectMemoryInstance: config.projectMemoryInstance,
			searchInstance: config.searchInstance,
			hooks: config.hooks,
			features: config.features,
			projectId: config.projectId,
			projectName: config.projectName,
			projectRoot: config.projectRoot,
			projectAliases: config.projectAliases,
			relatedProjects: config.relatedProjects,
			workspace: config.workspace,
		};
		jsonResponse(res, sanitized);
		return;
	}

	if (method === "POST" && path === "/api/shutdown") {
		jsonResponse(res, { message: "Server shutting down" });
		setTimeout(shutdownFn, 100);
		return;
	}

	// 404
	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "Not found" }));
}

function jsonResponse(res: ServerResponse, data: unknown) {
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}
