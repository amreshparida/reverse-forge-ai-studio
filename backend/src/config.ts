import * as dotenv from 'dotenv';
import path from 'path';

// Anchor runtime data dirs to the backend package root, not process.cwd().
// This ensures logs/, project-output/, sessions/ always land inside backend/
// regardless of which directory the server is launched from.
const BACKEND_ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(BACKEND_ROOT, '.env') });

function requireEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  port: parseInt(process.env['PORT'] ?? '3001', 10),
  // Local-only by default because captures and reports may contain sensitive application data.
  host: process.env['HOST'] ?? '127.0.0.1',
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  outputDir: process.env['OUTPUT_DIR'] || path.join(BACKEND_ROOT, 'project-output'),
  sessionDir: process.env['SESSION_DIR'] || path.join(BACKEND_ROOT, 'sessions'),

  llm: {
    // undefined = use the OpenAI SDK default (https://api.openai.com/v1)
    // Set this only when using a different provider (Ollama, Azure, Groq, etc.)
    baseUrl: process.env['LLM_BASE_URL'] || undefined,
    apiKey: process.env['LLM_API_KEY'] ?? '',
    model: process.env['LLM_MODEL'] ?? 'gpt-4o-mini',
    /**
     * Optional cheaper / vision-capable model for page-analysis + image OCR only.
     * Falls back to LLM_* when unset. Must support vision if OCR is enabled.
     */
    analysisBaseUrl: process.env['ANALYSIS_LLM_BASE_URL'] || undefined,
    analysisApiKey: process.env['ANALYSIS_LLM_API_KEY'] || undefined,
    analysisModel: process.env['ANALYSIS_LLM_MODEL'] || undefined,
    /** Parallel LLM calls for page-analysis (+ image OCR). Default 5. */
    analysisConcurrency: Math.max(1, parseInt(process.env['ANALYSIS_CONCURRENCY'] ?? '5', 10) || 5),
    /** Parallel LLM calls for expert report chunk analysis. Default 3 (large prompts). */
    expertConcurrency: Math.max(
      1,
      parseInt(process.env['EXPERT_CONCURRENCY'] ?? process.env['ANALYSIS_CONCURRENCY'] ?? '3', 10) || 3,
    ),
    /**
     * After page-analysis: explore local page-analysis files via tools (Cursor-style)
     * instead of stuffing all JSON into one prompt. Set SYNTHESIS_AGENT=false to use legacy chatJson.
     */
    synthesisAgentEnabled: process.env['SYNTHESIS_AGENT'] !== 'false',
    /** LLM turns per synthesis stage (each turn may call multiple tools). Higher = more thorough reads. */
    synthesisMaxSteps: Math.max(8, parseInt(process.env['SYNTHESIS_AGENT_MAX_STEPS'] ?? '120', 10) || 120),
    /**
     * Hard ceiling when the agent auto-extends its step budget to finish coverage.
     * Prevents infinite loops while allowing large corpora (e.g. hundreds of graph chunks).
     */
    synthesisMaxStepsCeiling: Math.max(
      120,
      parseInt(process.env['SYNTHESIS_AGENT_MAX_STEPS_CEILING'] ?? '3000', 10) || 3000,
    ),
    /**
     * Optional separate OpenAI-compatible endpoint for synthesis agents only
     * (entity / workflow / permission / architecture / KG / specialists).
     * Typical: NVIDIA NIM at https://integrate.api.nvidia.com/v1
     * Falls back to LLM_* when unset.
     */
    synthesisBaseUrl: process.env['SYNTHESIS_LLM_BASE_URL'] || undefined,
    synthesisApiKey: process.env['SYNTHESIS_LLM_API_KEY'] || undefined,
    synthesisModel: process.env['SYNTHESIS_LLM_MODEL'] || undefined,
  },

  crawler: {
    timeoutMs: parseInt(process.env['CRAWL_TIMEOUT_MS'] ?? '30000', 10),
    delayMs: parseInt(process.env['CRAWL_DELAY_MS'] ?? '1000', 10),
    maxConcurrency: parseInt(process.env['CRAWL_MAX_CONCURRENCY'] ?? '2', 10),
    // Set CRAWL_HEADLESS=false to open a visible browser window during crawling
    headless: process.env['CRAWL_HEADLESS'] !== 'false',
    /** Agentic crawl LLM action budget (steps ≠ unique pages) */
    agentMaxSteps: Math.max(1, parseInt(process.env['AGENT_MAX_STEPS'] ?? '150', 10) || 150),
    /** Maximum duration for a human-guided crawl before it is finalized automatically. */
    manualMaxDurationMs: Math.max(
      60_000,
      (parseInt(process.env['MANUAL_CRAWL_MAX_MINUTES'] ?? '240', 10) || 240) * 60_000,
    ),
  },

  rateLimit: {
    windowMs: parseInt(process.env['RATE_LIMIT_WINDOW_MS'] ?? '60000', 10),
    max: parseInt(process.env['RATE_LIMIT_MAX'] ?? '100', 10),
  },

  security: {
    /** Optional bearer/X-API-Key required for API and static evidence endpoints. */
    apiAuthToken: process.env['API_AUTH_TOKEN'] || undefined,
  },

  isDev(): boolean {
    return this.nodeEnv !== 'production';
  },
} as const;
