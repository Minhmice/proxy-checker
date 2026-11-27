import { Hono } from "hono";
import type { ApiDependencies, ApiEnv } from "../types.js";
import { createAlreadySentResponse } from "../app.js";
import { getNodeInventory, fetchFromNode } from "../../ninerouter-node-proxy.js";

export function createNineRouterRoutes(deps: ApiDependencies): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get("/stats", async (c) => {
    const period = c.req.query("period") || "today";
    const requestedNodeId = c.req.query("nodeId");
    const allNodes = getNodeInventory();
    const nodes = requestedNodeId ? allNodes.filter((n) => n.id === requestedNodeId) : allNodes;

    const results = await Promise.allSettled(
      nodes.map(async (node) => {
        const res = await fetchFromNode(
          node.id,
          `/api/usage/stats?period=${encodeURIComponent(period)}`,
        );
        if (!res.ok) {
          throw new Error(`Node ${node.id} returned HTTP ${res.status}`);
        }
        return { nodeId: node.id, nodeName: node.name, data: await res.json() };
      }),
    );

    let totalRequests = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCachedTokens = 0;
    let totalCost = 0;
    const byModel: Record<
      string,
      {
        requests: number;
        promptTokens: number;
        completionTokens: number;
        cachedTokens: number;
        cost: number;
        provider?: string;
      }
    > = {};
    const nodeSummaries = [];

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const r = results[i];
      if (r.status === "fulfilled") {
        const stats = (r.value.data || {}) as Record<string, any>;
        const reqs = Number(stats.totalRequests) || 0;
        const prompt = Number(stats.totalPromptTokens) || 0;
        const comp = Number(stats.totalCompletionTokens) || 0;
        const cached = Number(stats.totalCachedTokens) || 0;
        const cost = Number(stats.totalCost) || 0;

        totalRequests += reqs;
        totalPromptTokens += prompt;
        totalCompletionTokens += comp;
        totalCachedTokens += cached;
        totalCost += cost;

        if (stats.byModel && typeof stats.byModel === "object") {
          for (const [model, m] of Object.entries(stats.byModel)) {
            const mData = m as Record<string, any>;
            if (!byModel[model]) {
              byModel[model] = {
                requests: 0,
                promptTokens: 0,
                completionTokens: 0,
                cachedTokens: 0,
                cost: 0,
                provider: typeof mData.provider === "string" ? mData.provider : undefined,
              };
            }
            byModel[model].requests += Number(mData.requests) || 0;
            byModel[model].promptTokens += Number(mData.promptTokens) || 0;
            byModel[model].completionTokens += Number(mData.completionTokens) || 0;
            byModel[model].cachedTokens += Number(mData.cachedTokens) || 0;
            byModel[model].cost += Number(mData.cost) || 0;
          }
        }

        nodeSummaries.push({
          id: node.id,
          name: node.name,
          url: node.url,
          online: true,
          totalTokens: prompt + comp + cached,
          requests: reqs,
        });
      } else {
        nodeSummaries.push({
          id: node.id,
          name: node.name,
          url: node.url,
          online: false,
          error: (r.reason as Error)?.message || "Unreachable",
          totalTokens: 0,
          requests: 0,
        });
      }
    }

    return c.json({
      period,
      totalRequests,
      totalPromptTokens,
      totalCompletionTokens,
      totalCachedTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens + totalCachedTokens,
      totalCost,
      byModel,
      nodes: nodeSummaries,
    });
  });

  router.get("/recent", async (c) => {
    const nodes = getNodeInventory();
    const results = await Promise.allSettled(
      nodes.map(async (node) => {
        const res = await fetchFromNode(node.id, "/api/usage/stats?period=today");
        if (!res.ok) throw new Error(`Node ${node.id} returned HTTP ${res.status}`);
        const stats = (await res.json()) as { recentRequests?: unknown };
        return { node, recent: Array.isArray(stats.recentRequests) ? stats.recentRequests : [] };
      }),
    );
    const requests = results
      .flatMap((r) =>
        r.status === "fulfilled" ? r.value.recent.map((e) => ({ e, id: r.value.node.id })) : [],
      )
      .map(({ e, id }) => {
        const r = e as Record<string, unknown>;
        return {
          nodeId: id,
          timestamp: String(r.timestamp ?? ""),
          model: String(r.model ?? "unknown"),
          provider: String(r.provider ?? ""),
          promptTokens: Number(r.promptTokens) || 0,
          completionTokens: Number(r.completionTokens) || 0,
          status: String(r.status ?? "ok"),
        };
      })
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, 30);
    if (nodes.length && results.every((r) => r.status === "rejected")) {
      return c.json({ error: "No 9Router node reported recent requests." }, 502);
    }
    return c.json({ requests });
  });

  router.get("/chart", async (c) => {
    try {
      const node = getNodeInventory()[0];
      if (!node) return c.json({ error: "No 9Router node configured" }, 503);
      const res = await fetchFromNode(node.id, "/api/usage/chart?period=60d");
      if (!res.ok) return c.json({ error: `Node returned ${res.status}` }, 502);
      const data = await res.json();
      if (!Array.isArray(data)) return c.json({ error: "Invalid usage chart response" }, 502);
      return c.json(data);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  router.get("/nodes/:nodeId/stats", async (c) => {
    const nodeId = c.req.param("nodeId");
    const period = c.req.query("period") || "today";
    try {
      const res = await fetchFromNode(
        nodeId,
        `/api/usage/stats?period=${encodeURIComponent(period)}`,
      );
      if (!res.ok) {
        return c.json({ error: `Node returned ${res.status}` }, res.status as 500);
      }
      const data = await res.json();
      return c.json(data);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  router.get("/nodes/:nodeId/connections", async (c) => {
    const nodeId = c.req.param("nodeId");
    try {
      const res = await fetchFromNode(
        nodeId,
        "/api/providers/client?pageSize=100&provider=antigravity",
      );
      if (!res.ok) return c.json({ error: `Node returned ${res.status}` }, res.status as 500);
      const data = await res.json();
      return c.json(data);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  router.put("/nodes/:nodeId/connections/:connectionId", async (c) => {
    const nodeId = c.req.param("nodeId");
    const connectionId = c.req.param("connectionId");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.isActive !== "boolean") {
      return c.json({ error: "isActive must be a boolean" }, 400);
    }
    const patch = { isActive: body.isActive };

    try {
      const res = await fetchFromNode(
        nodeId,
        `/api/providers/${encodeURIComponent(connectionId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      const data = await res.json();
      return c.json(data, res.status as 200);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  router.all("*", async (c) => {
    const req = c.env.incoming;
    const res = c.env.outgoing;
    const pathname = new URL(c.req.url).pathname;
    await deps.legacyHandlers.handleNineRouter(req, res, pathname);
    if (res?.writableEnded) {
      return createAlreadySentResponse();
    }
  });

  return router;
}
