import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandcodeSettings } from "@t3tools/provider-commandcode/settings";
import {
  COMMANDCODE_DRIVER_KIND,
  makeCommandcodeAdapterV2,
} from "@t3tools/provider-commandcode/testing";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import {
  type AcpReplayTranscript,
  AcpReplayTranscriptDecodeError,
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";

const DEFAULT_COMMANDCODE_SETTINGS = Schema.decodeSync(CommandcodeSettings)({});
const COMMANDCODE_INSTANCE_ID = ProviderInstanceId.make("commandcode");

function layerCommandcodeProviderAdapterRegistryReplay(
  transcript: AcpReplayTranscript,
  options: { readonly replayGate?: ProviderReplayGate } = {},
) {
  const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const replayGate = options.replayGate;
      const replayDir = yield* fileSystem
        .makeTempDirectory({
          prefix: `t3-orchestration-v2-commandcode-replay-${transcript.scenario}-`,
        })
        .pipe(Effect.orDie);
      const statusPath = path.join(replayDir, "status.json");
      const scriptPath = yield* path
        .fromFileUrl(new URL("../../../scripts/acp-replay-agent.ts", import.meta.url))
        .pipe(Effect.orDie);
      const adapter = yield* makeCommandcodeAdapterV2({
        instanceId: COMMANDCODE_INSTANCE_ID,
        settings: DEFAULT_COMMANDCODE_SETTINGS,
        environment: {},
        selfInvocation: yield* resolveSelfInvocation(),
        platform,
        fileSystem,
        makeRuntime: (runtimeInput) =>
          makeAcpReplayRuntime({
            transcript,
            statusPath,
            scriptPath,
            childProcessSpawner,
            fileSystem,
            ...(replayGate === undefined ? {} : { replayGate }),
          })(runtimeInput),
        assertComplete: makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
        ...(replayGate === undefined
          ? {}
          : {
              testHooks: {
                onDeferredFinalizeScheduled: (debounce) =>
                  Effect.sync(() => replayGate.recordFinishArmed(debounce)),
              },
            }),
      });
      return [adapter];
    }),
  ).pipe(
    Layer.provide(Layer.mergeAll(layerHost, NodeServices.layer, IdAllocator.layer)),
    Layer.merge(
      Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.sync(() => options.replayGate?.releaseAll())),
      ),
    ),
  );
}

export const CommandcodeOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver: COMMANDCODE_DRIVER_KIND,
  decodeTranscript: (transcript) => decodeAcpReplayTranscript(transcript, COMMANDCODE_DRIVER_KIND),
  makeProviderAdapterRegistryLayer: layerCommandcodeProviderAdapterRegistryReplay,
};
