import type { ProviderDriverKind, ProviderReplayTranscript } from "@t3tools/contracts";

import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The model the recording's session actually ran: `session/new`/`session/load`
 * result `models.currentModelId`, else the model config option's current value.
 * Matches what the adapter resolves at replay, so instructions built here match
 * the ones the adapter builds for a sentinel ("default"/"auto") selection.
 */
function transcriptSessionModel(transcript: ProviderReplayTranscript): string | undefined {
  for (const entry of transcript.entries) {
    if (entry.type !== "emit_inbound") continue;
    const frame = asRecord(entry.frame);
    if (
      frame === undefined ||
      frame.kind !== "response" ||
      (frame.method !== "session/new" && frame.method !== "session/load")
    ) {
      continue;
    }
    const result = asRecord(frame.result);
    if (result === undefined) continue;
    const models = asRecord(result.models);
    const currentModelId = models?.currentModelId;
    if (typeof currentModelId === "string" && currentModelId.length > 0) {
      return currentModelId;
    }
    const configOptions = Array.isArray(result.configOptions) ? result.configOptions : [];
    // Mirrors findModelConfigOption: the conventional `model` id wins, else the
    // first category-model select (fx also carries a backend selector).
    const modelOptions = configOptions.flatMap((candidate) => {
      const option = asRecord(candidate);
      return option?.category === "model" &&
        option.type === "select" &&
        typeof option.id === "string" &&
        option.id.length > 0 &&
        typeof option.currentValue === "string" &&
        option.currentValue.length > 0
        ? [option]
        : [];
    });
    const modelOption = modelOptions.find((option) => option.id === "model") ?? modelOptions[0];
    return modelOption === undefined ? undefined : (modelOption.currentValue as string);
  }
  return undefined;
}

const isSentinelModel = (model: string) =>
  model.length === 0 || model === "auto" || model === "default";

export function materializeReplayTranscriptRuntimeInstructions(
  transcript: ProviderReplayTranscript,
  runtime: { readonly driver: ProviderDriverKind; readonly model: string },
): ProviderReplayTranscript {
  const harness =
    runtime.driver === "cursor"
      ? "Cursor"
      : runtime.driver === "grok"
        ? "Grok"
: runtime.driver === "kiro"
          ? "Kiro"
          : runtime.driver === "acpRegistry"
            ? "acpRegistry"
            : runtime.driver === "fx"
              ? "fx"
              : runtime.driver === "commandcode"
                ? "Command Code"
                : undefined;
  if (harness === undefined) return transcript;
  const effectiveModel = isSentinelModel(runtime.model)
    ? (transcriptSessionModel(transcript) ?? runtime.model)
    : runtime.model;
  const instructions = buildRuntimeInstructions({ harness, model: effectiveModel });

  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound") return entry;
      const frame = entry.frame;
      if (typeof frame !== "object" || frame === null) return entry;
      if (
        runtime.driver === "cursor" &&
        "type" in frame &&
        frame.type === "run.start" &&
        "message" in frame &&
        typeof frame.message === "string"
      ) {
        return frame.message.endsWith(instructions)
          ? entry
          : { ...entry, frame: { ...frame, message: `${frame.message}\n\n${instructions}` } };
      }
      if (
        "method" in frame &&
        frame.method === "session/prompt" &&
        "params" in frame &&
        typeof frame.params === "object" &&
        frame.params !== null &&
        "prompt" in frame.params &&
        Array.isArray(frame.params.prompt)
      ) {
        const prompt: ReadonlyArray<unknown> = frame.params.prompt;
        const lastPart = prompt.at(-1);
        if (
          typeof lastPart === "object" &&
          lastPart !== null &&
          "type" in lastPart &&
          lastPart.type === "text" &&
          "text" in lastPart &&
          typeof lastPart.text === "string" &&
          // A recording that switched models mid-thread already carries the
          // instructions for the model each prompt ran on.
          (lastPart.text === instructions || lastPart.text.startsWith("<runtime_info>"))
        ) {
          return entry;
        }
        return {
          ...entry,
          frame: {
            ...frame,
            params: { ...frame.params, prompt: [...prompt, { type: "text", text: instructions }] },
          },
        };
      }
      return entry;
    }),
  };
}
