# Changelog

## [3.3.0](https://github.com/lobu-ai/lobu/compare/v3.2.0...v3.3.0) (2026-04-14)


### Features

* add agent-community use case and extract UseCaseTabs label prop ([ba956ad](https://github.com/lobu-ai/lobu/commit/ba956ad13bdb642e22c3ed6bc2a7c00128d2ff72))
* add ecommerce use case to landing page ([4982606](https://github.com/lobu-ai/lobu/commit/498260638532f7da16400a0bf6f1aca7e8ff3f46))
* add privacy policy page and footer link ([b9df04f](https://github.com/lobu-ai/lobu/commit/b9df04fffab714edaa569f447bb29b96c0c65c07))
* expand landing use cases and normalize network grants ([e9b0282](https://github.com/lobu-ai/lobu/commit/e9b02825b2c721fa4cde8a5a68d07e5ddfd4c993))
* harden file delivery flows and add OpenRouter CI evals ([676544c](https://github.com/lobu-ai/lobu/commit/676544c1d9871debd6116a638108ad2a757fd1af))
* **landing:** add posthog analytics ([b7b431d](https://github.com/lobu-ai/lobu/commit/b7b431d0bc30ddb1a104ed2473ab1aa7d695577c))
* **landing:** revamp memory page demo ([96dba19](https://github.com/lobu-ai/lobu/commit/96dba192e07b7861b333c9d7f3fc72701527436a))
* make skills page init preview contextual to selected use-case ([146e87a](https://github.com/lobu-ai/lobu/commit/146e87ad8838c5dd03c5f27900636e05c527823f))
* refresh landing pages and pricing UX ([c8d8b58](https://github.com/lobu-ai/lobu/commit/c8d8b58fd6ea4b16583d67259e61839dc9ee1f52))
* show nix packages in landing skill previews ([6095e13](https://github.com/lobu-ai/lobu/commit/6095e13447d9d7c3e6214a9995b9994645ee8bf9))


### Bug Fixes

* **ci:** guard docker sha tags on release events ([#181](https://github.com/lobu-ai/lobu/issues/181)) ([48b75ac](https://github.com/lobu-ai/lobu/commit/48b75ac8154c801bbdc8676412cf5fabe804d8aa))
* **cli:** replace RequestInfo with portable fetch input type ([ba23c4a](https://github.com/lobu-ai/lobu/commit/ba23c4a260949f75e81876dd4e85e35449d5cada))
* deduplicate owletto URL logic, fix skills card title, add skills link to memory reuse step ([78ad65e](https://github.com/lobu-ai/lobu/commit/78ad65e75faa689fbaa3715c0cc3eec1496c8527))
* make memory step layouts consistent ([990bf61](https://github.com/lobu-ai/lobu/commit/990bf61d7af60d43c6487f99c2b73b27820e4468))
* point agent-community Try Now to venture-capital org ([b117767](https://github.com/lobu-ai/lobu/commit/b117767c65e1e817a39f567ad39cc2abf2459da0))

## [3.2.0](https://github.com/lobu-ai/lobu/compare/v3.1.2...v3.2.0) (2026-04-11)


### Features

* refresh cli docs and restore release publish chain ([#179](https://github.com/lobu-ai/lobu/issues/179)) ([1ee0595](https://github.com/lobu-ai/lobu/commit/1ee0595d354b0dee1a85d4b3015fd1c9adcab4a0))

## [3.1.2](https://github.com/lobu-ai/lobu/compare/v3.1.1...v3.1.2) (2026-04-11)


### Bug Fixes

* **ci:** put version in release-please PR title + add workflow_dispatch ([#176](https://github.com/lobu-ai/lobu/issues/176)) ([9021308](https://github.com/lobu-ai/lobu/commit/9021308ed7162a7bd20e08817c351a64684ed7c1))
* **ci:** use default release-please title pattern variables ([#178](https://github.com/lobu-ai/lobu/issues/178)) ([26709e3](https://github.com/lobu-ai/lobu/commit/26709e3c19e01ebf58220118a056833caf6ea50b))

## [3.1.1](https://github.com/lobu-ai/lobu/compare/v3.1.0...v3.1.1) (2026-04-11)


### Bug Fixes

* **ci:** reconcile release-please config + Chart.yaml appVersion ([#174](https://github.com/lobu-ai/lobu/issues/174)) ([c6ea7c8](https://github.com/lobu-ai/lobu/commit/c6ea7c8368f312f2deb10deb5e723ef76e23ece6))

## [3.1.0](https://github.com/lobu-ai/lobu/compare/v3.0.19...v3.1.0) (2026-04-10)


### Features

* **gateway:** support leading-dot domain patterns in GrantStore ([f2a1006](https://github.com/lobu-ai/lobu/commit/f2a1006e4a9769c90bf5521332c87a8c0ed156ff))
* **mcp-auth:** surface login prompts as platform link buttons ([9ca5449](https://github.com/lobu-ai/lobu/commit/9ca5449a48321db1e6a81f3ab1172b8768f272fc))


### Bug Fixes

* **ci:** release-please triggers publish-packages via gh workflow run ([87b14cb](https://github.com/lobu-ai/lobu/commit/87b14cbaea46df47be6e5a71d7fc498523c23995))
* **ci:** use yaml updater for Chart.yaml version + appVersion ([58819bc](https://github.com/lobu-ai/lobu/commit/58819bc604ed04448a10e8a67535c8b1ff470911))

## [2.7.0](https://github.com/lobu-ai/lobu/compare/v2.6.1...v2.7.0) (2026-03-18)


### Features

* add Reddit and X (Twitter) as OAuth integrations ([7a57b9c](https://github.com/lobu-ai/lobu/commit/7a57b9c7b8a1f021923a5718c63e95000d20cf3e))
* **ci:** migrate Docker images from Docker Hub to GHCR ([c01824a](https://github.com/lobu-ai/lobu/commit/c01824a6e7a59ee202145df5471ee9f863380eb3))
* **cli,gateway:** multi-agent CLI, external OAuth, agent seeding ([d4dba49](https://github.com/lobu-ai/lobu/commit/d4dba4998f2914d07d9528abc0a3b48a564ec8cc))
* **config:** add system skills for integrations and LLM providers ([de25b3c](https://github.com/lobu-ai/lobu/commit/de25b3c885c6ec1301da998a1c38aac371b8e430))
* **config:** add system skills, skill registries, and MCP example config ([cb356d0](https://github.com/lobu-ai/lobu/commit/cb356d077eea2338d9b31b4c76db5e92d5f44e27))
* **core:** add integration, provider config, and skill metadata types ([94c1012](https://github.com/lobu-ai/lobu/commit/94c1012b28d1d7d9209f56ee8e8f237b212c0f7b))
* **gateway:** add integration framework — OAuth, credential store, API proxy ([0a19e2d](https://github.com/lobu-ai/lobu/commit/0a19e2d0ebaaf6910efe8e66a1135a2bbec0d419))
* **gateway:** improve OAuth UX on settings page by removing auto-redirect and adding login button ([2757725](https://github.com/lobu-ai/lobu/commit/2757725c6a4a2c450d003389235f334cb1e70f75))
* **gateway:** integration services, config-driven providers, and orchestration updates ([170e824](https://github.com/lobu-ai/lobu/commit/170e824c5c5f00f8ac8093d051f683e83d558cd6))
* **gateway:** settings page overhaul — skills section, integration status, remove env vars ([02b3160](https://github.com/lobu-ai/lobu/commit/02b3160d2b3234e99a2b714355096c76d75d9ec1))
* **landing:** add interactive prompt + output demo to skills section ([dc8a806](https://github.com/lobu-ai/lobu/commit/dc8a80640d748dc9a9bf46b7223d3739a52e1770))
* **landing:** embed OpenClaw creator tweet confirming single-user design ([4c6537b](https://github.com/lobu-ai/lobu/commit/4c6537b03aaa7218191c18a69b3b8d00c82e2297))
* **landing:** link OpenClaw runtime to comparison page with architecture reasoning ([2977bbb](https://github.com/lobu-ai/lobu/commit/2977bbb16d3415459793bacf1f3d769a763268b6))
* **landing:** migrate from Vite SPA to Astro with Starlight docs ([687c6f7](https://github.com/lobu-ai/lobu/commit/687c6f737f59f807d5e5723258d549593343b244))
* **landing:** rename skills-as-saas to skills and update hero copy ([42009c5](https://github.com/lobu-ai/lobu/commit/42009c5d709cbdac0455512326757813d7f27805))
* **landing:** replace Telegram chat with terminal log for connections row ([2a3467e](https://github.com/lobu-ai/lobu/commit/2a3467e385bef38a1f066ed90482f1bd91cf5b3b))
* migrate Owletto plugin to published @lobu/owletto-openclaw package ([b4666c5](https://github.com/lobu-ai/lobu/commit/b4666c50c375331aaf5fd2b8802b6891974459e0))
* migrate to Chat SDK platform adapters with typed OpenAPI schemas ([89573db](https://github.com/lobu-ai/lobu/commit/89573dbf3242249034f37543671db26493ccbd88))
* multi-auth settings UX, base provider module refactor, and infra improvements ([1c61b30](https://github.com/lobu-ai/lobu/commit/1c61b30e931f68ee37b9d8775fcae66c1e95643c))
* **oauth:** add PKCE, RFC 8707 resource, auto-grants, and MCP token endpoint ([63336a7](https://github.com/lobu-ai/lobu/commit/63336a78d92999384fa873216668467a2787666c))
* Owletto memory plugin, plugin hooks/services, test infrastructure, and misc improvements ([89c27f0](https://github.com/lobu-ai/lobu/commit/89c27f0736e74fe83de6b1664017b21130cd489f))
* **proxy:** resolve provider credentials via URL path agentId ([1dbcb8c](https://github.com/lobu-ai/lobu/commit/1dbcb8c3c3a9ee6471733cedfcadf9ee5e1b3f6d))
* settings page rewrite (Alpine→Preact), history page, Telegram enhancements, landing page ([b2cba55](https://github.com/lobu-ai/lobu/commit/b2cba551671812f2c54e9188fa74cc77ecd2f27c))
* **settings:** post-install callback with agent resume ([d96e99b](https://github.com/lobu-ai/lobu/commit/d96e99b120054cebad862f788eef427faefb4e40))
* **skills:** add scoring, URI, and system skill search to SearchSkills ([d63d7a8](https://github.com/lobu-ai/lobu/commit/d63d7a8e1a0b16dfcd8761a1ed54690cd84616c6))
* **worker:** ConnectService, CallService, DisconnectService tools and integration runtime ([af5a270](https://github.com/lobu-ai/lobu/commit/af5a270ba8e5d66e77cb7cd9c1d495d183e22a44))
* **worker:** expand ConnectService to support AI provider setup ([45b0c93](https://github.com/lobu-ai/lobu/commit/45b0c9396a759a14eb67c22347aee2de08e4543e))


### Bug Fixes

* add CSS generation step to gateway Dockerfile ([d361129](https://github.com/lobu-ai/lobu/commit/d3611292caadd929c89e4b7fbabb27da9f3c632c))
* add default model fallback per provider and fix z-ai base URL env var ([ebb8237](https://github.com/lobu-ai/lobu/commit/ebb82377c966a4cb44d033dc8744958f447f7133))
* **ci:** bump Bun to 1.3.5 to fix CONNECT test failures ([1970c9a](https://github.com/lobu-ai/lobu/commit/1970c9a7ad5380134c5da514a88847dbc520ca8d))
* **ci:** gate release steps on explicit true output ([47346e5](https://github.com/lobu-ai/lobu/commit/47346e54a866bc6700413e34621387b61d5cb924))
* **ci:** pin bun version for landing deploy ([0c62bf0](https://github.com/lobu-ai/lobu/commit/0c62bf09804b9e5851c51f85b22fdbafd744f278))
* **ci:** sync bun lockfile ([16c91dd](https://github.com/lobu-ai/lobu/commit/16c91dd052f7571da9c144787afef670ccc09338))
* **ci:** use GitHub secret for Telegram token, not k8s sealed secret ([ff27697](https://github.com/lobu-ai/lobu/commit/ff27697611db35e5c7d1c31e0b6fdcd1f27c045e))
* clear mismatched default model in auto-mode provider selection ([ab20949](https://github.com/lobu-ai/lobu/commit/ab20949514d09158e33c4a0951cdda498a226c8d))
* clear stale session when provider changes ([080afe0](https://github.com/lobu-ai/lobu/commit/080afe0b1bb818a3166b55804d285290e101d0e1))
* **deploy:** remove broken global.imageRegistry that caused double-slash in Bitnami Redis image paths ([e37d81c](https://github.com/lobu-ai/lobu/commit/e37d81c79593234b9fb44aa2f2e1b9150fa3678f))
* **deploy:** update sealed secrets with all required keys ([fbe588e](https://github.com/lobu-ai/lobu/commit/fbe588e8296746a29f1ddb12af56f56856f3b420))
* **gateway:** escape oauth callback template values ([#122](https://github.com/lobu-ai/lobu/issues/122)) ([d4cfc45](https://github.com/lobu-ai/lobu/commit/d4cfc45dacd6bec48c3c904f751a863b9f6510e6))
* **gateway:** redact secrets in agent config response ([#127](https://github.com/lobu-ai/lobu/issues/127)) ([6af4424](https://github.com/lobu-ai/lobu/commit/6af44241faa9f1fae60eba49423528a295d1a4c1))
* **gateway:** remove settings token query exposure ([#130](https://github.com/lobu-ai/lobu/issues/130)) ([9d4adb8](https://github.com/lobu-ai/lobu/commit/9d4adb83ffbcd128250704d5cf19859eaaf0193a))
* **gateway:** require auth for channel binding routes ([#123](https://github.com/lobu-ai/lobu/issues/123)) ([6736fe9](https://github.com/lobu-ai/lobu/commit/6736fe9ede187f71a7c513b20cf2f1c528188a10))
* **gateway:** require settings token for chatgpt start/poll ([#124](https://github.com/lobu-ai/lobu/issues/124)) ([4004401](https://github.com/lobu-ai/lobu/commit/4004401d78aa6e62a65661c1b0e3f229873a6c31))
* **gateway:** skip enqueuing worker delivery receipts to thread response queue ([c5c352d](https://github.com/lobu-ai/lobu/commit/c5c352d50b9dfd80570bb78743735eb94adb38d3))
* **gateway:** stop logging WhatsApp credential payloads ([#128](https://github.com/lobu-ai/lobu/issues/128)) ([68968b5](https://github.com/lobu-ai/lobu/commit/68968b57c8384e52939daca407c3f8f3a308050c))
* **helm:** expose ADMIN_PASSWORD and platform tokens as gateway env vars ([968f4a8](https://github.com/lobu-ai/lobu/commit/968f4a89b230c0608a48f851fcda7f77ce046992))
* **helm:** make claude-code-oauth-token secret ref optional ([992a2e6](https://github.com/lobu-ai/lobu/commit/992a2e6c2652781975285bd0b14618990c90ded0))
* **helm:** remove platform token env vars from gateway deployment ([062f18f](https://github.com/lobu-ai/lobu/commit/062f18f71f82538c0ee343e608e4861e78e9a281))
* include z.ai API path prefix in upstream base URL ([4ad79c9](https://github.com/lobu-ai/lobu/commit/4ad79c92da9d2b3ca0c0c39328956bf05b5aa60b))
* **landing:** correct homepage prompt and CLI command references ([5f4429f](https://github.com/lobu-ai/lobu/commit/5f4429fa118a23018df97db83cda7c8a62760602))
* **landing:** resolve zod alias from installed package ([f09e12d](https://github.com/lobu-ai/lobu/commit/f09e12d8409a122c8f33db3bb915c84af1d9e1c9))
* **landing:** use descriptive agent names in ConnectionsPanel ([f8f38c1](https://github.com/lobu-ai/lobu/commit/f8f38c118d703015580680eb3717c74755b2cb7b))
* map z-ai gateway slug to zai model registry provider name ([64b606e](https://github.com/lobu-ai/lobu/commit/64b606e1c274463e5b96419a77e42905a4abb0f4))
* **proxy:** handle CONNECT method in request handler for Bun on Linux ([320e028](https://github.com/lobu-ai/lobu/commit/320e028f6e8b2a24733fbca52d7a1880c9787590))
* recreate scaled-down workers with fresh env vars on wake-up ([879cd41](https://github.com/lobu-ai/lobu/commit/879cd41ff25146c2724e62f170bbe6566a2bbbca))
* resolve worker CJS/ESM module error and missing Nix in production ([fda47de](https://github.com/lobu-ai/lobu/commit/fda47de2bb6169eef79c4df8d96f57d7ca0af0c2))
* respect installed provider order when no explicit model is set ([2319f36](https://github.com/lobu-ai/lobu/commit/2319f360ae653dcc00a54fc4a9b2efb3dfffe9a2))
* session reset clears history, Telegram plain-text fallback ([7af9703](https://github.com/lobu-ai/lobu/commit/7af9703ce7fe333473f067eb6d504379041e3a23))
* **settings:** make OAuth client optional so Telegram mini app works without it ([f51abed](https://github.com/lobu-ai/lobu/commit/f51abedb6f73055bba1ee91d3e4dde42afa758cb))
* **settings:** rename "Scheduled Reminders" to "Schedules" ([6a74299](https://github.com/lobu-ai/lobu/commit/6a74299e3ac7886da3217ecc081473e5e956605b))
* **settings:** skip identity linked notification if already linked ([1674a3b](https://github.com/lobu-ai/lobu/commit/1674a3be8a08516f273f21ea2691a60213c74572))
* **telegram:** add platform=telegram param to provider setup URL ([61d9aed](https://github.com/lobu-ai/lobu/commit/61d9aed0ac706e33d08f469b231ec9a68f071c94))
* **telegram:** auto-enable when bot token is present ([a951747](https://github.com/lobu-ai/lobu/commit/a951747976c18d5b18930bcf6baf07da8d70a895))
