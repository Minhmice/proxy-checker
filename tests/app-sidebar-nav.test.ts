import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("AppSidebar includes 9Router Modifier navigation group", () => {
  const sidebarContent = fs.readFileSync("src/components/app-sidebar.tsx", "utf8");
  assert.ok(
    sidebarContent.includes("/ninerouter/dashboard"),
    "AppSidebar must include /ninerouter/dashboard",
  );
  assert.ok(
    sidebarContent.includes("/ninerouter/proxies"),
    "AppSidebar must include /ninerouter/proxies",
  );
  assert.ok(
    sidebarContent.includes("9Router Modifier"),
    "AppSidebar must include 9Router Modifier group label",
  );
});

test("Sidebar primitives enforce pure shadcn icon-mode centering and gap height", () => {
  const sidebarPrimitive = fs.readFileSync("src/components/ui/sidebar.tsx", "utf8");
  assert.ok(
    sidebarPrimitive.includes("group-data-[collapsible=icon]:justify-center"),
    "SidebarMenuButton variants must include group-data-[collapsible=icon]:justify-center",
  );
  assert.ok(
    sidebarPrimitive.includes("h-svh") && sidebarPrimitive.includes('data-slot="sidebar-gap"'),
    "sidebar-gap must enforce h-svh to preserve layout flow",
  );
});

test("AppSidebar hides group labels in collapsed icon rail", () => {
  const sidebarPrimitive = fs.readFileSync("src/components/ui/sidebar.tsx", "utf8");
  assert.ok(
    sidebarPrimitive.includes("group-data-[collapsible=icon]:hidden"),
    "SidebarGroupLabel must hide in collapsed icon rail",
  );
});

test("Sidebar dimensions are enlarged to standard 17.5rem expanded and 4rem icon rail", () => {
  const sidebarPrimitive = fs.readFileSync("src/components/ui/sidebar.tsx", "utf8");
  assert.ok(
    sidebarPrimitive.includes('SIDEBAR_WIDTH = "17.5rem"'),
    "Sidebar must have 17.5rem (280px) expanded width",
  );
  assert.ok(
    sidebarPrimitive.includes('SIDEBAR_WIDTH_ICON = "4rem"'),
    "Sidebar must have 4rem (64px) icon rail width",
  );
});

test("AppSidebar uses Cyber Flame lively effect and removes all pulse dots", () => {
  const sidebarContent = fs.readFileSync("src/components/app-sidebar.tsx", "utf8");

  // Removed all static/pulse dots
  assert.ok(!sidebarContent.includes("animate-ping rounded-full"), "Ping dots must be removed");
  assert.ok(
    !sidebarContent.includes("rounded-full bg-amber-500 shrink-0"),
    "Amber section dot must be removed",
  );

  // Active Cyber Flame effects applied
  assert.ok(
    sidebarContent.includes("flame-border-beam"),
    "Active item must have flame-border-beam",
  );
  assert.ok(
    sidebarContent.includes("flame-gradient-active"),
    "Active item must use flame-gradient-active",
  );
  assert.ok(
    sidebarContent.includes("flame-flicker-active"),
    "Active item must use flame-flicker-active",
  );
});

test("AppSidebar implements transient ignite-and-fade flame interaction", () => {
  const sidebarContent = fs.readFileSync("src/components/app-sidebar.tsx", "utf8");

  assert.ok(
    sidebarContent.includes("isIgnited") && sidebarContent.includes("setIsIgnited"),
    "NavMenuItem must manage isIgnited state for flame appearance",
  );
  assert.ok(
    sidebarContent.includes("AnimatePresence") && sidebarContent.includes("motion.span"),
    "Flame icon must animate via AnimatePresence with motion.span exit transition",
  );
});

test("AppSidebar removes button borders and preserves shadcn SidebarSeparator", () => {
  const sidebarContent = fs.readFileSync("src/components/app-sidebar.tsx", "utf8");

  // Border must be removed from menu buttons
  assert.ok(
    !sidebarContent.includes("border-[#FF5B22]"),
    "Active button must not have bounding box border",
  );
  assert.ok(sidebarContent.includes("border-0"), "NavMenuItem button must explicitly use border-0");

  // Preserves shadcn SidebarSeparator
  assert.ok(
    sidebarContent.includes("<SidebarSeparator"),
    "AppSidebar must render SidebarSeparator between navigation groups",
  );
  assert.ok(
    sidebarContent.includes(
      'import {\n  Sidebar,\n  SidebarContent,\n  SidebarFooter,\n  SidebarGroup,\n  SidebarGroupContent,\n  SidebarGroupLabel,\n  SidebarHeader,\n  SidebarMenu,\n  SidebarMenuButton,\n  SidebarMenuItem,\n  SidebarRail,\n  SidebarSeparator,\n} from "@/components/ui/sidebar"',
    ),
    "SidebarSeparator must be imported from shadcn sidebar UI",
  );
});
