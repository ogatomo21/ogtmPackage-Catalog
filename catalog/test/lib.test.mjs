import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { assertApkMetadata, assertVariantAbi, buildCatalog, defaultIconUrl, manifestMetadata, parseAaptBadging, selectApkAssets, selectLatestRelease, singleApkAbi } from "../lib.mjs";

test("selectLatestRelease excludes draft and prerelease releases", () => {
  assert.equal(selectLatestRelease([{ draft: true }, { prerelease: true }, { tag_name: "v2", draft: false, prerelease: false }]).tag_name, "v2");
});

test("a single APK is selected without source configuration", () => {
  const selected = selectApkAssets({ assets: [{ name: "checksums.txt" }, { name: "app.apk" }] });
  assert.equal(selected[0].asset.name, "app.apk");
  assert.equal(selected[0].abi, null);
  assert.throws(() => selectApkAssets({ assets: [] }), /does not contain an APK/);
});

test("multiple APKs are classified by ABI suffix", () => {
  const selected = selectApkAssets({ assets: [
    { name: "app-arm64-v8a.apk" },
    { name: "app-armeabi-v7a.apk" },
    { name: "app-x86.apk" },
    { name: "app-x86_64.apk" },
    { name: "app-universal.apk" }
  ] });
  assert.deepEqual(selected.map((item) => item.abi), ["arm64-v8a", "armeabi-v7a", "x86", "x86_64", "universal"]);
});

test("ambiguous, duplicate, or incomplete multiple APK releases fail", () => {
  assert.throws(() => selectApkAssets({ assets: [{ name: "app-one.apk" }, { name: "app-two.apk" }] }), /require an ABI/);
  assert.throws(() => selectApkAssets({ assets: [{ name: "one-arm64-v8a.apk" }, { name: "two-arm64-v8a.apk" }, { name: "app-universal.apk" }] }), /same ABI/);
  assert.throws(() => selectApkAssets({ assets: [{ name: "app-arm64-v8a.apk" }, { name: "app-x86_64.apk" }] }), /universal/);
});

test("APK metadata validates package and extracted fields", () => {
  const source = { packageName: "net.ogatomo.example" };
  assert.doesNotThrow(() => assertApkMetadata({ packageName: source.packageName, versionName: "2.0", versionCode: 2, minSdk: 23, targetSdk: 36 }, source));
  assert.throws(() => assertApkMetadata({ packageName: "wrong.package", versionName: "2.0", versionCode: 2, minSdk: 23, targetSdk: 36 }, source));
});

test("buildCatalog obtains README, release data and APK digest", async () => {
  const apkBytes = Buffer.from("apk fixture");
  const fetchImpl = async (url) => {
    if (url.includes("/releases?")) return Response.json([{ draft: false, prerelease: false, published_at: "2026-03-26T06:33:42Z", body: "Notes", assets: [{ name: "app.apk", browser_download_url: "https://download.example/app.apk" }] }]);
    if (url.endsWith("/readme")) return Response.json({ content: Buffer.from("# README").toString("base64"), encoding: "base64" });
    if (url.endsWith("/repos/owner/repo")) return Response.json({ default_branch: "main" });
    if (url.includes("download.example")) return new Response(apkBytes);
    throw new Error(url);
  };
  const download = async (fetch, url, file) => {
    await writeFile(file, apkBytes);
    return { sizeBytes: apkBytes.length, sha256: createHash("sha256").update(apkBytes).digest("hex") };
  };
  const catalog = await buildCatalog({ apps: [{ packageName: "net.ogatomo.example", displayName: "Example", shortDescription: "Short", repository: "owner/repo" }] }, {
    fetchImpl, downloadApkImpl: download,
    inspectApkImpl: () => ({ packageName: "net.ogatomo.example", versionName: "2.0", versionCode: 2, minSdk: 23, targetSdk: 36, nativeAbis: [] }),
    now: () => "2026-08-07T00:00:00Z"
  });
  assert.equal(catalog.apps[0].descriptionMarkdown, "# README");
  assert.equal(catalog.apps[0].latestRelease.versionCode, 2);
  assert.equal(catalog.apps[0].latestRelease.apks[0].abi, "universal");
  assert.equal(catalog.apps[0].iconUrl, "https://raw.githubusercontent.com/owner/repo/main/app/src/main/res/mipmap-xxxhdpi/ic_launcher.webp");
});

test("the default icon URL uses the repository default branch", () => {
  assert.equal(defaultIconUrl("owner/repo", "main"), "https://raw.githubusercontent.com/owner/repo/main/app/src/main/res/mipmap-xxxhdpi/ic_launcher.webp");
});

test("Tomoyan source selection has the expected v2 APK contract", () => {
  const release = selectLatestRelease([{ draft: false, prerelease: false, tag_name: "v2.0", assets: [{ name: "tomoyansblog-v20.apk", size: 3069127 }] }]);
  const asset = selectApkAssets(release)[0].asset;
  assert.equal(release.tag_name, "v2.0");
  assert.equal(asset.size, 3069127);
});

test("aapt manifest output extracts package, version and SDK fields", () => {
  assert.deepEqual(
    manifestMetadata({ package: " name='net.ogatomo.tomoyansblog' versionCode='2' versionName='2.0'", sdkVersion: "'23'", targetSdkVersion: "'36'" }),
    { packageName: "net.ogatomo.tomoyansblog", versionName: "2.0", versionCode: 2, minSdk: 23, targetSdk: 36, nativeAbis: [] }
  );
});

test("aapt badging output is converted to manifest fields", () => {
  const badging = "package: name='net.ogatomo.tomoyansblog' versionCode='2' versionName='2.0'\nsdkVersion:'23'\ntargetSdkVersion:'36'\nnative-code: 'arm64-v8a'\n";
  assert.deepEqual(
    manifestMetadata(parseAaptBadging(badging)),
    { packageName: "net.ogatomo.tomoyansblog", versionName: "2.0", versionCode: 2, minSdk: 23, targetSdk: 36, nativeAbis: ["arm64-v8a"] }
  );
});

test("single and filename-selected APK ABIs are validated", () => {
  assert.equal(singleApkAbi({ nativeAbis: [] }), "universal");
  assert.equal(singleApkAbi({ nativeAbis: ["arm64-v8a"] }), "arm64-v8a");
  assert.equal(singleApkAbi({ nativeAbis: ["arm64-v8a", "armeabi-v7a"] }), "universal");
  assert.doesNotThrow(() => assertVariantAbi({ nativeAbis: ["x86_64"] }, "x86_64", "app-x86_64.apk"));
  assert.doesNotThrow(() => assertVariantAbi({ nativeAbis: ["arm64-v8a", "armeabi-v7a"] }, "universal", "app-universal.apk"));
  assert.throws(() => assertVariantAbi({ nativeAbis: ["armeabi-v7a"] }, "arm64-v8a", "app-arm64-v8a.apk"), /does not match/);
});

test("catalog construction stops when APK metadata does not match the source package", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/releases?")) return Response.json([{ draft: false, prerelease: false, published_at: "2026-03-26T06:33:42Z", body: "", assets: [{ name: "app.apk", browser_download_url: "https://download.example/app.apk" }] }]);
    if (url.endsWith("/readme")) return Response.json({ content: Buffer.from("README").toString("base64"), encoding: "base64" });
    if (url.endsWith("/repos/owner/repo")) return Response.json({ default_branch: "main" });
    return new Response(Buffer.from("apk"));
  };
  await assert.rejects(
    buildCatalog({ apps: [{ packageName: "net.ogatomo.expected", displayName: "Example", shortDescription: "Short", repository: "owner/repo" }] }, {
      fetchImpl,
      downloadApkImpl: async (_fetch, _url, file) => {
        const bytes = Buffer.from("apk");
        await writeFile(file, bytes);
        return { sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      },
      inspectApkImpl: () => ({ packageName: "net.ogatomo.wrong", versionName: "1.0", versionCode: 1, minSdk: 23, targetSdk: 36, nativeAbis: [] })
    })
  );
});
