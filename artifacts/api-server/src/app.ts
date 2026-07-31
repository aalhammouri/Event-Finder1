import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import authRouter from "./routes/auth";
import { requireAuth } from "./middleware/auth";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());

// GuideStar organization exports are large (thousands of rows, ~50 columns).
// Accept them as a raw text/csv body, and raise the JSON limit for the
// { "csv": "..." } form. Ordinary routes keep the default-sized JSON body.
app.use(express.text({ type: ["text/csv", "text/plain"], limit: "64mb" }));
app.use(express.json({ limit: "64mb" }));
app.use(express.urlencoded({ extended: true }));

// Public auth routes — no auth middleware
app.use("/api", authRouter);

// All other API routes require a valid JWT
app.use("/api", requireAuth, router);

export default app;
