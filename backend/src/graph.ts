import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  calculateReadiness,
  generateScenario,
  invokeTarget,
  runDeterministicChecks,
  scoreEpisode,
  weaknessFor,
  type CampaignResult,
  type Episode,
  type EvaluationInput,
  type Finding,
  type Judgment,
  type GenLayerEvidence,
  type Scenario,
  type TargetResponse,
} from "./evaluator";

export type CampaignServices = {
  judge: (input: EvaluationInput) => Promise<{
    judgment: Judgment;
    evidence: GenLayerEvidence;
  }>;
  onStage?: (stage: string) => void;
};

type CampaignState = {
  campaignId: string;
  targetAgentUrl: string;
  mandate: string;
  authorityProfile: string;
  episodeIndex: number;
  maxEpisodes: number;
  currentScenario: Scenario | null;
  currentResponse: TargetResponse | null;
  currentFindings: Finding[];
  currentJudgment: Judgment | null;
  currentEvidence: GenLayerEvidence | null;
  weaknesses: string[];
  episodes: Episode[];
};

const State = Annotation.Root({
  campaignId: Annotation<string>,
  targetAgentUrl: Annotation<string>,
  mandate: Annotation<string>,
  authorityProfile: Annotation<string>,
  episodeIndex: Annotation<number>,
  maxEpisodes: Annotation<number>,
  currentScenario: Annotation<Scenario | null>,
  currentResponse: Annotation<TargetResponse | null>,
  currentFindings: Annotation<Finding[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  currentJudgment: Annotation<Judgment | null>,
  currentEvidence: Annotation<GenLayerEvidence | null>,
  weaknesses: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  episodes: Annotation<Episode[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
});

function stage(services: CampaignServices, value: string): void {
  services.onStage?.(value);
}

export async function runCampaign(input: {
  campaignId: string;
  targetAgentUrl: string;
  mandate: string;
  authorityProfile: string;
  maxEpisodes: number;
}, services: CampaignServices): Promise<CampaignResult> {
  const generateScenarioNode = async (state: typeof State.State) => {
    stage(services, "Generating adversarial scenario");
    const previous = state.episodes.at(-1);
    return {
      currentScenario: generateScenario(
        state.campaignId,
        state.episodeIndex,
        state.weaknesses,
        previous?.id ?? null,
      ),
    };
  };

  const invokeTargetNode = async (state: typeof State.State) => {
    if (!state.currentScenario) throw new Error("Scenario was not generated");
    stage(services, "Testing target agent");
    return { currentResponse: await invokeTarget(state.targetAgentUrl, state.currentScenario) };
  };

  const deterministicNode = async (state: typeof State.State) => {
    if (!state.currentScenario || !state.currentResponse) throw new Error("Target response is missing");
    stage(services, "Running deterministic checks");
    return {
      currentFindings: runDeterministicChecks(state.mandate, state.currentScenario, state.currentResponse),
    };
  };

  const judgmentNode = async (state: typeof State.State) => {
    if (!state.currentScenario || !state.currentResponse) throw new Error("Evaluation evidence is missing");
    stage(services, "Waiting for GenLayer judgment");
    const result = await services.judge({
      campaignId: state.campaignId,
      episodeId: state.currentScenario.id,
      mandate: state.mandate,
      authorityProfile: state.authorityProfile,
      scenario: state.currentScenario,
      response: state.currentResponse,
      deterministicFindings: state.currentFindings,
    });
    return { currentJudgment: result.judgment, currentEvidence: result.evidence };
  };

  const recordNode = async (state: typeof State.State) => {
    if (!state.currentScenario || !state.currentResponse || !state.currentJudgment || !state.currentEvidence) {
      throw new Error("Cannot record incomplete episode");
    }
    const weakness = weaknessFor(state.currentFindings, state.currentJudgment);
    const episode: Episode = {
      id: state.currentScenario.id,
      index: state.episodeIndex,
      scenario: state.currentScenario,
      response: state.currentResponse,
      deterministicFindings: state.currentFindings,
      judgment: state.currentJudgment,
      genlayerEvidence: state.currentEvidence,
      score: scoreEpisode(state.currentFindings, state.currentJudgment),
      weakness,
    };
    return {
      episodes: [episode],
      weaknesses: weakness ? [weakness] : [],
    };
  };

  const mutateScenarioNode = async (state: typeof State.State) => {
    stage(services, "Mutating next scenario");
    const nextIndex = state.episodeIndex + 1;
    const previous = state.episodes.at(-1);
    return {
      episodeIndex: nextIndex,
      currentScenario: generateScenario(state.campaignId, nextIndex, state.weaknesses, previous?.id ?? null),
      currentResponse: null,
      currentFindings: [],
      currentJudgment: null,
      currentEvidence: null,
    };
  };

  const shouldContinue = (state: typeof State.State) =>
    state.episodeIndex + 1 < state.maxEpisodes ? "mutateScenario" : END;

  const graph = new StateGraph(State)
    .addNode("generateScenario", generateScenarioNode)
    .addNode("invokeTarget", invokeTargetNode)
    .addNode("runDeterministicChecks", deterministicNode)
    .addNode("submitGenLayerJudgment", judgmentNode)
    .addNode("recordWeakness", recordNode)
    .addNode("mutateScenario", mutateScenarioNode)
    .addEdge(START, "generateScenario")
    .addEdge("generateScenario", "invokeTarget")
    .addEdge("invokeTarget", "runDeterministicChecks")
    .addEdge("runDeterministicChecks", "submitGenLayerJudgment")
    .addEdge("submitGenLayerJudgment", "recordWeakness")
    .addConditionalEdges("recordWeakness", shouldContinue)
    .addEdge("mutateScenario", "invokeTarget")
    .compile();

  const result = await graph.invoke({
    campaignId: input.campaignId,
    targetAgentUrl: input.targetAgentUrl,
    mandate: input.mandate,
    authorityProfile: input.authorityProfile,
    episodeIndex: 0,
    maxEpisodes: input.maxEpisodes,
    currentScenario: null,
    currentResponse: null,
    currentFindings: [] as Finding[],
    currentJudgment: null,
    currentEvidence: null,
    weaknesses: [],
    episodes: [],
  });
  const readiness = calculateReadiness(result.episodes);
  return {
    campaignId: result.campaignId,
    status: readiness.status,
    score: readiness.score,
    episodes: result.episodes,
    weaknesses: readiness.weaknesses,
    genlayerEvidence: result.episodes.map((episode) => episode.genlayerEvidence),
  };
}
