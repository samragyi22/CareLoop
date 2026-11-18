/**
 * Runs `work` up to `attempts` times with exponential backoff between tries.
 * Errors for which `isRetryable(err)` is false are thrown immediately.
 * The thrown error carries `attempts` (how many tries were made).
 */
export async function withRetries(work, { attempts = 3, baseDelayMs = 100, isRetryable = () => true } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work(attempt);
    } catch (err) {
      if (attempt >= attempts || !isRetryable(err)) {
        err.attempts = attempt;
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}
