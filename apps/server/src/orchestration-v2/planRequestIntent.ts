/**
 * True when a message asks T3 to plan rather than to implement. Plan-mode entry
 * must not fire on messages that merely mention a plan ("fix the plan cache",
 * "implement the plan"), so every pattern demands request framing around the
 * plan words.
 */
export function messageRequestsPlanMode(text: string): boolean {
  return (
    PLAN_NOUN_REQUEST.test(text) || LETS_PLAN_REQUEST.test(text) || PLAN_VERB_REQUEST.test(text)
  );
}

const LETS_PLAN_REQUEST = /\blet['’]?s\s+(?:plan|plan out)\b/i;
const PLAN_VERB_REQUEST =
  /(?:^|[.!?]\s+|,\s*|\b(?:and|then|so)\s+)\s*(?:plan|plan out)\s+(?:a|an|the|out|our|my|how)\b/i;
const PLAN_NOUN_REQUEST =
  /\b(?:make|create|write|draft|revise|refine|update|come\s+up\s+with)\s+(?:a\s+|the\s+|this\s+|our\s+)?plan\b(?!\s+(?:file|cache|mode)\b)/i;
