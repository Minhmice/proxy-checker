import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const projectSkillDir = path.resolve(".agents", "skills", "crucible");

test("crucible: all required project-level skill files exist with valid frontmatter", async () => {
  const expectedFiles = [
    "SKILL.md",
    "README.md",
    "scope.md",
    "stress.md",
    "evidence.md",
    "repro.md",
    "patch.md",
    "review.md",
  ];

  for (const file of expectedFiles) {
    const filePath = path.join(projectSkillDir, file);
    const stat = await fs.stat(filePath);
    assert.ok(stat.isFile(), `Expected ${file} to exist in .agents/skills/crucible`);
  }

  const skillContent = await fs.readFile(path.join(projectSkillDir, "SKILL.md"), "utf8");
  assert.match(skillContent, /^---\r?\nname:\s*crucible/m, "SKILL.md must have name: crucible");
  assert.match(skillContent, /description:\s*".+"/m, "SKILL.md must have valid description");
});

test("crucible: defines complete state machine and stop states", async () => {
  const content = await fs.readFile(path.join(projectSkillDir, "SKILL.md"), "utf8");
  const requiredStates = [
    "SCOPE",
    "COMPLEXITY_CLASSIFIED",
    "AUDIT_WAVE",
    "FINDINGS_MERGED",
    "WEB_EVIDENCE_CHECK",
    "REPRO_WAVE",
    "VERDICT_GATE",
    "ROOT_CAUSE",
    "FIX_WAVE",
    "REGRESSION_VERIFY",
    "FINAL_REVIEW",
    "DONE",
    "BLOCKED",
  ];

  for (const state of requiredStates) {
    assert.ok(content.includes(state), `crucible must document state ${state}`);
  }

  assert.match(content, /ask|ambiguous/i, "crucible must document ambiguous handling");
});

test("crucible: reference files satisfy schema contract", async () => {
  const scopeContent = await fs.readFile(path.join(projectSkillDir, "scope.md"), "utf8");
  for (const field of [
    "targetSymbols",
    "callers",
    "boundaries",
    "invariants",
    "riskDimensions",
    "changedFiles",
    "excludedScope",
    "complexity",
    "openQuestions",
  ]) {
    assert.ok(scopeContent.includes(field), `scope.md must document field ${field}`);
  }

  const stressContent = await fs.readFile(path.join(projectSkillDir, "stress.md"), "utf8");
  assert.match(stressContent, /falsification/i);
  assert.match(stressContent, /severity/i);
  assert.match(stressContent, /confidence/i);
  assert.match(stressContent, /codeEvidence/i);

  const reproContent = await fs.readFile(path.join(projectSkillDir, "repro.md"), "utf8");
  assert.match(reproContent, /targetSymbol/i);
  assert.match(reproContent, /oracle/i);
  assert.match(reproContent, /watchdog/i);
  assert.match(reproContent, /cleanup/i);
  assert.match(reproContent, /reproduced|not-reproduced|inconclusive|harness-error/i);

  const patchContent = await fs.readFile(path.join(projectSkillDir, "patch.md"), "utf8");
  assert.match(patchContent, /reproduced/i);
  assert.match(patchContent, /regressionTest/i);

  const reviewContent = await fs.readFile(path.join(projectSkillDir, "review.md"), "utf8");
  assert.match(reviewContent, /consistency/i);
  assert.match(reviewContent, /scope/i);
  assert.match(reviewContent, /verification/i);
});
