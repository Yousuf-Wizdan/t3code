/**
 * Command Code instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * @module provider-commandcode/settings
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const CommandcodeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    // Resolved per platform at spawn time: `cmdc` on Windows, `cmd` elsewhere.
    binaryPath: makeBinaryPathSetting("").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description:
          "Executable on this environment. Leave blank to use `cmdc` on Windows and `cmd` on macOS and Linux.",
        providerSettingsForm: {
          placeholder: "cmdc (Windows) / cmd (macOS, Linux)",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    taste: Schema.Literals(["", "disabled", "enabled"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Taste learning",
        description:
          "Learn coding preferences from accepted and rejected work. Disabled and Enabled run the CLI's `taste disable` / `taste enable` for this user (every project) when a session starts; Leave as configured never changes Command Code's own state.",
        providerSettingsForm: {
          control: "select",
          options: [
            { value: "", label: "Leave as configured" },
            { value: "disabled", label: "Disabled" },
            { value: "enabled", label: "Enabled" },
          ],
        },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "taste"],
  },
);
export type CommandcodeSettings = typeof CommandcodeSettings.Type;
