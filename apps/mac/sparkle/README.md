# Sparkle update signing

## Keys (one-time setup, already done)

This directory holds the EdDSA (Ed25519) key pair Sparkle uses to verify
appcast entries:

- **Public key** (32 bytes, base64): `mhwdq5zv5btlyfJFC/fKAB71fTE96/HUbhJgUMW3/qw=`
  - Embedded in `apps/mac/Lobu/Info.plist` as `SUPublicEDKey`. Already there.

- **Private key** (`.pem` + `sparkle_ed_private_combined.b64`): gitignored,
  lives only on the machine that generated it. Move it into 1Password / your
  password manager and into the GitHub Actions secret
  `SPARKLE_ED_PRIVATE_KEY` (use the **combined 64-byte** base64 form —
  contents of `sparkle_ed_private_combined.b64`). Lose this and the only
  recovery path is rotating to a new key + releasing a new app build with the
  new public key.

## Appcast publishing (per release)

`SUFeedURL` points at `https://lobu-ai.github.io/lobu/appcast.xml`. Until the
`gh-pages` branch + `appcast.xml` exist, in-app update checks will silently
fail (no harm, the app keeps running).

CI flow (to wire in `mac-release.yml`):

1. After uploading `Lobu.dmg` to the GitHub Release, fetch the existing
   `appcast.xml` from `gh-pages`.
2. Sign the DMG with Sparkle's `sign_update`:
   ```
   echo "$SPARKLE_ED_PRIVATE_KEY" | sign_update --ed-key-file - Lobu.dmg
   ```
   This prints `sparkle:edSignature="..." length="..."` — slot into a new
   `<item>` in `appcast.xml`.
3. Push the updated `appcast.xml` back to `gh-pages`.

`sign_update` ships in the Sparkle SPM artifact bundle — find it once Xcode
resolves the dependency:

```
find ~/Library/Developer/Xcode/DerivedData -name "sign_update" -path "*Sparkle*"
```
