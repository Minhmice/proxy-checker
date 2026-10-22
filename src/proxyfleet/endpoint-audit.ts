import { spawn } from "node:child_process";
import net from "node:net";
import type { FleetRepository } from "./db.js";
import type { ProxyIntelligenceRepository } from "../server/proxy-intelligence-repository.js";
import { resolveManagedEndpointForAudit } from "./pipeline-adapter.js";

/** Audit only authenticated fleet inventory; arbitrary browser-supplied private targets never enter this path. */
export async function auditManagedFleetEndpoints(repo: FleetRepository, intelligence: ProxyIntelligenceRepository): Promise<number> {
  const endpoints = await repo.listEndpoints({ enabled: true });
  let checked = 0;
  for (let offset = 0; offset < endpoints.length; offset += 4) {
    await Promise.all(endpoints.slice(offset, offset + 4).map(async endpoint => {
      const node = await repo.getNode(endpoint.node_id);
      if (!node) return;
      const validBindIp = (node.tailscale_ip && endpoint.listen_ip === node.tailscale_ip) || endpoint.listen_ip === node.wireguard_ip;
      if (!validBindIp || !net.isIPv4(endpoint.listen_ip)) return;
      if (node.tailscale_ip && node.proxy_activation === "disabled") return;
      const resolved = await resolveManagedEndpointForAudit(repo, endpoint.id);
      if (!resolved) return;
      const started = Date.now();
      let exitIp: string | undefined;
      let errorMessage: string | undefined;
      try {
        // stdin configuration keeps credentials out of process arguments and logs.
        const proxyUrl = resolved.targetUrl.replace(/^socks5:/, "socks5h:");
        const configValue = proxyUrl.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        if (/[\r\n\u0000]/.test(configValue)) throw new Error("Invalid managed proxy credentials");
        const body = await new Promise<string>((resolve, reject) => {
          const child = spawn("curl", ["--config", "-", "--silent", "--show-error", "--fail", "--connect-timeout", "3", "--max-time", "8", "--max-filesize", "1024", "--noproxy", "", "https://api.ipify.org?format=json"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
          const chunks: Buffer[] = [];
          let size = 0;
          const deadline = setTimeout(() => { child.kill(); reject(new Error("Managed proxy audit timed out")); }, 10_000);
          child.stdout.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1024) { child.kill(); reject(new Error("Managed proxy audit response too large")); }
            else chunks.push(chunk);
          });
          // Native error text may contain credentials, so surface bounded generic transport errors instead.
          child.stderr.resume();
          child.once("error", error => { clearTimeout(deadline); reject(new Error(`Managed proxy audit executable unavailable: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`)); });
          child.once("close", code => {
            clearTimeout(deadline);
            if (code !== 0) reject(new Error(`Managed proxy forwarding audit failed (curl exit ${code ?? "terminated"})`));
            else resolve(Buffer.concat(chunks).toString("utf8"));
          });
          child.stdin.on("error", () => {});
          child.stdin.end(`proxy = "${configValue}"\n`);
        });
        const parsed: unknown = JSON.parse(body);
        if (!parsed || typeof parsed !== "object" || !("ip" in parsed) || typeof parsed.ip !== "string" || !net.isIP(parsed.ip)) throw new Error("Managed proxy audit returned no valid exit IP");
        exitIp = parsed.ip;

        // If node has an expected public IP, verify exit matches expected
        if (node.expected_public_ip && exitIp !== node.expected_public_ip) {
          throw new Error(`Exit IP ${exitIp} does not match expected public IP ${node.expected_public_ip}`);
        }
        if (node.public_ip && exitIp !== node.public_ip) {
          throw new Error(`Exit IP ${exitIp} does not match verified worker public IP ${node.public_ip}`);
        }
      } catch (error) {
        errorMessage = error instanceof Error ? error.message.slice(0, 256) : "Managed proxy audit failed";
      }
      const latencyMs = Date.now() - started;
      // Recheck ownership after network I/O; deletion must not recreate audit state.
      if (!await repo.getEndpoint(endpoint.id)) return;
      await repo.recordHealthCheck({ endpointId: endpoint.id, nodeId: endpoint.node_id, status: exitIp ? "healthy" : "degraded", exitIp, latencyMs, errorMessage });
      await intelligence.recordTestResult(resolved.targetUrl, Boolean(exitIp), latencyMs, errorMessage);
      checked++;
    }));
  }
  return checked;
}
