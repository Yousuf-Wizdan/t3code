import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { CommandcodeSettings } from "../settings.ts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  COMMANDCODE_DRIVER_KIND,
  commandcodeRuntimeModeForSessionMode,
  commandcodeSessionModeForPolicy,
  makeCommandcodeAcpRuntime,
  normalizeCommandcodeToolCall,
} from "./acpSupport.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

const DEFAULT_COMMANDCODE_SETTINGS = Schema.decodeSync(CommandcodeSettings)({});

// Model switching, thread snapshot reads, fork support, MCP tools and
// conversation-snapshot reads negotiate from `cmd acp`'s initialize result;
// only the in-session mode switch is fixed, since `session/set_mode` always exists.
const CommandcodeProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsRuntimeModeSwitchInSession: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface CommandcodeAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: CommandcodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  /** Host platform for the default binary (`cmdc` on Windows, `cmd` elsewhere). */
  readonly platform: NodeJS.Platform;
  /** Captured so the flavor's fixed runtime contract does not need the service. */
  readonly fileSystem: FileSystem.FileSystem;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  /** Replaces the `cmd acp` launch (replay tests). Command Code's session setup still applies. */
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

function makeCommandcodeAcpAdapterFlavor(options: CommandcodeAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: COMMANDCODE_DRIVER_KIND,
    runtimeHarness: "Command Code",
    capabilities: CommandcodeProviderCapabilitiesV2,
    // Command Code advertises `mcpCapabilities.http`; prefer T3's HTTP bridge
    // over the stdio bridge, matching the ACP Registry adapter.
    mcpOverHttp: true,
    sessionModeForPolicy: commandcodeSessionModeForPolicy,
    runtimeModeForSessionMode: commandcodeRuntimeModeForSessionMode,
    normalizeToolCall: normalizeCommandcodeToolCall,
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy: _runtimePolicy, processEnvironment, ...input }) =>
        makeCommandcodeAcpRuntime({
          ...input,
          commandcodeSettings: options.settings,
          environment: { ...options.environment, ...processEnvironment },
          platform: options.platform,
          fileSystem: options.fileSystem,
        })),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeCommandcodeAdapterV2 = Effect.fn("makeCommandcodeAdapterV2")(function* (
  options: CommandcodeAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeCommandcodeAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type CommandcodeAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const CommandcodeAdapterV2Driver: ProviderAdapterDriver<
  CommandcodeSettings,
  CommandcodeAdapterV2DriverEnv
> = {
  driverKind: COMMANDCODE_DRIVER_KIND,
  configSchema: CommandcodeSettings,
  defaultConfig: (): CommandcodeSettings => DEFAULT_COMMANDCODE_SETTINGS,
  create: Effect.fn("CommandcodeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<CommandcodeSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const platform = yield* HostProcess.Platform;
      const fileSystem = yield* FileSystem.FileSystem;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeCommandcodeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        platform,
        fileSystem,
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: COMMANDCODE_DRIVER_KIND,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: COMMANDCODE_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create the Command Code ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
