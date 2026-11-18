import { env } from '../config/env.js';
import { maybeFail, consumeFault } from '../utils/faults.js';

/**
 * Minimal text-LLM client for the PlanPilot agent. Provider-agnostic interface: generateJson()
 * returns the model's raw text; the caller parses and validates it against the actions the server
 * allows. Currently one adapter (Gemini, per the project brief); adding another means adding one
 * function to ADAPTERS. No LLM output is ever trusted without that validation.
 */

export class LlmError extends Error {
  constructor(message, { code = 'LLM_ERROR', transient = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.transient = transient;
  }
}

async function geminiGenerate({ system, prompt, config }) {
  const url = `${config.PLANPILOT_LLM_BASE_URL.replace(/\/+$/, '')}/models/${encodeURIComponent(config.PLANPILOT_LLM_MODEL)}:generateContent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.PLANPILOT_LLM_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
      }),
      signal: controller.signal
    });
  } catch (err) {
    throw err.name === 'AbortError'
      ? new LlmError(`No answer within ${config.PLANPILOT_LLM_TIMEOUT_MS} ms`, { code: 'LLM_TIMEOUT', transient: true })
      : new LlmError(`Could not reach the LLM (${err.message})`, { code: 'LLM_UNREACHABLE', transient: true });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new LlmError(`LLM returned HTTP ${res.status}`, { code: 'LLM_HTTP_ERROR', transient: res.status === 429 || res.status >= 500 });
  }
  const data = await res.json().catch(() => null);
  const text = (data?.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('').trim();
  if (!text) throw new LlmError('LLM returned an empty answer', { code: 'LLM_EMPTY', transient: true });
  return text;
}

const ADAPTERS = {
  gemini: { generate: geminiGenerate, isConfigured: (config) => Boolean(config.GEMINI_API_KEY) }
};

export function getLlmStatus(config = env) {
  const adapter = ADAPTERS[config.PLANPILOT_LLM_PROVIDER];
  const configured = Boolean(adapter?.isConfigured(config));
  return {
    provider: adapter ? config.PLANPILOT_LLM_PROVIDER : 'none',
    model: configured ? config.PLANPILOT_LLM_MODEL : null,
    configured
  };
}

/**
 * Sends one prompt and returns the raw text answer. Throws LlmError on any failure.
 */
export async function generateJson({ system, prompt, config = env }) {
  const adapter = ADAPTERS[config.PLANPILOT_LLM_PROVIDER];
  if (!adapter?.isConfigured(config)) throw new LlmError('No LLM is configured.', { code: 'LLM_NOT_CONFIGURED' });
  maybeFail('llm');
  if (consumeFault('llm_garbage')) return 'Sure! I think the patient should probably go to the nearby clinic.';
  return adapter.generate({ system, prompt, config });
}
