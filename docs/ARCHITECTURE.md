# Architecture

## Purpose

EVA answers one question before authority is delegated:

> Can this autonomous agent follow its mandate under ambiguous, stale, conflicting, or adversarial conditions?

The MVP is a single Bun backend, a single React screen, one bundled target-agent behavior, one Intelligent Contract, and an in-memory campaign store.

## Runtime flow

```text
POST /api/evaluations
  → validate request
  → LangGraph: generateScenario
  → invokeTarget
  → runDeterministicChecks
  → submitGenLayerJudgment
  → recordWeakness
  → mutateScenario (episodes 2 and 3)
  → finalize readiness deterministically
```

`graph.ts` makes the adaptive loop explicit. Episode 1 has no parent. Later episodes record `parentEpisodeId`, `targetedWeakness`, `difficulty`, and `mutationReason`. There is no unbounded loop.

## Trust boundary

### Bun/TypeScript owns

- Request validation and bounded input.
- Target-agent HTTP invocation and response schema validation.
- Scenario generation for the reproducible MVP.
- Objective findings: budget cap, duplicate evidence, recurring fee, stale evidence, conflicting evidence, and forbidden instruction override.
- Episode penalties, hard gates, and campaign status.
- GenLayer transaction tracking and final judgment readback.

### GenLayer owns

- The subjective semantic judgment of the observed behavior.
- The structured fields `verdict`, `severity`, `mandate_alignment`, `evidence_sufficiency`, `material_weakness`, `weakness_category`, and `reason`.
- Independent validator assessment of the same original evidence and criteria.
- Minimal per-episode judgment storage keyed by episode ID.

### Target agent owns

- Only its own response. Its response is untrusted input. EVA does not trust a claimed role, price, evidence status, or reasoning string from the target.

## Intelligent Contract

`backend/contracts/eva_evaluator.py` has one write method, `evaluate(payload)`, and one view, `get_evaluation(episode_id)`.

The write method:

1. Validates the canonical JSON payload.
2. Runs an LLM-based subjective assessment in a nondeterministic block.
3. Re-runs the same assessment independently for validators.
4. Compares only decision-bearing fields with explicit numeric tolerance.
5. Does not compare prose in `reason` byte-for-byte.
6. Stores the accepted structured result for readback.

Malformed leader output fails before semantic comparison. A leader/validator disagreement cannot be turned into a successful application result by the Bun layer.

The contract starts with a concrete pinned GenVM runner hash. The currently installed stable `genlayer-py 0.16.3` / `genvm-linter 0.11.0` pair validates that hash; the linter reports a newer runner that is not loadable by this SDK pair, so the project does not mix them.

## GenLayer client correctness

`genlayer.ts`:

1. Creates a client only when network, contract address, and private key are configured.
2. Submits exactly one `evaluate` transaction for an episode.
3. Waits for `FINALIZED` using the same transaction hash.
4. Requires lifecycle `ACCEPTED` or `FINALIZED` **and** `FINISHED_WITH_RETURN` execution.
5. Reads `get_evaluation(episodeId)` from the contract.
6. Converts missing configuration, failed execution, timeout ambiguity, or malformed readback into `UNCERTAIN`; it never creates `PASS` from those paths.

Stable Studionet and Studio-dev are never conflated. The stable SDK intentionally rejects `studio-dev` until a matching RC SDK is installed.

## Scoring

The final score is a pure function of accepted episode data. GenLayer does not calculate or override the campaign score. See the readiness policy in `README.md` and the reproducible walkthrough in `docs/DEMO.md`.

## Scaling and limitations

The evaluator is stateless except for an in-memory map for the hackathon demo. A production deployment would need shared persistence and distributed request controls before horizontal scaling. Those are deliberately not added to the MVP because persistence is not required by the demonstrated flow.
