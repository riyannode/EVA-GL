import { cors } from "hono/cors";
import { Hono } from "hono";
import { z } from "zod";
import { runCampaign } from "./graph";
import { createGenLayerJudge, genLayerHealth } from "./genlayer";
import type { CampaignResult } from "./evaluator";

const targetUrlSchema = z.string().min(1).max(2_000).refine((value) => {
  if (value.startsWith("demo://")) return true;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}, "Use demo://unsafe-agent or an http(s) URL");

const EvaluationRequestSchema = z.object({
  targetAgentUrl: targetUrlSchema,
  mandate: z.string().min(20).max(4_000),
  authorityProfile: z.string().min(1).max(100),
  episodes: z.number().int().min(1).max(3).default(3),
});

type StoredCampaign = {
  status: "RUNNING" | "READY" | "CONDITIONALLY_READY" | "NOT_READY" | "FAILED";
  stage: string;
  result?: CampaignResult;
  error?: string;
};

export const campaigns = new Map<string, StoredCampaign>();
export const app = new Hono();
app.use("*", cors());

app.get("/health", (c) => {
  const health = genLayerHealth();
  return c.json({ ok: true, ...health });
});

app.post("/api/evaluations", async (c) => {
  let input: z.infer<typeof EvaluationRequestSchema>;
  try {
    input = EvaluationRequestSchema.parse(await c.req.json());
  } catch (error) {
    return c.json({ error: error instanceof z.ZodError ? error.issues : "Invalid JSON request" }, 400);
  }

  const campaignId = crypto.randomUUID();
  campaigns.set(campaignId, { status: "RUNNING", stage: "Starting evaluation" });
  try {
    const result = await runCampaign(
      {
        campaignId,
        targetAgentUrl: input.targetAgentUrl,
        mandate: input.mandate,
        authorityProfile: input.authorityProfile,
        maxEpisodes: input.episodes,
      },
      {
        judge: createGenLayerJudge(),
        onStage: (stage) => campaigns.set(campaignId, { status: "RUNNING", stage }),
      },
    );
    campaigns.set(campaignId, { status: result.status, stage: "Complete", result });
    return c.json(result, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Evaluation failed";
    campaigns.set(campaignId, { status: "FAILED", stage: "Failed", error: message });
    return c.json({ campaignId, status: "FAILED", error: message }, 502);
  }
});

const port = Number(Bun.env.PORT ?? 3001);
if (import.meta.main) {
  Bun.serve({ port, fetch: app.fetch });
  console.log(`EVA backend listening on http://localhost:${port}`);
}
