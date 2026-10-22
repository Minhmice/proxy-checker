export async function startBrowserMocks(): Promise<void> {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.NEXT_PUBLIC_ENABLE_API_MOCKS !== "true"
  ) {
    return;
  }
  if (typeof window === "undefined") {
    return;
  }
  // Dynamic import required: prevents bundling MSW browser mocks into client production bundles
  const { worker } = await import("./browser.js");
  await worker.start({
    onUnhandledFrame: "bypass",
    serviceWorker: { url: "/mockServiceWorker.js" },
  });
}
