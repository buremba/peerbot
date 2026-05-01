import { Hono } from "hono";

export function createLandingRoutes() {
  const app = new Hono();

  app.get("/", (c) => {
    return c.json({
      name: "Lobu Gateway",
      mode: "api-only",
      docs: "/api/docs",
      health: "/health",
    });
  });

  return app;
}
