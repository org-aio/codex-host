import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readConnection } from "../index.mjs";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture(extra = "") {
  const home = await mkdtemp(join(tmpdir(), "buddy-connection-test-"));
  homes.push(home);
  await writeFile(
    join(home, "config.toml"),
    `model_provider = "fixture"\n[model_providers.fixture]\nbase_url = "http://127.0.0.1:9999/v1"\nrequires_openai_auth = true\n${extra}`,
  );
  await writeFile(
    join(home, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "fixture-config-key" }),
  );
  return home;
}

it("uses configured Codex login instead of an unrelated inherited provider key", async () => {
  const home = await fixture();
  const connection = await readConnection(home, { OPENAI_API_KEY: "fixture-other-provider" });
  expect(connection.headers.get("Authorization")).toBe("Bearer fixture-config-key");
  expect(connection.url.toString()).toBe("http://127.0.0.1:9999/v1/models");
});

it("preserves the explicitly configured credential environment variable", async () => {
  const home = await fixture('env_key = "BUDDY_TEST_TOKEN"\n');
  const connection = await readConnection(home, { BUDDY_TEST_TOKEN: "fixture-explicit" });
  expect(connection.headers.get("Authorization")).toBe("Bearer fixture-explicit");
});

it("does not replace an explicit bearer token or authorization header", async () => {
  const home = await fixture('experimental_bearer_token = "fixture-inline"\n');
  expect((await readConnection(home, {})).headers.get("Authorization")).toBe(
    "Bearer fixture-inline",
  );
  const headerHome = await fixture(
    '[model_providers.fixture.http_headers]\nAuthorization = "Bearer fixture-header"\n',
  );
  expect((await readConnection(headerHome, {})).headers.get("Authorization")).toBe(
    "Bearer fixture-header",
  );
});
