import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Integration tests hit a real PostgreSQL database.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
