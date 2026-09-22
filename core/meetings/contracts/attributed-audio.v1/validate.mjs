import Ajv2020 from "ajv/dist/2020.js";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, "attributed-audio.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
const files = readdirSync(join(here, "golden")).filter((name) => name.endsWith(".json"));
let failed = 0;
for (const file of files) { if (validate(JSON.parse(readFileSync(join(here, "golden", file), "utf8")))) console.log(`  ✓ ${file}`); else { console.error(validate.errors); failed++; } }
process.exit(failed ? 1 : 0);
