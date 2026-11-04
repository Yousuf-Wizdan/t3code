import { describe, expect, it } from "vite-plus/test";

import { messageRequestsPlanMode } from "./planRequestIntent.ts";

describe("messageRequestsPlanMode", () => {
  it("matches plan requests in their common phrasings", () => {
    for (const text of [
      "Ok lets plan a feature in t3code for command code usage",
      "Lets plan a fix for why you are not able to enter plan mode",
      "let's plan",
      "ok, plan the next sprint",
      "plan out the migration",
      "review the code and plan a fix",
      "we should create a plan for the refactor",
      "Please write a plan for the auth flow",
      "come up with a plan for the release",
      "revise the plan for the settings screen",
    ]) {
      expect(messageRequestsPlanMode(text), text).toBe(true);
    }
  });

  it("ignores messages that only mention a plan", () => {
    for (const text of [
      "fix the plan cache bug",
      "implement the plan from yesterday",
      "explain plan mode in cmdc",
      "add plan support to the adapter",
      "the plans are ready for review",
      "update the plan file in the repo",
      "create the plan cache if missing",
      "remove the plan mode toggle",
      "what does the plan do?",
      "restart the planning worker",
    ]) {
      expect(messageRequestsPlanMode(text), text).toBe(false);
    }
  });
});
