# vendor

`nvidia-openshell-sdk-0.1.2.tgz` — `@nvidia/openshell-sdk` 0.1.2, the TypeScript
SDK for the OpenShell gateway. Upstream publishes it only to GitHub Packages
(needs a `read:packages` token), so it is vendored here and installed via
`file:` so `npm ci`, Docker builds and dev machines need no token.
Apache-2.0; license text in `nvidia-openshell-sdk.LICENSE`.

- sha256: `ed140d819453d717997f6b3f6fb80245cd406c368a54b7a316c15fb678a7dc2b`
- source: `npm pack @nvidia/openshell-sdk@0.1.2` (registry `npm.pkg.github.com`)

Keep the SDK on the same release as the gateway. To update: `npm pack` the new
version with a token, replace the tarball, update the server dependency and
this file.
