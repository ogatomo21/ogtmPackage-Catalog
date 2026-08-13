import { resolve } from "node:path";
import { buildCatalog, publishDist, readJson, validateJson } from "./lib.mjs";

const root = resolve(import.meta.dirname, "..");
const source = await readJson(resolve(root, "data/catalog.source.json"));
const sourceSchema = await readJson(resolve(root, "catalog/catalog.source.schema.json"));
const catalogSchema = await readJson(resolve(root, "catalog/app-catalog.schema.json"));
validateJson(sourceSchema, source, "Catalog source");
const catalog = await buildCatalog(source);
validateJson(catalogSchema, catalog, "Generated catalog");
await publishDist(catalog, catalogSchema, resolve(root, "dist"));
console.log(`Generated ${catalog.apps.length} app(s) at ${catalog.generatedAt}`);
