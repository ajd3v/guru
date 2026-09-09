import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "guru-tests-"));
const env = { ...process.env, GURU_NO_DOTENV: "1", NODE_ENV: "test", GURU_PROFILE: join(process.cwd(), "guru.config.json"), GURU_USER_DIR: join(directory, "users"), GURU_JOBS_DB: join(directory, "jobs.db"), GURU_LOG_DB: join(directory, "log.db") };
for (const key of Object.keys(env)) {
  if (/API_KEY|BASE_URL|CLERK_|GURU_(SINGLE_USER|BASIC_AUTH|GUEST|DEMO|PIPELINE_MODEL|ANSWER_MODEL)/.test(key)) delete env[key];
}
try {
  for (const args of [["src/cli.ts", "selfcheck"], ["src/server.ts", "--selfcheck"], ["test/llm.test.ts"], ["test/openai.test.ts"], ["test/quota.test.ts"], ["test/profile.test.ts"], ["test/source.test.ts"]]) {
    const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
    if (result.status !== 0) process.exitCode = 1;
    if (process.exitCode) break;
  }
  if (!process.exitCode) {
    const result = spawnSync(".venv/bin/python", ["ingest/ingest.py", "--selfcheck"], { env, stdio: "inherit" });
    if (result.status !== 0) process.exitCode = 1;
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
