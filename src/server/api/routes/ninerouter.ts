import { Hono } from "hono";
import type { ApiDependencies, ApiEnv } from "../types.js";
import { createAlreadySentResponse } from "../app.js";
import { getNodeInventory, fetchFromNode } from "../../ninerouter-node-proxy.js";

export function createNineRouterRoutes(deps: ApiDependencies): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  // 1. Get Node inventory
  router.get("/nodes", (c) => {
    return c.json({ nodes: getNodeInventory() });
  });
  // 1b. Aggregate Stats across all nodes or specific node
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

  // 2. Node Stats
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

  // 3. Node Recent Request Logs
  router.get("/nodes/:nodeId/request-logs", async (c) => {
    const nodeId = c.req.param("nodeId");
    const limit = c.req.query("limit") || "20";
    try {
      const res = await fetchFromNode(
        nodeId,
        `/api/usage/request-logs?limit=${encodeURIComponent(limit)}`,
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

  // 4. Node SSE Console Logs Stream
  router.get("/nodes/:nodeId/logs/stream", async (c) => {
    const nodeId = c.req.param("nodeId");

    try {
      const nodeRes = await fetchFromNode(
        nodeId,
        "/api/translator/console-logs/stream",
        {
          headers: { Accept: "text/event-stream" },
          signal: c.req.raw.signal,
        },
        true,
      );

      if (!nodeRes.ok || !nodeRes.body) {
        return c.text("Failed to open stream to 9router node", 502);
      }

      return new Response(nodeRes.body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    } catch (err) {
      return c.text(`Stream error: ${(err as Error).message}`, 502);
    }
  });

  // 5. Node Proxy Pools
  router.get("/nodes/:nodeId/proxy-pools", async (c) => {
    const nodeId = c.req.param("nodeId");
    try {
      const res = await fetchFromNode(nodeId, "/api/proxy-pools?includeUsage=true");
      if (!res.ok) return c.json({ error: `Node returned ${res.status}` }, res.status as 500);
      const data = await res.json();
      return c.json(data);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  // 6. Test Proxy Pool
  router.post("/nodes/:nodeId/proxy-pools/:poolId/test", async (c) => {
    const nodeId = c.req.param("nodeId");
    const poolId = c.req.param("poolId");
    try {
      const res = await fetchFromNode(
        nodeId,
        `/api/proxy-pools/${encodeURIComponent(poolId)}/test`,
        {
          method: "POST",
        },
      );
      const data = await res.json();
      return c.json(data, res.status as 200);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  // 7. Update Proxy Pool
  router.put("/nodes/:nodeId/proxy-pools/:poolId", async (c) => {
    const nodeId = c.req.param("nodeId");
    const poolId = c.req.param("poolId");
    const body = await c.req.json();
    try {
      const res = await fetchFromNode(nodeId, `/api/proxy-pools/${encodeURIComponent(poolId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      return c.json(data, res.status as 200);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  // 8. Delete Proxy Pool
  router.delete("/nodes/:nodeId/proxy-pools/:poolId", async (c) => {
    const nodeId = c.req.param("nodeId");
    const poolId = c.req.param("poolId");
    try {
      const res = await fetchFromNode(nodeId, `/api/proxy-pools/${encodeURIComponent(poolId)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      return c.json(data, res.status as 200);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  // 9. Node Connections
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

  // 10. Bind Connection to Pool
  router.put("/nodes/:nodeId/connections/:connectionId/bind-pool", async (c) => {
    const nodeId = c.req.param("nodeId");
    const connectionId = c.req.param("connectionId");
    const body = await c.req.json();
    const { poolId } = body;
    try {
      const patch = {
        providerSpecificData: {
          proxyPoolId: poolId || null,
        },
      };
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

  // Fallback to legacy handler
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
