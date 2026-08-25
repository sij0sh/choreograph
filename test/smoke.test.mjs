import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function modules(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(root, directory, entry.name));
}

test("every scaffolded src module parses and imports", async () => {
  const files = [
    ...modules("src/authoring"),
    ...modules("src/domain"),
    ...modules("src/engine"),
    ...modules("src/planning"),
    ...modules("src/persistence"),
    ...modules("src/runtime"),
    ...modules("src/pi"),
    join(root, "src/index.ts"),
  ];
  for (const file of files) {
    const loaded = await import(file);
    assert.ok(loaded !== null && loaded !== undefined, `${file} should import`);
  }
});
