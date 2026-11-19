import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  commandcodeProjectDir,
  listCommandcodeSessions,
  deleteCommandcodeSession,
} from "./sessions.ts";

describe("sessions", () => {
  describe("commandcodeProjectDir", () => {
    it("converts Windows and POSIX paths to project slugs deterministically", () => {
      const env = { USERPROFILE: "C:\\Users\\testuser" };
      const winPath = "C:\\Users\\testuser\\my-project";
      const dir = commandcodeProjectDir(winPath, env);
      assert.include(dir, "c-users-testuser-my-project");
      assert.isTrue(dir.startsWith("C:\\Users\\testuser/.commandcode/projects/"));
    });

    it("handles POSIX paths with HOME", () => {
      const env = { HOME: "/home/testuser" };
      const posixPath = "/home/testuser/work/my-app";
      const dir = commandcodeProjectDir(posixPath, env);
      assert.include(dir, "home-testuser-work-my-app");
    });
  });

  describe("listCommandcodeSessions", () => {
    it.effect("returns empty session list when project directory does not exist", () =>
      Effect.gen(function* () {
        const result = yield* listCommandcodeSessions(
          "C:\\nonexistent\\project",
          { USERPROFILE: "C:\\nonexistent" },
          undefined,
        );
        assert.deepEqual(result.sessions, []);
        assert.isNull(result.nextCursor);
        assert.isTrue(result.canResume);
        assert.isTrue(result.canDelete);
        assert.isFalse(result.canLoad);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  describe("deleteCommandcodeSession", () => {
    it.effect("rejects invalid session IDs that are not UUID-shaped", () =>
      Effect.gen(function* () {
        const exit = yield* deleteCommandcodeSession("C:\\test\\project", "../traversal-attempt", {
          USERPROFILE: "C:\\test",
        }).pipe(Effect.exit);
        assert.isTrue(exit._tag === "Failure");
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });
});
