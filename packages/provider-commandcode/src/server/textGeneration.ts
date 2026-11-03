import { TextGenerationError } from "@t3tools/contracts";
import type { CommandcodeSettings } from "../settings.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectStreamAsString } from "@t3tools/provider-core/server/snapshotProbe";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { commandcodeBinaryPath } from "./acpSupport.ts";

const TEXT_GENERATION_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

const ResultLine = Schema.fromJsonString(
  Schema.Struct({
    subtype: Schema.String,
    finalText: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
  }),
);
const decodeResultLine = Schema.decodeUnknownOption(ResultLine);

/** The last `{"type":"result",...}` line of the headless NDJSON stream. */
export function commandcodeHeadlessResult(output: string): string | undefined {
  const lines = output.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith('{"type":"result"')) continue;
    const parsed = Option.getOrUndefined(decodeResultLine(line));
    if (parsed === undefined) return undefined;
    if (parsed.subtype !== "success") {
      return undefined;
    }
    return parsed.finalText ?? undefined;
  }
  return undefined;
}

export function commandcodeHeadlessError(output: string, exitCode: number): string {
  const lines = output.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith('{"type":"result"')) continue;
    const parsed = Option.getOrUndefined(decodeResultLine(line));
    if (parsed?.subtype !== undefined && parsed.subtype !== "success") {
      return parsed.error ?? `Command Code headless run ended with ${parsed.subtype}.`;
    }
  }
  return `Command Code headless run failed with exit code ${exitCode}.`;
}

/** T3's "default"/"auto" sentinels select the session's own model, never a `-m` value. */
export function commandcodeHeadlessArgs(model: string): ReadonlyArray<string> {
  const trimmed = model.trim();
  const args = ["-p", "--no-session", "--output-format", "json", "--skip-onboarding"];
  if (trimmed.length > 0 && trimmed !== "default" && trimmed !== "auto") {
    args.push("-m", trimmed);
  }
  return args;
}

export const makeCommandcodeTextGeneration = Effect.fn("makeCommandcodeTextGeneration")(
  function* (
    settings: CommandcodeSettings,
    platform: NodeJS.Platform,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const runCommandcodeJson: TextGenerationOperations.Runner = Effect.fn(
      "CommandcodeTextGeneration.runCommandcodeJson",
    )(function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;

      const produced = yield* Effect.gen(function* () {
        const command = commandcodeBinaryPath(settings.binaryPath, platform);
        const spawnCommand = yield* resolveSpawnCommand(
          command,
          commandcodeHeadlessArgs(modelSelection.model),
          { env: environment },
        );
        const child = yield* commandSpawner.spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd,
            env: environment,
            shell: spawnCommand.shell,
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectStreamAsString(child.stdout),
            collectStreamAsString(child.stderr),
            // A headless run that exits before reading stdin closes the pipe;
            // its exit code and stderr carry the real failure.
            Stream.run(Stream.encodeText(Stream.make(prompt)), child.stdin).pipe(Effect.exit),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map(([out, err, _written, code]) => [out, err, code] as const));
        const output = `${stdout}\n${stderr}`;
        if (exitCode !== 0) {
          return yield* new TextGenerationError({
            operation,
            detail: commandcodeHeadlessError(output, exitCode),
          });
        }
        const finalText = commandcodeHeadlessResult(stdout);
        if (finalText === undefined) {
          return yield* new TextGenerationError({
            operation,
            detail: "Command Code headless run returned no result line.",
          });
        }
        return finalText;
      }).pipe(
        Effect.timeout(TEXT_GENERATION_TIMEOUT_MS),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Command Code headless text generation failed.",
                cause,
              }),
        ),
      );

      return yield* TextGenerationOperations.decodeJsonReply(request, "Command Code", produced);
    });

    return TextGenerationOperations.fromRunner(
      "CommandcodeTextGeneration",
      TextGenerationOperations.withoutInvestigation("Command Code", runCommandcodeJson),
    );
  },
  (effect) => effect.pipe(Effect.scoped),
);
