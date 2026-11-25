# Babata Baileys — custom distribution builder

Builds a complete compiled distribution of WhiskeySockets Baileys 7.0.0-rc14 (MIT) with Babata's experimental VC module embedded. Does not depend on Rifza's Baileys, and does not require a separate Baileys runtime package. This repository is the builder and custom source, not a copy of upstream TypeScript. The upstream package is fetched from npm at build time. Its original license and credits are retained. No WhatsApp credentials, bot data or session are included.

## Build
Node 22, npm, tar, internet access to npm. `npm test` requires FFmpeg with libx264. Run `npm run build` to produce `dist/babata-baileys-7.0.0-rc14-babata.1.tgz`. Alternatively upload this repository to GitHub, enable Actions and run the Build Babata Baileys workflow, then download the artifact. Extract the downloaded artifact zip to obtain the actual npm tarball. An official predownloaded npm tarball can be passed as the second argument: `node build.mjs dist /path/to/official.tgz` (verify registry integrity yourself).

## Use with Babata
Copy the .tgz into the bot's `vendor/` directory and install using the supplied bot patch, which retains `@whiskeysockets/baileys` as the import key. Never upload the full bot backup to GitHub. Stop the bot, back up the session/database, apply the patch to a test copy, move the old package-lock.json out of the bot directory, then run npm install and npm run check:baileys. Keep the newly generated lockfile. Existing commands remain in place; runtime compatibility is not established. For direct GitHub delivery, publish the built tgz as a release asset in your repository and point the dependency to its actual HTTPS URL, then regenerate the lockfile.

## VC
Embedded VC module uses optional nexcaller 0.5.0 and FFmpeg. It is experimental, not an independently written WhatsApp protocol stack. Real incoming/outgoing calls, encryption, relay, media playback and Android/iOS compatibility are unverified. Optional native transport dependency may fail to install. Only use consenting test accounts. `npm test` checks local FFmpeg conversion and mocked lifecycle, not WhatsApp. No mass calling; auto answer is opt-in for a single number. Credits: WhiskeySockets upstream and nexcaller transport contributors. See original package license.
