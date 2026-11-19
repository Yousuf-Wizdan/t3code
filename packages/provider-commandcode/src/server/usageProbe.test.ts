import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { probeCommandcodeUsage } from "./usageProbe.ts";

describe("usageProbe", () => {
  it.effect("returns unavailable when auth.json does not exist", () =>
    Effect.gen(function* () {
      const result = yield* probeCommandcodeUsage({
        USERPROFILE: "C:\\nonexistent-test-user-dir",
        HOME: "C:\\nonexistent-test-user-dir",
      });
      assert.isDefined(result.unavailable);
      assert.equal(result.unavailable?.reason, "probeFailed");
      assert.include(result.unavailable?.message ?? "", "not signed in");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
