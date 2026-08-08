# Bedrock model comparison (us-east-1)

Reference for picking/repointing `low`/`med`/`high` tier models (`src/config.ts`
`TIER_DEFAULTS`). Update this table when tiers change or when re-probing.

**Methodology:** prices are pulled from the AWS Pricing API
(`aws pricing list-price-lists` / `get-price-list-file-url`, `AmazonBedrock` service code,
us-east-1, standard on-demand tier — not priority/flex/batch), not from marketing pages or
AI-generated summaries, which have previously included fabricated model ids and prices (see
memory `feedback-verify-ai-writeups`). Anthropic current-generation prices aren't in that
feed; they come from the rate card embedded in
`aws bedrock list-foundation-model-agreement-offers`. Invocability was checked live via
`aws bedrock-runtime converse`, per-model — the model catalog (`list-foundation-models`)
lists everything regardless of whether an account can actually call it (see memory
`project-bedrock-model-access`). All data as of 2026-08-06.

## Our requirements

- **Input context:** must comfortably exceed the largest observed prompt. A `maintain` run
  was observed sending **>24K input tokens**; Qwen3 32B's 32K window was too tight in
  practice and `med` was moved to Nova Pro's 300K window as a result.
  Treat anything under ~100K context as risky for `med`/`high`; `low` tier prompts are
  short and not affected.
- **Output budget:** configured via `maxTokens` per tier — `med` = 8,192, `high` = 32,768
  (`high`'s tier exists specifically for judge escalation, which needs headroom for
  reasoning/thinking output on top of the answer).
- **Request shape:** families differ on whether they accept `temperature` vs `effort`
  (never both) and on inference-profile prefix (`global.`, `us.`, or bare id). See
  `src/bedrock/families.ts`. A model can't be dropped into a tier without a matching family
  entry.
- **Structured output reliability:** JSON responses (librarian/heal, judge verdicts) must be
  reliable. Nova Lite was tried for `med` and rejected on this basis even though it's
  cheaper than Nova Pro.
- **`high` must be a real capability step up from `med`**, not a repointed model of similar
  strength — otherwise judge escalation testing (`med` → `high`) can't distinguish
  "escalation doesn't help" from "escalation was never really tested." See memory
  `project-cortex-judge-design`.

## Comparison table

Prices are $ per 1M tokens, standard on-demand tier, us-east-1.

| Model | Provider | Max input | In $/1M | Out $/1M | Invocable now? | Notes |
|---|---|---|---|---|---|---|
| **Nova Pro** (current `med`) | Amazon | 300K | $0.80 | $3.20 | Yes | bare id, `TEMPERATURE_ONLY`. ⚠️ **only model capped at 10K output** — forces `MAX_TOKENS_MED=9999` |
| Nova Lite | Amazon | 300K | — | — | Yes | rejected for `med`: unreliable structured JSON output |
| Qwen3 32B | Qwen | 32K | $0.15 | $0.60 | Yes | too small a context window for `maintain` prompts |
| Kimi K2 Thinking | Moonshot AI | 256K | $0.60 | $2.50 | Yes | ⚠️ **tested: flaky** — 433–2933 out tokens, inconsistent verdict at temp 0. Per-token price is misleading |
| Kimi K2.5 | Moonshot AI | 256K | $0.60 | $3.00 | Yes | non-thinking variant, multimodal |
| Mistral Large 3 (675B) | Mistral AI | 256K | $0.50 | $1.50 | Yes | **tested: fails case B** |
| Qwen3 VL 235B A22B | Qwen | 256K | $0.53 | $2.66 | Yes | vision-capable MoE |
| Qwen3 Coder Next | Qwen | 256K | $0.50 | $1.20 | Yes | coding-agent focused |
| Qwen3 Next 80B A3B | Qwen | 256K | $0.14 | $1.20 | Yes | **tested: fails case B**; only 3B active params (MoE) |
| NVIDIA Nemotron 3 Super 120B | NVIDIA | 262K | $0.15 | $0.65 | Yes | ⚠️ **tested: fails case A** on re-run (passed once, then 3/3 fail) |
| MiniMax M2 | MiniMax | 400K | $0.30 | $1.20 | Yes | |
| MiniMax M2.5 | MiniMax | 196K | $0.30 | $1.20 | Yes | **tested: answers `overturn` to everything** |
| MiniMax M2.1 | MiniMax | 196K | $0.30 | $1.20 | Yes | |
| Devstral 2 123B | Mistral AI | 256K | $0.40 | $2.00 | Yes | coding-agent focused, not general judge use |
| NVIDIA Nemotron Nano 3 30B | NVIDIA | 256K | $0.06 | $0.24 | Yes | cheapest of all — but **tested: fails case A** |
| GLM 5 | Z.AI | 203K | $1.00 | $3.20 | Yes | **tested 3/3 stable**; pricier than Nova Pro on input |
| GLM 4.7 | Z.AI | 203K | $0.60 | $2.20 | Yes | **tested 3/3 stable**; fallback if Flash regresses on heal |
| **GLM 4.7 Flash** | Z.AI | 203K | $0.07 | $0.40 | Yes | ✅ **recommended `med`/`low`** — 3/3 stable, ~10x cheaper than Nova Pro, 32K output |
| **DeepSeek V3.2** | DeepSeek | 164K | $0.62 | $1.85 | Yes | ✅ **recommended `high`** — 3/3 stable, different vendor from `med`. Id is `deepseek.v3.2` (lowercase) |
| DeepSeek-R1 (`deepseek.r1-v1:0`) | DeepSeek | — | — | — | Untested | not evaluated as a candidate. Recorded here only because its inference type is `INFERENCE_PROFILE` (verified live via `aws bedrock get-foundation-model`, 2026-08-06), unlike V3.2's `ON_DEMAND` — this is why the `deepseek` family in `src/bedrock/families.ts` matches `deepseek.v3.2` exactly rather than by `deepseek.` prefix |
| Llama 3.3 70B | Meta | 128K | $0.72 | $0.72 | Yes | flat rate, same price both directions; `us.` inference profile required |
| Llama 3.1 70B | Meta | 128K | $0.72 | $0.72 | Yes | flat rate; `us.` inference profile required |
| Llama 3.1 8B | Meta | 128K | $0.22 | $0.22 | Yes | flat rate; `us.` inference profile required |
| Llama 4 Maverick 17B | Meta | 1M | — | — | Untested | requires an inference profile (`INFERENCE_PROFILE`, not `ON_DEMAND`) |
| Llama 4 Scout 17B | Meta | 3.5M | — | — | Untested | requires an inference profile |
| Nova Micro | Amazon | — | $0.035 | $0.14 | Yes | **tested: abstains on everything** — too weak to judge |
| Nova Premier | Amazon | 1M | — | — | **No** | provider-deprecated: "marked Legacy, not actively used in 30 days" — no self-service reactivation |
| Claude Haiku 4.5 (current `low`) | Anthropic | 1M | $1.10 | $5.50 | Yes | requires `global.` prefix inference profile |
| Claude Opus 4.6 (current `high`, pre-Kimi) | Anthropic | 1M | — | — | Yes | `TEMPERATURE_ONLY`; kept as fallback since EULA-gated 5-gen models are AccessDenied |
| Claude Sonnet 5 | Anthropic | 1M | $2.00 | $10.00 | **No — EULA accepted 2026-08-06, still AccessDeniedException live** | see below |
| Claude Opus 5 | Anthropic | 1M | $5.00 | $25.00 | **No — EULA accepted 2026-08-06, still AccessDeniedException live** | see below |

Blank In/Out cells mean pricing wasn't collected for that row (not needed for the decision
in hand); fill in before relying on them.

## Empirical evaluation (2026-08-06)

Price alone was not enough to choose: Nova Lite had already been rejected for `med` on output
quality despite being cheaper. So candidates were tested against this repo's *real* prompts
rather than ranked by headline price.

**What was tested.** Three judge cases using the verbatim `SYSTEM_PROMPT_MED` contract from
`src/judge/assess.ts`, each with a known-correct answer, at `temperature: 0`:

| Case | Scenario | Correct verdict |
|---|---|---|
| A | Same document reached by two paths (a real pattern from our corpus) | `misfiled` |
| B | Two facts about *different* teams' headcount — no actual conflict | `overturn` |
| C | Genuine supersession, detector correctly picked the older/lower-confidence side | `uphold` |

Case C is the control: without it, a model biased toward `overturn` scores well on B by luck.
Plus an ingest test using the library's real `INGEST_SYSTEM_PROMPT`
(`@equationalapplications/core-llm-wiki`) on a document chunk.

**Every candidate was run at least 3 times.** This mattered — see Nemotron Super below.

| Model | A | B | C | Verdict consistency | Output tokens |
|---|---|---|---|---|---|
| Nova Pro (current `med`) | ✅ | ✅ | ✅ | consistent | 51–69 |
| **GLM 4.7 Flash** | ✅✅✅ | ✅✅✅ | ✅✅✅ | **3/3 stable** | 52–80 |
| GLM 4.7 | ✅✅✅ | ✅✅✅ | ✅✅✅ | 3/3 stable | 54–88 |
| GLM 5 | ✅✅✅ | ✅✅✅ | ✅✅✅ | 3/3 stable | 60–92 |
| **DeepSeek V3.2** | ✅✅✅ | ✅✅✅ | ✅✅✅ | **3/3 stable** | 74–106 |
| Kimi K2 Thinking | ❌✅✅ | ✅✅✅ | ✅✅✅ | **flaky on A** | 433–2933 |
| Nemotron 3 Super 120B | ✅ then ❌❌❌ | ✅ | ✅✅✅ | **fails A on re-run** | 60–112 |
| Nemotron Nano 3 30B | ❌ | ✅ | — | fails A | 54–64 |
| Qwen3 Next 80B A3B | ✅ | ❌ | — | fails B | 70–81 |
| MiniMax M2.5 | ❌ | ✅ (bias) | — | answers `overturn` to everything | 406–438 |
| Mistral Large 3 | ✅ | ❌ | — | fails B | 69–72 |
| Nova Micro | abstain | abstain | — | too weak to judge | 69–91 |

### Findings that price tables do not show

1. **Nova Pro is the only candidate capped at 10,000 output tokens.** Every other model
   accepted `maxTokens: 32768`. This cap is why `MAX_TOKENS_MED` is pinned to `9999` in
   `infra/stack.ts`, and why `doRunHeal` responses were truncating. Moving `med` off Nova Pro
   removes a live constraint, it doesn't just save money.
2. **Repeat trials are mandatory.** Nemotron 3 Super 120B passed case A on its first run and
   then failed it 3/3 on re-runs. A single-trial comparison would have selected it.
3. **Kimi K2 Thinking is not the bargain its per-token price suggests.** It burned 433–2933
   output tokens (vs ~50–110 for the stable alternatives) and its token count and *verdict* both varied
   at `temperature: 0`. On the measured ingest chunk it used 2,933 output tokens against Nova
   Pro's 533. Its headline $2.50/1M output is ~10× more expensive per actual call.
   Its reasoning does at least land in a separate `reasoningContent` block, so it cannot
   corrupt JSON parsing — but the inconsistency on case A (the "most expensive answer you can
   give", per our own prompt) is disqualifying for a judge.
4. **GLM 4.7 Flash, GLM 4.7, GLM 5 and DeepSeek V3.2 wrap replies in markdown fences** despite
   the prompt saying not to. Harmless *only* because both `parseJsonResponse` (library) and
   `extractJson` (`src/judge/assess.ts`) slice from the first `{` to the last `}`. Worth
   knowing before writing any stricter parser.
5. **Family shapes** — GLM (`zai.*`) and DeepSeek (`deepseek.*`) both probed `TEMPERATURE_ONLY`
   with bare ids only (`us.`/`global.` are invalid identifiers). The `effort` negative control
   was *accepted* by both, so like `qwen` these validate permissively and `effort` must be
   treated as unsupported.

### Measured cost per call

Using `usage.inputTokens`/`usage.outputTokens` actually returned by `Converse`, not
estimated, against list price:

| Workload | Nova Pro (in/out tokens) | Cost | GLM 4.7 Flash (in/out tokens) | Cost | Ratio |
|---|---|---|---|---|---|
| Ingest chunk | 295 / 558 | $0.00202 | 276 / 473 | $0.00021 | **9.7× cheaper** |
| Judge med call (case B) | 496 / 63 | $0.00060 | 488 / 59 | $0.00006 | **~10× cheaper** |

DeepSeek V3.2 (the `high` pick) measured 74–106 output tokens across the three judge cases
in the table above, not a flat number — see §3.3's recommendation, which quotes the range
rather than a single figure.

## Recommendation (2026-08-06)

| Tier | From | To | Why |
|---|---|---|---|
| `low` | `anthropic.claude-haiku-4-5` ($1.10/$5.50) | `zai.glm-4.7-flash` | **The tier has zero call sites** — nothing invokes it. It is currently pointed at the most expensive per-token model in the stack, costing $0 only by accident. Repoint defensively so a future call site cannot silently bill Anthropic rates. |
| `med` | `amazon.nova-pro-v1:0` ($0.80/$3.20) | `zai.glm-4.7-flash` ($0.07/$0.40) | ~10× cheaper on measured workloads, 3/3 stable on all judge cases, 203K context, and a 32K output ceiling that removes the `MAX_TOKENS_MED=9999` truncation constraint. |
| `high` | `moonshot.kimi-k2-thinking` | `deepseek.v3.2` ($0.62/$1.85) | 3/3 stable where Kimi was flaky; 74–106 output tokens across the three cases; 164K context; 32K output. Crucially it is a **different vendor from `med`** — a same-family `high` would share `med`'s blind spots and systematically agree with it, which would quietly invalidate the judge's control-arm comparison (`src/judge/assess.ts` §5.2). |

### Caveats

- Three synthetic cases are evidence, not proof. They were built to be discriminating, but
  they are not our real corpus. Validate with a live `maintain` run before trusting the
  `med` change broadly — compare `g3UntypedFacts` movement and `op_stats` against the
  Nova Pro baseline.
- GLM 4.7 Flash is a small MoE model. The `doRunHeal` prompt (a full fact dump) is materially
  harder than anything tested here. If heal quality regresses, GLM 4.7 (non-Flash, $0.60/$2.20)
  is the natural fallback — same family, same request shape, 3/3 on these cases.
- Adopting these requires new `zai` and `deepseek` family entries in `src/bedrock/families.ts`
  and matching resource ARNs in `infra/stack.ts`, or invocation fails with AccessDenied.

## Anthropic models (kept for future reference — not currently in use)

Opus 5 and Sonnet 5 are markedly more expensive than every non-Anthropic candidate above —
Opus 5 is ~8x Nova Pro's output price, ~10x Kimi K2 Thinking's. Haiku 4.5 (the current `low`
tier) is comparable in price to `med`-tier candidates like Kimi K2 Thinking, not
meaningfully cheap, which is worth remembering if `low` is ever revisited.
