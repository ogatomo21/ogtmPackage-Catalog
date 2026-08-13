import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import Ajv2020 from "ajv/dist/2020.js";

const execFileAsync = promisify(execFile);
const supportedAbis = new Set(["arm64-v8a", "armeabi-v7a", "x86", "x86_64"]);
const defaultIconPath = "app/src/main/res/mipmap-xxxhdpi/ic_launcher.webp";

export function validateJson(schema, value, name = "JSON") {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  const validator = ajv.compile(schema);
  if (!validator(value)) throw new Error(`${name} is invalid: ${ajv.errorsText(validator.errors, { separator: "; " })}`);
}

export function selectLatestRelease(releases) {
  const release = releases.find((candidate) => !candidate.draft && !candidate.prerelease);
  if (!release) throw new Error("No non-draft, non-prerelease GitHub Release was found");
  return release;
}

export function selectApkAssets(release) {
  const assets = (release.assets ?? []).filter((asset) => asset.name.toLowerCase().endsWith(".apk"));
  if (assets.length === 0) throw new Error("Release does not contain an APK asset");
  if (assets.length === 1) return [{ asset: assets[0], abi: null }];

  const variants = assets.map((asset) => {
    const match = asset.name.match(/(?:^|[-_.])(arm64-v8a|armeabi-v7a|x86_64|x86|universal)\.apk$/i);
    if (!match) {
      throw new Error(`Multiple APK assets require an ABI or universal suffix: ${asset.name}`);
    }
    return { asset, abi: match[1].toLowerCase() };
  });
  const duplicate = variants.find((variant, index) => variants.findIndex((candidate) => candidate.abi === variant.abi) !== index);
  if (duplicate) throw new Error(`Multiple APK assets target the same ABI: ${duplicate.abi}`);
  if (!variants.some((variant) => variant.abi === "universal")) {
    throw new Error("Multiple ABI APK assets must include a universal APK");
  }
  return variants;
}

export function assertApkMetadata(metadata, source) {
  if (metadata.packageName !== source.packageName) {
    throw new Error(`APK packageName mismatch: expected ${source.packageName}, got ${metadata.packageName}`);
  }
  for (const key of ["versionName", "versionCode", "minSdk", "targetSdk"]) {
    if (metadata[key] === undefined || metadata[key] === null || metadata[key] === "") {
      throw new Error(`APK manifest is missing ${key}`);
    }
  }
  if (!Number.isInteger(metadata.versionCode) || metadata.versionCode < 1) throw new Error("APK versionCode is invalid");
  if (!Number.isInteger(metadata.minSdk) || !Number.isInteger(metadata.targetSdk)) throw new Error("APK SDK values are invalid");
}

function integer(value) {
  const match = String(value ?? "").match(/-?\d+/);
  const parsed = match ? Number(match[0]) : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function attribute(value, name) {
  if (typeof value !== "string") return undefined;
  return value.match(new RegExp("\\b" + name + "='?([^'\\s]+)"))?.[1];
}

export function manifestMetadata(manifest) {
  const packageField = manifest.package ?? manifest.manifest?.["@package"] ?? "";
  const nativeCode = manifest["native-code"] ?? manifest.nativeCode ?? "";
  return {
    packageName: manifest["@package"] ?? attribute(packageField, "name") ?? manifest.packageName,
    versionName: String(manifest["@android:versionName"] ?? attribute(packageField, "versionName") ?? manifest.versionName ?? ""),
    versionCode: integer(manifest["@android:versionCode"] ?? attribute(packageField, "versionCode") ?? manifest.versionCode),
    minSdk: integer(manifest.sdkVersion ?? manifest["@android:minSdkVersion"] ?? manifest.minSdkVersion),
    targetSdk: integer(manifest.targetSdkVersion ?? manifest["@android:targetSdkVersion"] ?? manifest.targetSdkVersion),
    nativeAbis: typeof nativeCode === "string"
      ? [...nativeCode.matchAll(/'([^']+)'/g)].map((match) => match[1].toLowerCase())
      : []
  };
}

export function singleApkAbi(metadata) {
  const abis = metadata.nativeAbis ?? [];
  if (abis.length !== 1) return "universal";
  if (!supportedAbis.has(abis[0])) throw new Error(`Unsupported APK ABI: ${abis[0]}`);
  return abis[0];
}

export function assertVariantAbi(metadata, expectedAbi, assetName) {
  const abis = metadata.nativeAbis ?? [];
  if (expectedAbi === "universal") {
    if (abis.length === 1) {
      throw new Error(`${assetName}: universal APK contains only ${abis[0]}`);
    }
    return;
  }
  if (abis.length !== 1 || abis[0] !== expectedAbi) {
    throw new Error(`${assetName}: filename ABI ${expectedAbi} does not match APK native-code ${abis.join(", ") || "none"}`);
  }
}

export function parseAaptBadging(output) {
  return Object.fromEntries(
    output.split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf(":");
      return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
    })
  );
}

export async function inspectApk(apkPath) {
  const aaptPath = process.env.AAPT_PATH;
  if (!aaptPath) throw new Error("AAPT_PATH must point to an Android SDK aapt executable");
  const { stdout } = await execFileAsync(aaptPath, ["dump", "badging", apkPath], { maxBuffer: 1024 * 1024 });
  return manifestMetadata(parseAaptBadging(stdout));
}

async function githubJson(fetchImpl, path, token) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ogtm-packages-catalog",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });
  if (!response.ok) throw new Error(`GitHub API ${path} failed: ${response.status}`);
  return response.json();
}

async function fetchReadme(fetchImpl, repository, token) {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/readme`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ogtm-packages-catalog",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });
  if (!response.ok) throw new Error(`README for ${repository} failed: ${response.status}`);
  const body = await response.json();
  return Buffer.from(body.content.replace(/\n/g, ""), body.encoding ?? "base64").toString("utf8");
}

export function defaultIconUrl(repository, defaultBranch) {
  return `https://raw.githubusercontent.com/${repository}/${defaultBranch}/${defaultIconPath}`;
}

async function downloadApk(fetchImpl, url, filePath) {
  const response = await fetchImpl(url, { headers: { "User-Agent": "ogtm-packages-catalog" } });
  if (!response.ok) throw new Error(`APK download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, bytes);
  return { sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function buildCatalog(source, options = {}) {
  const {
    fetchImpl = fetch,
    token = process.env.GITHUB_TOKEN,
    inspectApkImpl = inspectApk,
    downloadApkImpl = downloadApk,
    now = () => new Date().toISOString()
  } = options;
  const downloadDir = await mkdtemp(join(tmpdir(), "ogtm-catalog-"));
  try {
    const apps = await Promise.all(source.apps.map(async (app) => {
      const [repository, releases] = await Promise.all([
        githubJson(fetchImpl, `/repos/${app.repository}`, token),
        githubJson(fetchImpl, `/repos/${app.repository}/releases?per_page=100`, token)
      ]);
      if (typeof repository.default_branch !== "string" || repository.default_branch.length === 0) {
        throw new Error(`Repository default branch is missing: ${app.repository}`);
      }
      const release = selectLatestRelease(releases);
      const selectedAssets = selectApkAssets(release);
      const [descriptionMarkdown, variants] = await Promise.all([
        fetchReadme(fetchImpl, app.repository, token),
        Promise.all(selectedAssets.map(async ({ asset, abi: fileNameAbi }) => {
          const apkPath = join(downloadDir, `${app.packageName}-${asset.name}`);
          const downloaded = await downloadApkImpl(fetchImpl, asset.browser_download_url, apkPath);
          const metadata = await inspectApkImpl(apkPath);
          assertApkMetadata(metadata, app);
          const actualSize = (await stat(apkPath)).size;
          if (downloaded.sizeBytes !== actualSize) throw new Error(`APK size changed while reading ${asset.name}`);
          const abi = fileNameAbi ?? singleApkAbi(metadata);
          if (fileNameAbi) assertVariantAbi(metadata, fileNameAbi, asset.name);
          return {
            metadata,
            artifact: {
              abi,
              url: asset.browser_download_url,
              fileName: asset.name,
              sizeBytes: downloaded.sizeBytes,
              sha256: downloaded.sha256
            }
          };
        }))
      ]);
      const metadata = variants[0].metadata;
      for (const variant of variants.slice(1)) {
        for (const key of ["versionName", "versionCode", "minSdk", "targetSdk"]) {
          if (variant.metadata[key] !== metadata[key]) {
            throw new Error(`${variant.artifact.fileName}: ${key} does not match the other APK variants`);
          }
        }
      }
      return {
        packageName: app.packageName,
        displayName: app.displayName,
        iconUrl: app.iconUrl ?? defaultIconUrl(app.repository, repository.default_branch),
        ...(app.headerUrl ? { headerUrl: app.headerUrl } : {}),
        shortDescription: app.shortDescription,
        descriptionMarkdown,
        repositoryUrl: `https://github.com/${app.repository}`,
        minSdk: metadata.minSdk,
        targetSdk: metadata.targetSdk,
        latestRelease: {
          versionName: metadata.versionName,
          versionCode: metadata.versionCode,
          publishedAt: release.published_at,
          releaseNotesMarkdown: release.body ?? "",
          apks: variants.map((variant) => variant.artifact)
        }
      };
    }));
    return { schemaVersion: 1, generatedAt: now(), apps };
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }
}

export async function publishDist(catalog, schema, distDir) {
  validateJson(schema, catalog, "Generated catalog");
  const staging = await mkdtemp(join(dirname(distDir), ".catalog-dist-"));
  try {
    await writeFile(join(staging, "app_catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
    await writeFile(join(staging, "app-catalog.schema.json"), `${JSON.stringify(schema, null, 2)}\n`);
    await writeFile(join(staging, "CNAME"), "packages-api.ogtm.dev\n");
    await writeFile(join(staging, "index.html"), `<!doctype html><meta charset="utf-8"><title>ogtmPackages catalog</title><p>Catalog generated at ${catalog.generatedAt}.</p>\n`);
    await rm(distDir, { recursive: true, force: true });
    await rename(staging, distDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
