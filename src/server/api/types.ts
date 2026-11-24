import type { HttpBindings } from "@hono/node-server";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AntigravityRotator } from "../antigravity-rotator.js";
import type { UnifiedSyncCoordinator } from "../unified-sync-coordinator.js";
import type { verifyControlPassword } from "../app-config.js";
import type * as NineRouterClient from "../nine-router-client.js";
import type * as AppConfig from "../app-config.js";
export type ApiEnv = {
  Bindings: HttpBindings;
  Variables: {
    authenticated: boolean;
  };
};

export interface ApiDependencies {
  verifyControlPassword: typeof verifyControlPassword;
  antigravityRotator: AntigravityRotator;
  unifiedSyncCoordinator: UnifiedSyncCoordinator;
  router: typeof NineRouterClient;
  settings: typeof AppConfig;
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
  };
}
