# Changelog

## [2.7.0](https://github.com/lobu-ai/lobu/compare/v2.6.1...v2.7.0) (2026-03-06)


### Features

* **config:** add system skills for integrations and LLM providers ([de25b3c](https://github.com/lobu-ai/lobu/commit/de25b3c885c6ec1301da998a1c38aac371b8e430))
* **config:** add system skills, skill registries, and MCP example config ([cb356d0](https://github.com/lobu-ai/lobu/commit/cb356d077eea2338d9b31b4c76db5e92d5f44e27))
* **core:** add integration, provider config, and skill metadata types ([94c1012](https://github.com/lobu-ai/lobu/commit/94c1012b28d1d7d9209f56ee8e8f237b212c0f7b))
* **gateway:** add integration framework — OAuth, credential store, API proxy ([0a19e2d](https://github.com/lobu-ai/lobu/commit/0a19e2d0ebaaf6910efe8e66a1135a2bbec0d419))
* **gateway:** improve OAuth UX on settings page by removing auto-redirect and adding login button ([2757725](https://github.com/lobu-ai/lobu/commit/2757725c6a4a2c450d003389235f334cb1e70f75))
* **gateway:** integration services, config-driven providers, and orchestration updates ([170e824](https://github.com/lobu-ai/lobu/commit/170e824c5c5f00f8ac8093d051f683e83d558cd6))
* **gateway:** settings page overhaul — skills section, integration status, remove env vars ([02b3160](https://github.com/lobu-ai/lobu/commit/02b3160d2b3234e99a2b714355096c76d75d9ec1))
* **landing:** embed OpenClaw creator tweet confirming single-user design ([4c6537b](https://github.com/lobu-ai/lobu/commit/4c6537b03aaa7218191c18a69b3b8d00c82e2297))
* **landing:** link OpenClaw runtime to comparison page with architecture reasoning ([2977bbb](https://github.com/lobu-ai/lobu/commit/2977bbb16d3415459793bacf1f3d769a763268b6))
* **landing:** migrate from Vite SPA to Astro with Starlight docs ([687c6f7](https://github.com/lobu-ai/lobu/commit/687c6f737f59f807d5e5723258d549593343b244))
* multi-auth settings UX, base provider module refactor, and infra improvements ([1c61b30](https://github.com/lobu-ai/lobu/commit/1c61b30e931f68ee37b9d8775fcae66c1e95643c))
* Owletto memory plugin, plugin hooks/services, test infrastructure, and misc improvements ([89c27f0](https://github.com/lobu-ai/lobu/commit/89c27f0736e74fe83de6b1664017b21130cd489f))
* **proxy:** resolve provider credentials via URL path agentId ([1dbcb8c](https://github.com/lobu-ai/lobu/commit/1dbcb8c3c3a9ee6471733cedfcadf9ee5e1b3f6d))
* settings page rewrite (Alpine→Preact), history page, Telegram enhancements, landing page ([b2cba55](https://github.com/lobu-ai/lobu/commit/b2cba551671812f2c54e9188fa74cc77ecd2f27c))
* **worker:** ConnectService, CallService, DisconnectService tools and integration runtime ([af5a270](https://github.com/lobu-ai/lobu/commit/af5a270ba8e5d66e77cb7cd9c1d495d183e22a44))


### Bug Fixes

* add CSS generation step to gateway Dockerfile ([d361129](https://github.com/lobu-ai/lobu/commit/d3611292caadd929c89e4b7fbabb27da9f3c632c))
* add default model fallback per provider and fix z-ai base URL env var ([ebb8237](https://github.com/lobu-ai/lobu/commit/ebb82377c966a4cb44d033dc8744958f447f7133))
* **ci:** bump Bun to 1.3.5 to fix CONNECT test failures ([1970c9a](https://github.com/lobu-ai/lobu/commit/1970c9a7ad5380134c5da514a88847dbc520ca8d))
* clear mismatched default model in auto-mode provider selection ([ab20949](https://github.com/lobu-ai/lobu/commit/ab20949514d09158e33c4a0951cdda498a226c8d))
* clear stale session when provider changes ([080afe0](https://github.com/lobu-ai/lobu/commit/080afe0b1bb818a3166b55804d285290e101d0e1))
* **gateway:** escape oauth callback template values ([#122](https://github.com/lobu-ai/lobu/issues/122)) ([d4cfc45](https://github.com/lobu-ai/lobu/commit/d4cfc45dacd6bec48c3c904f751a863b9f6510e6))
* **gateway:** redact secrets in agent config response ([#127](https://github.com/lobu-ai/lobu/issues/127)) ([6af4424](https://github.com/lobu-ai/lobu/commit/6af44241faa9f1fae60eba49423528a295d1a4c1))
* **gateway:** remove settings token query exposure ([#130](https://github.com/lobu-ai/lobu/issues/130)) ([9d4adb8](https://github.com/lobu-ai/lobu/commit/9d4adb83ffbcd128250704d5cf19859eaaf0193a))
* **gateway:** require auth for channel binding routes ([#123](https://github.com/lobu-ai/lobu/issues/123)) ([6736fe9](https://github.com/lobu-ai/lobu/commit/6736fe9ede187f71a7c513b20cf2f1c528188a10))
* **gateway:** require settings token for chatgpt start/poll ([#124](https://github.com/lobu-ai/lobu/issues/124)) ([4004401](https://github.com/lobu-ai/lobu/commit/4004401d78aa6e62a65661c1b0e3f229873a6c31))
* **gateway:** skip enqueuing worker delivery receipts to thread response queue ([c5c352d](https://github.com/lobu-ai/lobu/commit/c5c352d50b9dfd80570bb78743735eb94adb38d3))
* **gateway:** stop logging WhatsApp credential payloads ([#128](https://github.com/lobu-ai/lobu/issues/128)) ([68968b5](https://github.com/lobu-ai/lobu/commit/68968b57c8384e52939daca407c3f8f3a308050c))
* include z.ai API path prefix in upstream base URL ([4ad79c9](https://github.com/lobu-ai/lobu/commit/4ad79c92da9d2b3ca0c0c39328956bf05b5aa60b))
* **landing:** correct homepage prompt and CLI command references ([5f4429f](https://github.com/lobu-ai/lobu/commit/5f4429fa118a23018df97db83cda7c8a62760602))
* map z-ai gateway slug to zai model registry provider name ([64b606e](https://github.com/lobu-ai/lobu/commit/64b606e1c274463e5b96419a77e42905a4abb0f4))
* **proxy:** handle CONNECT method in request handler for Bun on Linux ([320e028](https://github.com/lobu-ai/lobu/commit/320e028f6e8b2a24733fbca52d7a1880c9787590))
* recreate scaled-down workers with fresh env vars on wake-up ([879cd41](https://github.com/lobu-ai/lobu/commit/879cd41ff25146c2724e62f170bbe6566a2bbbca))
* resolve worker CJS/ESM module error and missing Nix in production ([fda47de](https://github.com/lobu-ai/lobu/commit/fda47de2bb6169eef79c4df8d96f57d7ca0af0c2))
* respect installed provider order when no explicit model is set ([2319f36](https://github.com/lobu-ai/lobu/commit/2319f360ae653dcc00a54fc4a9b2efb3dfffe9a2))
