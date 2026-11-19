/** Reads Command Code sessions from ~/.commandcode/projects/<slug>/. */
import { AcpRegistryListSessionsResult, AcpRegistryOperationError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeOS from "node:os";
import * as Schema from "effect/Schema";

const MAX_SESSIONS = 128;
const MAX_CURSOR = 10_000;

function cwdToSlug(cwd: string): string {
  return cwd
    .toLowerCase()
    .replace(/[/\\]/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function commandcodeProjectDir(cwd: string, environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME ?? environment.USERPROFILE ?? NodeOS.homedir();
  return `${home}/.commandcode/projects/${cwdToSlug(cwd)}`;
}

const MetaFile = Schema.fromJsonString(
  Schema.Struct({
    title: Schema.optional(Schema.String),
    traceIds: Schema.optional(Schema.Array(Schema.String)),
  }),
);
const decodeMetaFile = Schema.decodeUnknownOption(MetaFile);

function sessionIdFromFileName(name: string): string | undefined {
  if (name.endsWith(".jsonl") && !name.startsWith("hooks-audit-")) {
    return name.slice(0, -".jsonl".length);
  }
  return undefined;
}

function sessionTimestampFromJsonl(firstLine: string): string | null {
  try {
    const parsed = JSON.parse(firstLine) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "timestamp" in parsed &&
      typeof (parsed as { timestamp: unknown }).timestamp === "string"
    ) {
      return (parsed as { timestamp: string }).timestamp;
    }
  } catch {
    // ignore
  }
  return null;
}

export const listCommandcodeSessions = Effect.fn("listCommandcodeSessions")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv,
  cursor: string | undefined,
): Effect.fn.Return<
  typeof AcpRegistryListSessionsResult.Type,
  AcpRegistryOperationError,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  const projectDir = commandcodeProjectDir(cwd, environment);

  const names = yield* fs
    .readDirectory(projectDir)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

  const sessionIds = names.flatMap((name) => sessionIdFromFileName(name) ?? []);

  if (sessionIds.length === 0) {
    return AcpRegistryListSessionsResult.make({
      sessions: [],
      nextCursor: null,
      canLoad: false,
      canResume: true,
      canDelete: true,
    });
  }

  const sessionWithMtimes = yield* Effect.forEach(
    sessionIds,
    (sessionId) =>
      fs.stat(`${projectDir}/${sessionId}.jsonl`).pipe(
        Effect.map((info) => ({
          sessionId,
          mtime: info.mtime ? DateTime.toEpochMillis(info.mtime) : 0,
        })),
        Effect.orElseSucceed(() => ({ sessionId, mtime: 0 })),
      ),
    { concurrency: 8 },
  );

  sessionWithMtimes.sort((a, b) => b.mtime - a.mtime);

  const offset = cursor !== undefined ? Math.min(parseInt(cursor, 10) || 0, MAX_CURSOR) : 0;
  const page = sessionWithMtimes.slice(offset, offset + MAX_SESSIONS);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < sessionWithMtimes.length;

  const sessions = yield* Effect.forEach(
    page,
    ({ sessionId, mtime }) =>
      Effect.gen(function* () {
        const metaRaw = yield* fs
          .readFileString(`${projectDir}/${sessionId}.meta.json`)
          .pipe(Effect.orElseSucceed(() => null));
        const meta = metaRaw !== null ? decodeMetaFile(metaRaw) : undefined;
        const title = meta?._tag === "Some" ? (meta.value.title?.trim() ?? null) : null;

        const firstLine = yield* fs.readFileString(`${projectDir}/${sessionId}.jsonl`).pipe(
          Effect.map((raw) => raw.split("\n")[0] ?? ""),
          Effect.orElseSucceed(() => ""),
        );
        const timestamp =
          sessionTimestampFromJsonl(firstLine) ??
          (mtime > 0 ? new Date(mtime).toISOString() : null);

        return {
          sessionId,
          cwd,
          additionalDirectories: [] as string[],
          title: title && title.length > 0 ? title : null,
          updatedAt: timestamp,
          importedThreadId: null,
        };
      }),
    { concurrency: 8 },
  );

  return AcpRegistryListSessionsResult.make({
    sessions,
    nextCursor: hasMore ? String(nextOffset) : null,
    canLoad: false,
    canResume: true,
    canDelete: true,
  });
});

export const deleteCommandcodeSession = Effect.fn("deleteCommandcodeSession")(function* (
  cwd: string,
  sessionId: string,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<void, AcpRegistryOperationError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const projectDir = commandcodeProjectDir(cwd, environment);

  if (!/^[0-9a-f-]{32,36}$/i.test(sessionId)) {
    return yield* Effect.fail(
      new AcpRegistryOperationError({
        reason: "probe_failed",
        message: `Invalid Command Code session ID: ${sessionId}`,
      }),
    );
  }

  const filesToDelete = [
    `${projectDir}/${sessionId}.jsonl`,
    `${projectDir}/${sessionId}.meta.json`,
    `${projectDir}/${sessionId}.checkpoints.jsonl`,
  ];

  yield* Effect.forEach(filesToDelete, (file) => fs.remove(file).pipe(Effect.ignore), {
    concurrency: 3,
  });
});
