const isProduction =
  process.env.NODE_ENV === "production" ||
  process.env.npm_lifecycle_event === "start" ||
  process.env.npm_lifecycle_event === "build";

export default {
  distDir: isProduction ? ".next-build" : ".next",
  allowedDevOrigins: ["127.0.0.1", "[::1]"],
};
