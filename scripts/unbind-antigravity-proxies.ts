import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getNineRouterClientUrls,
  listAntigravityConnections,
  updateConnection,
  type NineRouterConnectionItem,
} from "../src/server/nine-router-client.js";
import { parseNineRouterUrls } from "../src/server/app-config.js";

export interface UnbindChange {
  id: string;
  providerSpecificData: Record<string, unknown>;
}

export interface UnbindSummary {
  scanned: number;
  changed: number;
  skipped: number;
  failed: number;
}

export function planUnbind(connections: NineRouterConnectionItem[]): UnbindChange[] {
  return connections.flatMap((connection) => {
    const data = connection.providerSpecificData;
    if (!data || !Object.hasOwn(data, "proxyPoolId")) return [];
    const providerSpecificData = { ...data };
    delete providerSpecificData.proxyPoolId;
    return [{ id: connection.id, providerSpecificData }];
  });
}

export interface ApplyUnbindOptions {
  dryRun: boolean;
  routerUrls: string[];
  listConnections: typeof listAntigravityConnections;
  updateConnection: typeof updateConnection;
}

export async function applyUnbind(options: ApplyUnbindOptions): Promise<UnbindSummary> {
  const summary: UnbindSummary = { scanned: 0, changed: 0, skipped: 0, failed: 0 };

  for (const routerUrl of options.routerUrls) {
    let connections: NineRouterConnectionItem[];
    try {
      connections = await options.listConnections({ url: routerUrl });
    } catch (error) {
      console.error(
        `Failed to list connections at ${routerUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
      summary.failed++;
      continue;
    }

    summary.scanned += connections.length;
    const changes = planUnbind(connections);
    summary.skipped += connections.length - changes.length;
    const changesById = new Map(changes.map((change) => [change.id, change]));

    if (options.dryRun) {
      for (const connection of connections) {
        const wouldChange = changesById.has(connection.id);
        console.log(`${routerUrl} ${connection.id}: ${wouldChange ? "would unbind" : "skipped"}`);
      }
      summary.changed += changes.length;
      continue;
    }

    for (const change of changes) {
      try {
        await options.updateConnection(change.id, { proxyPoolId: null }, { url: routerUrl });
        summary.changed++;
        console.log(`${routerUrl} ${change.id}: unbound`);
      } catch (error) {
        console.error(
          `${routerUrl} ${change.id}: failed to unbind: ${error instanceof Error ? error.message : String(error)}`,
        );
        summary.failed++;
      }
    }
  }

  return summary;
}

export interface CliArgs {
  apply: boolean;
  dryRun: boolean;
  routerUrls: string[];
}

export function parseCliArgs(args: string[]): CliArgs {
  let apply = false;
  let dryRun = false;
  const routerUrls: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--router-url" || arg === "--router-urls") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a URL`);
      routerUrls.push(value);
      continue;
    }
    if (arg.startsWith("--router-url=") || arg.startsWith("--router-urls=")) {
      const value = arg.slice(arg.indexOf("=") + 1);
      if (!value) throw new Error(`${arg.split("=")[0]} requires a URL`);
      routerUrls.push(value);
      continue;
    }
    throw new Error(`Unknown flag: ${arg}`);
  }

  if (apply && dryRun) throw new Error("--apply and --dry-run are conflicting flags");
  return { apply, dryRun: !apply, routerUrls: parseNineRouterUrls(routerUrls) };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const routerUrls = args.routerUrls.length > 0 ? args.routerUrls : getNineRouterClientUrls();
  if (routerUrls.length === 0) throw new Error("No 9Router endpoints configured");
  const summary = await applyUnbind({
    dryRun: args.dryRun,
    routerUrls,
    listConnections: listAntigravityConnections,
    updateConnection,
  });
  console.log(JSON.stringify(summary));
  if (summary.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
