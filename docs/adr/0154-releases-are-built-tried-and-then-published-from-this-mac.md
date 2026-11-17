# Releases are built, tried and then published from this Mac

Status: accepted (TED-330)

Ted could already update itself from GitHub Releases (ADR 0078), but nothing ever reached other people. The repo was private, so the updater couldn’t read it. `pnpm release` pushed the tag, built a `--dir` app signed with any Apple Development identity and copied it into the user’s own `/Applications`, and the only upload was a draft from a workflow started by hand. Other Macs block an app signed for development, and Squirrel.Mac installs only an update signed by the same team as the running app.

**`forjoyilive/ted` goes public and holds the releases.** `releaseRepo` already names it. The user makes it public; a gitleaks scan of every commit on every branch found only made-up test values.

**A release is two commands, run on the user’s Mac.** `pnpm release <version>` builds the Apple silicon app signed with a Developer ID Application identity and notarized, checks it with `codesign`, `spctl` and `stapler`, installs it in `/Applications` and records the commit and each file’s SHA-512 in `packages/app/dist/release/ted-release.json`. The version commit and tag stay local. After the user has tried it, `pnpm release publish` pushes `main` and the tag and creates a published GitHub release with the `.dmg`, the `.zip`, their blockmaps, `latest-mac.yml` and GitHub’s generated notes. Every installed copy finds it at its next check. A bad build is thrown away with `pnpm release discard` and the same version is built again.

**Publish uploads only the build that was tried.** `publishRefusal` refuses when `HEAD` or the tag isn’t at the recorded commit, a file’s hash changed, `origin/main` moved since the build started, or the repo isn’t public. `discardPlan` refuses once the tag is on GitHub. Both are plain functions, tested in `scripts/release.test.ts`.

**Notarization credentials stay in the macOS keychain.** By default the script uses the `notarytool` keychain profile `ted-notary` (`TED_NOTARY_PROFILE` names another) and hands it to electron-builder as `APPLE_KEYCHAIN_PROFILE`; electron-builder’s `APPLE_API_KEY*` or `APPLE_ID*` variables still work. The build refuses to start without credentials or a Developer ID identity, before the checks run.

## Considered Options

- **A separate public repo holding only releases.** It keeps the source private for the same work. The user chose to make the source public.
- **Building and uploading on GitHub Actions.** It needs the certificate and notarization key as repo secrets, and the user wanted to try each build before it goes out.
- **A beta channel through GitHub prereleases.** It needs a setting in the app and a second feed. Trying the build on the user’s own Mac covers the need for one person.
- **Notarization credentials in environment variables only.** That keeps secrets in a shell profile.

## Consequences

- Only Apple silicon Macs get releases. Intel and Linux builds are not published, though `.github/workflows/release.yml` can still build them by hand.
- A copy signed with Apple Development, such as one installed by an older `pnpm release`, may not update itself to a Developer ID build, because its designated requirement differs. `pnpm release` replaces the user’s own copy directly.
- The end-to-end path (a copy installed from a release updating to the next one) can only be shown with a real certificate, notarization and a public repo, so it is checked by hand at the first release.
