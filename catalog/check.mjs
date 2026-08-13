import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readJson, validateJson } from "./lib.mjs";

const root = resolve(import.meta.dirname, "..");
const source = await readJson(resolve(root, "data/catalog.source.json"));
const sourceSchema = await readJson(resolve(root, "catalog/catalog.source.schema.json"));
validateJson(sourceSchema, source, "Catalog source");
const catalogPath = resolve(root, "dist/app_catalog.json");
if (existsSync(catalogPath)) {
  validateJson(await readJson(resolve(root, "catalog/app-catalog.schema.json")), await readJson(catalogPath), "Generated catalog");
}
console.log("Catalog schemas are valid");
