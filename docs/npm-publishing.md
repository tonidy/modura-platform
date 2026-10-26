# Publishing the TypeScript packages to npm

The package set is published from the public repository, `tonidy/modura-platform`. Private development commits are copied there as fresh commits; package publishing and npm provenance must come from the public repository.

## First publish (bootstrap)

Each npm package must exist before npm lets its Trusted Publisher be configured. After reviewing the package manifests and tarballs, run from a clean public clone:

```sh
npm login --scope=@modura --auth-type=web --registry=https://registry.npmjs.org/
pnpm install --frozen-lockfile
pnpm build:npm
node scripts/publish-npm.mjs                 # pack and validate only
node scripts/publish-npm.mjs --publish       # initial public prerelease
```

The bootstrap uses the local npm login and does not claim GitHub provenance. The script publishes the packages in dependency order and checks that `workspace:` ranges were rewritten in each tarball.

## Configure Trusted Publishing

After bootstrap has created the packages, configure the npm Trusted Publisher on **each** `@modura/*` package:

- Provider: GitHub Actions
- Owner/repository: `tonidy/modura-platform`
- Workflow: `.github/workflows/publish-npm.yml`
- GitHub environment: `npm`

The workflow has `id-token: write`, runs on version tags matching `npm-v*`, verifies and builds the workspace, then invokes `npm publish --provenance` for each tarball. No npm token is stored in GitHub Secrets.

## Subsequent releases

Update the version of every package being released and its internal dependency ranges as needed. Versions are immutable on npm; do not reuse an already-published version. Then push a matching tag from the public repository, for example:

```sh
git tag npm-v1.0.0-rc.5
git push origin npm-v1.0.0-rc.5
```

The version also appears in `modura.config.ts` (the registry API version), so run `pnpm generate` after a bump and commit the regenerated OpenAPI and Go code with it.

Dist-tags: a stable version takes `latest`. A prerelease takes `latest` too while no stable version exists, and `next` after that, so a release candidate never replaces a stable release for `npm install`.
