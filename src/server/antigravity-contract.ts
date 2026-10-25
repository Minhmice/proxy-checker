import type { ProxyOwnershipGrant } from "./antigravity-ownership.js";

export interface RouterBindingRevision {
  accountId: string;
  poolId: string | null;
  revision: number;
  isActive: boolean;
}
export interface BindingUpdate {
  operationId: string;
  expectedRevision: number;
  expectedPoolId: string | null;
  desiredPoolId: string | null;
  expectedIsActive: boolean;
  desiredIsActive: boolean;
  expectedPoolRevision: number | null;
  grant: ProxyOwnershipGrant | null;
}
export type ConditionalUpdateResult =
  | { status: "applied"; binding: RouterBindingRevision }
  | { status: "conflict" | "unsupported" | "no_capacity"; reason: string };
