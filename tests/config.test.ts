import assert from "node:assert/strict";
import test from "node:test";

import { requireProductionApiToken } from "../src/server/config.ts";

test("production API startup requires ERP_API_TOKEN", () => {
  assert.throws(
    () => requireProductionApiToken({ nodeEnv: "production", apiToken: undefined }),
    /ERP_API_TOKEN is required/
  );
  assert.throws(() => requireProductionApiToken({ nodeEnv: "production", apiToken: "" }), /ERP_API_TOKEN is required/);
  assert.doesNotThrow(() => requireProductionApiToken({ nodeEnv: "production", apiToken: "secret-token" }));
  assert.doesNotThrow(() => requireProductionApiToken({ nodeEnv: "development", apiToken: undefined }));
  assert.doesNotThrow(() => requireProductionApiToken({ nodeEnv: "", apiToken: undefined }));
});
