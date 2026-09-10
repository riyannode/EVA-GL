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

const MAX_REQUEST_BYTES = 16_384;
const MAX_CAMPAIGNS = 100;

export const campaigns = new Map<string, StoredCampaign>();
export const app = new Hono();
app.use("*", cors());

const evaluationRequests = new Map<string, number[]>();
const RATE_WINDOW_MS = 60_000;
const MAX_EVALUATIONS_PER_WINDOW = 3;

type HeaderRequest = { req: { header(name: string): string | undefined } };
function requestIdentity(c: HeaderRequest): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

function rateLimited(identity: string): boolean {
  const now = Date.now();
  const recent = (evaluationRequests.get(identity) ?? []).filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
  if (recent.length >= MAX_EVALUATIONS_PER_WINDOW) {
    evaluationRequests.set(identity, recent);
    return true;
  }
  recent.push(now);
  evaluationRequests.set(identity, recent);
  return false;
}

function rememberCampaign(campaignId: string, campaign: StoredCampaign): void {
  if (!campaigns.has(campaignId) && campaigns.size >= MAX_CAMPAIGNS) {
    const oldest = campaigns.keys().next().value;
    if (oldest) campaigns.delete(oldest);
  }
  campaigns.set(campaignId, campaign);
}

async function readBoundedJson(c: { req: { header(name: string): string | undefined; text(): Promise<string> } }): Promise<unknown> {
  const contentLength = c.req.header("content-length");
  if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES) throw new Error("Request body exceeds 16384 bytes");
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) throw new Error("Request body exceeds 16384 bytes");
  return JSON.parse(text);
}

app.get("/health", (c) => {
  const health = genLayerHealth();
  return c.json({ ok: true, ...health });
});

app.post("/api/evaluations", async (c) => {
  if (rateLimited(requestIdentity(c))) {
    c.header("Retry-After", "60");
    return c.json({ error: "Evaluation rate limit exceeded; retry in 60 seconds" }, 429);
  }
  let input: z.infer<typeof EvaluationRequestSchema>;
  try {
    input = EvaluationRequestSchema.parse(await readBoundedJson(c));
  } catch (error) {
    return c.json({ error: error instanceof z.ZodError ? error.issues : "Invalid JSON request" }, 400);
  }

  const campaignId = crypto.randomUUID();
  rememberCampaign(campaignId, { status: "RUNNING", stage: "Starting evaluation" });
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
        onStage: (stage) => rememberCampaign(campaignId, { status: "RUNNING", stage }),
      },
    );
    rememberCampaign(campaignId, { status: result.status, stage: "Complete", result });
    return c.json(result, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Evaluation failed";
    rememberCampaign(campaignId, { status: "FAILED", stage: "Failed", error: message });
    return c.json({ campaignId, status: "FAILED", error: message }, 502);
  }
});

const port = Number(Bun.env.PORT ?? 3001);
if (import.meta.main) {
  Bun.serve({ port, fetch: app.fetch });
  console.log(`EVA backend listening on http://localhost:${port}`);
}
