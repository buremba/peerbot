# Changelog

## [2.5.0](https://github.com/lobu-ai/lobu/compare/v2.4.0...v2.5.0) (2026-02-19)


### Features

* add multi-platform support to CLI init wizard ([2597712](https://github.com/lobu-ai/lobu/commit/2597712762c5caa506622c2b1b129b8daac04aca))
* add Slack multi-workspace OAuth distribution ([137ec6a](https://github.com/lobu-ai/lobu/commit/137ec6af3105e24fdc1735e0f4a6cc7ca131e939))
* refactor settings page to Alpine.js with pre-compiled Tailwind ([2126001](https://github.com/lobu-ai/lobu/commit/2126001d4e720eae0b99c7b22cd9fcb342ea174a))


### Bug Fixes

* delete existing webhook before starting Telegram long polling ([c6cd02c](https://github.com/lobu-ai/lobu/commit/c6cd02c8f2bc711934764823448723feda6d503f))
* use strategic merge patch for K8s deployment scaling ([fde3201](https://github.com/lobu-ai/lobu/commit/fde320157297b6dae58d7f65e22c2dd743892137))

## [2.4.0](https://github.com/lobu-ai/lobu/compare/v2.3.0...v2.4.0) (2026-02-18)


### Features

* add direct sessions API for browser/CLI clients ([c34ab3c](https://github.com/lobu-ai/lobu/commit/c34ab3c0b4be5161e94eb98584f0819b36e2d872))
* add direct sessions API for browser/CLI clients ([8f78d87](https://github.com/lobu-ai/lobu/commit/8f78d87b39f51f58b318b61f8f139b426e2b18dd))
* add github package support and enable plan mode ([b9ccf5d](https://github.com/lobu-ai/lobu/commit/b9ccf5df45082d286ea0f8c988dd9a14a04f3e77))
* add MCP registry service and discovery routes ([fbff9bf](https://github.com/lobu-ai/lobu/commit/fbff9bf0da6d18ea9e06b0ca1b678330c5d2bb09))
* add network isolation, HTTP proxy, and enhanced worker configuration ([d3a7db1](https://github.com/lobu-ai/lobu/commit/d3a7db15f0e78e2c59782937400a414e334771a7))
* add platform-agnostic messaging API with self-queueing and MAX_TURNS protection ([c872522](https://github.com/lobu-ai/lobu/commit/c872522fdeeff6f00696cb746c2e615b72924dbb))
* add user interaction system with forms and suggestions ([18db834](https://github.com/lobu-ai/lobu/commit/18db8342cb69bc1a76b426652640c60a040106e5))
* enable WhatsApp support in community deployment ([658bb25](https://github.com/lobu-ai/lobu/commit/658bb256ece4fc3bf3d61e238a2f4d850bcd8f34))
* **gateway:** agent selector + per-user agent stores ([f1c0d85](https://github.com/lobu-ai/lobu/commit/f1c0d85f339a9b670078af2d821d56ad1911582c))
* implement multi-tenant space architecture ([abc195f](https://github.com/lobu-ai/lobu/commit/abc195f52d8aa02c4c04b5c27476906774fd4f6b))
* implement multi-tenant space architecture ([16b8723](https://github.com/lobu-ai/lobu/commit/16b8723b218d3fd3bc4af0b83cc1600030350b9c))
* improve first-time setup UX and add upgrade instructions ([e3df936](https://github.com/lobu-ai/lobu/commit/e3df936c6e1094155cad5d1ebbeeb8367d50c77a))
* migrate gateway to Hono and remove Express from worker ([#94](https://github.com/lobu-ai/lobu/issues/94)) ([499ab1b](https://github.com/lobu-ai/lobu/commit/499ab1b992267017872e90ecb2a662186cd574e3))
* move workspace files to worker filesystem, fix CI, lint cleanup ([142d0c8](https://github.com/lobu-ai/lobu/commit/142d0c8c96a7eb9a0d6792809bbefbd2bbb7027e))
* multi-provider auth, MCP REST API, workspace instructions, dev tooling ([2e08491](https://github.com/lobu-ai/lobu/commit/2e084912a65f495d16f090a7abe2e37f08a356c8))
* support Telegram webhooks when PUBLIC_GATEWAY_URL is set ([c3d266e](https://github.com/lobu-ai/lobu/commit/c3d266e59ef45c386bcf7ccbe3808dbf18abb3f4))


### Bug Fixes

* add HTTP to HTTPS redirect for community.lobu.ai ([1b22074](https://github.com/lobu-ai/lobu/commit/1b220743ab0e366586cdb4118f3c6578fe690cc7))
* add missing orchestrator defaults to Helm values ([b882ad3](https://github.com/lobu-ai/lobu/commit/b882ad3056645b3c5691db23684b4327c1530044))
* address critical security and functionality issues in direct sessions API ([782f617](https://github.com/lobu-ai/lobu/commit/782f617ba4cc1f66f3d5e9a27366a5ae90845b13))
* correct session-manager tests to use proper session key format ([45af581](https://github.com/lobu-ai/lobu/commit/45af581e3ee97e0a8433362a9437c7634edbeb79))
* disable Nix sandbox for arm64 QEMU builds ([e54e712](https://github.com/lobu-ai/lobu/commit/e54e712a5360899e67722159232e04a2b90bee8a))
* disable WhatsApp in community deployment (no credentials) ([2e14197](https://github.com/lobu-ai/lobu/commit/2e14197530f6c6328f8e048c10ec2bdd5b891499))
* handle empty HOME env in git cache fallback ([c00ebfe](https://github.com/lobu-ai/lobu/commit/c00ebfe5f0e55bb8b68e3a0a0e14378a8998affc))
* improve team ID handling in Slack events ([d083365](https://github.com/lobu-ai/lobu/commit/d083365b5eca36d305e611ffb4991cbcd248a453))
* include mcp-servers.json in gateway Docker image ([d0c9cd3](https://github.com/lobu-ai/lobu/commit/d0c9cd33cc09f4fb9fc80078b0c7d9b025880f52))
* pass TELEGRAM_BOT_TOKEN in community deploy workflow ([e9c86e9](https://github.com/lobu-ai/lobu/commit/e9c86e9d87cd1c41ad758daa51b6fb6e35149f00))
* pin redis chart version to avoid Helm OCI panic ([af348ef](https://github.com/lobu-ai/lobu/commit/af348ef5553e67dd88b637d976b2fc2cea6c3e95))
* properly configure Nix sandbox for arm64 builds ([71daf7b](https://github.com/lobu-ai/lobu/commit/71daf7be81f94753f543f9b07a22351eb5f232d5))
* README link rendering and enable auto-deploy on push ([f7743a8](https://github.com/lobu-ai/lobu/commit/f7743a8765bb6636b8c6db1270c7de136a1957ea))
* remove CLI_VERSION pinning, use latest for worker package ([9c33352](https://github.com/lobu-ai/lobu/commit/9c3335248df9ca1010a9931c8798616bf64d0305))
* repair failing tests and exclude workspaces from test discovery ([3227430](https://github.com/lobu-ai/lobu/commit/3227430cae3cebcf5e815c0274197615dff276b9))
* resolve K8s deployment issues ([9d48358](https://github.com/lobu-ai/lobu/commit/9d48358c38f66b95522b0cb288060fc664bf2aab))
* resolve K8s deployment issues ([dcd6eff](https://github.com/lobu-ai/lobu/commit/dcd6eff4292c676d886b42991fab481949a58134))
* restart stream on message_not_in_streaming_state error ([32db4a1](https://github.com/lobu-ai/lobu/commit/32db4a157777224a1f6cbc93854aa1d3471e7a28))
* security hardening and reliability improvements across gateway/worker ([ea00cef](https://github.com/lobu-ai/lobu/commit/ea00cef9cc526d6c8a471a855a6a379c32af68c5))
* skip arm64 worker build due to Nix/QEMU seccomp issue ([fa3f96c](https://github.com/lobu-ai/lobu/commit/fa3f96cfa86272cd6523162154745790a01183ca))
* update ChatGPT device code OAuth flow and skill display ([a81594a](https://github.com/lobu-ai/lobu/commit/a81594af63c4050c2e315a76c0c74b90cb940712))
* update community deployment for Hetzner cluster ([fe5bf90](https://github.com/lobu-ai/lobu/commit/fe5bf908bd708ffad198991378e6054b1ff75fba))
* upgrade Helm to 3.16 to fix OCI registry panic ([e4f88de](https://github.com/lobu-ai/lobu/commit/e4f88def1378c4f946b5f8f00f3a038e4562e716))
* use bun instead of tsx in gateway Helm template ([77dccfa](https://github.com/lobu-ai/lobu/commit/77dccfac62474062b26d5b2e7299b2f42f48c694))
* use PAT for repository_dispatch in deploy trigger ([10add7e](https://github.com/lobu-ai/lobu/commit/10add7e377bf4c27520264704b9fcea6d079a477))
* use writable temp directory for git cache fallback ([c45fc01](https://github.com/lobu-ai/lobu/commit/c45fc01a5ada190bf467b2ab27f71f770c4e927a))

## [2.3.0](https://github.com/lobu-ai/lobu/compare/v2.2.1...v2.3.0) (2025-10-30)


### Features

* enhance Docker security and simplify session management ([3f68c50](https://github.com/lobu-ai/lobu/commit/3f68c50376731470cd8a6912403ef631430e39ad))
* enhance MCP OAuth integration and worker session management ([abfdeb4](https://github.com/lobu-ai/lobu/commit/abfdeb469aadd51923ecceab5159e561d917499c))
* improve status indicators and error handling ([7a7684a](https://github.com/lobu-ai/lobu/commit/7a7684a076a542098d3d250bb56cc3072a6b057f))


### Bug Fixes

* add production environment to Docker publish workflow and clean up outputs ([9fe8120](https://github.com/lobu-ai/lobu/commit/9fe812050fa603c62764108f734b76284080b76c))
* apply code formatting fixes ([0e17f0c](https://github.com/lobu-ai/lobu/commit/0e17f0c38f5fd08b616cf7648a89b4f49b4bea98))
* build core package before running tests in CI ([1752131](https://github.com/lobu-ai/lobu/commit/175213174d40d3b2dfe17af179dacb6490b248be))
* improve error handling for streaming validation errors ([ea72817](https://github.com/lobu-ai/lobu/commit/ea72817918823efbac688b9ae84e73289399c648))
* resolve CI workflow syntax errors ([a312b9f](https://github.com/lobu-ai/lobu/commit/a312b9f909c7b5c96896add46d4bb5ffc488267e))
* simplify Docker multi-arch support and improve MCP configuration ([5f4e2d8](https://github.com/lobu-ai/lobu/commit/5f4e2d8d0f7d475663b0458d2075d878a263d646))

## [2.2.1](https://github.com/lobu-ai/lobu/compare/v2.2.0...v2.2.1) (2025-10-27)


### Bug Fixes

* export ActionButton and ModuleSessionContext types and fix implicit any ([6d6bc01](https://github.com/lobu-ai/lobu/commit/6d6bc01ff53e912f5a6bc584b6e99b132a18fd75))

## [2.2.0](https://github.com/lobu-ai/lobu/compare/v2.1.0...v2.2.0) (2025-10-27)


### Features

* add 20-minute timeout to all GitHub Actions workflows ([0798d77](https://github.com/lobu-ai/lobu/commit/0798d777908090c285eeda35074739e54dae6bf7))


### Bug Fixes

* remove broken integration tests causing 6-hour CI timeout ([1abd9c4](https://github.com/lobu-ai/lobu/commit/1abd9c4f0d24d2752780dc55db20cb7bc1a20113))
* update worker-job-router tests to match fire-and-forget architecture ([b7d00d2](https://github.com/lobu-ai/lobu/commit/b7d00d27311339312cf9aa2b08f87e5fe1ecb83a))

## [2.1.0](https://github.com/lobu-ai/lobu/compare/v2.0.0...v2.1.0) (2025-10-27)


### Features

* add force npm publish workflow for emergency release ([92965fc](https://github.com/lobu-ai/lobu/commit/92965fcebda8b3c1d1f7d1d987d66459a71c117b))
* add Gemini integration and improve gateway/worker architecture ([331cdda](https://github.com/lobu-ai/lobu/commit/331cddaff94a4ccee01ff4e52e095ea611d9f77b))
* add manual npm publish workflow for existing releases ([e1c13d4](https://github.com/lobu-ai/lobu/commit/e1c13d448ca2078f134d38cbfc4934577cdcc8cc))
* re-enable custom tools and remove unused claudeSessionId tracking ([2adb766](https://github.com/lobu-ai/lobu/commit/2adb766077f1d688ba93ca1994b260aff3f6e4b8))


### Bug Fixes

* build only required packages for npm publishing ([55065a7](https://github.com/lobu-ai/lobu/commit/55065a773f1d86785732ea2b116447013cbb3d35))
* simplify manual npm publish to use main branch ([423eb43](https://github.com/lobu-ai/lobu/commit/423eb436c21445fd42ed99129fd7a89469a00dc7))
* temporarily disable custom tools to fix npm build ([2065c74](https://github.com/lobu-ai/lobu/commit/2065c7456cb50bb7f7b8b413d0ec0b9f9509655e))

## [2.0.0](https://github.com/lobu-ai/lobu/compare/v1.0.6...v2.0.0) (2025-10-26)


### ⚠ BREAKING CHANGES

* Database schema changed - requires fresh migration

### Features

* add CLI and create-lobu packages with platform-agnostic architecture ([4674b47](https://github.com/lobu-ai/lobu/commit/4674b4769989b8302605b4bb0b254f0b53f2d350))
* add dispatcher package and enhance MCP OAuth support with SSE ([d39a4ce](https://github.com/lobu-ai/lobu/commit/d39a4ce338b78a84beea1fed378dcdcf109c364d))
* add ENCRYPTION_KEY to orchestrator deployment ([61d1ba3](https://github.com/lobu-ai/lobu/commit/61d1ba3d76a90d131a477f816a9c3fb2b96b0dcb))
* add environment variable encryption and improve Slack handlers ([87fa08a](https://github.com/lobu-ai/lobu/commit/87fa08a673344423280494e85b7ea81eaf4ec6c7))
* add file handling, Slack Assistant support, and comprehensive MCP OAuth system ([a3d6f3a](https://github.com/lobu-ai/lobu/commit/a3d6f3ab46d40cabf18f08807c5a4ac4c57d52ea))
* add file handling, Slack Assistant support, and comprehensive MCP OAuth system ([0f98b23](https://github.com/lobu-ai/lobu/commit/0f98b235c04c5a7b536d77ed4edddf7edcc31022))
* add file handling, Slack Assistant support, and comprehensive MCP OAuth system ([44214cf](https://github.com/lobu-ai/lobu/commit/44214cf5ad174235a9551921215b5decfc1dd72a))
* add gVisor runtime support for enhanced Docker isolation ([90c4c5f](https://github.com/lobu-ai/lobu/commit/90c4c5f844e25d7d8d562b7116eb20efa52f7e13))
* add integration tests and fix type errors ([28e5229](https://github.com/lobu-ai/lobu/commit/28e522912c932806ee57ba82c0f727818a280014))
* add kata runtime support for enhanced container isolation ([60c3ee1](https://github.com/lobu-ai/lobu/commit/60c3ee136e1bd778f2a8c34c90e58854d66356e8))
* add MCP OAuth discovery, worker config API, and hot reload improvements ([bd39890](https://github.com/lobu-ai/lobu/commit/bd39890a1f58541c59e1ef0a0999e7dd1b219c41))
* add PostgreSQL schema initialization to Helm chart ([1569127](https://github.com/lobu-ai/lobu/commit/1569127860d0dd7412e84d22c9e61c6ca2509cee))
* add slash commands and channel-aware environment storage ([f0abbd4](https://github.com/lobu-ai/lobu/commit/f0abbd4ddd9add116a5dfad839db4bc49c68933c))
* add subprocess deployment manager with bubblewrap sandboxing ([d877c74](https://github.com/lobu-ai/lobu/commit/d877c743b1ac79bd43bfed604bb1bb50ad82bbb8))
* add task list header and dividers between task status changes ([994e127](https://github.com/lobu-ai/lobu/commit/994e12726c8054e31fadb409c315be04340ca64d))
* add welcome message for new team members ([8f7b0b3](https://github.com/lobu-ai/lobu/commit/8f7b0b3d56d02ea40cb033137cd304097b169c06))
* chronological output with intermediate text and final summary ([f218f24](https://github.com/lobu-ai/lobu/commit/f218f24051474d74cd2fc88bdf36171853ad1d92))
* cleanup deprecated code, implement TODOs, and improve logging ([2af7546](https://github.com/lobu-ai/lobu/commit/2af754678460529ed7907c1bb54f280cf8180c8d))
* cleanup deprecated code, implement TODOs, and improve logging ([f7b479d](https://github.com/lobu-ai/lobu/commit/f7b479da1d6e33d4795c8c7ec64b724b5e376d6d))
* complete module system implementation with endpoint registration ([2b11395](https://github.com/lobu-ai/lobu/commit/2b11395c18f97277882dac84082ae9e4fc0fe6dd))
* consolidate error classes into shared package ([e29ab36](https://github.com/lobu-ai/lobu/commit/e29ab36825935ab6cadb84abe6f600e6ab8b71d7))
* consolidate error classes into shared package ([495c1f9](https://github.com/lobu-ai/lobu/commit/495c1f9ac89ee722c41319f6c8e90e7952254213)), closes [#56](https://github.com/lobu-ai/lobu/issues/56)
* enhance GitHub integration and update Docker configuration ([c777d7b](https://github.com/lobu-ai/lobu/commit/c777d7be4e1bac3354e71d34ee27ce1e970e4718))
* enhance MCP OAuth with discovery and config service ([a1cc8fe](https://github.com/lobu-ai/lobu/commit/a1cc8fefa22b9b6ceb22803a8c2e656bbfd2921b))
* implement context-aware environment storage ([afb50cd](https://github.com/lobu-ai/lobu/commit/afb50cd9c29db912417eaa5c74c3103319b83636))
* implement direct environment variable storage for BlockKit forms ([87a749c](https://github.com/lobu-ai/lobu/commit/87a749cbbbd43bf53099561a9723f0ffe2e647d2))
* implement module system for pluggable integrations ([8153c12](https://github.com/lobu-ai/lobu/commit/8153c12960da55f9ec7256f7b93e296fd9fcb65e))
* implement module system for pluggable integrations ([9ab2508](https://github.com/lobu-ai/lobu/commit/9ab250839466311edf864001bb08bc9b0f1dd4c9))
* improve Claude OAuth authentication flow ([4cc1051](https://github.com/lobu-ai/lobu/commit/4cc10510d3aceea1f095fbc3b06d046a06325e62))
* improve MCP OAuth with dynamic registration and credential persistence ([9872656](https://github.com/lobu-ai/lobu/commit/98726569a45d1d9d8c254662191b40bd8469dfcb))
* increase PVC quota limit from 5 to 100 ([154f3d6](https://github.com/lobu-ai/lobu/commit/154f3d6373b8392f099ff10217da048dec04fa9c))
* optimize worker resources and increase capacity for 30+ workers ([898d04c](https://github.com/lobu-ai/lobu/commit/898d04c09ca6b270ad9cfb2c0a9f35307def14c3))
* remove GitHub dependencies from core packages ([5c20e59](https://github.com/lobu-ai/lobu/commit/5c20e59a9539af373ea74adff9a27f642cd89766))
* remove subprocess deployment mode ([15f7c1a](https://github.com/lobu-ai/lobu/commit/15f7c1a3838deb5197e381556a0419f2ae9e8b95))
* replace image-puller DaemonSet with Spegel P2P image distribution ([e8c78a3](https://github.com/lobu-ai/lobu/commit/e8c78a30f9663a0ae9201b17ee155228b871bb92))
* replace image-puller DaemonSet with Spegel P2P image distribution ([b49dce6](https://github.com/lobu-ai/lobu/commit/b49dce60e9646566125edc6f0e9cc5542e2956e8)), closes [#52](https://github.com/lobu-ai/lobu/issues/52)
* update slash commands and add global shortcuts ([bc4ca4f](https://github.com/lobu-ai/lobu/commit/bc4ca4f43c46ed6543857178c65b26a0076126c2))


### Bug Fixes

* add automatic handling of stuck Helm releases in deployment ([83963ae](https://github.com/lobu-ai/lobu/commit/83963ae4b18b995aa40a1a04b2a9b66959296565))
* add backward compatibility for environment variable encryption ([949fd58](https://github.com/lobu-ai/lobu/commit/949fd5828d7dc7a16b5726d7e84a25c7f59c9cc2))
* Add explicit npm authentication step in release workflow ([1fc0eab](https://github.com/lobu-ai/lobu/commit/1fc0eab307bf9ec9e361936e64affb8d0ea13a0d))
* add GitHub Container Registry authentication for OCI charts in workflows ([a15ebdc](https://github.com/lobu-ai/lobu/commit/a15ebdcf9f1e87d9cfb5369500b7dc58ff9b2d01))
* add production environment to release-please workflow for npm publishing ([1cd6121](https://github.com/lobu-ai/lobu/commit/1cd6121d15876e223a2a741c0839cc6c4e3c99fc))
* add production environment to release-please workflow for npm publishing ([92a5c26](https://github.com/lobu-ai/lobu/commit/92a5c26aca24b5ab395c9a9ae6299177a156d4ec))
* add resource limits to Spegel for quota compliance ([101d41e](https://github.com/lobu-ai/lobu/commit/101d41e18b893d2a8defa5852e8b0231bf067f7c))
* add slash commands to Slack app manifest ([eb4f5f3](https://github.com/lobu-ai/lobu/commit/eb4f5f37be861a422b6030fa269c52daa7d3bcb6))
* add timeout and debugging for stuck deployments ([cbd0218](https://github.com/lobu-ai/lobu/commit/cbd021895d97ba38939ae4ef91350f84f056c4e8))
* change slash command back to /lobu ([55e8f15](https://github.com/lobu-ai/lobu/commit/55e8f15e9fe11f2f8c333272304cf36b04240117))
* cleanup more Helm release secrets to stay under quota ([48eefbe](https://github.com/lobu-ai/lobu/commit/48eefbef0c6076ae3c65da52ff0e277c3fed3744))
* completely remove imagePuller and fix Helm dependency management ([a96aeeb](https://github.com/lobu-ai/lobu/commit/a96aeeb814174d91ab8744b360943925cbebd83f))
* consolidate database schema initialization in Helm ConfigMap ([7a1fd29](https://github.com/lobu-ai/lobu/commit/7a1fd29902768644880c55cb89df12d478323988))
* correct deployment command syntax in GitHub workflow ([765b170](https://github.com/lobu-ai/lobu/commit/765b170ff7fff8e256b45f4c87a5b66abab02f51))
* correct Docker image repository names in Makefile ([3c4d535](https://github.com/lobu-ai/lobu/commit/3c4d5358bd51d03d2e1d06f577b8a8fa498ae9f4))
* correct Makefile syntax error in TARGET handling ([f53ece5](https://github.com/lobu-ai/lobu/commit/f53ece5d268413d77c55b0d50100adf2c5a74c91))
* correct Sentry postgres integration import ([25e9353](https://github.com/lobu-ai/lobu/commit/25e9353f5fd49126a411ca1603f5e07949dfc686))
* correct Sentry postgres integration import ([6d28818](https://github.com/lobu-ai/lobu/commit/6d28818d4b80c782e3f9cc232ebe3cc113d57659)), closes [#50](https://github.com/lobu-ai/lobu/issues/50)
* correct Spegel resource format to match chart structure ([c60eaf5](https://github.com/lobu-ai/lobu/commit/c60eaf543a4e5af03f71747897e77dc8167423ce))
* Create GitHub repositories in user's space instead of organization ([8624626](https://github.com/lobu-ai/lobu/commit/862462695811ce9d1ab325af131ec89dad2423dc))
* downgrade @kubernetes/client-node to 0.21.0 to fix build errors ([8195f6b](https://github.com/lobu-ai/lobu/commit/8195f6b72712ed4f00e36a1241a68413f190cac9))
* ensure PostgreSQL user exists when reusing K8s secrets ([d58569b](https://github.com/lobu-ai/lobu/commit/d58569b93f7405d75fa2160583bf0fbf1f516884))
* force clear stuck Helm releases by deleting state secrets ([b4b00ba](https://github.com/lobu-ai/lobu/commit/b4b00ba9e04e028dd336212baf73fbad4f623ce1))
* format code with biome ([83d81cc](https://github.com/lobu-ai/lobu/commit/83d81cc7bdb52f15489f68730d94672ef72f4611))
* format slack-app-manifest.json to pass CI checks ([cd2e119](https://github.com/lobu-ai/lobu/commit/cd2e119b3269bff2532b981ee905e6802ff5c1cf))
* handle PostgreSQL StatefulSet immutable field updates in deployment ([affaf10](https://github.com/lobu-ai/lobu/commit/affaf103f3f3c43ce4d06c43ae52161ec23a7753))
* handle PostgreSQL StatefulSet update conflicts in deployment ([7d88920](https://github.com/lobu-ai/lobu/commit/7d88920952c90d06de9a341b2ecbafba2edd6bf9))
* handle Try Demo button from home tab and database constraints ([7ad143a](https://github.com/lobu-ai/lobu/commit/7ad143ab31beb6066f929f8abddb8a12e1a9594d))
* improve error handling for PVC quota exceeded errors ([45ef739](https://github.com/lobu-ai/lobu/commit/45ef739c6702a0cb6a5759076502999becf3dc78))
* improve Helm release state handling in deployment workflow ([a878c28](https://github.com/lobu-ai/lobu/commit/a878c28011218f284175e5fe04b85b1ce3ee3db7))
* improve K8s deployment error handling and debugging ([024d4bc](https://github.com/lobu-ai/lobu/commit/024d4bc581f907b072ddd2879512d3b1d5d18f73))
* improve K8s deployment error handling with detailed PVC logging ([e5e809c](https://github.com/lobu-ai/lobu/commit/e5e809c58109adcbdbf0228f845e0b52d96d18a2))
* include all Helm releases in state check including failed/pending ([349a4b8](https://github.com/lobu-ai/lobu/commit/349a4b8924d306cedfec0a9951f7b58c1d0cde1e))
* increase secret quota to 100 for Helm releases ([663c181](https://github.com/lobu-ai/lobu/commit/663c1810da09745814f99568bf65697ba5603b4a))
* make GITHUB_TOKEN optional in dispatcher deployment ([ef1b004](https://github.com/lobu-ai/lobu/commit/ef1b004a296bbe91f1aada7392b3f784c1cf0e25))
* make github-token optional in worker deployments ([edadc33](https://github.com/lobu-ai/lobu/commit/edadc33d5f51f5a5f2307e751f64b97fb12e68ea))
* make Slack notifications optional in deployment workflow ([65fdce8](https://github.com/lobu-ai/lobu/commit/65fdce83eb6bb4f50c89fa6863708ac0715b6080))
* make task updates append-only to prevent multiple messages ([2a2afcc](https://github.com/lobu-ai/lobu/commit/2a2afccb040bb8a1d8e6d9190cc6302c4553aef1))
* move GitHub Container Registry login to same step as helm commands ([358b241](https://github.com/lobu-ai/lobu/commit/358b241e3502ba8185c286ddd55e0c101ead0e52))
* preserve VALUES_FILE variable throughout Makefile deploy target ([b2022f7](https://github.com/lobu-ai/lobu/commit/b2022f7f22f327f45bdf348c67ac4fb0085558b1))
* prevent duplicate content by not resending accumulated output at completion ([0a886f1](https://github.com/lobu-ai/lobu/commit/0a886f13715501d2891ffcc2d410d6923a878579))
* prevent duplicate TodoWrite messages by skipping tool_call processing ([6e9f09b](https://github.com/lobu-ai/lobu/commit/6e9f09bcb0fc0dd47a03dab29c5c1547d0e7cb34))
* remove content-encoding header to prevent ZlibError ([e78c9a4](https://github.com/lobu-ai/lobu/commit/e78c9a41bb37cb15944571874c0573ed657c0b38))
* remove dead code and clean up module system ([66429d3](https://github.com/lobu-ai/lobu/commit/66429d3d4e8ebc6761ca72d37e50aab4749eb650))
* remove duplicate ENCRYPTION_KEY environment variable ([f991fa5](https://github.com/lobu-ai/lobu/commit/f991fa56f4bcc5a3ad817ad41d6c2a2a2a2f264d))
* remove duplicate values file logic in Makefile ([24ad6f0](https://github.com/lobu-ai/lobu/commit/24ad6f08947082d5b7905eeadfcb96497b5bc1e6))
* remove gateway placeholder stream logic ([d490f3b](https://github.com/lobu-ai/lobu/commit/d490f3b7a95ea26e9ddf05040f8cfcc1eeda93c4))
* remove K8s-specific database initialization ([4c7924f](https://github.com/lobu-ai/lobu/commit/4c7924f0e71d3842c589bd9d1c1ae50e92021386))
* remove Slack notifications from deployment workflow ([9d9d8bd](https://github.com/lobu-ai/lobu/commit/9d9d8bd1488b7d58eee52e6bb1ffd4db6eb3c9e9))
* resolve CI failures - correct Sentry import and format code ([4c27e7f](https://github.com/lobu-ai/lobu/commit/4c27e7fac84014c06f274cad3ea84880505a25b1))
* resolve CI failures and add pre-commit hooks ([0173fe3](https://github.com/lobu-ai/lobu/commit/0173fe36a5d775a8e74729059b6a117de7ab59f1))
* resolve critical issues from code review ([912232d](https://github.com/lobu-ai/lobu/commit/912232ddc46e9a25bed7f49f2823d1ffaa3fe15d))
* resolve linting issues in test files ([b214013](https://github.com/lobu-ai/lobu/commit/b2140138acc5c13812a6057029a5197930844a62))
* resolve PostgreSQL StatefulSet upgrade issues properly ([9a17db2](https://github.com/lobu-ai/lobu/commit/9a17db2853308e98e2cf1a184ef0d9ec22a6d65d))
* resolve Slack form submission timeout issues ([0238283](https://github.com/lobu-ai/lobu/commit/023828358c5139f18da3f14ab9483d6ae359ecb3))
* resolve TypeScript and formatting issues for CI pipeline ([1e7b3e2](https://github.com/lobu-ai/lobu/commit/1e7b3e2a65bb20ee2222a4cceaab964343a24a35))
* restore slack-qa-bot.js and update E2E test script ([f0f5bf5](https://github.com/lobu-ai/lobu/commit/f0f5bf59e67d631c591513cf5d7c3e29c45baad5))
* simplify deployment by using Makefile properly ([558af50](https://github.com/lobu-ai/lobu/commit/558af5088c7b340f57460e5f76269aee013a403a))
* stabilize module registry integration ([4c8c6a3](https://github.com/lobu-ai/lobu/commit/4c8c6a3fbe48defb425689bc86f7921480f4cbaf))
* TypeScript and lint errors in Slack handlers ([943fae6](https://github.com/lobu-ai/lobu/commit/943fae6d51f25fbebac213df11ddab89ac8a8991))
* update slack thread processor imports ([207a173](https://github.com/lobu-ai/lobu/commit/207a173230272bbdff8d315d96d1f79f4d80272d))
* update Spegel to v0.4.0 and add Helm artifacts to gitignore ([32a4964](https://github.com/lobu-ai/lobu/commit/32a4964e667e70f5c1d7e416b3281ba1dbf6af0f))
* use demo repository as default instead of creating user repos ([17d0303](https://github.com/lobu-ai/lobu/commit/17d030359a3ed3674f3e2cca21c0031d975fa434))
* use Helm directly in deployment workflow instead of make ([2320d4a](https://github.com/lobu-ai/lobu/commit/2320d4ab8686879b8215b29f51fbe2fcedca87e1))
* worker stuck on named pipe + chronological output display ([f0ad8bf](https://github.com/lobu-ai/lobu/commit/f0ad8bf560635ac55a9622db2da8ccd7e4c6e5bd))


### Reverts

* remove task list header and dividers ([ac83f9b](https://github.com/lobu-ai/lobu/commit/ac83f9b2dd285c66b8162a5551f8a2ab46f959a7))


### Code Refactoring

* consolidate environment variables and streamline CI/CD ([e24b185](https://github.com/lobu-ai/lobu/commit/e24b185a4f4edc775730ac759efbcf64a78ea58d))

## [1.0.6](https://github.com/lobu-ai/lobu/compare/v1.0.5...v1.0.6) (2025-09-16)


### Bug Fixes

* add Helm release cleanup to prevent quota exceeded errors ([cbe8762](https://github.com/lobu-ai/lobu/commit/cbe8762a94acca14fec7933b7705f56bf4184b13))
* enable OVH deployment and fix GitHub Actions workflows ([408c36b](https://github.com/lobu-ai/lobu/commit/408c36b2c3b94cff00f2a46998f1234efdbb01da))
* handle stuck Helm deployments and use correct image tags ([bf83c61](https://github.com/lobu-ai/lobu/commit/bf83c61cda61530dcc345006e640693a37523a86))
