import { CommandcodeSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { type CommandcodeAdapterV2DriverEnv, CommandcodeAdapterV2Driver } from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  buildInitialCommandcodeProviderSnapshot,
  checkCommandcodeProviderStatus,
} from "./status.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  homebrewOwnershipFromCommandPath,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { makeCommandcodeTextGeneration } from "./textGeneration.ts";
import { COMMANDCODE_DRIVER_KIND } from "./acpSupport.ts";

const decodeCommandcodeSettings = Schema.decodeSync(CommandcodeSettings);

const COMMANDCODE_NPM_PACKAGE = "command-code";
// `cmd update` self-updates; a Homebrew cask owns its own upgrades, so there
// `cmd update` would install a second copy instead of the cask's binary.
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: Effect.fn("resolveCommandcodeMaintenance")(function* (context) {
    if (!context) {
      return makeManualOnlyProviderMaintenanceCapabilities({
        provider: COMMANDCODE_DRIVER_KIND,
        packageName: COMMANDCODE_NPM_PACKAGE,
      });
    }
    const homebrew = homebrewOwnershipFromCommandPath(context.realCommandPath);
    if (homebrew?.kind === "cask") {
      return makeManualOnlyProviderMaintenanceCapabilities({
        provider: COMMANDCODE_DRIVER_KIND,
        packageName: COMMANDCODE_NPM_PACKAGE,
        installPath: context.realCommandPath,
      });
    }
    return makeProviderMaintenanceCapabilities({
      provider: COMMANDCODE_DRIVER_KIND,
      packageName: COMMANDCODE_NPM_PACKAGE,
      updateExecutable: context.resolvedCommandPath,
      updateArgs: ["update"],
      updateLockKey: "commandcode",
      platform: context.platform,
      env: context.env,
    });
  }),
};

export type CommandcodeDriverEnv =
  | CommandcodeAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | Path.Path
  | ProviderHost.ProviderHost;

export const CommandcodeDriver: ProviderDriver<CommandcodeSettings, CommandcodeDriverEnv> = {
  driverKind: COMMANDCODE_DRIVER_KIND,
  metadata: {
    displayName: "Command Code",
    supportsMultipleInstances: true,
  },
  configSchema: CommandcodeSettings,
  defaultConfig: (): CommandcodeSettings => decodeCommandcodeSettings({}),
  create: Effect.fn("CommandcodeDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: COMMANDCODE_DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: COMMANDCODE_DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies CommandcodeSettings;
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<
      ProviderSnapshotSettings<CommandcodeSettings>
    >({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialCommandcodeProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: checkCommandcodeProviderStatus(effectiveConfig, processEnv, platform).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: COMMANDCODE_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the Command Code provider snapshot.",
            cause,
          }),
      ),
    );

    const orchestrationAdapter = yield* CommandcodeAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: COMMANDCODE_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the Command Code orchestration adapter.",
            cause,
          }),
      ),
    );
    const textGeneration = yield* makeCommandcodeTextGeneration(
      effectiveConfig,
      platform,
      processEnv,
    );

    return {
      instanceId,
      driverKind: COMMANDCODE_DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
