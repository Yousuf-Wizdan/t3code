import { describe } from "@effect/vitest";

import { CommandcodeOrchestratorReplayHarness } from "../Adapters/CommandcodeAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Command Code replay fixtures", () => {
  itRunsReplayFixtures("commandcode", (input) =>
    runReplayFixture({ ...input, harness: CommandcodeOrchestratorReplayHarness }),
  );
});
