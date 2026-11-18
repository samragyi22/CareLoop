import { env } from '../config/env.js';

/**
 * Failure injection for tests and demos: makes a named step fail the next `times` times, so
 * retries, fallbacks, and escalation can be shown working. Never active in production.
 *
 * Named points: see FAULT_POINTS. Most make a step throw; 'slot_taken' and 'llm_garbage' change
 * what happens instead (someone else books the slot first; the LLM answers with nonsense).
 */

export const FAULT_POINTS = {
  directory: 'The service directory is unavailable during a feasibility check',
  slot_taken: 'Someone else books the chosen slot just before PlanPilot does',
  approval_execution: 'The booking system errors while booking an approved option',
  agent_action: 'An agent action fails with a technical error',
  llm: 'The LLM service is unreachable',
  llm_garbage: 'The LLM answers with text that is not a valid decision'
};

const armed = new Map(); // name -> { remaining, message }

export class InjectedFault extends Error {
  constructor(name, message) {
    super(message || `Injected failure at "${name}".`);
    this.name = 'InjectedFault';
    this.faultPoint = name;
    this.transient = true;
  }
}

export function armFault(name, { times = 1, message = null } = {}) {
  if (env.NODE_ENV === 'production') return;
  armed.set(name, { remaining: times, message });
}

export function clearFaults() {
  armed.clear();
}

export function listArmedFaults() {
  return [...armed.entries()].map(([name, { remaining }]) => ({ name, remaining }));
}

/**
 * Throws if a fault is armed at this point (and counts it down).
 */
export function maybeFail(name) {
  if (env.NODE_ENV === 'production') return;
  const fault = armed.get(name);
  if (!fault || fault.remaining <= 0) return;
  fault.remaining -= 1;
  if (fault.remaining === 0) armed.delete(name);
  throw new InjectedFault(name, fault.message);
}

/**
 * For faults that change behaviour instead of throwing: true (and counts down) if armed.
 */
export function consumeFault(name) {
  if (env.NODE_ENV === 'production') return false;
  const fault = armed.get(name);
  if (!fault || fault.remaining <= 0) return false;
  fault.remaining -= 1;
  if (fault.remaining === 0) armed.delete(name);
  return true;
}
