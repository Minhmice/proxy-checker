import type { HttpBindings } from "@hono/node-server";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PoolRanker } from "../pool-ranker.js";
import type { AntigravityRotator } from "../antigravity-rotator.js";
import type { UnifiedSyncCoordinator } from "../unified-sync-coordinator.js";
import type { ProxyIntelligenceRepository } from "../proxy-intelligence-repository.js";
import type { FleetRepository } from "../../proxyfleet/db.js";
import type { FleetRuntimeApiDependencies } from "../../proxyfleet/runtime-api.js";
import type { verifyControlPassword } from "../app-config.js";
import type * as NineRouterClient from "../nine-router-client.js";
import type * as AppConfig from "../app-config.js";
import type {
  DualRouterCoordinator,
  DualRouterScheduler,
  SyncRepository,
  RouterAdapter,
} from "../dual-router/types.js";
import type { ProxyOwnershipAuthority } from "../antigravity-ownership.js";
export type ApiEnv = {
  Bindings: HttpBindings;
  Variables: {
    authenticated: boolean;
  };
};

export interface ApiDependencies {
  verifyControlPassword: typeof verifyControlPassword;
  proxyIntelligenceRepo: ProxyIntelligenceRepository;
  fleetRepo: FleetRepository;
  poolRanker: PoolRanker;
  antigravityRotator: AntigravityRotator;
  unifiedSyncCoordinator: UnifiedSyncCoordinator;
  fleetWireguard: FleetRuntimeApiDependencies["getWireguard"];
  handleFleetRuntimeApi: (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ) => Promise<boolean>;
  handleFleetApi: (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean>;
  handleProxyCheck: (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ) => Promise<boolean>;
  router: typeof NineRouterClient;
  settings: typeof AppConfig;
  dualRouterCoordinator?: DualRouterCoordinator;
  dualRouterScheduler?: DualRouterScheduler;
  dualRouterRepo?: SyncRepository;
  dualRouterAdapters?: RouterAdapter[];
  antigravityOwnership?: ProxyOwnershipAuthority;
  antigravityRouters?: Array<{ routerId: string; url: string }>;
  legacyHandlers: {
    handleNineRouter: (
      req: IncomingMessage,
      res: ServerResponse,
      pathname: string,
    ) => Promise<void>;
    handleAntigravity: (
      req: IncomingMessage,
      res: ServerResponse,
      pathname: string,
    ) => Promise<void>;
    handleSettings: (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<void>;
    handleIntelligence: (
      req: IncomingMessage,
      res: ServerResponse,
      pathname: string,
    ) => Promise<void>;
    handleProxiesUnified: (
      req: IncomingMessage,
      res: ServerResponse,
      pathname: string,
    ) => Promise<void>;
  };
}
