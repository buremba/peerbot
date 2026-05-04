# Changelog

## [6.0.1](https://github.com/lobu-ai/lobu/compare/lobu-v6.0.0...lobu-v6.0.1) (2026-05-04)


### Bug Fixes

* **ci:** restore owletto-* image names so prod can pull them ([#512](https://github.com/lobu-ai/lobu/issues/512)) ([f4f841c](https://github.com/lobu-ai/lobu/commit/f4f841c34c95be9068173a8efee026cc9ac886ca))
* **connectors:** replace Deno-style 'npm:' specifiers with real deps ([#513](https://github.com/lobu-ai/lobu/issues/513)) ([ecdeb7c](https://github.com/lobu-ai/lobu/commit/ecdeb7ce4269d4be3d500cdc111278b9f0b2fff8))
* **publish:** add re-export shims to deprecated redirect packages ([#510](https://github.com/lobu-ai/lobu/issues/510)) ([cb499fc](https://github.com/lobu-ai/lobu/commit/cb499fcac01ae7cb20ae09c1c44496655bb77155))

## [6.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v5.0.0...lobu-v6.0.0) (2026-05-01)


### ⚠ BREAKING CHANGES

* external MCP clients calling `manage_connections` or `manage_auth_profiles` directly will receive `Tool not found`. Move those callers to the REST proxy at `POST /api/{orgSlug}/{toolName}`.
* **owletto-backend:** the `execute` MCP tool is removed. External MCP clients must switch to `run` (mutating scripts) or `query` (read-only scripts). The internal `manage_connections` and `manage_auth_profiles` tools are no longer visible on the public MCP surface; CLI/web flows continue to reach them via the REST proxy.

### Features

* **cli:** align agent management with web API ([#491](https://github.com/lobu-ai/lobu/issues/491)) ([86e0b25](https://github.com/lobu-ai/lobu/commit/86e0b254186a6cb0fc24b6837499723547572b5c))
* **cli:** replace bespoke device login with OAuth 2.0 device-code flow ([#489](https://github.com/lobu-ai/lobu/issues/489)) ([3a8ec73](https://github.com/lobu-ai/lobu/commit/3a8ec7396e14edaa6a4c4dc4911a388dc8113e4b))
* **connectors:** add reddit user_activity feed ([#445](https://github.com/lobu-ai/lobu/issues/445)) ([f53c6a1](https://github.com/lobu-ai/lobu/commit/f53c6a1ce6ee63a548a0ef67dadd0dc06f529675))
* drop Docker/K8s deployment modes — embedded-only ([5fef6c2](https://github.com/lobu-ai/lobu/commit/5fef6c27a4ce3474a6935ddd702c1f9233f46e5c))
* **identity:** facts-as-events identity engine ([475baab](https://github.com/lobu-ai/lobu/commit/475baab3da2d13d1f45834e3f572ceb97fdc4ce3))
* **landing:** Attio-style landing redesign with use-case-driven hero ([0e7af50](https://github.com/lobu-ai/lobu/commit/0e7af505acd6e16ec8a7284edff41d861709d12a))
* **landing:** dark mode support with system preference detection ([#497](https://github.com/lobu-ai/lobu/issues/497)) ([da7f8cd](https://github.com/lobu-ai/lobu/commit/da7f8cd8f3fb148ad41d7ee2670c58915d8099ee))
* migrate browser-auth to REST, demote manage_* to internal MCP ([#439](https://github.com/lobu-ai/lobu/issues/439)) ([9f883a5](https://github.com/lobu-ai/lobu/commit/9f883a5d56c92665da27bce37886d97e665565d5))
* **owletto-backend:** 401 + WWW-Authenticate for unauth /mcp ([#438](https://github.com/lobu-ai/lobu/issues/438)) ([ae703fa](https://github.com/lobu-ai/lobu/commit/ae703fa69478fc3d54a464ef3e7c99a51c3bff7c))
* **owletto-backend:** split MCP execute into query (read-only) + run (full) ([#432](https://github.com/lobu-ai/lobu/issues/432)) ([aef8254](https://github.com/lobu-ai/lobu/commit/aef825435dbc4a5015b5f6cc35419940e245e6a5))
* **scheduler:** unified TaskScheduler — replace setInterval maintenance loop ([#478](https://github.com/lobu-ai/lobu/issues/478)) ([ab4ee13](https://github.com/lobu-ai/lobu/commit/ab4ee1383535e1abe2ec9eea1202b4fc9aadaeb4))
* **watchers:** edit propagates across the group; snapshot version_id on runs ([#485](https://github.com/lobu-ai/lobu/issues/485)) ([7a18f83](https://github.com/lobu-ai/lobu/commit/7a18f83acab4be1e5f0e3b0b2db2cdeec60b9f92))
* **worker:** per-exec OS sandbox for spawned binaries in embedded mode ([daa25d7](https://github.com/lobu-ai/lobu/commit/daa25d7065d2abe1584642d7c94378c8c707b6d2))


### Bug Fixes

* **connectors:** bundle pino + link-preview-js instead of externalising ([#448](https://github.com/lobu-ai/lobu/issues/448)) ([7486f39](https://github.com/lobu-ai/lobu/commit/7486f393197ab9d0b980800c9c2562e13566189a))
* **db:** drop legacy event source id ([#419](https://github.com/lobu-ai/lobu/issues/419)) ([560c073](https://github.com/lobu-ai/lobu/commit/560c0731b10197bd8dc40c5781cfed517bffb111))
* **db:** tenant-scoped FK on connections.auth_profile references ([#447](https://github.com/lobu-ai/lobu/issues/447)) ([891f7ab](https://github.com/lobu-ai/lobu/commit/891f7ab45abdd16e90377a7187c25f79e9491eb0))
* **embedded:** default MEMORY_URL so dispatcher service tokens validate ([#451](https://github.com/lobu-ai/lobu/issues/451)) ([596cd9c](https://github.com/lobu-ai/lobu/commit/596cd9c877a838d663fae085ff159fe418f466b7))
* **events:** make creator attribution nullable ([#418](https://github.com/lobu-ai/lobu/issues/418)) ([b7f59f5](https://github.com/lobu-ai/lobu/commit/b7f59f51f2041b5ffb42e2e025881190f599eac7))
* **execute:** bundle backend so prod runs under Node + isolated-vm ([#433](https://github.com/lobu-ai/lobu/issues/433)) ([20afae5](https://github.com/lobu-ai/lobu/commit/20afae540b02983e47a38d8cb7650b15f2907a5d))
* **execute:** harden sandbox runtime ([#427](https://github.com/lobu-ai/lobu/issues/427)) ([343cc03](https://github.com/lobu-ai/lobu/commit/343cc03962ef4e26e795664f7a07ca50716dc724))
* **execute:** run backend under Node so isolated-vm loads ([#430](https://github.com/lobu-ai/lobu/issues/430)) ([71c74e1](https://github.com/lobu-ai/lobu/commit/71c74e18600c8d5c1c21c0638b994a05aefbc687))
* **get_watcher:** bound unprocessedCount scan even on fresh watchers ([#486](https://github.com/lobu-ai/lobu/issues/486)) ([da2d9ef](https://github.com/lobu-ai/lobu/commit/da2d9ef60f3cd86922392290e12c448c2e06314f))
* **get_watcher:** cap unprocessedCount scan at 1000 rows ([#487](https://github.com/lobu-ai/lobu/issues/487)) ([c548440](https://github.com/lobu-ai/lobu/commit/c5484407efd8922d347966af10034e2fc685380a))
* harden lobu memory watcher reliability ([#498](https://github.com/lobu-ai/lobu/issues/498)) ([459c7b2](https://github.com/lobu-ai/lobu/commit/459c7b2910a676f84d73cab522e34bd3e5013058))
* **landing:** send start CTA to app ([#492](https://github.com/lobu-ai/lobu/issues/492)) ([ed112a4](https://github.com/lobu-ai/lobu/commit/ed112a412df082bf97938e81f9580dd96873dc8f))
* **list_watchers:** cap pending-content total at 1000 rows ([#488](https://github.com/lobu-ai/lobu/issues/488)) ([e296a99](https://github.com/lobu-ai/lobu/commit/e296a9952b2dad0a3eee415f9aee7f50ae393a67))
* **owletto-backend:** make classification reconciliation candidate query selective ([#454](https://github.com/lobu-ai/lobu/issues/454)) ([4b83739](https://github.com/lobu-ai/lobu/commit/4b837390d0de44a6003ffd0a10354512558091fc))
* **owletto-backend:** MCP rough edges — org scope, paginated SDK examples, knowledge.delete tombstone ([#442](https://github.com/lobu-ai/lobu/issues/442)) ([6f2ae98](https://github.com/lobu-ai/lobu/commit/6f2ae988b802393f6653485cacac3727c91452c9))
* **owletto-backend:** re-register list_watchers/get_watcher/read_knowledge for REST ([#434](https://github.com/lobu-ai/lobu/issues/434)) ([dac1603](https://github.com/lobu-ai/lobu/commit/dac1603f7e3c5988e3656e4753539351fd510308))
* **public-pages:** serve scrapeable HTML for generic clients ([#415](https://github.com/lobu-ai/lobu/issues/415)) ([818c804](https://github.com/lobu-ai/lobu/commit/818c804fde615724d6b02c3a278345508b465919))
* **public-pages:** skip SSR shell for signed-in users ([4c31a04](https://github.com/lobu-ai/lobu/commit/4c31a04543035ac0928bc22c623025031062dfbb))
* **reddit:** request identity scope so /api/v1/me works ([#449](https://github.com/lobu-ai/lobu/issues/449)) ([2fc08d8](https://github.com/lobu-ai/lobu/commit/2fc08d80e3fa61eff7c6c386c4f63374cf16f4f7))
* **watchers:** connector dep hygiene + dispatcher fail-closed ([#444](https://github.com/lobu-ai/lobu/issues/444)) ([b4bb37f](https://github.com/lobu-ai/lobu/commit/b4bb37fd62c26b085d0490972d3b261cab445db5))
* **watchers:** include watcher_group_id in list response; bump owletto-web for inline version chip ([#435](https://github.com/lobu-ai/lobu/issues/435)) ([4f9db5a](https://github.com/lobu-ai/lobu/commit/4f9db5a1437d531e5263bf431dcefa076156c087))
* **worker:** skip --import tsx when running under Bun ([#412](https://github.com/lobu-ai/lobu/issues/412)) ([39e031d](https://github.com/lobu-ai/lobu/commit/39e031d512561db27215a44469995ca11c043eb1))


### Performance Improvements

* **events:** fold visibility into get_content WHERE; drop entity lookup ([#455](https://github.com/lobu-ai/lobu/issues/455)) ([9f0566b](https://github.com/lobu-ai/lobu/commit/9f0566b04c4ded0d9b58d70497ede0b1a8b686c0))
* **get_watcher:** consolidate to 3 round-trips per page open ([#482](https://github.com/lobu-ai/lobu/issues/482)) ([61c5606](https://github.com/lobu-ai/lobu/commit/61c5606311295e9d1c9124d209a5e9a4e46c0433))
* **get_watcher:** delete dead cold-path queries, bound unprocessedCount ([#481](https://github.com/lobu-ai/lobu/issues/481)) ([e533449](https://github.com/lobu-ai/lobu/commit/e5334494d31a689584db912bb42e14962b0f8234))
* **watchers:** fix /watchers/:id timeouts — slim get_watcher to first-paint queries ([#479](https://github.com/lobu-ai/lobu/issues/479)) ([a3b98fc](https://github.com/lobu-ai/lobu/commit/a3b98fcd125204bbbaa3c906afc900c408a8aabc))


### Reverts

* **execute:** drop runtime swap in [#430](https://github.com/lobu-ai/lobu/issues/430) — keep prod on bun ([#431](https://github.com/lobu-ai/lobu/issues/431)) ([f6115d8](https://github.com/lobu-ai/lobu/commit/f6115d8e9f79a8cf0d145db5c5c62f54387165ef))

## [5.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v4.3.0...lobu-v5.0.0) (2026-04-27)


### ⚠ BREAKING CHANGES

* **db:** convert entities.entity_type to entity_type_id FK ([#370](https://github.com/lobu-ai/lobu/issues/370))

### Features

* **agents:** public install endpoint for template agents ([#357](https://github.com/lobu-ai/lobu/issues/357)) ([4fb42ed](https://github.com/lobu-ai/lobu/commit/4fb42edc321afcaabc4f84add654ec8c4a290df6))
* **agents:** public install manifest endpoint + slug-based install ([#362](https://github.com/lobu-ai/lobu/issues/362)) ([74d8e39](https://github.com/lobu-ai/lobu/commit/74d8e398de9821c8b168e9d5ed7a095940751757))
* **agents:** schema-mirror + install flow for template agents ([#369](https://github.com/lobu-ai/lobu/issues/369)) ([48bdb20](https://github.com/lobu-ai/lobu/commit/48bdb201fd88ec5054544bcbe791efd2ae4a1d80))
* **auth:** auto-provision personal org on user signup ([#352](https://github.com/lobu-ai/lobu/issues/352)) ([deff32a](https://github.com/lobu-ai/lobu/commit/deff32aa14c8d7d0bf9b4dcfc38fbe25de51e740))
* **auth:** provision $member entity + identities on signup and install ([#359](https://github.com/lobu-ai/lobu/issues/359)) ([db1e199](https://github.com/lobu-ai/lobu/commit/db1e199b1f3ee92c4afcaae549faf8359965cf01))
* **db:** convert entities.entity_type to entity_type_id FK ([#370](https://github.com/lobu-ai/lobu/issues/370)) ([ab7ecde](https://github.com/lobu-ai/lobu/commit/ab7ecde23bc0d257595fa44c6e16cecdbfb3966e))
* **examples:** add personal-finance project for UK Self Assessment ([#350](https://github.com/lobu-ai/lobu/issues/350)) ([5852ea6](https://github.com/lobu-ai/lobu/commit/5852ea6de6650077ca7ed025f3b9f8924a4117cf))
* **examples:** company-aware world model for personal-finance ([#358](https://github.com/lobu-ai/lobu/issues/358)) ([0df7e19](https://github.com/lobu-ai/lobu/commit/0df7e190a0e901cbdbdcb8b1107648dc45b7083b))
* **examples:** evals for personal-finance agent (SA102/SA105/SA108 + behavioral) ([#356](https://github.com/lobu-ai/lobu/issues/356)) ([cf49872](https://github.com/lobu-ai/lobu/commit/cf49872e09ab866577b193aff44c39d33506f813))
* **examples:** Phase 2 — FX, allowance windows, filing timeline ([#360](https://github.com/lobu-ai/lobu/issues/360)) ([820af04](https://github.com/lobu-ai/lobu/commit/820af0430d54ae798a2aa577f81e95af157b8dde))
* **examples:** SA100 assembly playbook for personal-finance agent ([#354](https://github.com/lobu-ai/lobu/issues/354)) ([76d627d](https://github.com/lobu-ai/lobu/commit/76d627d61795c0ef5cbdff67c81382340d15132f))
* **examples:** statement ingestion playbook + Nix tooling ([#355](https://github.com/lobu-ai/lobu/issues/355)) ([d82d76c](https://github.com/lobu-ai/lobu/commit/d82d76ce236ad98d754f13a2da0ba02373d142b7))
* **landing:** add siloed-vs-shared memory topology section ([#375](https://github.com/lobu-ai/lobu/issues/375)) ([c759955](https://github.com/lobu-ai/lobu/commit/c7599556764bc1b9437f55b85e966ccb84c70b6c))
* **landing:** canonical https://lobu.ai/mcp endpoint with OAuth proxy and tracing ([#389](https://github.com/lobu-ai/lobu/issues/389)) ([29c6d2f](https://github.com/lobu-ai/lobu/commit/29c6d2f74ff622c6f1a78ec8c359a13f88c9ba1c))
* **owletto-backend:** multi-org execute + search MCP tools ([#348](https://github.com/lobu-ai/lobu/issues/348)) ([bb4ff94](https://github.com/lobu-ai/lobu/commit/bb4ff94d046acc4c8db74e5585764bb592e925a9))
* **watchers:** per-field feedback storage with mutation kinds ([#363](https://github.com/lobu-ai/lobu/issues/363)) ([5e0c16e](https://github.com/lobu-ai/lobu/commit/5e0c16ed4012a2e4330ae5802d60c1752797c4b9))
* **worker,backend:** capture subprocess output and exit metadata on run records ([#376](https://github.com/lobu-ai/lobu/issues/376)) ([02eb47a](https://github.com/lobu-ai/lobu/commit/02eb47a2af63b57538a75393a576d76ceb0ff2ab))
* **world-model:** allow read-only cross-org list_rules ([#399](https://github.com/lobu-ai/lobu/issues/399)) ([b30dc63](https://github.com/lobu-ai/lobu/commit/b30dc6347eea136a78d7b24fb98f63e0bbdc5ef0))
* **world-model:** cross-org references — schema search path + write guard ([#374](https://github.com/lobu-ai/lobu/issues/374)) ([426b2e2](https://github.com/lobu-ai/lobu/commit/426b2e2efda58dc73f57cb510ad4afe3cf4c7549))
* **world-model:** cross-org relationship_types + catalog discovery ([#377](https://github.com/lobu-ai/lobu/issues/377)) ([bfb7dfb](https://github.com/lobu-ai/lobu/commit/bfb7dfbd05c45047b2cecc2a2d07897da2f23f17))
* **world-model:** cross-org schema CRUD + read-side tolerance ([#386](https://github.com/lobu-ai/lobu/issues/386)) ([1fbdd35](https://github.com/lobu-ai/lobu/commit/1fbdd35f02a0a3ebf08b36ffd7a5758581441ee4))


### Bug Fixes

* **ci:** deploy landing functions by running wrangler from packages/landing ([#391](https://github.com/lobu-ai/lobu/issues/391)) ([7c3676b](https://github.com/lobu-ai/lobu/commit/7c3676be2c34ae4e9c7b9710a4d464882e53fa7e))
* **connector-catalog,worker-auth:** externalize on resolve fail; pino err serialization ([#405](https://github.com/lobu-ai/lobu/issues/405)) ([eb84fe4](https://github.com/lobu-ai/lobu/commit/eb84fe4f8d3ceebbd40fceaf47291092504bb4cb))
* **db:** add dbmate up/down directives to repair-agent migrations ([#390](https://github.com/lobu-ai/lobu/issues/390)) ([8a115dd](https://github.com/lobu-ai/lobu/commit/8a115dd520ee3c9768f2aebcf5ea262eb49ab23d))
* **db:** backfill events.created_by NULLs before NOT NULL validate ([#392](https://github.com/lobu-ai/lobu/issues/392)) ([bb7cce3](https://github.com/lobu-ai/lobu/commit/bb7cce3b5ca8de9a6825c8ed7cf9984430c2ac81))
* **db:** drop CONCURRENTLY from migration's index recreation ([#402](https://github.com/lobu-ai/lobu/issues/402)) ([bccd3da](https://github.com/lobu-ai/lobu/commit/bccd3daceae6ddc444004e723a8cfa01bd7177d8))
* **db:** drop CONCURRENTLY from migration's index recreation ([#403](https://github.com/lobu-ai/lobu/issues/403)) ([7870f0d](https://github.com/lobu-ai/lobu/commit/7870f0dab002004ae1569cffb54b064d07651182))
* **db:** scope baseline's search_path reset to migration transaction ([#406](https://github.com/lobu-ai/lobu/issues/406)) ([ba33bae](https://github.com/lobu-ai/lobu/commit/ba33baec1013ec209c966eb961fa86a634bac27f))
* **db:** SET lock_timeout = 0 for events.created_by backfill ([#396](https://github.com/lobu-ai/lobu/issues/396)) ([5224b92](https://github.com/lobu-ai/lobu/commit/5224b92a464956ef32b3373fd1706a6f771756c8))
* **db:** single UPDATE backfill — chunked DO LOOP exceeded liveness budget ([#395](https://github.com/lobu-ai/lobu/issues/395)) ([b9cd8ca](https://github.com/lobu-ai/lobu/commit/b9cd8cad38d0b85ef9762b9370bcd4656e8a4835))
* **landing:** defer cal.com iframe until schedule dialog opens ([#398](https://github.com/lobu-ai/lobu/issues/398)) ([d86e7db](https://github.com/lobu-ai/lobu/commit/d86e7dbcfedee084911b778042ab7b1786c6cd59))
* **landing:** point Scalar API reference at the real /openapi.json ([#394](https://github.com/lobu-ai/lobu/issues/394)) ([8046abe](https://github.com/lobu-ai/lobu/commit/8046abe0b1eac7f1fd03bda8463f4146158fa0cd))
* **landing:** satisfy isitagentready.com checks for markdown + OAuth metadata ([#397](https://github.com/lobu-ai/lobu/issues/397)) ([8d84627](https://github.com/lobu-ai/lobu/commit/8d84627ed6412fa8daad7ad2d6d02d2f0d1dea8c))
* set working-directory to packages/landing and deploy ./dist. ([7c3676b](https://github.com/lobu-ai/lobu/commit/7c3676be2c34ae4e9c7b9710a4d464882e53fa7e))
* **worker:** drop unused code/signal params from computeExitReason ([#388](https://github.com/lobu-ai/lobu/issues/388)) ([7aa3406](https://github.com/lobu-ai/lobu/commit/7aa340621b6a4910b42b41682db1a538dd00d458))
* **world-model:** cross-org schema validation + defensive count scoping + tests ([#407](https://github.com/lobu-ai/lobu/issues/407)) ([576dae5](https://github.com/lobu-ai/lobu/commit/576dae56d48ebf87704cfc30b3f38bdcbeec1ce7))


### Reverts

* **install-flow:** remove template-install pipeline ([#369](https://github.com/lobu-ai/lobu/issues/369), [#357](https://github.com/lobu-ai/lobu/issues/357), [#362](https://github.com/lobu-ai/lobu/issues/362), [#359](https://github.com/lobu-ai/lobu/issues/359) install-half) ([#372](https://github.com/lobu-ai/lobu/issues/372)) ([d5dfbc2](https://github.com/lobu-ai/lobu/commit/d5dfbc22814906999efc86fc618fb515e622f14e))

## [4.3.0](https://github.com/lobu-ai/lobu/compare/lobu-v4.2.0...lobu-v4.3.0) (2026-04-25)


### Features

* **ci:** autonomous PR triage workflow ([#349](https://github.com/lobu-ai/lobu/issues/349)) ([1fd4add](https://github.com/lobu-ai/lobu/commit/1fd4add1c69f62e11f5a9a788017253ff23fb0af))
* **examples:** add LLM-judged ping eval to each surfaced example ([#366](https://github.com/lobu-ai/lobu/issues/366)) ([d6aa5ad](https://github.com/lobu-ai/lobu/commit/d6aa5adb70f98220a3b583a994d0a155c86bed07))
* **gateway:** LLM-judged egress via per-skill `action: judge` ([#319](https://github.com/lobu-ai/lobu/issues/319)) ([#327](https://github.com/lobu-ai/lobu/issues/327)) ([0171679](https://github.com/lobu-ai/lobu/commit/017167907246f65ae83da6091b0b5b6670c4fe2d))
* **watchers:** in-process lifecycle tracker, durable correlation, drop heartbeat ([#336](https://github.com/lobu-ai/lobu/issues/336)) ([51be366](https://github.com/lobu-ai/lobu/commit/51be366129315ffcc1c7f94bdc135e541eaf4a3a))


### Bug Fixes

* **auth:** align Claude OAuth client with public CLI to avoid 429 ([#345](https://github.com/lobu-ai/lobu/issues/345)) ([aa91a81](https://github.com/lobu-ai/lobu/commit/aa91a81da7ce0caa1afa18f3ab37a24888f37502))
* **ci:** bump landing deploy to Node 22 for Astro 6 ([#344](https://github.com/lobu-ai/lobu/issues/344)) ([1eb9d60](https://github.com/lobu-ai/lobu/commit/1eb9d603cb1c6be549ac6b8927f4875d024253b7))
* **cli:** migrate to @inquirer/prompts to fix Node 25 readline crash ([#364](https://github.com/lobu-ai/lobu/issues/364)) ([8ab0dd9](https://github.com/lobu-ai/lobu/commit/8ab0dd9c9d41f9bc8436a7e2d038f78bb5453f50))
* **embedded-lobu:** make the embedded gateway boot cleanly in the owletto app image ([#332](https://github.com/lobu-ai/lobu/issues/332)) ([c378015](https://github.com/lobu-ai/lobu/commit/c378015e51adf7fbf688684bcb1684680b2f38d3))
* **events:** tolerate stale client_id refs on insert + relax FK ([#339](https://github.com/lobu-ai/lobu/issues/339)) ([5c19d26](https://github.com/lobu-ai/lobu/commit/5c19d26bdf6604aba88c44ee437773abb2e9f071))
* **gateway,dev-native:** thread worker entryPoint through config, unblock native dev ([#347](https://github.com/lobu-ai/lobu/issues/347)) ([e5ff4d8](https://github.com/lobu-ai/lobu/commit/e5ff4d8d5bd73b02cf010d64a668610a4fde7767))
* **mcp-handler,entity-management:** SSE close race + classify entity-type errors ([#340](https://github.com/lobu-ai/lobu/issues/340)) ([4b4649a](https://github.com/lobu-ai/lobu/commit/4b4649aef22db89f8a4fe6abe787ec7bd321b01b))
* **owletto-backend:** unblock image builds after dead-code refactor ([#329](https://github.com/lobu-ai/lobu/issues/329)) ([5619e1f](https://github.com/lobu-ai/lobu/commit/5619e1f338c312cff299e73170e6d247a4382704))
* post-merge review follow-ups (path traversal, Sentry PII, Slack instr guard, MCP join rate-limit) ([#325](https://github.com/lobu-ai/lobu/issues/325)) ([3faad40](https://github.com/lobu-ai/lobu/commit/3faad40d0da299f683c492de84623aea2332f6eb))
* **resolve_path:** return 4xx instead of throwing on client-input errors ([#338](https://github.com/lobu-ai/lobu/issues/338)) ([326f543](https://github.com/lobu-ai/lobu/commit/326f543a90539a7504918b8c56743140384a5f17))
* **sentry:** disable NodeSystemError integration to unblock node v24 builds ([#341](https://github.com/lobu-ai/lobu/issues/341)) ([4124e00](https://github.com/lobu-ai/lobu/commit/4124e0094129d4c625cbad5f3026bac031159542))
* stabilize multiple security and reliability gaps across gateway ([#321](https://github.com/lobu-ai/lobu/issues/321)) ([3c6efc2](https://github.com/lobu-ai/lobu/commit/3c6efc284d8273cd598ad3747922e5ac36d2316b))
* **watchers:** no-op complete_window when all events already analyzed ([#337](https://github.com/lobu-ai/lobu/issues/337)) ([495d615](https://github.com/lobu-ai/lobu/commit/495d615034804382ed9e8606a74b979f57cb0136))


### Performance Improvements

* **auth:** consolidate better-auth onto shared postgres.js pool ([#342](https://github.com/lobu-ai/lobu/issues/342)) ([012754a](https://github.com/lobu-ai/lobu/commit/012754ad70f78e9b25a9664133db19eafdacd747))

## [4.2.0](https://github.com/lobu-ai/lobu/compare/lobu-v4.1.0...lobu-v4.2.0) (2026-04-23)


### Features

* **core:** add guardrail primitive ([#254](https://github.com/lobu-ai/lobu/issues/254)) ([#317](https://github.com/lobu-ai/lobu/issues/317)) ([912dfff](https://github.com/lobu-ai/lobu/commit/912dfffbe78a3cfa0e0664338ee8a9c4fd826110))
* **gateway:** Gemini Code Assist OAuth for CI smoke ([#315](https://github.com/lobu-ai/lobu/issues/315)) ([e4957d0](https://github.com/lobu-ai/lobu/commit/e4957d007993268dbaf7074721953da5a88205cd))
* **owletto-backend:** accept entity_link_overrides at install/create/connect ([#318](https://github.com/lobu-ai/lobu/issues/318)) ([c08e052](https://github.com/lobu-ai/lobu/commit/c08e0521df83b78fd669ce794110e61e49429443))

## [4.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v4.0.1...lobu-v4.1.0) (2026-04-23)


### Features

* add separate Lobu and Owletto starter skill installs ([#304](https://github.com/lobu-ai/lobu/issues/304)) ([d0a4bc4](https://github.com/lobu-ai/lobu/commit/d0a4bc4d7ef61c56250b698805ae854396391469))
* **landing:** rewrite hero headline and subhead for agent-first pitch ([#312](https://github.com/lobu-ai/lobu/issues/312)) ([044b1ed](https://github.com/lobu-ai/lobu/commit/044b1ed5eb2fa1ea578701673cc1922afeee1e3d))
* **owletto-backend:** centralize transactional email + rebrand to Lobu ([#314](https://github.com/lobu-ai/lobu/issues/314)) ([4db7a1e](https://github.com/lobu-ai/lobu/commit/4db7a1e2e3dc7c214f13fa5d0bea885db080617a))
* **owletto-backend:** gate $member list to members, emails to admins ([#309](https://github.com/lobu-ai/lobu/issues/309)) ([c37c72f](https://github.com/lobu-ai/lobu/commit/c37c72f6473838163149b12c8677d8dda6acabb2))
* **owletto-backend:** public-org read access + self-serve join ([#296](https://github.com/lobu-ai/lobu/issues/296)) ([38cf00f](https://github.com/lobu-ai/lobu/commit/38cf00f09c51d57fbe5d1fb3f8811f84b2d35756))


### Bug Fixes

* **landing:** move outcome channel into outcome box ([#306](https://github.com/lobu-ai/lobu/issues/306)) ([885ab61](https://github.com/lobu-ai/lobu/commit/885ab6171bbc3e347e32c3dbf36583eef2b4f215))
* **owletto-backend:** add missing memberRole to internal ToolContext literals ([#311](https://github.com/lobu-ai/lobu/issues/311)) ([dce8105](https://github.com/lobu-ai/lobu/commit/dce8105ba0de3c4e03ba7ce268cd3e2899cc2a61))
* **owletto-backend:** exclude watcher runs from worker poll claims ([#313](https://github.com/lobu-ai/lobu/issues/313)) ([afd5d7b](https://github.com/lobu-ai/lobu/commit/afd5d7b78ed5f2125e655349079aff3b0658106e))

## [4.0.1](https://github.com/lobu-ai/lobu/compare/lobu-v4.0.0...lobu-v4.0.1) (2026-04-21)


### Bug Fixes

* **ci:** correct jq precedence in codex-auto-approve lookup ([#300](https://github.com/lobu-ai/lobu/issues/300)) ([86063c6](https://github.com/lobu-ai/lobu/commit/86063c647af6f92c0cd8f32b46f0237ff3487c7d))
* **gateway:** gate agent API handlers with ownership check to prevent cross-tenant access ([#285](https://github.com/lobu-ai/lobu/issues/285)) ([ec8ff6b](https://github.com/lobu-ai/lobu/commit/ec8ff6bb28389acc023a9b363bb8bbd7813518ad))

## [4.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v3.7.0...lobu-v4.0.0) (2026-04-21)


### ⚠ BREAKING CHANGES

* **core, worker:** drop unused public exports from @lobu/core ([#281](https://github.com/lobu-ai/lobu/issues/281))

### Features

* **landing:** restore Integrate dropdown on copy-prompt CTAs ([#289](https://github.com/lobu-ai/lobu/issues/289)) ([bf565f1](https://github.com/lobu-ai/lobu/commit/bf565f190a3f211b6be5b135fe0cb1cda1f1f1e7))


### Bug Fixes

* **docker:** include owletto workspaces in Dockerfile.worker ([#274](https://github.com/lobu-ai/lobu/issues/274)) ([2aa042b](https://github.com/lobu-ai/lobu/commit/2aa042bce577fd4c498a5defbaa532515b39dd23))
* **gateway:** escape user input in MCP OAuth callback to prevent XSS ([#284](https://github.com/lobu-ai/lobu/issues/284)) ([ab19e8a](https://github.com/lobu-ai/lobu/commit/ab19e8ac569df321866921fd64b59bca9d01920d))
* **gateway:** require worker auth on /api/bedrock/* to prevent unauthenticated AWS spend ([#287](https://github.com/lobu-ai/lobu/issues/287)) ([5e6e91c](https://github.com/lobu-ai/lobu/commit/5e6e91c32a75e872a052705854277d8114b5c240))
* **landing:** repair broken links surfaced by audit ([#275](https://github.com/lobu-ai/lobu/issues/275)) ([1de4aee](https://github.com/lobu-ai/lobu/commit/1de4aee458e9039396f62b6d357c1c5450040b27))
* **landing:** resolve zod parse error on connect-from route ([#271](https://github.com/lobu-ai/lobu/issues/271)) ([cef2284](https://github.com/lobu-ai/lobu/commit/cef2284ab1c1e10f1406f43301378036767dbafa))
* **landing:** wire benchmark methodology link and add tables to memory + comparison ([#276](https://github.com/lobu-ai/lobu/issues/276)) ([39a0436](https://github.com/lobu-ai/lobu/commit/39a043696a4910f931d885dfe6baa48f5570d0fe))
* **owletto-backend:** use parameter binding in content-search to prevent SQL injection ([#286](https://github.com/lobu-ai/lobu/issues/286)) ([65511c1](https://github.com/lobu-ai/lobu/commit/65511c1fc2eb13a3ebd180ca341a8d74ea57a877))


### Code Refactoring

* **core, worker:** drop unused public exports from @lobu/core ([#281](https://github.com/lobu-ai/lobu/issues/281)) ([7c5ffa4](https://github.com/lobu-ai/lobu/commit/7c5ffa40139add5f100cb34fcda4aa173b3180f2))

## [3.7.0](https://github.com/lobu-ai/lobu/compare/lobu-v3.6.0...lobu-v3.7.0) (2026-04-21)


### Features

* inline memory config into lobu.toml and rename devops→engineering ([#247](https://github.com/lobu-ai/lobu/issues/247)) ([1daf272](https://github.com/lobu-ai/lobu/commit/1daf2728bec2b374a52c2212231ae641f439e89a))
* **landing:** add memory benchmarks section + methodology docs ([#242](https://github.com/lobu-ai/lobu/issues/242)) ([28e2980](https://github.com/lobu-ai/lobu/commit/28e2980796ed037aca37f90ab7785f95050c83d0))
* **owletto-backend:** allow lobu.ai to embed app via CSP frame-ancestors ([#246](https://github.com/lobu-ai/lobu/issues/246)) ([6cbf3d2](https://github.com/lobu-ai/lobu/commit/6cbf3d29aafee5b5c80f389c25e54c9eb3afc267))
* **owletto:** absorb skills, benchmarks, and dev scripts from deprecated owletto repo ([#231](https://github.com/lobu-ai/lobu/issues/231)) ([ccef71e](https://github.com/lobu-ai/lobu/commit/ccef71e1b2e3c58d79a767a84f919777b724cc44))
* **owletto:** consolidate CLI profiles into lobu.toml ([#233](https://github.com/lobu-ai/lobu/issues/233)) ([577ec37](https://github.com/lobu-ai/lobu/commit/577ec3731c70faea3272128b26ad2787d4198a99))
* subdomain-aware SPA + SSR routing ([#234](https://github.com/lobu-ai/lobu/issues/234)) ([9c66f16](https://github.com/lobu-ai/lobu/commit/9c66f16cd4b16d96356de05e3aa401e6499f0d5e))


### Bug Fixes

* **ci:** initialize owletto-web submodule in landing deploy ([#229](https://github.com/lobu-ai/lobu/issues/229)) ([0dee7bc](https://github.com/lobu-ai/lobu/commit/0dee7bc8c229562b9335aa226f765af563fe25f5))
* **deps:** sync bun.lock with release-please 3.6.0 version bump ([#227](https://github.com/lobu-ai/lobu/issues/227)) ([e14500c](https://github.com/lobu-ai/lobu/commit/e14500c1ab0d60e50ad38c5c59b8b4f8fa45362b))
* **landing:** restore campaign description from runtime.request ([#250](https://github.com/lobu-ai/lobu/issues/250)) ([56eac67](https://github.com/lobu-ai/lobu/commit/56eac673486777867c5115ba174f019a0dbe245b))
* **owletto-backend:** resolve default org when loading social credentials ([#235](https://github.com/lobu-ai/lobu/issues/235)) ([90419cc](https://github.com/lobu-ai/lobu/commit/90419ccd931328f402f9dfbc16b97fb7f355a1a9))
* ship app.lobu.ai SPA + retire owletto.com defaults ([#230](https://github.com/lobu-ai/lobu/issues/230)) ([e3817d4](https://github.com/lobu-ai/lobu/commit/e3817d41732b51fcbde1b56e69b0da85a1fb51d8))
* **web:** bump owletto-web for history adapter import fix ([#237](https://github.com/lobu-ai/lobu/issues/237)) ([279a3ed](https://github.com/lobu-ai/lobu/commit/279a3edabeb32080168180f33cf42ccae11f9ef0))
* **web:** bump owletto-web for public-org auth-redirect fix ([#240](https://github.com/lobu-ai/lobu/issues/240)) ([f4641eb](https://github.com/lobu-ai/lobu/commit/f4641eb163bdc78fdc90dcd5d826f62360144e69))
* **web:** bump owletto-web for sidebar auth gating ([#238](https://github.com/lobu-ai/lobu/issues/238)) ([e51458e](https://github.com/lobu-ai/lobu/commit/e51458e2998705c987c4de84478719d34d093c3e))
* **web:** bump owletto-web for sidebar gating + add reserved-subdomain parity test ([#241](https://github.com/lobu-ai/lobu/issues/241)) ([8961e58](https://github.com/lobu-ai/lobu/commit/8961e5865e99d12996e70df1679188f38ad95458))
* **web:** bump owletto-web for subdomain history adapter ([#236](https://github.com/lobu-ai/lobu/issues/236)) ([a53c978](https://github.com/lobu-ai/lobu/commit/a53c978331acb9fff5b0b2eda2830dc68a6f42e5))

## [3.6.0](https://github.com/lobu-ai/lobu/compare/lobu-v3.5.0...lobu-v3.6.0) (2026-04-20)


### Features

* **backend:** wildcard trusted origins + reserved subdomain skip-list ([#214](https://github.com/lobu-ai/lobu/issues/214)) ([7656f2b](https://github.com/lobu-ai/lobu/commit/7656f2bf465a0cb2ea7eb91ec123c42ae015bb02))
* consolidate owletto into the lobu monorepo (PRs 1–4) ([#212](https://github.com/lobu-ai/lobu/issues/212)) ([a6d0d3f](https://github.com/lobu-ai/lobu/commit/a6d0d3f9a46696b5874e1a4029ab8f73e579a4e3))
* **gateway:** file-driven agent schedules in lobu.toml ([#211](https://github.com/lobu-ai/lobu/issues/211)) ([6b2eb51](https://github.com/lobu-ai/lobu/commit/6b2eb5128584d0d7d7cfaa38f203684ce422709f))
* **landing:** architecture diagram badges, blog section, and use-case chat examples ([#206](https://github.com/lobu-ai/lobu/issues/206)) ([969e5ee](https://github.com/lobu-ai/lobu/commit/969e5ee6e96858521187c7af8aaeeb35786516d3))
* **landing:** consolidate use-case demo into unified trace view ([#226](https://github.com/lobu-ai/lobu/issues/226)) ([c030fa7](https://github.com/lobu-ai/lobu/commit/c030fa709bcd9423224214276e3cd315cce67cff))
* **landing:** per-use-case chat switcher on platform pages ([#202](https://github.com/lobu-ai/lobu/issues/202)) ([f65cc35](https://github.com/lobu-ai/lobu/commit/f65cc3567a30059c8589264610f4531ec11e89e8))
* **landing:** publish agent-readiness signals for lobu.ai ([#208](https://github.com/lobu-ai/lobu/issues/208)) ([8360cef](https://github.com/lobu-ai/lobu/commit/8360cefd6401afa1271f21a01f11a09231aada09))


### Bug Fixes

* **ci:** skip web build when owletto-web is stubbed ([#222](https://github.com/lobu-ai/lobu/issues/222)) ([acee38a](https://github.com/lobu-ai/lobu/commit/acee38aae91b8389553800ccdbbace542460b89f))
* **docker:** build gateway dist + exclude tests from backend typecheck ([#219](https://github.com/lobu-ai/lobu/issues/219)) ([96b0033](https://github.com/lobu-ai/lobu/commit/96b00332c637262d6a22bc624ddee802e938d519))
* **docker:** name owletto-cli stub package as 'owletto' (unscoped) ([#215](https://github.com/lobu-ai/lobu/issues/215)) ([17fba3f](https://github.com/lobu-ai/lobu/commit/17fba3fac7b910f39d3bad256befa85e9ad9876c))
* **docker:** unzip in runtime + worker chromium install via bunx ([#216](https://github.com/lobu-ai/lobu/issues/216)) ([019253e](https://github.com/lobu-ai/lobu/commit/019253e8977cf8b0c14b38d5045abd6952b25a5c))
* **docker:** use bun run build for owletto-web (local vite) ([#221](https://github.com/lobu-ai/lobu/issues/221)) ([7734259](https://github.com/lobu-ai/lobu/commit/7734259b4886b2ab1cbb44468a689b8b5aff33f2))
* **gateway,worker:** deliver provider base URLs via session context only ([#225](https://github.com/lobu-ai/lobu/issues/225)) ([9171d37](https://github.com/lobu-ai/lobu/commit/9171d37d34cbe07fd004ee2e7842b8a66328e46b))
* **gateway:** isolate tsconfig from root bun-types ([#220](https://github.com/lobu-ai/lobu/issues/220)) ([c533e27](https://github.com/lobu-ai/lobu/commit/c533e274217d2af6177f902fd4cf0502f73192b5))
* **gateway:** Owletto MCP sync, Slack markdown/threading, tool-approval lifecycle, deployment coalescing ([#210](https://github.com/lobu-ai/lobu/issues/210)) ([92ce0eb](https://github.com/lobu-ai/lobu/commit/92ce0eb3308e4d4b476c96b60d5f8e45803d9597))
* **landing:** refine Owletto memory section copy ([#205](https://github.com/lobu-ai/lobu/issues/205)) ([9075d6c](https://github.com/lobu-ai/lobu/commit/9075d6c74f33716429b030c4406b10e28450b63d))
* **owletto-backend:** resolve *.lobu.ai as org subdomain under AUTH_COOKIE_DOMAIN ([#224](https://github.com/lobu-ai/lobu/issues/224)) ([c893aae](https://github.com/lobu-ai/lobu/commit/c893aaedb64ac3437e081641947dca297f390f79))
* **owletto-backend:** resolve typecheck errors blocking build-images ([#218](https://github.com/lobu-ai/lobu/issues/218)) ([7ce6271](https://github.com/lobu-ai/lobu/commit/7ce62711bd2c35d763d01f35426e24e07dc88bf4))
* **worker:** QA hardening for careops agent (Gemini support, UploadUserFile workspace paths, dedup error messages) ([#203](https://github.com/lobu-ai/lobu/issues/203)) ([8026d5d](https://github.com/lobu-ai/lobu/commit/8026d5d341c5738961f8179a3ab9f5acb72b797e))

## [3.5.0](https://github.com/lobu-ai/lobu/compare/lobu-v3.4.3...lobu-v3.5.0) (2026-04-16)


### Features

* add /skills/for/{useCase} routes, version eval schema, clean up duplication ([d84a856](https://github.com/lobu-ai/lobu/commit/d84a856a307916b87641426e0d2de48f89442089))
* add 20-minute timeout to all GitHub Actions workflows ([0798d77](https://github.com/lobu-ai/lobu/commit/0798d777908090c285eeda35074739e54dae6bf7))
* add agent-community use case and extract UseCaseTabs label prop ([ba956ad](https://github.com/lobu-ai/lobu/commit/ba956ad13bdb642e22c3ed6bc2a7c00128d2ff72))
* add Bedrock provider and AWS deployment docs ([#171](https://github.com/lobu-ai/lobu/issues/171)) ([9210a36](https://github.com/lobu-ai/lobu/commit/9210a362f8bbc85ac37ded05e6fb95173d1f12a0))
* add CLI and create-peerbot packages with platform-agnostic architecture ([4674b47](https://github.com/lobu-ai/lobu/commit/4674b4769989b8302605b4bb0b254f0b53f2d350))
* add direct sessions API for browser/CLI clients ([c34ab3c](https://github.com/lobu-ai/lobu/commit/c34ab3c0b4be5161e94eb98584f0819b36e2d872))
* add direct sessions API for browser/CLI clients ([8f78d87](https://github.com/lobu-ai/lobu/commit/8f78d87b39f51f58b318b61f8f139b426e2b18dd))
* add ecommerce use case to landing page ([4982606](https://github.com/lobu-ai/lobu/commit/498260638532f7da16400a0bf6f1aca7e8ff3f46))
* add file handling, Slack Assistant support, and comprehensive MCP OAuth system ([a3d6f3a](https://github.com/lobu-ai/lobu/commit/a3d6f3ab46d40cabf18f08807c5a4ac4c57d52ea))
* add file handling, Slack Assistant support, and comprehensive MCP OAuth system ([0f98b23](https://github.com/lobu-ai/lobu/commit/0f98b235c04c5a7b536d77ed4edddf7edcc31022))
* add file handling, Slack Assistant support, and comprehensive MCP OAuth system ([44214cf](https://github.com/lobu-ai/lobu/commit/44214cf5ad174235a9551921215b5decfc1dd72a))
* add force npm publish workflow for emergency release ([92965fc](https://github.com/lobu-ai/lobu/commit/92965fcebda8b3c1d1f7d1d987d66459a71c117b))
* add Gemini integration and improve gateway/worker architecture ([331cdda](https://github.com/lobu-ai/lobu/commit/331cddaff94a4ccee01ff4e52e095ea611d9f77b))
* add github package support and enable plan mode ([b9ccf5d](https://github.com/lobu-ai/lobu/commit/b9ccf5df45082d286ea0f8c988dd9a14a04f3e77))
* add manual npm publish workflow for existing releases ([e1c13d4](https://github.com/lobu-ai/lobu/commit/e1c13d448ca2078f134d38cbfc4934577cdcc8cc))
* add MCP registry service and discovery routes ([fbff9bf](https://github.com/lobu-ai/lobu/commit/fbff9bf0da6d18ea9e06b0ca1b678330c5d2bb09))
* add multi-platform support to CLI init wizard ([2597712](https://github.com/lobu-ai/lobu/commit/2597712762c5caa506622c2b1b129b8daac04aca))
* add network isolation, HTTP proxy, and enhanced worker configuration ([d3a7db1](https://github.com/lobu-ai/lobu/commit/d3a7db15f0e78e2c59782937400a414e334771a7))
* add platform-agnostic messaging API with self-queueing and MAX_TURNS protection ([c872522](https://github.com/lobu-ai/lobu/commit/c872522fdeeff6f00696cb746c2e615b72924dbb))
* add privacy policy page and footer link ([b9df04f](https://github.com/lobu-ai/lobu/commit/b9df04fffab714edaa569f447bb29b96c0c65c07))
* add Reddit and X (Twitter) as OAuth integrations ([7a57b9c](https://github.com/lobu-ai/lobu/commit/7a57b9c7b8a1f021923a5718c63e95000d20cf3e))
* add Slack multi-workspace OAuth distribution ([137ec6a](https://github.com/lobu-ai/lobu/commit/137ec6af3105e24fdc1735e0f4a6cc7ca131e939))
* add user interaction system with forms and suggestions ([18db834](https://github.com/lobu-ai/lobu/commit/18db8342cb69bc1a76b426652640c60a040106e5))
* **ci:** migrate Docker images from Docker Hub to GHCR ([c01824a](https://github.com/lobu-ai/lobu/commit/c01824a6e7a59ee202145df5471ee9f863380eb3))
* **cli,gateway:** multi-agent CLI, external OAuth, agent seeding ([d4dba49](https://github.com/lobu-ai/lobu/commit/d4dba4998f2914d07d9528abc0a3b48a564ec8cc))
* **cli,landing:** add connections CLI + themeable chat component ([506b91c](https://github.com/lobu-ai/lobu/commit/506b91c5f4136c3867b509b4c2c52529d14ab778))
* **cli:** add lobu eval command with model comparison and CI workflow ([910da9b](https://github.com/lobu-ai/lobu/commit/910da9bd32fbc4f38a9479f3d5b070fe6def52b2))
* **cli:** add WhatsApp, Teams, and Google Chat to init platform choices ([d140b3b](https://github.com/lobu-ai/lobu/commit/d140b3be6f67958c843dfe29df74976897576fef))
* **config:** add system skills for integrations and LLM providers ([de25b3c](https://github.com/lobu-ai/lobu/commit/de25b3c885c6ec1301da998a1c38aac371b8e430))
* **config:** add system skills, skill registries, and MCP example config ([cb356d0](https://github.com/lobu-ai/lobu/commit/cb356d077eea2338d9b31b4c76db5e92d5f44e27))
* **core:** add integration, provider config, and skill metadata types ([94c1012](https://github.com/lobu-ai/lobu/commit/94c1012b28d1d7d9209f56ee8e8f237b212c0f7b))
* enable WhatsApp support in community deployment ([658bb25](https://github.com/lobu-ai/lobu/commit/658bb256ece4fc3bf3d61e238a2f4d850bcd8f34))
* enhance Docker security and simplify session management ([3f68c50](https://github.com/lobu-ai/lobu/commit/3f68c50376731470cd8a6912403ef631430e39ad))
* enhance MCP OAuth integration and worker session management ([abfdeb4](https://github.com/lobu-ai/lobu/commit/abfdeb469aadd51923ecceab5159e561d917499c))
* expand landing use cases and normalize network grants ([e9b0282](https://github.com/lobu-ai/lobu/commit/e9b02825b2c721fa4cde8a5a68d07e5ddfd4c993))
* **gateway:** add integration framework — OAuth, credential store, API proxy ([0a19e2d](https://github.com/lobu-ai/lobu/commit/0a19e2d0ebaaf6910efe8e66a1135a2bbec0d419))
* **gateway:** add MCP OAuth 2.1 auth-code + PKCE flow ([9ea9f45](https://github.com/lobu-ai/lobu/commit/9ea9f45dedb9aa0f5ef740b949cd6b51fa8bf2ee))
* **gateway:** add optional body text to link-button cards ([#183](https://github.com/lobu-ai/lobu/issues/183)) ([1e93013](https://github.com/lobu-ai/lobu/commit/1e93013d542d4021fe33b4029b58b6329c4b19bd))
* **gateway:** agent selector + per-user agent stores ([f1c0d85](https://github.com/lobu-ai/lobu/commit/f1c0d85f339a9b670078af2d821d56ad1911582c))
* **gateway:** embedded runtime credential resolver + secret-backed device auth ([8b3053a](https://github.com/lobu-ai/lobu/commit/8b3053a80c5aeb3fa05bcf1e3c379a691103c882))
* **gateway:** improve OAuth UX on settings page by removing auto-redirect and adding login button ([2757725](https://github.com/lobu-ai/lobu/commit/2757725c6a4a2c450d003389235f334cb1e70f75))
* **gateway:** integration services, config-driven providers, and orchestration updates ([170e824](https://github.com/lobu-ai/lobu/commit/170e824c5c5f00f8ac8093d051f683e83d558cd6))
* **gateway:** proxy-driven MCP tool approval with execute-on-approve ([cde529a](https://github.com/lobu-ai/lobu/commit/cde529ac3433820b40be2639412d89b2a3673314))
* **gateway:** settings page overhaul — skills section, integration status, remove env vars ([02b3160](https://github.com/lobu-ai/lobu/commit/02b3160d2b3234e99a2b714355096c76d75d9ec1))
* **gateway:** support leading-dot domain patterns in GrantStore ([f2a1006](https://github.com/lobu-ai/lobu/commit/f2a1006e4a9769c90bf5521332c87a8c0ed156ff))
* harden file delivery flows and add OpenRouter CI evals ([676544c](https://github.com/lobu-ai/lobu/commit/676544c1d9871debd6116a638108ad2a757fd1af))
* implement multi-tenant space architecture ([abc195f](https://github.com/lobu-ai/lobu/commit/abc195f52d8aa02c4c04b5c27476906774fd4f6b))
* implement multi-tenant space architecture ([16b8723](https://github.com/lobu-ai/lobu/commit/16b8723b218d3fd3bc4af0b83cc1600030350b9c))
* improve Claude OAuth authentication flow ([4cc1051](https://github.com/lobu-ai/lobu/commit/4cc10510d3aceea1f095fbc3b06d046a06325e62))
* improve first-time setup UX and add upgrade instructions ([e3df936](https://github.com/lobu-ai/lobu/commit/e3df936c6e1094155cad5d1ebbeeb8367d50c77a))
* improve status indicators and error handling ([7a7684a](https://github.com/lobu-ai/lobu/commit/7a7684a076a542098d3d250bb56cc3072a6b057f))
* **landing:** add connect-from pages and refresh use-case content ([1ce6f6c](https://github.com/lobu-ai/lobu/commit/1ce6f6c0754aa8adfa45f6dc0738f5931717dbf1))
* **landing:** add interactive prompt + output demo to skills section ([dc8a806](https://github.com/lobu-ai/lobu/commit/dc8a80640d748dc9a9bf46b7223d3739a52e1770))
* **landing:** add posthog analytics ([b7b431d](https://github.com/lobu-ai/lobu/commit/b7b431d0bc30ddb1a104ed2473ab1aa7d695577c))
* **landing:** add terms of service page ([0347573](https://github.com/lobu-ai/lobu/commit/0347573d58d5aff6594713bb4a7277f7227d9e83))
* **landing:** embed OpenClaw creator tweet confirming single-user design ([4c6537b](https://github.com/lobu-ai/lobu/commit/4c6537b03aaa7218191c18a69b3b8d00c82e2297))
* **landing:** link OpenClaw runtime to comparison page with architecture reasoning ([2977bbb](https://github.com/lobu-ai/lobu/commit/2977bbb16d3415459793bacf1f3d769a763268b6))
* **landing:** migrate from Vite SPA to Astro with Starlight docs ([687c6f7](https://github.com/lobu-ai/lobu/commit/687c6f737f59f807d5e5723258d549593343b244))
* **landing:** remove Lobu for X labels and redundant use case summaries ([e861218](https://github.com/lobu-ai/lobu/commit/e861218120dbfc5265152bd09b2ab96a6202f5c3))
* **landing:** rename skills-as-saas to skills and update hero copy ([42009c5](https://github.com/lobu-ai/lobu/commit/42009c5d709cbdac0455512326757813d7f27805))
* **landing:** replace Telegram chat with terminal log for connections row ([2a3467e](https://github.com/lobu-ai/lobu/commit/2a3467e385bef38a1f066ed90482f1bd91cf5b3b))
* **landing:** revamp memory page demo ([96dba19](https://github.com/lobu-ai/lobu/commit/96dba192e07b7861b333c9d7f3fc72701527436a))
* **landing:** update copy prompt behavior and text ([a551a79](https://github.com/lobu-ai/lobu/commit/a551a7965c9c46aa2b44e2a29eecd065fd9c1f13))
* live per-agent MCP install flow with discovery and no worker restart ([#106](https://github.com/lobu-ai/lobu/issues/106)) ([435202b](https://github.com/lobu-ai/lobu/commit/435202b965f85a2085e604c463a74f6163111316))
* make examples/ single source of truth for use cases and Owletto orgs ([3fc5380](https://github.com/lobu-ai/lobu/commit/3fc5380a720681d4b54ca88ff401dcaa7462db70))
* make Hero GitHub button contextual to active use case ([f1ca9fe](https://github.com/lobu-ai/lobu/commit/f1ca9fed7cfbe4326599e546109eca7f6a45bb05))
* make skills page init preview contextual to selected use-case ([146e87a](https://github.com/lobu-ai/lobu/commit/146e87ad8838c5dd03c5f27900636e05c527823f))
* **mcp-auth:** surface login prompts as platform link buttons ([9ca5449](https://github.com/lobu-ai/lobu/commit/9ca5449a48321db1e6a81f3ab1172b8768f272fc))
* migrate gateway to Hono and remove Express from worker ([#94](https://github.com/lobu-ai/lobu/issues/94)) ([499ab1b](https://github.com/lobu-ai/lobu/commit/499ab1b992267017872e90ecb2a662186cd574e3))
* migrate owletto examples to models/ directory with type field ([3deeb77](https://github.com/lobu-ai/lobu/commit/3deeb77f5eea1cd9d1124691e42430e3bb6fa496))
* migrate Owletto plugin to published @lobu/owletto-openclaw package ([b4666c5](https://github.com/lobu-ai/lobu/commit/b4666c50c375331aaf5fd2b8802b6891974459e0))
* migrate to Chat SDK platform adapters with typed OpenAPI schemas ([89573db](https://github.com/lobu-ai/lobu/commit/89573dbf3242249034f37543671db26493ccbd88))
* move workspace files to worker filesystem, fix CI, lint cleanup ([142d0c8](https://github.com/lobu-ai/lobu/commit/142d0c8c96a7eb9a0d6792809bbefbd2bbb7027e))
* multi-auth settings UX, base provider module refactor, and infra improvements ([1c61b30](https://github.com/lobu-ai/lobu/commit/1c61b30e931f68ee37b9d8775fcae66c1e95643c))
* multi-provider auth, MCP REST API, workspace instructions, dev tooling ([2e08491](https://github.com/lobu-ai/lobu/commit/2e084912a65f495d16f090a7abe2e37f08a356c8))
* **oauth:** add PKCE, RFC 8707 resource, auto-grants, and MCP token endpoint ([63336a7](https://github.com/lobu-ai/lobu/commit/63336a78d92999384fa873216668467a2787666c))
* **observability:** vendor-neutral OTEL tracing + opt-in Sentry ([#172](https://github.com/lobu-ai/lobu/issues/172)) ([f3345d3](https://github.com/lobu-ai/lobu/commit/f3345d364cfa28c9cc8f9c801041ccb1fd492b5c))
* **otel:** switch from OTLP HTTP to gRPC exporter (port 4317) ([60178db](https://github.com/lobu-ai/lobu/commit/60178db403596efadcd3124e367b06287f7696ba))
* Owletto memory plugin, plugin hooks/services, test infrastructure, and misc improvements ([89c27f0](https://github.com/lobu-ai/lobu/commit/89c27f0736e74fe83de6b1664017b21130cd489f))
* **proxy:** resolve provider credentials via URL path agentId ([1dbcb8c](https://github.com/lobu-ai/lobu/commit/1dbcb8c3c3a9ee6471733cedfcadf9ee5e1b3f6d))
* re-enable custom tools and remove unused claudeSessionId tracking ([2adb766](https://github.com/lobu-ai/lobu/commit/2adb766077f1d688ba93ca1994b260aff3f6e4b8))
* refactor settings page to Alpine.js with pre-compiled Tailwind ([2126001](https://github.com/lobu-ai/lobu/commit/2126001d4e720eae0b99c7b22cd9fcb342ea174a))
* refresh cli docs and restore release publish chain ([#179](https://github.com/lobu-ai/lobu/issues/179)) ([1ee0595](https://github.com/lobu-ai/lobu/commit/1ee0595d354b0dee1a85d4b3015fd1c9adcab4a0))
* refresh landing pages and pricing UX ([c8d8b58](https://github.com/lobu-ai/lobu/commit/c8d8b58fd6ea4b16583d67259e61839dc9ee1f52))
* rename CTA to "Open in Owletto" and open in new tab ([179fc23](https://github.com/lobu-ai/lobu/commit/179fc239b240a31aabd3d412a98035353b638924))
* settings page rewrite (Alpine→Preact), history page, Telegram enhancements, landing page ([b2cba55](https://github.com/lobu-ai/lobu/commit/b2cba551671812f2c54e9188fa74cc77ecd2f27c))
* **settings:** add generic OpenAI provider ([fcae8c3](https://github.com/lobu-ai/lobu/commit/fcae8c30497d52263787930588763b64934160ae))
* **settings:** add generic OpenAI provider ([f60e93a](https://github.com/lobu-ai/lobu/commit/f60e93af00324191d7f842cb4f99ec8501aa5e04))
* **settings:** post-install callback with agent resume ([d96e99b](https://github.com/lobu-ai/lobu/commit/d96e99b120054cebad862f788eef427faefb4e40))
* show nix packages in landing skill previews ([6095e13](https://github.com/lobu-ai/lobu/commit/6095e13447d9d7c3e6214a9995b9994645ee8bf9))
* **skills:** add scoring, URI, and system skill search to SearchSkills ([d63d7a8](https://github.com/lobu-ai/lobu/commit/d63d7a8e1a0b16dfcd8761a1ed54690cd84616c6))
* support Telegram webhooks when PUBLIC_GATEWAY_URL is set ([c3d266e](https://github.com/lobu-ai/lobu/commit/c3d266e59ef45c386bcf7ccbe3808dbf18abb3f4))
* wire file-first owletto memory config ([46c7554](https://github.com/lobu-ai/lobu/commit/46c7554d27284724333d5aa043316fe208f278b1))
* **worker:** ConnectService, CallService, DisconnectService tools and integration runtime ([af5a270](https://github.com/lobu-ai/lobu/commit/af5a270ba8e5d66e77cb7cd9c1d495d183e22a44))
* **worker:** expand ConnectService to support AI provider setup ([45b0c93](https://github.com/lobu-ai/lobu/commit/45b0c9396a759a14eb67c22347aee2de08e4543e))
* **worker:** generic MCP login tools + bash hardening ([5e167a4](https://github.com/lobu-ai/lobu/commit/5e167a41bf87f71704c7f936759624a26e959e85))
* **worker:** redact sandbox leaks, replace base prompt identity, use signed artifact URLs ([a5c33d8](https://github.com/lobu-ai/lobu/commit/a5c33d818d9de4e0bef8fd1710a2244f8592e33f))


### Bug Fixes

* add CSS generation step to CI typecheck job ([de4e500](https://github.com/lobu-ai/lobu/commit/de4e500d7e2e29727b136e03e062ba35ffb2bc20))
* add CSS generation step to gateway Dockerfile ([d361129](https://github.com/lobu-ai/lobu/commit/d3611292caadd929c89e4b7fbabb27da9f3c632c))
* add default model fallback per provider and fix z-ai base URL env var ([ebb8237](https://github.com/lobu-ai/lobu/commit/ebb82377c966a4cb44d033dc8744958f447f7133))
* add HTTP to HTTPS redirect for community.lobu.ai ([1b22074](https://github.com/lobu-ai/lobu/commit/1b220743ab0e366586cdb4118f3c6578fe690cc7))
* add missing orchestrator defaults to Helm values ([b882ad3](https://github.com/lobu-ai/lobu/commit/b882ad3056645b3c5691db23684b4327c1530044))
* add production environment to Docker publish workflow and clean up outputs ([9fe8120](https://github.com/lobu-ai/lobu/commit/9fe812050fa603c62764108f734b76284080b76c))
* add production environment to release-please workflow for npm publishing ([1cd6121](https://github.com/lobu-ai/lobu/commit/1cd6121d15876e223a2a741c0839cc6c4e3c99fc))
* add production environment to release-please workflow for npm publishing ([92a5c26](https://github.com/lobu-ai/lobu/commit/92a5c26aca24b5ab395c9a9ae6299177a156d4ec))
* address critical security and functionality issues in direct sessions API ([782f617](https://github.com/lobu-ai/lobu/commit/782f617ba4cc1f66f3d5e9a27366a5ae90845b13))
* apply code formatting fixes ([0e17f0c](https://github.com/lobu-ai/lobu/commit/0e17f0c38f5fd08b616cf7648a89b4f49b4bea98))
* build core package before running tests in CI ([1752131](https://github.com/lobu-ai/lobu/commit/175213174d40d3b2dfe17af179dacb6490b248be))
* build only required packages for npm publishing ([55065a7](https://github.com/lobu-ai/lobu/commit/55065a773f1d86785732ea2b116447013cbb3d35))
* **ci:** add group-pull-request-title-pattern for merge plugin ([#200](https://github.com/lobu-ai/lobu/issues/200)) ([d01fe2e](https://github.com/lobu-ai/lobu/commit/d01fe2ebe30bba653775a683458c667ead5697fd))
* **ci:** bump Bun to 1.3.5 to fix CONNECT test failures ([1970c9a](https://github.com/lobu-ai/lobu/commit/1970c9a7ad5380134c5da514a88847dbc520ca8d))
* **ci:** drop package-name from release-please config to fix auto-tagging ([#190](https://github.com/lobu-ai/lobu/issues/190)) ([31056a2](https://github.com/lobu-ai/lobu/commit/31056a2e8af8e9347aa7e6680109162e85509f17))
* **ci:** gate release steps on explicit true output ([47346e5](https://github.com/lobu-ai/lobu/commit/47346e54a866bc6700413e34621387b61d5cb924))
* **ci:** guard docker sha tags on release events ([#181](https://github.com/lobu-ai/lobu/issues/181)) ([48b75ac](https://github.com/lobu-ai/lobu/commit/48b75ac8154c801bbdc8676412cf5fabe804d8aa))
* **ci:** include component in title pattern to fix release-please auto-tagging ([#194](https://github.com/lobu-ai/lobu/issues/194)) ([deaa3dc](https://github.com/lobu-ai/lobu/commit/deaa3dca4737fefb502d7982f37ed75abb122e33))
* **ci:** include component in title pattern to fix release-please auto-tagging ([#196](https://github.com/lobu-ai/lobu/issues/196)) ([524e715](https://github.com/lobu-ai/lobu/commit/524e715fe8da91adc8eb133afac18250b4010916))
* **ci:** pin bun version for landing deploy ([0c62bf0](https://github.com/lobu-ai/lobu/commit/0c62bf09804b9e5851c51f85b22fdbafd744f278))
* **ci:** put version in release-please PR title + add workflow_dispatch ([#176](https://github.com/lobu-ai/lobu/issues/176)) ([9021308](https://github.com/lobu-ai/lobu/commit/9021308ed7162a7bd20e08817c351a64684ed7c1))
* **ci:** reconcile release-please config + Chart.yaml appVersion ([#174](https://github.com/lobu-ai/lobu/issues/174)) ([c6ea7c8](https://github.com/lobu-ai/lobu/commit/c6ea7c8368f312f2deb10deb5e723ef76e23ece6))
* **ci:** release-please triggers publish-packages via gh workflow run ([87b14cb](https://github.com/lobu-ai/lobu/commit/87b14cbaea46df47be6e5a71d7fc498523c23995))
* **ci:** remove invalid secrets check from eval workflow job condition ([1889cc4](https://github.com/lobu-ai/lobu/commit/1889cc47c6b10c43d78a2a91e92f9ff5924c1559))
* **ci:** repair broken npm publish workflows ([6f6ea08](https://github.com/lobu-ai/lobu/commit/6f6ea08ec2f2d15e10933c1ecd993fe205dad55f))
* **ci:** restore release config for package releases ([6c7190c](https://github.com/lobu-ai/lobu/commit/6c7190ceff17b4b113e9036b5663c40ec01fe19f))
* **ci:** restore release manifest for package releases ([892cdc5](https://github.com/lobu-ai/lobu/commit/892cdc5d3fa91db47bd06e44ad1e9507a57f0f58))
* **ci:** restore release-please pull-request-title-pattern ([#186](https://github.com/lobu-ai/lobu/issues/186)) ([699f40b](https://github.com/lobu-ai/lobu/commit/699f40b0cf9375b25a76733f7351ca934730fe9d))
* **ci:** set empty component to fix release-please auto-tagging ([#192](https://github.com/lobu-ai/lobu/issues/192)) ([ec809f9](https://github.com/lobu-ai/lobu/commit/ec809f9069f0a8b79b0fab0b37eeb409783da67e))
* **ci:** set include-component-in-tag true so release-please auto-tags ([#197](https://github.com/lobu-ai/lobu/issues/197)) ([85cc88a](https://github.com/lobu-ai/lobu/commit/85cc88ae1c6ff4d4b69c276824162206bc5e0d3a))
* **ci:** sync bun lockfile ([16c91dd](https://github.com/lobu-ai/lobu/commit/16c91dd052f7571da9c144787afef670ccc09338))
* **ci:** upgrade npm to latest for OIDC trusted publishing ([a85bbb2](https://github.com/lobu-ai/lobu/commit/a85bbb280ea814c8ab6c8c2d576b18cd14817ff6))
* **ci:** use default release-please title pattern variables ([#178](https://github.com/lobu-ai/lobu/issues/178)) ([26709e3](https://github.com/lobu-ai/lobu/commit/26709e3c19e01ebf58220118a056833caf6ea50b))
* **ci:** use GitHub secret for Telegram token, not k8s sealed secret ([ff27697](https://github.com/lobu-ai/lobu/commit/ff27697611db35e5c7d1c31e0b6fdcd1f27c045e))
* **ci:** use Node 24 for bundled npm 11 (OIDC trusted publishing) ([3697004](https://github.com/lobu-ai/lobu/commit/3697004f3cf00a41e0dcbdaae2f7e539e9a7d00b))
* **ci:** use NODE_AUTH_TOKEN for npm auth instead of manual .npmrc ([606a82b](https://github.com/lobu-ai/lobu/commit/606a82ba9d7879a0a028fb63d1ab09e7e3f6326c))
* **ci:** use OIDC trusted publishing, drop stale NPM_TOKEN path ([e8f5ca0](https://github.com/lobu-ai/lobu/commit/e8f5ca08c70be3f0afc2b29c3f5ac3b78e0c8669))
* **ci:** use simpler release-please title pattern that actually works ([#188](https://github.com/lobu-ai/lobu/issues/188)) ([11e1e70](https://github.com/lobu-ai/lobu/commit/11e1e7056674b1ed67be9678ed4c1fa2a988a9c2))
* **ci:** use yaml updater for Chart.yaml version + appVersion ([58819bc](https://github.com/lobu-ai/lobu/commit/58819bc604ed04448a10e8a67535c8b1ff470911))
* clear mismatched default model in auto-mode provider selection ([ab20949](https://github.com/lobu-ai/lobu/commit/ab20949514d09158e33c4a0951cdda498a226c8d))
* clear stale session when provider changes ([080afe0](https://github.com/lobu-ai/lobu/commit/080afe0b1bb818a3166b55804d285290e101d0e1))
* **cli:** auth reliability — server-side logout, --force login, stale cred cleanup, concurrent refresh ([b0ee7a3](https://github.com/lobu-ai/lobu/commit/b0ee7a3cf89be660254febed38481f26f7a95eec))
* **cli:** hide hidden skills from 'lobu skills list' ([abbf99e](https://github.com/lobu-ai/lobu/commit/abbf99e93a6a60e2828e6222324835b2faac403e))
* **cli:** replace RequestInfo with portable fetch input type ([ba23c4a](https://github.com/lobu-ai/lobu/commit/ba23c4a260949f75e81876dd4e85e35449d5cada))
* **cli:** restore system skills and add CLI to publish workflow ([1fc3687](https://github.com/lobu-ai/lobu/commit/1fc3687985505bf6dd9133b94f162bdd568947c4))
* correct session-manager tests to use proper session key format ([45af581](https://github.com/lobu-ai/lobu/commit/45af581e3ee97e0a8433362a9437c7634edbeb79))
* deduplicate owletto URL logic, fix skills card title, add skills link to memory reuse step ([78ad65e](https://github.com/lobu-ai/lobu/commit/78ad65e75faa689fbaa3715c0cc3eec1496c8527))
* delete existing webhook before starting Telegram long polling ([c6cd02c](https://github.com/lobu-ai/lobu/commit/c6cd02c8f2bc711934764823448723feda6d503f))
* **deploy:** remove broken global.imageRegistry that caused double-slash in Bitnami Redis image paths ([e37d81c](https://github.com/lobu-ai/lobu/commit/e37d81c79593234b9fb44aa2f2e1b9150fa3678f))
* **deploy:** update sealed secrets with all required keys ([fbe588e](https://github.com/lobu-ai/lobu/commit/fbe588e8296746a29f1ddb12af56f56856f3b420))
* disable Nix sandbox for arm64 QEMU builds ([e54e712](https://github.com/lobu-ai/lobu/commit/e54e712a5360899e67722159232e04a2b90bee8a))
* disable WhatsApp in community deployment (no credentials) ([2e14197](https://github.com/lobu-ai/lobu/commit/2e14197530f6c6328f8e048c10ec2bdd5b891499))
* **docs:** correct outdated references across documentation ([b78fa65](https://github.com/lobu-ai/lobu/commit/b78fa65611ca556fb672b52a950c03e73c741cab))
* **docs:** fix Teams Chat SDK link and update CLI generated files list ([737a3d7](https://github.com/lobu-ai/lobu/commit/737a3d747aa9cc62f9d8334743c1a22167357159))
* **eval:** continue running remaining evals after individual failures ([8187b7f](https://github.com/lobu-ai/lobu/commit/8187b7f3f9422b3ec919878f64034be40e70cc17))
* **eval:** create data dir for Redis persistence in CI ([3f7f598](https://github.com/lobu-ai/lobu/commit/3f7f598ea25aa3a03a2da2465ebe1bfcb27e9bd7))
* **eval:** disable Redis RDB persistence in CI to avoid MISCONF errors ([c131bbb](https://github.com/lobu-ai/lobu/commit/c131bbb4eeaa8c628d9528963ecf9fad66741752))
* **eval:** don't override provider/model unless --model flag is set ([8b8bd4b](https://github.com/lobu-ai/lobu/commit/8b8bd4b1c02d6c630da41c900973604c69b32487))
* **eval:** don't pass provider/model to session creation, use agent config ([49f3b4d](https://github.com/lobu-ai/lobu/commit/49f3b4df506751b5b1a62ede913e5abc9c84f761))
* **eval:** improve judge prompts with prose fallback, CI runs smoke only ([6876107](https://github.com/lobu-ai/lobu/commit/6876107f5620341056bc821accaad33d14d15333))
* **eval:** isolate trials + feat(worker): MCP-as-CLI for embedded mode ([#184](https://github.com/lobu-ai/lobu/issues/184)) ([c256d6d](https://github.com/lobu-ai/lobu/commit/c256d6d2604b514df9eb2c5658524079286e73b9))
* **eval:** pass Z_AI_API_KEY to gateway container in docker-compose ([ad890e3](https://github.com/lobu-ai/lobu/commit/ad890e35add1fee8285b241415b53d1984a2302d))
* export ActionButton and ModuleSessionContext types and fix implicit any ([6d6bc01](https://github.com/lobu-ai/lobu/commit/6d6bc01ff53e912f5a6bc584b6e99b132a18fd75))
* **gateway:** escape oauth callback template values ([#122](https://github.com/lobu-ai/lobu/issues/122)) ([d4cfc45](https://github.com/lobu-ai/lobu/commit/d4cfc45dacd6bec48c3c904f751a863b9f6510e6))
* **gateway:** preserve base path when mounted as sub-app ([edc0be5](https://github.com/lobu-ai/lobu/commit/edc0be54a5a1d56d771a0b70541d3752306779f9))
* **gateway:** publish embedded runtime packages ([148e7dc](https://github.com/lobu-ai/lobu/commit/148e7dcfb47b8a29c5e7f14926a55a3b5754e09b))
* **gateway:** redact secrets in agent config response ([#127](https://github.com/lobu-ai/lobu/issues/127)) ([6af4424](https://github.com/lobu-ai/lobu/commit/6af44241faa9f1fae60eba49423528a295d1a4c1))
* **gateway:** remove settings token query exposure ([#130](https://github.com/lobu-ai/lobu/issues/130)) ([9d4adb8](https://github.com/lobu-ai/lobu/commit/9d4adb83ffbcd128250704d5cf19859eaaf0193a))
* **gateway:** require auth for channel binding routes ([#123](https://github.com/lobu-ai/lobu/issues/123)) ([6736fe9](https://github.com/lobu-ai/lobu/commit/6736fe9ede187f71a7c513b20cf2f1c528188a10))
* **gateway:** require settings token for chatgpt start/poll ([#124](https://github.com/lobu-ai/lobu/issues/124)) ([4004401](https://github.com/lobu-ai/lobu/commit/4004401d78aa6e62a65661c1b0e3f229873a6c31))
* **gateway:** skip enqueuing worker delivery receipts to thread response queue ([c5c352d](https://github.com/lobu-ai/lobu/commit/c5c352d50b9dfd80570bb78743735eb94adb38d3))
* **gateway:** stop logging WhatsApp credential payloads ([#128](https://github.com/lobu-ai/lobu/issues/128)) ([68968b5](https://github.com/lobu-ai/lobu/commit/68968b57c8384e52939daca407c3f8f3a308050c))
* handle empty HOME env in git cache fallback ([c00ebfe](https://github.com/lobu-ai/lobu/commit/c00ebfe5f0e55bb8b68e3a0a0e14378a8998affc))
* **helm:** expose ADMIN_PASSWORD and platform tokens as gateway env vars ([968f4a8](https://github.com/lobu-ai/lobu/commit/968f4a89b230c0608a48f851fcda7f77ce046992))
* **helm:** make claude-code-oauth-token secret ref optional ([992a2e6](https://github.com/lobu-ai/lobu/commit/992a2e6c2652781975285bd0b14618990c90ded0))
* **helm:** remove platform token env vars from gateway deployment ([062f18f](https://github.com/lobu-ai/lobu/commit/062f18f71f82538c0ee343e608e4861e78e9a281))
* improve error handling for streaming validation errors ([ea72817](https://github.com/lobu-ai/lobu/commit/ea72817918823efbac688b9ae84e73289399c648))
* improve team ID handling in Slack events ([d083365](https://github.com/lobu-ai/lobu/commit/d083365b5eca36d305e611ffb4991cbcd248a453))
* include mcp-servers.json in gateway Docker image ([d0c9cd3](https://github.com/lobu-ai/lobu/commit/d0c9cd33cc09f4fb9fc80078b0c7d9b025880f52))
* include z.ai API path prefix in upstream base URL ([4ad79c9](https://github.com/lobu-ai/lobu/commit/4ad79c92da9d2b3ca0c0c39328956bf05b5aa60b))
* **landing:** bold connector label inline instead of separate heading ([3ac690e](https://github.com/lobu-ai/lobu/commit/3ac690e5f803408fa8ee4a91ebd87f9ecdf07138))
* **landing:** clarify use-case source CTA ([d0b64f2](https://github.com/lobu-ai/lobu/commit/d0b64f2367c4c0f7e8c815c2ae89d92047ae38d8))
* **landing:** correct homepage prompt and CLI command references ([5f4429f](https://github.com/lobu-ai/lobu/commit/5f4429fa118a23018df97db83cda7c8a62760602))
* **landing:** correct owletto demo links ([150a7c9](https://github.com/lobu-ai/lobu/commit/150a7c94f26b04e51271e6dc9074a649eb178099))
* **landing:** improve hero CTA labels ([ae6a807](https://github.com/lobu-ai/lobu/commit/ae6a807ae33679770e7f851ab0f4c8ef5dce2c3a))
* **landing:** inline connector labels to balance recall/auth column heights ([6125016](https://github.com/lobu-ai/lobu/commit/61250162d3a4b28fccfcb273282e39afbc000a69))
* **landing:** keep homepage hero generic ([8078103](https://github.com/lobu-ai/lobu/commit/807810394c3d6ed87aa445075b4e9b7e4e248136))
* **landing:** left-align skills workspace preview ([54519ca](https://github.com/lobu-ai/lobu/commit/54519cab40a6f157c5f19761e7e5a3ca6a565813))
* **landing:** resolve zod alias from installed package ([f09e12d](https://github.com/lobu-ai/lobu/commit/f09e12d8409a122c8f33db3bb915c84af1d9e1c9))
* **landing:** use descriptive agent names in ConnectionsPanel ([f8f38c1](https://github.com/lobu-ai/lobu/commit/f8f38c118d703015580680eb3717c74755b2cb7b))
* make memory step layouts consistent ([990bf61](https://github.com/lobu-ai/lobu/commit/990bf61d7af60d43c6487f99c2b73b27820e4468))
* map z-ai gateway slug to zai model registry provider name ([64b606e](https://github.com/lobu-ai/lobu/commit/64b606e1c274463e5b96419a77e42905a4abb0f4))
* **packages:** add repository.url to all published package.json files ([c3f14c0](https://github.com/lobu-ai/lobu/commit/c3f14c04649c690ee6d5ee02a69e94f0f55de279))
* pass TELEGRAM_BOT_TOKEN in community deploy workflow ([e9c86e9](https://github.com/lobu-ai/lobu/commit/e9c86e9d87cd1c41ad758daa51b6fb6e35149f00))
* pin redis chart version to avoid Helm OCI panic ([af348ef](https://github.com/lobu-ai/lobu/commit/af348ef5553e67dd88b637d976b2fc2cea6c3e95))
* point agent-community Try Now to venture-capital org ([b117767](https://github.com/lobu-ai/lobu/commit/b117767c65e1e817a39f567ad39cc2abf2459da0))
* properly configure Nix sandbox for arm64 builds ([71daf7b](https://github.com/lobu-ai/lobu/commit/71daf7be81f94753f543f9b07a22351eb5f232d5))
* **proxy:** handle CONNECT method in request handler for Bun on Linux ([320e028](https://github.com/lobu-ai/lobu/commit/320e028f6e8b2a24733fbca52d7a1880c9787590))
* README link rendering and enable auto-deploy on push ([f7743a8](https://github.com/lobu-ai/lobu/commit/f7743a8765bb6636b8c6db1270c7de136a1957ea))
* recreate scaled-down workers with fresh env vars on wake-up ([879cd41](https://github.com/lobu-ai/lobu/commit/879cd41ff25146c2724e62f170bbe6566a2bbbca))
* **release:** sync helm chart to 3.0.5 ([92c5142](https://github.com/lobu-ai/lobu/commit/92c51422bc96f3267f89d607fafa47237b2709e8))
* remove broken integration tests causing 6-hour CI timeout ([1abd9c4](https://github.com/lobu-ai/lobu/commit/1abd9c4f0d24d2752780dc55db20cb7bc1a20113))
* remove CLI_VERSION pinning, use latest for worker package ([9c33352](https://github.com/lobu-ai/lobu/commit/9c3335248df9ca1010a9931c8798616bf64d0305))
* repair failing tests and exclude workspaces from test discovery ([3227430](https://github.com/lobu-ai/lobu/commit/3227430cae3cebcf5e815c0274197615dff276b9))
* resolve biome lint and format errors in landing/ ([#107](https://github.com/lobu-ai/lobu/issues/107)) ([40965cb](https://github.com/lobu-ai/lobu/commit/40965cbfe60039311fc6f00f66ebef157d3c4b0f))
* resolve CI workflow syntax errors ([a312b9f](https://github.com/lobu-ai/lobu/commit/a312b9f909c7b5c96896add46d4bb5ffc488267e))
* resolve K8s deployment issues ([9d48358](https://github.com/lobu-ai/lobu/commit/9d48358c38f66b95522b0cb288060fc664bf2aab))
* resolve K8s deployment issues ([dcd6eff](https://github.com/lobu-ai/lobu/commit/dcd6eff4292c676d886b42991fab481949a58134))
* resolve linting issues in test files ([b214013](https://github.com/lobu-ai/lobu/commit/b2140138acc5c13812a6057029a5197930844a62))
* resolve worker CJS/ESM module error and missing Nix in production ([fda47de](https://github.com/lobu-ai/lobu/commit/fda47de2bb6169eef79c4df8d96f57d7ca0af0c2))
* respect installed provider order when no explicit model is set ([2319f36](https://github.com/lobu-ai/lobu/commit/2319f360ae653dcc00a54fc4a9b2efb3dfffe9a2))
* restart stream on message_not_in_streaming_state error ([32db4a1](https://github.com/lobu-ai/lobu/commit/32db4a157777224a1f6cbc93854aa1d3471e7a28))
* security hardening and reliability improvements across gateway/worker ([ea00cef](https://github.com/lobu-ai/lobu/commit/ea00cef9cc526d6c8a471a855a6a379c32af68c5))
* session reset clears history, Telegram plain-text fallback ([7af9703](https://github.com/lobu-ai/lobu/commit/7af9703ce7fe333473f067eb6d504379041e3a23))
* **settings:** make OAuth client optional so Telegram mini app works without it ([f51abed](https://github.com/lobu-ai/lobu/commit/f51abedb6f73055bba1ee91d3e4dde42afa758cb))
* **settings:** rename "Scheduled Reminders" to "Schedules" ([6a74299](https://github.com/lobu-ai/lobu/commit/6a74299e3ac7886da3217ecc081473e5e956605b))
* **settings:** skip identity linked notification if already linked ([1674a3b](https://github.com/lobu-ai/lobu/commit/1674a3be8a08516f273f21ea2691a60213c74572))
* simplify Docker multi-arch support and improve MCP configuration ([5f4e2d8](https://github.com/lobu-ai/lobu/commit/5f4e2d8d0f7d475663b0458d2075d878a263d646))
* simplify manual npm publish to use main branch ([423eb43](https://github.com/lobu-ai/lobu/commit/423eb436c21445fd42ed99129fd7a89469a00dc7))
* skip arm64 worker build due to Nix/QEMU seccomp issue ([fa3f96c](https://github.com/lobu-ai/lobu/commit/fa3f96cfa86272cd6523162154745790a01183ca))
* **telegram:** add platform=telegram param to provider setup URL ([61d9aed](https://github.com/lobu-ai/lobu/commit/61d9aed0ac706e33d08f469b231ec9a68f071c94))
* **telegram:** auto-enable when bot token is present ([a951747](https://github.com/lobu-ai/lobu/commit/a951747976c18d5b18930bcf6baf07da8d70a895))
* temporarily disable custom tools to fix npm build ([2065c74](https://github.com/lobu-ai/lobu/commit/2065c7456cb50bb7f7b8b413d0ec0b9f9509655e))
* track tailwind.config.js so CI CSS generation works ([ae6f1e7](https://github.com/lobu-ai/lobu/commit/ae6f1e753d1c02fb863fb17b64e041e622adada4))
* update ChatGPT device code OAuth flow and skill display ([a81594a](https://github.com/lobu-ai/lobu/commit/a81594af63c4050c2e315a76c0c74b90cb940712))
* update community deployment for Hetzner cluster ([fe5bf90](https://github.com/lobu-ai/lobu/commit/fe5bf908bd708ffad198991378e6054b1ff75fba))
* update README and landing page (Baileys→Cloud API, Anthropic→OpenRouter, bare lobu→npx) ([45ee64f](https://github.com/lobu-ai/lobu/commit/45ee64f1ced1ee883ea2db6b48c2255dc72ab229))
* update worker-job-router tests to match fire-and-forget architecture ([b7d00d2](https://github.com/lobu-ai/lobu/commit/b7d00d27311339312cf9aa2b08f87e5fe1ecb83a))
* upgrade Helm to 3.16 to fix OCI registry panic ([e4f88de](https://github.com/lobu-ai/lobu/commit/e4f88def1378c4f946b5f8f00f3a038e4562e716))
* use bun instead of tsx in gateway Helm template ([77dccfa](https://github.com/lobu-ai/lobu/commit/77dccfac62474062b26d5b2e7299b2f42f48c694))
* use npx @lobu/cli consistently across CLI output, docs, and landing page ([ca1133c](https://github.com/lobu-ai/lobu/commit/ca1133cde710605a017a79c7dd161cf6dca11d33))
* use PAT for repository_dispatch in deploy trigger ([10add7e](https://github.com/lobu-ai/lobu/commit/10add7e377bf4c27520264704b9fcea6d079a477))
* use strategic merge patch for K8s deployment scaling ([fde3201](https://github.com/lobu-ai/lobu/commit/fde320157297b6dae58d7f65e22c2dd743892137))
* use writable temp directory for git cache fallback ([c45fc01](https://github.com/lobu-ai/lobu/commit/c45fc01a5ada190bf467b2ab27f71f770c4e927a))
* **worker:** use string concatenation for session-context URL ([09d474e](https://github.com/lobu-ai/lobu/commit/09d474e6e2e5c8ec48505196803a0d7c8beb055d))

## [3.4.3](https://github.com/lobu-ai/lobu/compare/v3.4.2...v3.4.3) (2026-04-16)


### Bug Fixes

* **ci:** set empty component to fix release-please auto-tagging ([#192](https://github.com/lobu-ai/lobu/issues/192)) ([ec809f9](https://github.com/lobu-ai/lobu/commit/ec809f9069f0a8b79b0fab0b37eeb409783da67e))

## [3.4.2](https://github.com/lobu-ai/lobu/compare/v3.4.1...v3.4.2) (2026-04-16)


### Bug Fixes

* **ci:** drop package-name from release-please config to fix auto-tagging ([#190](https://github.com/lobu-ai/lobu/issues/190)) ([31056a2](https://github.com/lobu-ai/lobu/commit/31056a2e8af8e9347aa7e6680109162e85509f17))

## [3.4.1](https://github.com/lobu-ai/lobu/compare/v3.4.0...v3.4.1) (2026-04-16)


### Bug Fixes

* **ci:** restore release-please pull-request-title-pattern ([#186](https://github.com/lobu-ai/lobu/issues/186)) ([699f40b](https://github.com/lobu-ai/lobu/commit/699f40b0cf9375b25a76733f7351ca934730fe9d))
* **ci:** use simpler release-please title pattern that actually works ([#188](https://github.com/lobu-ai/lobu/issues/188)) ([11e1e70](https://github.com/lobu-ai/lobu/commit/11e1e7056674b1ed67be9678ed4c1fa2a988a9c2))

## [3.4.0](https://github.com/lobu-ai/lobu/compare/v3.3.0...v3.4.0) (2026-04-16)


### Features

* add /skills/for/{useCase} routes, version eval schema, clean up duplication ([d84a856](https://github.com/lobu-ai/lobu/commit/d84a856a307916b87641426e0d2de48f89442089))
* **gateway:** add MCP OAuth 2.1 auth-code + PKCE flow ([9ea9f45](https://github.com/lobu-ai/lobu/commit/9ea9f45dedb9aa0f5ef740b949cd6b51fa8bf2ee))
* **gateway:** add optional body text to link-button cards ([#183](https://github.com/lobu-ai/lobu/issues/183)) ([1e93013](https://github.com/lobu-ai/lobu/commit/1e93013d542d4021fe33b4029b58b6329c4b19bd))
* **landing:** add connect-from pages and refresh use-case content ([1ce6f6c](https://github.com/lobu-ai/lobu/commit/1ce6f6c0754aa8adfa45f6dc0738f5931717dbf1))
* **landing:** add terms of service page ([0347573](https://github.com/lobu-ai/lobu/commit/0347573d58d5aff6594713bb4a7277f7227d9e83))
* **landing:** remove Lobu for X labels and redundant use case summaries ([e861218](https://github.com/lobu-ai/lobu/commit/e861218120dbfc5265152bd09b2ab96a6202f5c3))
* **landing:** update copy prompt behavior and text ([a551a79](https://github.com/lobu-ai/lobu/commit/a551a7965c9c46aa2b44e2a29eecd065fd9c1f13))
* make examples/ single source of truth for use cases and Owletto orgs ([3fc5380](https://github.com/lobu-ai/lobu/commit/3fc5380a720681d4b54ca88ff401dcaa7462db70))
* make Hero GitHub button contextual to active use case ([f1ca9fe](https://github.com/lobu-ai/lobu/commit/f1ca9fed7cfbe4326599e546109eca7f6a45bb05))
* migrate owletto examples to models/ directory with type field ([3deeb77](https://github.com/lobu-ai/lobu/commit/3deeb77f5eea1cd9d1124691e42430e3bb6fa496))
* rename CTA to "Open in Owletto" and open in new tab ([179fc23](https://github.com/lobu-ai/lobu/commit/179fc239b240a31aabd3d412a98035353b638924))
* wire file-first owletto memory config ([46c7554](https://github.com/lobu-ai/lobu/commit/46c7554d27284724333d5aa043316fe208f278b1))
* **worker:** redact sandbox leaks, replace base prompt identity, use signed artifact URLs ([a5c33d8](https://github.com/lobu-ai/lobu/commit/a5c33d818d9de4e0bef8fd1710a2244f8592e33f))


### Bug Fixes

* **eval:** isolate trials + feat(worker): MCP-as-CLI for embedded mode ([#184](https://github.com/lobu-ai/lobu/issues/184)) ([c256d6d](https://github.com/lobu-ai/lobu/commit/c256d6d2604b514df9eb2c5658524079286e73b9))
* **landing:** clarify use-case source CTA ([d0b64f2](https://github.com/lobu-ai/lobu/commit/d0b64f2367c4c0f7e8c815c2ae89d92047ae38d8))
* **landing:** correct owletto demo links ([150a7c9](https://github.com/lobu-ai/lobu/commit/150a7c94f26b04e51271e6dc9074a649eb178099))
* **landing:** improve hero CTA labels ([ae6a807](https://github.com/lobu-ai/lobu/commit/ae6a807ae33679770e7f851ab0f4c8ef5dce2c3a))
* **landing:** keep homepage hero generic ([8078103](https://github.com/lobu-ai/lobu/commit/807810394c3d6ed87aa445075b4e9b7e4e248136))
* **landing:** left-align skills workspace preview ([54519ca](https://github.com/lobu-ai/lobu/commit/54519cab40a6f157c5f19761e7e5a3ca6a565813))

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
