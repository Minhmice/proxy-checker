import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("AntigravityQuotaWidget includes collapsible icon-mode responsive containment", () => {
  const content = fs.readFileSync("src/components/antigravity-quota-widget.tsx", "utf8");

  assert.ok(
    content.includes("group-data-[collapsible=icon]:w-auto") ||
      content.includes("group-data-[collapsible=icon]:size-8!"),
    "Must include icon-mode responsive containment classes",
  );
  assert.ok(
    content.includes("group-data-[collapsible=icon]:hidden"),
    "Must hide expanded labels when sidebar is collapsed to icon rail",
  );

  assert.ok(
    content.includes('role="progressbar"'),
    "Progress bar must have accessible role='progressbar'",
  );
  assert.ok(content.includes("aria-valuenow"), "Progress bar must provide aria-valuenow");

  assert.ok(
    content.includes("lastManualRefreshAtRef"),
    "Must track manual refresh timestamp to prevent stale background overwrite",
  );
});
