# ogtmPackages app catalog

The Android client retrieves one HTTPS document:

`https://packages-api.ogtm.dev/app_catalog.json`

It stores the last successful response on disk, sends `If-None-Match` on later
requests, accepts `304 Not Modified`, and uses the last valid catalog while
offline. The same cached document powers the list, details, and update checks;
details never make a separate network request.

`data/catalog.source.json` is the only hand-edited application data. GitHub
Actions runs the generator on pushes to `main`, then publishes only `dist/`
to `gh-pages`. Configure GitHub Pages to serve the root of that branch and
configure `packages-api.ogtm.dev` as a CNAME for `ogatomo21.github.io`.

`iconUrl` and `headerUrl` are optional. When `iconUrl` is omitted, the
generator uses the repository's default branch and
`app/src/main/res/mipmap-xxxhdpi/ic_launcher.webp`.

`app_catalog.json` and `app-catalog.schema.json` are published together.
The generator rejects draft/prerelease releases and discovers every `.apk`
asset automatically. A release with one APK uses that artifact. A release with
multiple APKs must use `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`, or
`universal` immediately before `.apk`, must not duplicate an ABI, and must
include a universal fallback. Android SDK `aapt` verifies package name,
version, SDK levels, and native ABI metadata; size and SHA-256 are recorded for
every artifact before the published directory is replaced.
