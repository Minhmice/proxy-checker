import type { AuditVerdict, RiskFactor } from "../types.js";
import { explainRiskFactors, recommendationsFromRiskFactors, type ExplainedRiskFactor } from "./explanations.js";
import type { AuditEvidence, ScoresResult } from "./scores.js";

export interface VerdictResult {
  verdict: AuditVerdict;
  riskFactors: ExplainedRiskFactor[];
  recommendations: string[];
}

function isCritical(factor: RiskFactor): boolean {
  return factor.severity === "critical";
}

function isObservedWarning(factor: ExplainedRiskFactor): boolean {
  if (factor.code === "INSUFFICIENT_EVIDENCE") return false;
  return factor.severity === "high" || factor.severity === "medium" || factor.severity === "low";
}

export function determineVerdict(evidence: AuditEvidence, scores: ScoresResult): VerdictResult {
  const riskFactors = explainRiskFactors(evidence);
  const recommendations = recommendationsFromRiskFactors(riskFactors);

  if (riskFactors.some(isCritical)) {
    return { verdict: "FAIL", riskFactors, recommendations };
  }
  if (riskFactors.some(isObservedWarning)) {
    return { verdict: "WARN", riskFactors, recommendations };
  }
  if (scores.overallSafety === null || riskFactors.some((factor) => factor.code === "INSUFFICIENT_EVIDENCE")) {
    return { verdict: "UNKNOWN", riskFactors, recommendations };
  }
  return { verdict: "PASS", riskFactors, recommendations };
}
