# Changelog

## [11.2.0](https://github.com/lobu-ai/lobu/compare/lobu-v11.1.0...lobu-v11.2.0) (2026-06-11)


### Features

* **connector-sdk:** auth-aware HTTP client and pagination helpers; nine connectors gain 429/5xx retry ([4f6a495](https://github.com/lobu-ai/lobu/commit/4f6a4950d9b09bba0f2be9325c33c73dcafc64b0))


### Bug Fixes

* **cli:** drop scaffolded node_modules in smoke gates so the workspace connector-sdk is under test ([#1223](https://github.com/lobu-ai/lobu/issues/1223)) ([3cc9cc8](https://github.com/lobu-ai/lobu/commit/3cc9cc8f2e4492e4aead9790f51fa24eb4c45b87)), closes [#1222](https://github.com/lobu-ai/lobu/issues/1222)
* **gateway:** resolve org-shared provider keys at the egress proxy ([#1215](https://github.com/lobu-ai/lobu/issues/1215)) ([3582ac0](https://github.com/lobu-ai/lobu/commit/3582ac0cd87d4dd39fbbff6d5910d4941ea25da2))
* **sentry:** classify provider auth hints; suppress only the readiness drain 503 ([#1218](https://github.com/lobu-ai/lobu/issues/1218)) ([6f89cad](https://github.com/lobu-ai/lobu/commit/6f89cadbc4f785b040fb80bb61bfb319ffa56fa8))
* **server:** enforce rate limits cluster-wide via Postgres (per-pod limiter multiplied limits by replica count) ([4f6a495](https://github.com/lobu-ai/lobu/commit/4f6a4950d9b09bba0f2be9325c33c73dcafc64b0))
* **server:** truthful vitest exit codes, fail-closed CI gate, and the 8 red integration tests ([#1220](https://github.com/lobu-ai/lobu/issues/1220)) ([0235681](https://github.com/lobu-ai/lobu/commit/023568100f97d8c9b13fa2bbe3660338d15ded04))
* **tests:** raise live-provider max_tokens so reasoning-default models aren't starved ([#1219](https://github.com/lobu-ai/lobu/issues/1219)) ([d500d89](https://github.com/lobu-ai/lobu/commit/d500d897874c071d93da5cf79567f71d01acd72b))

## [11.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v11.0.0...lobu-v11.1.0) (2026-06-11)


### Features

* **auth:** global login-provider baseline; drop default-org pointer ([#1183](https://github.com/lobu-ai/lobu/issues/1183)) ([a6ebbff](https://github.com/lobu-ai/lobu/commit/a6ebbffd6c3dd38c7825fbe7e23bef762870b3c9))
* **cli:** add --org override to lobu chat ([#1185](https://github.com/lobu-ai/lobu/issues/1185)) ([38aa4ab](https://github.com/lobu-ai/lobu/commit/38aa4aba9d582fbce9d17fa263484ec776eeeaa4))
* **connectors:** native Postgres connector — memory feeds, live pushdown, connection-backed derived entities ([#1182](https://github.com/lobu-ai/lobu/issues/1182)) ([aaebe15](https://github.com/lobu-ai/lobu/commit/aaebe152b4fbbbb5187a73bbc6de379b1f36d979))
* derived entity types (SQL-view backing) + measure inference ([#1161](https://github.com/lobu-ai/lobu/issues/1161)) ([73abb03](https://github.com/lobu-ai/lobu/commit/73abb03b06c47bee0c3113e6f4b11aa71b96a3d6))
* **landing:** add /schedule page + revamp 404 ([#1166](https://github.com/lobu-ai/lobu/issues/1166)) ([8812b2f](https://github.com/lobu-ai/lobu/commit/8812b2f840816159e372492a528625dc74a42111))
* **queue:** emit a failed-run metric and a durable dead-letter retention window ([#1201](https://github.com/lobu-ai/lobu/issues/1201)) ([c7fffa5](https://github.com/lobu-ai/lobu/commit/c7fffa566fa812e4f8088e3786ea62da79e2d23b))
* **sentry:** report worker provider/model failures + cut alert-feed noise ([#1186](https://github.com/lobu-ai/lobu/issues/1186)) ([39b8aa6](https://github.com/lobu-ai/lobu/commit/39b8aa60b63293a467d6978316cee47b97f65507))
* **server:** query-rewrite recall mode for read_knowledge ([#1187](https://github.com/lobu-ai/lobu/issues/1187)) ([a7c7784](https://github.com/lobu-ai/lobu/commit/a7c7784dbb74d9f645a1577fd62f3c15d2d60261))
* **watchers:** device CLI results flow through the shared complete_window pipeline ([#1196](https://github.com/lobu-ai/lobu/issues/1196)) ([78c95dd](https://github.com/lobu-ai/lobu/commit/78c95dd47acd32675c34bdee10b98017fe872728))


### Bug Fixes

* **apply:** surface schema-validation errors instead of misreporting them as duplicates ([#1211](https://github.com/lobu-ai/lobu/issues/1211)) ([c2bdde5](https://github.com/lobu-ai/lobu/commit/c2bdde5212d9d082a6cd3a5d67f8b29f22290df5))
* **cli:** document canonical dotted connector keys in scaffolded AGENTS.md ([#1209](https://github.com/lobu-ai/lobu/issues/1209)) ([4a6fd96](https://github.com/lobu-ai/lobu/commit/4a6fd96ddc58bc2fb883324d8e26d06f2fda16e1))
* **cli:** point community telemetry at the dedicated lobu-oss Sentry org ([#1208](https://github.com/lobu-ai/lobu/issues/1208)) ([3ae6f6e](https://github.com/lobu-ai/lobu/commit/3ae6f6eeb9e870609716e494b7efcc5a8d3db233))
* **connectors:** resolve connector SDK for metadata extraction in projects without node_modules ([#1214](https://github.com/lobu-ai/lobu/issues/1214)) ([a415355](https://github.com/lobu-ai/lobu/commit/a41535582d5719742c63db4e0f3b5efbc02b6ee7))
* correctness/security bugs from multi-agent audit (rebased onto main) ([#1202](https://github.com/lobu-ai/lobu/issues/1202)) ([56dc97d](https://github.com/lobu-ai/lobu/commit/56dc97d606f422e68b70bdc31cddd92bb3bfd550))
* **gateway:** deliver ask_user/tool-approval/link-button cards cross-replica ([#1194](https://github.com/lobu-ai/lobu/issues/1194)) ([dd47727](https://github.com/lobu-ai/lobu/commit/dd47727c0739b690f818177cf616151fe475c60b))
* **gateway:** stop forwarding content-length/hop-by-hop headers in secret-proxy; log real proxy errors ([#1210](https://github.com/lobu-ai/lobu/issues/1210)) ([a630cb2](https://github.com/lobu-ai/lobu/commit/a630cb21ca796b7cf6dc676c27bb63f43401cb39)), closes [#1176](https://github.com/lobu-ai/lobu/issues/1176)
* **guardrails:** execute skill-declared and agent-inline guardrails (wire the dead aggregator) ([#1200](https://github.com/lobu-ai/lobu/issues/1200)) ([440e660](https://github.com/lobu-ai/lobu/commit/440e6605338e3686992e2197d4fc6847eeddf5f7))
* **providers:** correct broken provider URLs + add e2e provider-integration coverage ([#1193](https://github.com/lobu-ai/lobu/issues/1193)) ([55aea18](https://github.com/lobu-ai/lobu/commit/55aea188f3652f506d2bfd418c67929d902f5550))
* **sdk:** correct search_sdk metadata + validate viewTemplates args ([#1184](https://github.com/lobu-ai/lobu/issues/1184)) ([36f41e2](https://github.com/lobu-ai/lobu/commit/36f41e2f9fac2b7301ccd6edc6813bf5dd988492))
* **security:** close critical access-control and injection gaps from codebase audit ([#1192](https://github.com/lobu-ai/lobu/issues/1192)) ([a784560](https://github.com/lobu-ai/lobu/commit/a7845601957e6257ac4bfe3ac15fcf2cd6aff83c))
* **sentry:** stop worker traces + cut server span sampling to fit the span quota ([#1207](https://github.com/lobu-ai/lobu/issues/1207)) ([9051f90](https://github.com/lobu-ai/lobu/commit/9051f9059ec523ec2a623221a3ae4002375681fd))
* **server:** accept rest as a first-class adapterless platform ([#1212](https://github.com/lobu-ai/lobu/issues/1212)) ([c8294bb](https://github.com/lobu-ai/lobu/commit/c8294bb62701465de556389be85091f3aee30391)), closes [#1179](https://github.com/lobu-ai/lobu/issues/1179)
* **server:** provision install operator + default org on external-DB lobu run ([#1213](https://github.com/lobu-ai/lobu/issues/1213)) ([e6cc6da](https://github.com/lobu-ai/lobu/commit/e6cc6da0b4d72607b6b128d7e06a90f22b98f98c))

## [11.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v10.2.0...lobu-v11.0.0) (2026-05-30)


### ⚠ BREAKING CHANGES

* **cli:** `lobu memory browser-auth --connector <key>` now launches a dedicated debug Chrome instead of copying cookies from your real Chrome profile. The `--chrome-profile` and `--launch-cdp` flags are removed (`--launch-cdp` was the path now always taken).

### Features

* **connector-sdk:** extensionDomScrape helper; use it in LinkedIn home_feed ([#1155](https://github.com/lobu-ai/lobu/issues/1155)) ([ef359c0](https://github.com/lobu-ai/lobu/commit/ef359c0726d79513ab64f4628a4609f4095ab9e6))
* **connectors:** add Hacker News front-page feed ([#1147](https://github.com/lobu-ai/lobu/issues/1147)) ([153f82a](https://github.com/lobu-ai/lobu/commit/153f82acc3768b3d3359b5b3408631e0d718e1c3))
* **infra:** alert on prod deploy failures (Flux + CI) ([#1130](https://github.com/lobu-ai/lobu/issues/1130)) ([b79e599](https://github.com/lobu-ai/lobu/commit/b79e5996fe92463ce3b6b725fee2f78d32eafe0a))
* **landing:** use-case-specific /for/ pages with collapsible code tabs ([#1134](https://github.com/lobu-ai/lobu/issues/1134)) ([51124de](https://github.com/lobu-ai/lobu/commit/51124de19bb10f52bce836878d6a81d988f86a09))
* LinkedIn end-to-end on Owletto Chrome extension (delete Playwright fallback) ([#1132](https://github.com/lobu-ai/lobu/issues/1132)) ([080a3a3](https://github.com/lobu-ai/lobu/commit/080a3a33da581b11dbed363ec0e07370ccd5df02))
* **linkedin:** home_feed via content-script scrape ([#1151](https://github.com/lobu-ai/lobu/issues/1151)) ([c9baa1a](https://github.com/lobu-ai/lobu/commit/c9baa1a699cf4648ccef756fc7c233b9d15a10fa))
* **server:** associate connections with entities (union with feeds) ([#1158](https://github.com/lobu-ai/lobu/issues/1158)) ([4fb67f7](https://github.com/lobu-ai/lobu/commit/4fb67f7e3009de3cfcf2d14c618fae46189fcba2))
* **server:** device workers can claim runs in orgs they're pinned to ([#1149](https://github.com/lobu-ai/lobu/issues/1149)) ([3f24eec](https://github.com/lobu-ai/lobu/commit/3f24eec66408640fa44577391683da276364df14))


### Bug Fixes

* **auth:** expose username in session so home routing is synchronous ([#1162](https://github.com/lobu-ai/lobu/issues/1162)) ([c5fee87](https://github.com/lobu-ai/lobu/commit/c5fee878762c3f194e90e9fcbf0471df71a6615e))
* **auth:** login requests only connector loginScopes, not sensitive connector scopes ([#1145](https://github.com/lobu-ai/lobu/issues/1145)) ([5bb81cd](https://github.com/lobu-ai/lobu/commit/5bb81cdbde20ca2f0a92b0ac4d1945edab6b93b3))
* **auth:** set username at signup + bump owletto (new-user org routing) ([#1160](https://github.com/lobu-ai/lobu/issues/1160)) ([fc6a6d4](https://github.com/lobu-ai/lobu/commit/fc6a6d4fece8eee5394817902a121b932573bcfa))
* **gateway:** allow Owletto extension origins through CORS ([#1116](https://github.com/lobu-ai/lobu/issues/1116)) ([449f93e](https://github.com/lobu-ai/lobu/commit/449f93e46ac73fcd2d5f69e2084a159e50d22e4a))
* **gateway:** route lobu chat to org's default agent end-to-end ([#1136](https://github.com/lobu-ai/lobu/issues/1136)) ([6c07546](https://github.com/lobu-ai/lobu/commit/6c075465eac397b3d5dbab391697e828ffd2e270))
* **linkedin:** home_feed author body-fallback + drop promoted/suggested/noise rows ([#1156](https://github.com/lobu-ai/lobu/issues/1156)) ([858e8e0](https://github.com/lobu-ai/lobu/commit/858e8e029c3df060dc76ebbc396bff0fba230683))
* **server,cli:** migrate external DATABASE_URL on `lobu run` + honor LOBU_DATA_DIR ([#1154](https://github.com/lobu-ai/lobu/issues/1154)) ([1d7d69f](https://github.com/lobu-ai/lobu/commit/1d7d69f0e0d993a58efce5584be3f3e0e7d52252))
* **server,db:** per-user pending oauth_account uniqueness + clean conflict errors ([#1121](https://github.com/lobu-ai/lobu/issues/1121)) ([8ec3a81](https://github.com/lobu-ai/lobu/commit/8ec3a8193d12a0faa2835a70904a946b459f42b2))
* **server:** clear field-missing errors on query_sdk/run_sdk ([#1131](https://github.com/lobu-ai/lobu/issues/1131)) ([5ef81b8](https://github.com/lobu-ai/lobu/commit/5ef81b8e94817af1344348fa9079dee87dd181ef))
* **server:** repair connections.entity_ids schema drift for query_sql ([#1157](https://github.com/lobu-ai/lobu/issues/1157)) ([4081c0a](https://github.com/lobu-ai/lobu/commit/4081c0a492f250ed69f6aaeb825d7ebed72901ef))
* **watchers,feeds:** guard id-less source queries and cross-org entity_ids ([#1146](https://github.com/lobu-ai/lobu/issues/1146)) ([f04469a](https://github.com/lobu-ai/lobu/commit/f04469af9686a3e7f923ed4fd88d2716f89dd9e4))


### Performance Improvements

* **auth:** don't block signup on the welcome email ([#1163](https://github.com/lobu-ai/lobu/issues/1163)) ([21443c0](https://github.com/lobu-ai/lobu/commit/21443c0e8115656c14b56aceac0e1f441447827b))
* **web:** critical-path XHR cuts + route code-splitting ([#1135](https://github.com/lobu-ai/lobu/issues/1135)) ([9c5a3ce](https://github.com/lobu-ai/lobu/commit/9c5a3ceb3143eee22b0a28e66dbf63432723e0c7))


### Code Refactoring

* **cli:** drop profile-cookie capture from browser-auth ([#1114](https://github.com/lobu-ai/lobu/issues/1114)) ([dea44b1](https://github.com/lobu-ai/lobu/commit/dea44b1a083bb93aaef74585fe51e6a95ece4814))

## [10.2.0](https://github.com/lobu-ai/lobu/compare/lobu-v10.1.0...lobu-v10.2.0) (2026-05-28)


### Features

* **cli:** scaffold AGENTS.md as config-API guide; pure-CLI onboarding prompt; rest-platform validate fix ([#1110](https://github.com/lobu-ai/lobu/issues/1110)) ([25abc9f](https://github.com/lobu-ai/lobu/commit/25abc9feb8d4b06e80b045aea6f916a3a31657f4))
* **examples:** working npm-downloads custom connector for lobu-crm ([#1108](https://github.com/lobu-ai/lobu/issues/1108)) ([2db43f5](https://github.com/lobu-ai/lobu/commit/2db43f5ad2df646ed2a5d59dde6d65af50cba382))
* **landing:** outcome-first homepage, less code up front ([#1112](https://github.com/lobu-ai/lobu/issues/1112)) ([a1b1e4a](https://github.com/lobu-ai/lobu/commit/a1b1e4a5d7436222579d34d06e40020fdc487467))


### Bug Fixes

* **cli:** init --from-org declares only org-owned types, not public/system ([#1111](https://github.com/lobu-ai/lobu/issues/1111)) ([6bc689f](https://github.com/lobu-ai/lobu/commit/6bc689fc6343ebd5e7f6ecf0c4623cd4a3fc7767))
* **cli:** lobu apply falls back to npm when bun is missing ([#1115](https://github.com/lobu-ai/lobu/issues/1115)) ([b077b97](https://github.com/lobu-ai/lobu/commit/b077b97c1b5f7a35c4b1a167403a9db43733c13a))
* **cli:** scaffolded projects validate/run with zero install; slim skill; provider-id align; clean-test-pg target ([#1113](https://github.com/lobu-ai/lobu/issues/1113)) ([d72d49a](https://github.com/lobu-ai/lobu/commit/d72d49af7fed2cc57d969a731aa3408f247f199f))

## [10.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v10.0.0...lobu-v10.1.0) (2026-05-27)


### Features

* **gateway:** accept `/lobu link <code>` as a DM message, not only a slash command ([#1101](https://github.com/lobu-ai/lobu/issues/1101)) ([94d2db4](https://github.com/lobu-ai/lobu/commit/94d2db4d75fa5ed682b8a375a2b773848f957f5c))


### Bug Fixes

* **agent-worker:** force-end the turn after AskUser + cap runaway tool loops ([#1090](https://github.com/lobu-ai/lobu/issues/1090)) ([19e61de](https://github.com/lobu-ai/lobu/commit/19e61deadf50897e3ef814ebe9f5ebb6ae321103))
* **auth:** deliver the session cookie to the Owletto extension iframe (CHIPS) ([#1092](https://github.com/lobu-ai/lobu/issues/1092)) ([f779068](https://github.com/lobu-ai/lobu/commit/f779068bb8b63c027efada6bc84eac7fe7a5c5e1))
* garbled finalText under divergent-final ([#1099](https://github.com/lobu-ai/lobu/issues/1099)) ([5451e1f](https://github.com/lobu-ai/lobu/commit/5451e1f8c43f1fe9bb60c6b22cddfad738fa1f4c))
* **gateway:** hydrate connection on per-connection webhook under multi-replica ([#1098](https://github.com/lobu-ai/lobu/issues/1098)) ([9ce0716](https://github.com/lobu-ai/lobu/commit/9ce07168857f5262995689b187455764feda01a5))
* review follow-ups — AJV deep-traversal DoS guard, snake_case doc label, e2e test rigor ([#1100](https://github.com/lobu-ai/lobu/issues/1100)) ([2668147](https://github.com/lobu-ai/lobu/commit/26681474cc3778c259196e8f045ce9fb0de210bd))

## [10.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v9.4.1...lobu-v10.0.0) (2026-05-26)


### ⚠ BREAKING CHANGES

* **client:** AgentSession.agentId is renamed to conversationId.

### Features

* **client:** @lobu/client v1.1 — refresh(), ask(), typed SSE events, conversationId ([#1055](https://github.com/lobu-ai/lobu/issues/1055)) ([615cca6](https://github.com/lobu-ai/lobu/commit/615cca6d7b20b2fbdcf26c17f39e07260ac3d0b2)), closes [#1032](https://github.com/lobu-ai/lobu/issues/1032)
* **cli:** typed reactionFromFile() + connectorFromFile() for watchers and connectors ([#1082](https://github.com/lobu-ai/lobu/issues/1082)) ([91d2c08](https://github.com/lobu-ai/lobu/commit/91d2c084ae0a5f5f554553f1ecf16cacf029121f))
* **connect:** managed-connector full integration — login-scoped fetch, consent deep-link, local feeds ([#1049](https://github.com/lobu-ai/lobu/issues/1049)) ([6e2a94b](https://github.com/lobu-ai/lobu/commit/6e2a94b59c9f6148e4dc1d7d12ad124585f5a91e))
* **landing:** config-first homepage on a single sales example ([#1076](https://github.com/lobu-ai/lobu/issues/1076)) ([9615eff](https://github.com/lobu-ai/lobu/commit/9615eff24c3029da1d89ea637d8734c2d87ab6bb))
* **reactions:** notify from reactions + repair the bot-delivery path ([#1064](https://github.com/lobu-ai/lobu/issues/1064)) ([2011695](https://github.com/lobu-ai/lobu/commit/20116958537e3e1b836e65f8baa986a5502f177d))
* **server,cli:** auth.md discovery + lobu login --email headless claim ([#1073](https://github.com/lobu-ai/lobu/issues/1073)) ([56fbe94](https://github.com/lobu-ai/lobu/commit/56fbe949e8d47fbe1553bf6cd65c5612d3cefb39))
* **server:** agent account-claim via emailed device authorization ([#1071](https://github.com/lobu-ai/lobu/issues/1071)) ([6889f8f](https://github.com/lobu-ai/lobu/commit/6889f8f1ec5ccb32e75f8b0bb245c88544592234))
* **server:** informed consent for agent user_claimed flow ([#1081](https://github.com/lobu-ai/lobu/issues/1081)) ([48cd6ea](https://github.com/lobu-ai/lobu/commit/48cd6ea456d531e6b7b31bf8430894d7ab7ffa1c))
* **server:** ship watcher current-version prompt in device poll payload ([#1088](https://github.com/lobu-ai/lobu/issues/1088)) ([073cf8d](https://github.com/lobu-ai/lobu/commit/073cf8dc87cadf856c06d93ae9e39edc139e9cbd))
* **server:** tunable per-watcher execution_config for device-worker runs ([#1058](https://github.com/lobu-ai/lobu/issues/1058)) ([9bd5d10](https://github.com/lobu-ai/lobu/commit/9bd5d10a5073d9daaf7e3b2a0e627692d92561d5))


### Bug Fixes

* **agent-worker:** log the failure reason when a worker run fails ([#1078](https://github.com/lobu-ai/lobu/issues/1078)) ([6eb19f4](https://github.com/lobu-ai/lobu/commit/6eb19f4c926b5d838daf35370dfd078e9c52dd87))
* **agent-worker:** strip provider self-prefix AFTER auto-resolution (close gap) ([#1085](https://github.com/lobu-ai/lobu/issues/1085)) ([217367e](https://github.com/lobu-ai/lobu/commit/217367e40db646464e9bea7459a9c0851d423dfb))
* **agent-worker:** strip redundant provider self-prefix from model code ([#1083](https://github.com/lobu-ai/lobu/issues/1083)) ([6aa3e96](https://github.com/lobu-ai/lobu/commit/6aa3e96c1f68533d5d989e12ece695341e615ea6))
* **agent-worker:** worker bash secret leak, SESSION_TIMEOUT UX, dead sandbox-leak redaction ([#1070](https://github.com/lobu-ai/lobu/issues/1070)) ([12ec940](https://github.com/lobu-ai/lobu/commit/12ec9400259b4c1fd396c84b6bdd3a93b3910ea3))
* **cli:** token create honors --context/-c flag ([#1023](https://github.com/lobu-ai/lobu/issues/1023)) ([#1054](https://github.com/lobu-ai/lobu/issues/1054)) ([26efe00](https://github.com/lobu-ai/lobu/commit/26efe00abd41166e617418d66aebd299f368e869))
* **embeddings:** stamp legacy embedding_model + stop liveness probe killing the embeddings service ([#1080](https://github.com/lobu-ai/lobu/issues/1080)) ([b9ba6c9](https://github.com/lobu-ai/lobu/commit/b9ba6c9db4b665eccd99b377fda076999a5f547f))
* **embeddings:** version-stamp embeddings and batch the sync embed path ([#1069](https://github.com/lobu-ai/lobu/issues/1069)) ([e8c354b](https://github.com/lobu-ai/lobu/commit/e8c354bf7fd8ff481041c92078170f4c249fe894))
* **examples:** use valid event kinds in lobu-crm reactions ([#1072](https://github.com/lobu-ai/lobu/issues/1072)) ([a680342](https://github.com/lobu-ai/lobu/commit/a68034281f143c0ad3e445837c9715bf50bf5a22))
* four small confirmed findings (token timing, apply provider keys, worker probes, dead AsyncLock) ([#1066](https://github.com/lobu-ai/lobu/issues/1066)) ([96a6df7](https://github.com/lobu-ai/lobu/commit/96a6df706f2cf303ff706a189b775ba4e7eb40ab))
* **gateway:** deliver Slack reply from worker finalText under multi-replica ([#1087](https://github.com/lobu-ai/lobu/issues/1087)) ([6741aed](https://github.com/lobu-ai/lobu/commit/6741aed2b88e37097fdf1b1492d9c53a71b809a5))
* **server:** orchestration cleanup — dead dischargeTurn + cross-pod spawn gate ([#1068](https://github.com/lobu-ai/lobu/issues/1068)) ([7bf6d8a](https://github.com/lobu-ai/lobu/commit/7bf6d8afb27fb8e88b3f7b0ad89dc69313564012))
* **server:** resolve Slack OAuth/preview config from env, not pod-local instance ([#1065](https://github.com/lobu-ai/lobu/issues/1065)) ([56b6cff](https://github.com/lobu-ai/lobu/commit/56b6cffe32fcd1fc7432f9faaaf1981a4bd68df3))
* **server:** watcher device-pin authz + table-schema drift test runs in CI ([#1062](https://github.com/lobu-ai/lobu/issues/1062)) ([75c52a0](https://github.com/lobu-ai/lobu/commit/75c52a02b22e192fa3bc11fc506638cf28bc0c9c))

## [9.4.1](https://github.com/lobu-ai/lobu/compare/lobu-v9.4.0...lobu-v9.4.1) (2026-05-25)


### Bug Fixes

* **chart+metrics:** ServiceMonitor path /lobu/metrics + rename label job→task ([#1053](https://github.com/lobu-ai/lobu/issues/1053)) ([a5c3de6](https://github.com/lobu-ai/lobu/commit/a5c3de6d713d4d14a3ef31faddd17ffa22882a64))

## [9.4.0](https://github.com/lobu-ai/lobu/compare/lobu-v9.3.0...lobu-v9.4.0) (2026-05-25)


### Features

* **agent-worker:** support before_tool_call/after_tool_call plugin hooks ([#1036](https://github.com/lobu-ai/lobu/issues/1036)) ([846d173](https://github.com/lobu-ai/lobu/commit/846d173943d14b1b4c6e4aba875ef97941d7fca9)), closes [#1022](https://github.com/lobu-ai/lobu/issues/1022)
* **cli:** inline skills via defineSkill/skillFromFile; drop dir auto-discovery ([#1039](https://github.com/lobu-ai/lobu/issues/1039)) ([5e488ce](https://github.com/lobu-ai/lobu/commit/5e488ce5e52366263e421c3c9c019860b98cef51))
* **connect:** managed connectors via public org — cloud auth, local data ([#1038](https://github.com/lobu-ai/lobu/issues/1038)) ([cae142a](https://github.com/lobu-ai/lobu/commit/cae142a32adc71aeb6c31d485ba8ae6fc933b26b))
* **server:** watcher/scheduler health metrics + ServiceMonitor/PrometheusRule ([#1047](https://github.com/lobu-ai/lobu/issues/1047)) ([60c6e73](https://github.com/lobu-ai/lobu/commit/60c6e73618c4ef0ba15918e24111f72723de6377))


### Bug Fixes

* **ci:** migrate sdk-e2e fixture to connectorFromFile ([#1043](https://github.com/lobu-ai/lobu/issues/1043) dropped ./connectors scan) ([#1048](https://github.com/lobu-ai/lobu/issues/1048)) ([d8454a9](https://github.com/lobu-ai/lobu/commit/d8454a983a8d0275cf522b683f76bf056fb31885))
* **cli:** doctor recognizes embedded file:// Postgres; quiet bundled-SPA Vite log ([#1033](https://github.com/lobu-ai/lobu/issues/1033)) ([0b53bd9](https://github.com/lobu-ai/lobu/commit/0b53bd92987134d9fc24970b85492bb2dc11961d))
* **release:** pass --manual-override-reason to ClawHub publish ([#1030](https://github.com/lobu-ai/lobu/issues/1030)) ([1e9fe29](https://github.com/lobu-ai/lobu/commit/1e9fe290f462476fb8b80eb1b1840c21584d1899))
* **server:** unwedge watchers (array-binding bug) + hardening ([#1046](https://github.com/lobu-ai/lobu/issues/1046)) ([c524b42](https://github.com/lobu-ai/lobu/commit/c524b428806a787d121002b05443aa8c8fc81cf0))
* **test:** ephemeral embedded backend uses a lobu_test database ([#1050](https://github.com/lobu-ai/lobu/issues/1050)) ([2be43e0](https://github.com/lobu-ai/lobu/commit/2be43e0f431deff5fd8e217b00e367b74ba8a43a))
* **worker:** copy packages/core into worker runtime image ([#1035](https://github.com/lobu-ai/lobu/issues/1035)) ([3d9175c](https://github.com/lobu-ai/lobu/commit/3d9175c558ee413d40e49eaf0b65fc08900a886d))

## [9.3.0](https://github.com/lobu-ai/lobu/compare/lobu-v9.2.0...lobu-v9.3.0) (2026-05-24)


### Features

* **cli:** fold @lobu/sdk into @lobu/cli/config ([#1026](https://github.com/lobu-ai/lobu/issues/1026)) ([06f3432](https://github.com/lobu-ai/lobu/commit/06f3432f4b0fb98693a93ef4982528950d298f2d))

## [9.2.0](https://github.com/lobu-ai/lobu/compare/lobu-v9.1.1...lobu-v9.2.0) (2026-05-23)


### Features

* **auth:** local sign-in passcode + /api/local-passcode (web/mac rework) ([#999](https://github.com/lobu-ai/lobu/issues/999)) ([7799c21](https://github.com/lobu-ai/lobu/commit/7799c211ba59a111292e913f6e03095ee18c731d))
* **client:** add TypeScript SDK ([#1015](https://github.com/lobu-ai/lobu/issues/1015)) ([3993aad](https://github.com/lobu-ai/lobu/commit/3993aad2b29ed806553f0fd9dd26e4e8d4c25099))


### Bug Fixes

* **cli:** honor local context for memory and token auth ([#1011](https://github.com/lobu-ai/lobu/issues/1011)) ([176a3f1](https://github.com/lobu-ai/lobu/commit/176a3f13ecb1b566a80b87e526e9fb665707dc76)), closes [#1008](https://github.com/lobu-ai/lobu/issues/1008)
* **cli:** warn when apply ignores connectors ([#1010](https://github.com/lobu-ai/lobu/issues/1010)) ([0b145cd](https://github.com/lobu-ai/lobu/commit/0b145cda338fcc535525cb6762061349b4186d77)), closes [#1009](https://github.com/lobu-ai/lobu/issues/1009)
* **connectors:** serve catalog from a build-time manifest, stop cold-scan 503s ([#1013](https://github.com/lobu-ai/lobu/issues/1013)) ([4e5db74](https://github.com/lobu-ai/lobu/commit/4e5db742b4fe49c885058b0b9c6f1f63ea0f81ea))
* **server:** heartbeat-aware reaping for orphaned watcher runs ([#1020](https://github.com/lobu-ai/lobu/issues/1020)) ([a0a15b9](https://github.com/lobu-ai/lobu/commit/a0a15b91fc03b6b4dab08fe41d52a3d33ae003c5))
* **server:** register local device-worker capabilities even when poll is anonymous ([#1017](https://github.com/lobu-ai/lobu/issues/1017)) ([463a5a4](https://github.com/lobu-ai/lobu/commit/463a5a4b688e84228659006c25bc713136899d5e))

## [9.1.1](https://github.com/lobu-ai/lobu/compare/lobu-v9.1.0...lobu-v9.1.1) (2026-05-21)


### Bug Fixes

* **cli:** build pgvector-embedded in the publish chain so it vendors into the tarball ([#1003](https://github.com/lobu-ai/lobu/issues/1003)) ([850e21a](https://github.com/lobu-ai/lobu/commit/850e21adaee4ae3f5575a5d6b9ef314b45ea8d91))

## [9.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v9.0.0...lobu-v9.1.0) (2026-05-21)


### Bug Fixes

* **cli:** vendor private @lobu/pgvector-embedded into the CLI tarball ([#1000](https://github.com/lobu-ai/lobu/issues/1000)) ([d8634e0](https://github.com/lobu-ai/lobu/commit/d8634e0998045d88d2fec359dfbb023443500951))

## [9.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v8.0.0...lobu-v9.0.0) (2026-05-21)


### ⚠ BREAKING CHANGES

* **server:** the local `lobu run` / test database engine is now a real embedded PostgreSQL instead of PGlite. Existing ~/.lobu PGlite data dirs are not migrated — a fresh embedded PG cluster is created. Production (external Postgres via DATABASE_URL) is unchanged.

### Features

* **cli:** flatten Lobu context config ([#955](https://github.com/lobu-ai/lobu/issues/955)) ([50dd706](https://github.com/lobu-ai/lobu/commit/50dd706d736af268dffed8b1c92c33ac3e2d093b))
* **cli:** lobu call — generic dispatcher over admin REST tools ([#938](https://github.com/lobu-ai/lobu/issues/938)) ([17f0da9](https://github.com/lobu-ai/lobu/commit/17f0da929293444d6393770ba0e13398cd263b52))
* **cli:** ship the owletto web UI bundle in lobu run ([#985](https://github.com/lobu-ai/lobu/issues/985)) ([2439747](https://github.com/lobu-ai/lobu/commit/2439747c7ee2269f92d59e49930e337d56ae3ab3))
* **connectors:** user-declared connector dependencies (npm bundled + nix native) ([#973](https://github.com/lobu-ai/lobu/issues/973)) ([ac2ddbd](https://github.com/lobu-ai/lobu/commit/ac2ddbd5a379ee1f6808fa8db57d9bc533adcbf4))
* **landing:** dev-focused rebuild — pinned examples, animated architecture, real cast ([#945](https://github.com/lobu-ai/lobu/issues/945)) ([8695c57](https://github.com/lobu-ai/lobu/commit/8695c57c51c917b830412571265becd1b0300a37))
* **landing:** per-use-case snippet tabs, connector logo wall, drop asciinema, simplify nav ([#988](https://github.com/lobu-ai/lobu/issues/988)) ([ca889c6](https://github.com/lobu-ai/lobu/commit/ca889c6242429ed4c9fb84c9946ce64cca1c6ceb))
* local review tool (make review) — shadow-mode multi-axis verdict ([#942](https://github.com/lobu-ai/lobu/issues/942)) ([dfb4958](https://github.com/lobu-ai/lobu/commit/dfb4958f0ee31a5a5cabcf2ea55aa657c9f5e1a5))
* **server:** generalize list_runs for connection/device/feed run tables ([#963](https://github.com/lobu-ai/lobu/issues/963)) ([68cefde](https://github.com/lobu-ai/lobu/commit/68cefde3404238af906d0e7fc3362c1e036c2208))
* **server:** PGlite-mode parity with Postgres for Agent API ([#940](https://github.com/lobu-ai/lobu/issues/940)) ([cb2a6f1](https://github.com/lobu-ai/lobu/commit/cb2a6f1cf5fd797e03f3174d07fb274ecf831d1a))
* **server:** replace PGlite with embedded Postgres; bundle pgvector; earthdistance geo ([#965](https://github.com/lobu-ai/lobu/issues/965)) ([7793c56](https://github.com/lobu-ai/lobu/commit/7793c5605d7cb223983e3f161c69b425741916d4))


### Bug Fixes

* **auth:** unwedge PGlite sign-up by routing single-user guard through the transaction adapter ([#952](https://github.com/lobu-ai/lobu/issues/952)) ([521e6f7](https://github.com/lobu-ai/lobu/commit/521e6f7eee31e89059f987cf673a496ee2188f63))
* **ci:** expose ClawHub token flag to login step ([03160db](https://github.com/lobu-ai/lobu/commit/03160db2d101c8f7522b8f5c47a371b09d8abffc)), closes [#953](https://github.com/lobu-ai/lobu/issues/953)
* **cli/server:** zero-to-chat local-dev flow works without --org or browser sign-in ([#944](https://github.com/lobu-ai/lobu/issues/944)) ([e6f201b](https://github.com/lobu-ai/lobu/commit/e6f201b98191607881f614b3e6dfa868bd1dbc0c))
* **gateway:** surface worker failures to chat clients as terminal errors ([#946](https://github.com/lobu-ai/lobu/issues/946)) ([#971](https://github.com/lobu-ai/lobu/issues/971)) ([c8553c1](https://github.com/lobu-ai/lobu/commit/c8553c1a57fbb86beb95e354ae99da04c4282965))
* getting-started reliability (openrouter model routing + run auto-apply) ([#987](https://github.com/lobu-ai/lobu/issues/987)) ([86b3f17](https://github.com/lobu-ai/lobu/commit/86b3f17b4100d2f6a099dd2144e265350e795a8f))
* prevent prod data wipe — non-destructive baseline down + test-DB guard ([#989](https://github.com/lobu-ai/lobu/issues/989)) ([df38fbf](https://github.com/lobu-ai/lobu/commit/df38fbf48b34ee7e73fe30d4705ec0cdb6aac6af))
* **providers:** reliable routing for all config-driven LLM providers ([#992](https://github.com/lobu-ai/lobu/issues/992)) ([ada2219](https://github.com/lobu-ai/lobu/commit/ada2219767c32a356e3113f39e6ff5041a4c962b))
* remove redundant getDb dynamic imports and fix $member entity FK violation ([#957](https://github.com/lobu-ai/lobu/issues/957) [#956](https://github.com/lobu-ai/lobu/issues/956)) ([#959](https://github.com/lobu-ai/lobu/issues/959)) ([9e61edd](https://github.com/lobu-ai/lobu/commit/9e61eddc5eda1d87dda8251ccdec92149b9b46ce))
* **server:** apply takes effect without lobu run restart ([#993](https://github.com/lobu-ai/lobu/issues/993)) ([3012104](https://github.com/lobu-ai/lobu/commit/301210475c57916fb821708547d942d00f8865af))
* **start-local:** close 7 PGlite/Postgres parity-hygiene risks ([#943](https://github.com/lobu-ai/lobu/issues/943)) ([e80f0c2](https://github.com/lobu-ai/lobu/commit/e80f0c2ad1a166a1ae7db2260d93c8de35ce2ffa))
* **test:** tolerate non-owner of schema public in setupTestDatabase ([#961](https://github.com/lobu-ai/lobu/issues/961)) ([1600bc4](https://github.com/lobu-ai/lobu/commit/1600bc461ed3b958e7cd3f31c49b4af61327c475))

## [8.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v7.2.0...lobu-v8.0.0) (2026-05-19)


### ⚠ BREAKING CHANGES

* **core:** drop unused module-lifecycle public types; consolidate wire + session-file utilities ([#930](https://github.com/lobu-ai/lobu/issues/930))
* **evals:** The in-house `lobu eval` command and YAML eval schema are removed. Migrate evals to promptfoo + @lobu/promptfoo-provider; see examples/personal-finance/evals/promptfooconfig.yaml for the new pattern.

### Features

* **auth:** install_operator bootstrap — unblock headless installs ([#923](https://github.com/lobu-ai/lobu/issues/923)) ([2a903fd](https://github.com/lobu-ai/lobu/commit/2a903fd99ddc41a2fe6a864c33806fe674e53f5e))
* **connector-sdk:** FileSystemSource primitive for filesystem-shape ingestion ([#933](https://github.com/lobu-ai/lobu/issues/933)) ([7cced39](https://github.com/lobu-ai/lobu/commit/7cced3953f977d0787acda30d8bd03cd923362e7))
* **core:** drop unused module-lifecycle public types; consolidate wire + session-file utilities ([#930](https://github.com/lobu-ai/lobu/issues/930)) ([27fbece](https://github.com/lobu-ai/lobu/commit/27fbeceaa9792ecf8aa01eba4c3d5b91b5083518))
* **evals:** drop in-house YAML runner, ship @lobu/promptfoo-provider ([#911](https://github.com/lobu-ai/lobu/issues/911)) ([f8f087b](https://github.com/lobu-ai/lobu/commit/f8f087bca8f503f12158ff5fd6ece7739021fb6d))
* **gateway:** tool_use SSE events for client-side trace inspection ([#918](https://github.com/lobu-ai/lobu/issues/918)) ([dcb5b1d](https://github.com/lobu-ai/lobu/commit/dcb5b1d8ba6ac7b76ec108156d260740540fd8b7))
* guardrails schema extensions + judge engine + pii-scan ([#915](https://github.com/lobu-ai/lobu/issues/915)) ([ef48a3d](https://github.com/lobu-ai/lobu/commit/ef48a3dbc0c8ccd0c2690d3b1ced5a787c35c8f2))
* local-first polish — magic-link gating, task-use bug, no_user_yet route + SPA copy ([#909](https://github.com/lobu-ai/lobu/issues/909)) ([125fb6b](https://github.com/lobu-ai/lobu/commit/125fb6b5faaf7ebd9bf288d7104ae94983699551))
* make bump shortcut + "main checkout read-only" doctrine ([#928](https://github.com/lobu-ai/lobu/issues/928)) ([57cd312](https://github.com/lobu-ai/lobu/commit/57cd3123faec5c1c5db416ae0a05bfefcc9c6aff))
* passkey (WebAuthn) auth + auth-config flags for local-mode routing ([#905](https://github.com/lobu-ai/lobu/issues/905)) ([54de2e0](https://github.com/lobu-ai/lobu/commit/54de2e0d365f8de22fbf564f0c43c6272583ea8a))
* **promptfoo-provider:** vars.transcript multi-turn + migrate 4 personal-finance evals ([#913](https://github.com/lobu-ai/lobu/issues/913)) ([69151a9](https://github.com/lobu-ai/lobu/commit/69151a9d98013cf4bb85e5cad825c3d87ce7e3b1))
* **promptfoo-provider:** vars.transcript multi-turn + migrate 4 personal-finance evals ([#921](https://github.com/lobu-ai/lobu/issues/921)) ([9453f37](https://github.com/lobu-ai/lobu/commit/9453f3747a250d91faa2e3f0ce9da3b8cd996a6e))
* **server,chrome-ext:** mint session_token alongside child PAT for native auto-pair ([#896](https://github.com/lobu-ai/lobu/issues/896)) ([a675eeb](https://github.com/lobu-ai/lobu/commit/a675eeb233b3416812fd68731b66dfb94fde5af8))
* **server:** drop bootstrap-user, first /sign-up becomes the install's identity ([#902](https://github.com/lobu-ai/lobu/issues/902)) ([f6522b3](https://github.com/lobu-ai/lobu/commit/f6522b3923cb025831d4715658159713c39775b8))
* **server:** local-first identity + single-user mode for bootstrap ([#898](https://github.com/lobu-ai/lobu/issues/898)) ([aa5a71f](https://github.com/lobu-ai/lobu/commit/aa5a71f7c5595cf510757de5c76c439ec9a65cc5))
* wire guardrails runtime end-to-end + secret-scan and forbidden-tools built-ins ([#919](https://github.com/lobu-ai/lobu/issues/919)) ([a66c00d](https://github.com/lobu-ai/lobu/commit/a66c00d3a61a3c0e9d5e31114d4c44e522702b73))


### Bug Fixes

* **build:** drop examples/personal-finance from root workspaces — unblock image builds ([#927](https://github.com/lobu-ai/lobu/issues/927)) ([8932729](https://github.com/lobu-ai/lobu/commit/89327292eace0e477f49f90726240d489f2b2296))
* **cli:** task-setup resolves repo via git-common-dir, not script cwd ([#899](https://github.com/lobu-ai/lobu/issues/899)) ([8e26abd](https://github.com/lobu-ai/lobu/commit/8e26abd691e4d729d7eaecf71da63eaa7cfad100))
* **cli:** task-setup uses --path-format=absolute for git-common-dir ([#900](https://github.com/lobu-ai/lobu/issues/900)) ([f200751](https://github.com/lobu-ai/lobu/commit/f200751c5dbcbc97246e3b561bfcae96b6bc5cd7))
* **sync:** wire embedded feed-sync executor + workers/poll RangeError ([#929](https://github.com/lobu-ai/lobu/issues/929)) ([9b1d40b](https://github.com/lobu-ai/lobu/commit/9b1d40b2776dc045c163af5b779f89d28b0fd50f))

## [7.2.0](https://github.com/lobu-ai/lobu/compare/lobu-v7.1.0...lobu-v7.2.0) (2026-05-18)


### Features

* **chart:** real-worker smoke test gates Helm upgrades on actual run completion ([#878](https://github.com/lobu-ai/lobu/issues/878)) ([48ee1ed](https://github.com/lobu-ai/lobu/commit/48ee1ed23b3190c694e945556255bc4fc5d4efbe))
* **cli,server:** LOBU_CONTEXT + lifecycle tag, bump owletto submodule ([#889](https://github.com/lobu-ai/lobu/issues/889)) ([137d8fe](https://github.com/lobu-ai/lobu/commit/137d8fea2de847f500e1f382d06b65f6d7442b52))
* **cli:** task-setup.sh + per-worktree context registration ([#891](https://github.com/lobu-ai/lobu/issues/891)) ([a8e4a35](https://github.com/lobu-ai/lobu/commit/a8e4a358ada6aeb697e3d82bd83a32947e4c6335))
* **connector-worker,server:** heartbeat action+embed_backfill, atomic reaper retries ([#893](https://github.com/lobu-ai/lobu/issues/893)) ([568f989](https://github.com/lobu-ai/lobu/commit/568f9892e52f2673eb9c81852333dd95d913d4e9))
* **connectors:** chrome connector — tool dispatcher v1 ([#872](https://github.com/lobu-ai/lobu/issues/872)) ([6b2a32b](https://github.com/lobu-ai/lobu/commit/6b2a32b40ab716306e740d5f3420970d6d3d025e))
* **mac-release:** auto-fire on release-please published releases ([#895](https://github.com/lobu-ai/lobu/issues/895)) ([4c16f1b](https://github.com/lobu-ai/lobu/commit/4c16f1b46ee8027d8d59b6527d7ec051e93d2643))
* **mac-release:** Developer ID signing + Owletto rebrand + submodule bump ([#894](https://github.com/lobu-ai/lobu/issues/894)) ([d3591b1](https://github.com/lobu-ai/lobu/commit/d3591b1b8c42735bc03c4d2609634da576de04ad))
* **operations:** async device-action scheduling for chrome / device-bound connectors ([#879](https://github.com/lobu-ai/lobu/issues/879)) ([c3d7aad](https://github.com/lobu-ai/lobu/commit/c3d7aad4a26a2cb005c987f947074338379267db))
* **server,chart:** flip snapshot default + drop workspaces PVC (Phase 5) ([#871](https://github.com/lobu-ai/lobu/issues/871)) ([9484be3](https://github.com/lobu-ai/lobu/commit/9484be39ed2cbc31a9688ac2a99cd92676081ebb))
* **server:** broaden CSP frame-ancestors to allow owletto extension to embed the whole app ([#884](https://github.com/lobu-ai/lobu/issues/884)) ([458f37e](https://github.com/lobu-ai/lobu/commit/458f37eab898efc09c1b76e9ed2c1c9773e9d954))
* **worker:** PG-backed agent_transcript_snapshot (multi-replica unblock) ([#865](https://github.com/lobu-ai/lobu/issues/865)) ([8d1beee](https://github.com/lobu-ai/lobu/commit/8d1beeedd3540baef99237079536cc951fc9075f))


### Bug Fixes

* **agent-worker:** propagate runId + runJobToken through JobEventSchema ([#874](https://github.com/lobu-ai/lobu/issues/874)) ([d6b3b68](https://github.com/lobu-ai/lobu/commit/d6b3b68c80092cf53f86088ae9f26136963ee6ad))
* **reaper:** narrow stale-run reaper to lanes that actually heartbeat (sync + auth) ([#859](https://github.com/lobu-ai/lobu/issues/859)) ([cc4dbe3](https://github.com/lobu-ai/lobu/commit/cc4dbe36632728e64559d4cdfaec9ef67e8eb46a))
* **server:** close SSE bridge registration-order races + wire abort into MCP heartbeat ([#864](https://github.com/lobu-ai/lobu/issues/864)) ([110c046](https://github.com/lobu-ai/lobu/commit/110c0461d1dce6e105590f269fafff8c93c09e2c))
* **server:** handle action_input JSONB-string shape + write JSONB objects for new runs ([#877](https://github.com/lobu-ai/lobu/issues/877)) ([683481c](https://github.com/lobu-ai/lobu/commit/683481c654b8ba5a99f4cfc5cabe434c667b8470))
* **server:** inject organizationId from worker token onto worker-response payloads (4th writer) ([#888](https://github.com/lobu-ai/lobu/issues/888)) ([cd31882](https://github.com/lobu-ai/lobu/commit/cd3188231ce67a01ca22476e531f6173ad1e97db))
* **server:** pass organizationId on continuation chat_message enqueues ([#887](https://github.com/lobu-ai/lobu/issues/887)) ([7cfeac6](https://github.com/lobu-ai/lobu/commit/7cfeac6c5f7302a6a160deba64cb2ee43e11852b))
* **server:** post-review cleanup of multi-tenant isolation + pending interactions ([#867](https://github.com/lobu-ai/lobu/issues/867)) ([907bdd8](https://github.com/lobu-ai/lobu/commit/907bdd88411fe6d515413b629627bf66b9c7dd0d))
* **server:** restore organization_id INSERT in runs-queue ([#883](https://github.com/lobu-ai/lobu/issues/883)) ([0c32c18](https://github.com/lobu-ai/lobu/commit/0c32c1816d8def0063117ff8258a86f4df8386e1))
* **server:** wrap connection-boot secret resolution in orgContext to fix Slack ([#881](https://github.com/lobu-ai/lobu/issues/881)) ([ad75eb9](https://github.com/lobu-ai/lobu/commit/ad75eb9fc138ce0935b917165e2edd3483fdbe65))


### Performance Improvements

* **server:** denormalize runs.agent_id+conversation_id + reserve-connection cap ([#870](https://github.com/lobu-ai/lobu/issues/870)) ([d4691a7](https://github.com/lobu-ai/lobu/commit/d4691a73a7678e7c2555e01ea315a4b9a0b1d37e))

## [7.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v7.0.0...lobu-v7.1.0) (2026-05-18)


### Features

* **apply:** org-shared provider keys end-to-end ([#740](https://github.com/lobu-ai/lobu/issues/740)) ([1da480d](https://github.com/lobu-ai/lobu/commit/1da480d0234166e1f7e6457bf5cf88111fc2ca9d))
* **apply:** watcher admin-only fields + lobu export + examples roll-out ([#829](https://github.com/lobu-ai/lobu/issues/829)) ([d43df65](https://github.com/lobu-ai/lobu/commit/d43df658e85625bdd449c4e8f2fa44d3ce5fd918))
* **auth-profiles:** admin-pinned default app profile per connector ([#764](https://github.com/lobu-ai/lobu/issues/764)) ([71e9b0f](https://github.com/lobu-ai/lobu/commit/71e9b0f0b86d8f374aee525e7b134b470f881fbe))
* **auth:** cookie pivot — drop bootstrap-pat.txt, add /api/auth/local-init ([#830](https://github.com/lobu-ai/lobu/issues/830)) ([9b842cd](https://github.com/lobu-ai/lobu/commit/9b842cdf5f2acf35db81f9a38b0281f03e355298))
* **chart:** auto-pick RollingUpdate when workspaces is RWX ([#776](https://github.com/lobu-ai/lobu/issues/776)) ([e98e1ea](https://github.com/lobu-ai/lobu/commit/e98e1eab1464a2da77464927344657316c1fd6d3))
* **chart:** expose service.sessionAffinity for multi-replica SSE stickiness ([#848](https://github.com/lobu-ai/lobu/issues/848)) ([7fc36dc](https://github.com/lobu-ai/lobu/commit/7fc36dcabe104e7521dc5065d84e5e883ff3d8c6))
* **chrome-extension:** MV3 connector with auto-pair via Mac native messaging ([#773](https://github.com/lobu-ai/lobu/issues/773)) ([9d06663](https://github.com/lobu-ai/lobu/commit/9d06663fd03b34c4164e9b3099638692ba592a1c))
* **connections:** action_modes tri-state — disabled / approval / auto ([#727](https://github.com/lobu-ai/lobu/issues/727)) ([7fe865e](https://github.com/lobu-ai/lobu/commit/7fe865ee083a01efed9bafed77a66d505864ae9a))
* **connectors:** browser.evaluate connector + owletto submodule bump ([#828](https://github.com/lobu-ai/lobu/issues/828)) ([d159443](https://github.com/lobu-ai/lobu/commit/d159443fad30e8426d30fbb946d65b884612e086))
* **geo:** server-side reverse-geocoding via PostGIS + GeoNames ([#738](https://github.com/lobu-ai/lobu/issues/738)) ([0dc0973](https://github.com/lobu-ai/lobu/commit/0dc097374334249593db70ca71041a4c7087eb6d))
* **infra:** postgis-enabled CNPG Postgres image for geo enrichment ([#749](https://github.com/lobu-ai/lobu/issues/749)) ([bc721e5](https://github.com/lobu-ai/lobu/commit/bc721e548428d074949296c11e5dd447296875df))
* **knowledge:** filter content by feed_ids / run_ids / connection_ids ([#722](https://github.com/lobu-ai/lobu/issues/722)) ([584a6af](https://github.com/lobu-ai/lobu/commit/584a6af2d96d1309478558f276f9392ce3d32f0a))
* **landing:** product-named stage tabs + copy-prompt CTA + audit follow-ups ([#743](https://github.com/lobu-ai/lobu/issues/743)) ([fe896ea](https://github.com/lobu-ai/lobu/commit/fe896eaa3b332381a528a961f9e8985c79c6702a))
* **landing:** rebuild hero preview to v2 + simplify sections ([#737](https://github.com/lobu-ai/lobu/issues/737)) ([cf392f7](https://github.com/lobu-ai/lobu/commit/cf392f7d754ba56468da508c3abbcf0e52368537))
* **lifecycle:** emit device + member create/delete events ([#757](https://github.com/lobu-ai/lobu/issues/757)) ([ca31cca](https://github.com/lobu-ai/lobu/commit/ca31cca4242b1360aa6505a4b4ebc48d483fe057))
* **lifecycle:** MCP-client emitter + strict typecheck Makefile target ([#761](https://github.com/lobu-ai/lobu/issues/761)) ([31ef33f](https://github.com/lobu-ai/lobu/commit/31ef33f33894e9d38ba6abf0948c9d215d61cf1e))
* lobu connector run + mirror-mode browser auth (no managed Chrome) ([#725](https://github.com/lobu-ai/lobu/issues/725)) ([10ef310](https://github.com/lobu-ai/lobu/commit/10ef31052b4f8ac2d3ffdb4a93eee248af1e5354))
* **local-server:** persist DATABASE_URL/PORT/HOST/dataDir in user config ([#839](https://github.com/lobu-ai/lobu/issues/839)) ([8102b9e](https://github.com/lobu-ai/lobu/commit/8102b9e914dddb1fd15db3eef0919676752a3add))
* **mac:** collapse Chrome profile rows behind a disclosure ([#736](https://github.com/lobu-ai/lobu/issues/736)) ([6eef3df](https://github.com/lobu-ai/lobu/commit/6eef3df0d570f5c62cc6cccdad0d8000ce962299))
* **mac:** menu bar connector overhaul + inline sign-in card ([#774](https://github.com/lobu-ai/lobu/issues/774)) ([3f1379c](https://github.com/lobu-ai/lobu/commit/3f1379c48e08117ea1da4cb238c0c7bb4688bbbe))
* **metric_series:** events-sourced stat trends + lifecycle emitters ([#756](https://github.com/lobu-ai/lobu/issues/756)) ([26253b9](https://github.com/lobu-ai/lobu/commit/26253b9912eee29fc308c1d9da5602d810e26c10))
* **photos:** apple.photos via Mac app; drop google_photos ([#732](https://github.com/lobu-ai/lobu/issues/732)) ([4a6f257](https://github.com/lobu-ai/lobu/commit/4a6f2570e7580f94ff7e98f089f16a97a59967c0))
* **schema:** goals primitive — top-level handle for watcher hierarchy ([#813](https://github.com/lobu-ai/lobu/issues/813)) ([70e2b6e](https://github.com/lobu-ai/lobu/commit/70e2b6e87f0fa879969e5030584f775099c6ba0c))
* **schema:** per-org agent id PK — close two-orgs-same-id footgun ([#750](https://github.com/lobu-ai/lobu/issues/750)) ([e4f15b9](https://github.com/lobu-ai/lobu/commit/e4f15b967740b3b70394273c5b4758b82b6a17ff))
* **schema:** watchers — device_worker_id, agent_kind, notification, cooldown columns ([#811](https://github.com/lobu-ai/lobu/issues/811)) ([76aaf2d](https://github.com/lobu-ai/lobu/commit/76aaf2dd6c298eebdca69d3b59d1549e00dcea64)), closes [#799](https://github.com/lobu-ai/lobu/issues/799)
* **server,mac:** no-auth mode for embedded server (LOBU_NO_AUTH=1) ([#779](https://github.com/lobu-ai/lobu/issues/779)) ([a3e6f0a](https://github.com/lobu-ai/lobu/commit/a3e6f0af1cc927157f8a90fd1ba24b6369a3a93f))
* **server:** auto-provision default agent + watcher; add manual-trigger endpoint ([#824](https://github.com/lobu-ai/lobu/issues/824)) ([53e9ddd](https://github.com/lobu-ai/lobu/commit/53e9ddd1a100115266528bb1c149a27c1df129dd))
* **theme:** apply tweakcn "Retro" to landing + web ([#751](https://github.com/lobu-ai/lobu/issues/751)) ([139b1b6](https://github.com/lobu-ai/lobu/commit/139b1b614449ea889d82d726f7dc2f3725178472))
* **watchers:** device-pinned watcher runs end-to-end ([#798](https://github.com/lobu-ai/lobu/issues/798) PR-1) ([#814](https://github.com/lobu-ai/lobu/issues/814)) ([2ffccfb](https://github.com/lobu-ai/lobu/commit/2ffccfbd257e9462221ff980a418938dcdda9d9e))
* **web:** sidebar UX pass — tooltips, inline loading, members link, dedicated client routes ([#723](https://github.com/lobu-ai/lobu/issues/723)) ([013fe8d](https://github.com/lobu-ai/lobu/commit/013fe8d5336c4ef01787b578cbbc038188c086c7))
* **web:** swap bare Loading… text for skeleton placeholders ([#786](https://github.com/lobu-ai/lobu/issues/786)) ([592d497](https://github.com/lobu-ai/lobu/commit/592d4974479ea81622011269e93d7c4c348dec63))
* **web:** UX sweep — unified landings, /connectors rename, skeleton loading ([#726](https://github.com/lobu-ai/lobu/issues/726)) ([52f477e](https://github.com/lobu-ai/lobu/commit/52f477e26b2bc77632f874bdc78f2cbe7cfe2fe4))


### Bug Fixes

* **agent-worker:** guard against null assistantMessageEvent in OpenClawProgressProcessor ([#841](https://github.com/lobu-ai/lobu/issues/841)) ([8a42a53](https://github.com/lobu-ai/lobu/commit/8a42a53febcb686a849323ff56d049beb5b57321)), closes [#691](https://github.com/lobu-ai/lobu/issues/691)
* **apply, chat, gateway:** three bugs in the org-shared-provider-keys flow ([#746](https://github.com/lobu-ai/lobu/issues/746)) ([f563f17](https://github.com/lobu-ai/lobu/commit/f563f17b130d7cb27115f79bad86ede13977ef41))
* **apply:** surface config path, auto-load .env, schema-prep for per-org agent IDs ([#734](https://github.com/lobu-ai/lobu/issues/734)) ([73eba79](https://github.com/lobu-ai/lobu/commit/73eba79ad7fcde4d72eb03755a270408ee0d9603))
* **auth-profiles:** bound agentOwner / agentOrg caches at 1024 entries ([#855](https://github.com/lobu-ai/lobu/issues/855)) ([7b0c819](https://github.com/lobu-ai/lobu/commit/7b0c819b2879a77c25d5dcb383d1a744e639394d))
* **ci:** cap DB_POOL_MAX=5 in the integration job ([#805](https://github.com/lobu-ai/lobu/issues/805)) ([32920c8](https://github.com/lobu-ai/lobu/commit/32920c821ae6ec36103a092d08c8b4c587b16acd))
* **cli:** connector run uses agent API origin, not memory MCP URL ([#730](https://github.com/lobu-ai/lobu/issues/730)) ([52414d1](https://github.com/lobu-ai/lobu/commit/52414d11b9f8781e81447140eea19d534bf4e20b))
* close monitoring + deploy gaps from post-incident audit ([#775](https://github.com/lobu-ai/lobu/issues/775)) ([bdea9d5](https://github.com/lobu-ai/lobu/commit/bdea9d5cab4be8471898bb510fcc176aa89fce09))
* **connections:** admin-gate app profile updates + member account-profile rebind UI ([#812](https://github.com/lobu-ai/lobu/issues/812)) ([54ee582](https://github.com/lobu-ai/lobu/commit/54ee5828937b42a104eae0f1caadfa8ed7dc91e0))
* **connector-sdk:** use vanilla Playwright for CDP attach ([#731](https://github.com/lobu-ai/lobu/issues/731)) ([d057f95](https://github.com/lobu-ai/lobu/commit/d057f9522bd15aa0f6f728ead535f172c1c41a18))
* **connectors:** add faviconDomain to github + reddit ([#754](https://github.com/lobu-ai/lobu/issues/754)) ([b4e5a35](https://github.com/lobu-ai/lobu/commit/b4e5a350d17c76ac76dd3fe247543461330f9304))
* **core:** accept URL-safe base64 in ENCRYPTION_KEY validator ([#735](https://github.com/lobu-ai/lobu/issues/735)) ([df759d7](https://github.com/lobu-ai/lobu/commit/df759d71765863c03ec60f22245e28f78491fe96))
* **device-reconcile:** replace uuid[] cast with text[] to avoid PG array parse failure ([#835](https://github.com/lobu-ai/lobu/issues/835)) ([be8166c](https://github.com/lobu-ai/lobu/commit/be8166c02987ad5ff4859935ab2ff7b200bd8954))
* **docker:** correct compose example after e2e test ([#853](https://github.com/lobu-ai/lobu/issues/853)) ([b95a35e](https://github.com/lobu-ai/lobu/commit/b95a35e1337b368f83dbcc16134626af8b92a557))
* **goals:** emit lifecycle event on update ([#815](https://github.com/lobu-ai/lobu/issues/815)) ([#818](https://github.com/lobu-ai/lobu/issues/818)) ([7a72456](https://github.com/lobu-ai/lobu/commit/7a7245629ebb33a980ef990b5a0ff3bae8be081b))
* **insert-event:** guard against empty INSERT RETURNING ([#780](https://github.com/lobu-ai/lobu/issues/780)) ([5226d99](https://github.com/lobu-ai/lobu/commit/5226d99defeb6b53fef37a43dd26a3b98c3a6cfc))
* **interactions:** require connectionId to prevent cross-platform leakage ([#847](https://github.com/lobu-ai/lobu/issues/847)) ([16998ab](https://github.com/lobu-ai/lobu/commit/16998ab8dde923536b002017b11fc5e528201e2f)), closes [#690](https://github.com/lobu-ai/lobu/issues/690)
* **mac:** auto-start runner with the env it actually needs ([#783](https://github.com/lobu-ai/lobu/issues/783)) ([f8013b5](https://github.com/lobu-ai/lobu/commit/f8013b5956c407044f551a813a6aaeae7fd09bba))
* **mcp:** fail closed when tool annotations cannot be fetched ([#688](https://github.com/lobu-ai/lobu/issues/688)) ([#844](https://github.com/lobu-ai/lobu/issues/844)) ([ea24266](https://github.com/lobu-ai/lobu/commit/ea24266f3437d84cf04b740cb1e77f07ba33e347))
* **metric_series:** defense-in-depth (prefix check + row cap) ([#763](https://github.com/lobu-ai/lobu/issues/763)) ([35285ea](https://github.com/lobu-ai/lobu/commit/35285eafb32d756fcf57e22c199ec0ed25f0a9db))
* **metric_series:** inline statement_timeout (SET LOCAL rejects params) ([#762](https://github.com/lobu-ai/lobu/issues/762)) ([039c7ab](https://github.com/lobu-ai/lobu/commit/039c7ab790fd6b5b64d9194fd323c68ab8a990ba))
* **metric_series:** tsc errors that broke the build-app image ([#758](https://github.com/lobu-ai/lobu/issues/758)) ([a5f1212](https://github.com/lobu-ai/lobu/commit/a5f12128ea38ee944c8be0ac8c6ad86549df672f))
* **no-auth:** address CodeRabbit follow-ups from PR [#780](https://github.com/lobu-ai/lobu/issues/780) review ([#785](https://github.com/lobu-ai/lobu/issues/785)) ([33e6c04](https://github.com/lobu-ai/lobu/commit/33e6c045c519b7613d12b1095030881c7cb64411))
* **reliability:** gate boot on schema, surface err, split readiness ([#767](https://github.com/lobu-ai/lobu/issues/767)) ([ca4ba0e](https://github.com/lobu-ai/lobu/commit/ca4ba0ea4105e96277fc23d8039937ae5083e798))
* **runs:** add heartbeat + stale-run reaper ([#849](https://github.com/lobu-ai/lobu/issues/849)) ([741a4d7](https://github.com/lobu-ai/lobu/commit/741a4d7c63cdb4f19e0592ab11cdc2c6e904c297))
* schema.sql drift + manage_feeds feed_key narrowing + submodule bump ([#804](https://github.com/lobu-ai/lobu/issues/804)) ([3a9d8fd](https://github.com/lobu-ai/lobu/commit/3a9d8fdde6618084f7db272e436378d987546f7f))
* **schema:** drop agents_organization_id_id_key — broke ON CONFLICT (id) callers ([#747](https://github.com/lobu-ai/lobu/issues/747)) ([8af9021](https://github.com/lobu-ai/lobu/commit/8af90219038fa1b3001979c8ca8d00a133acd3be))
* **server:** bundle build copies connectors next to server.bundle.mjs ([#739](https://github.com/lobu-ai/lobu/issues/739)) ([0358a4a](https://github.com/lobu-ai/lobu/commit/0358a4aec3570a30fdde413535bc9aa1eb6d8b35))
* **server:** ignore packages/owletto in dev watcher ([#826](https://github.com/lobu-ai/lobu/issues/826)) ([67792d8](https://github.com/lobu-ai/lobu/commit/67792d856a518f7e162c01afcc5789620bbda5ef))
* **server:** plug listener leaks on Hono SSE routes via abort bridge ([#845](https://github.com/lobu-ai/lobu/issues/845)) ([3ee73d9](https://github.com/lobu-ai/lobu/commit/3ee73d9cfbf663762cb07362ef64e64e64379069))
* **server:** project device_worker_id + goal_id on watcher list endpoint ([#816](https://github.com/lobu-ai/lobu/issues/816)) ([0a863bc](https://github.com/lobu-ai/lobu/commit/0a863bcb482c3063b3eedf6c6e6d181b3022b09a))
* **server:** remove LOBU_NO_AUTH, add /api/exchange-token PAT handoff ([#827](https://github.com/lobu-ai/lobu/issues/827)) ([4fddc72](https://github.com/lobu-ai/lobu/commit/4fddc72cdec5fb865ddf2395007bcc237742c624))
* **server:** remove unauthenticated GET /internal/connections ([#846](https://github.com/lobu-ai/lobu/issues/846)) ([c8c0db3](https://github.com/lobu-ai/lobu/commit/c8c0db32332730334dfcbad814821593806cee9a)), closes [#687](https://github.com/lobu-ai/lobu/issues/687)
* **server:** scheduled-jobs embedded patch — guard FK against composite-PK swap ([#809](https://github.com/lobu-ai/lobu/issues/809)) ([6683036](https://github.com/lobu-ai/lobu/commit/66830364ed3af555a10f293bf2cf568e2c5d6269))
* **server:** scope tenant boundaries across egress judge, secret proxy, and oauth state ([#836](https://github.com/lobu-ai/lobu/issues/836)) ([de4c238](https://github.com/lobu-ai/lobu/commit/de4c238bb39d321211ca149447bdf568c3204b04))
* **server:** server-side agent must skip device-pinned watcher runs ([#808](https://github.com/lobu-ai/lobu/issues/808)) ([a88d840](https://github.com/lobu-ai/lobu/commit/a88d840155c768ba062a22fb200d08481eec2f52))
* **server:** tear down SSE keepalive + listener on abnormal disconnect ([#833](https://github.com/lobu-ai/lobu/issues/833)) ([f597e76](https://github.com/lobu-ai/lobu/commit/f597e768ecd3e8346d05a4009bb864f68f453fc5))


### Performance Improvements

* drop 8 unused indexes (5.16 GB) + event_count from list ([#771](https://github.com/lobu-ai/lobu/issues/771)) ([653566f](https://github.com/lobu-ai/lobu/commit/653566f56377eb3ce21c4ed6c153d9584f5f6e01))
* **events:** stored fulltext column + lifecycle partial index ([#765](https://github.com/lobu-ai/lobu/issues/765)) ([48c2b92](https://github.com/lobu-ai/lobu/commit/48c2b92fe8fd6de9456108495ed82070e26924cf))
* **server:** SIGUSR2 writes V8 heap snapshot ([#768](https://github.com/lobu-ai/lobu/issues/768)) ([e5c93a3](https://github.com/lobu-ai/lobu/commit/e5c93a38fd478c1cd4d4b9e474c631cac39e09fa))
* **workers:** stop shipping connector bundles + LRU cache cap ([#772](https://github.com/lobu-ai/lobu/issues/772)) ([c40408c](https://github.com/lobu-ai/lobu/commit/c40408ce698df84d1b0a53fcc6d7f0c4445f4404))


### Reverts

* **server:** drop goals primitive — agents are the grouping concept ([#823](https://github.com/lobu-ai/lobu/issues/823)) ([f5dee4e](https://github.com/lobu-ai/lobu/commit/f5dee4e2a96b33119ebf0f133a74e82e9a849728))

## [7.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v6.1.1...lobu-v7.0.0) (2026-05-14)


### ⚠ BREAKING CHANGES

* **cli:** remove inline [memory.schema] from lobu.toml ([#630](https://github.com/lobu-ai/lobu/issues/630))

### Features

* **apply:** declarative Slack channel routing on platforms ([#661](https://github.com/lobu-ai/lobu/issues/661)) ([4622016](https://github.com/lobu-ai/lobu/commit/4622016f99eb56d6f56cb0ed7c76b4708d173834))
* **auth:** save password credential on email+password sign-in ([#695](https://github.com/lobu-ai/lobu/issues/695)) ([018335d](https://github.com/lobu-ai/lobu/commit/018335d6b5291902baf76f172d0917b4bd76551d))
* **browser-profiles:** device-bound browser auth + per-folder feeds + Mac UI overhaul ([#706](https://github.com/lobu-ai/lobu/issues/706)) ([ad19392](https://github.com/lobu-ai/lobu/commit/ad19392d15398cdf5f165c7885350881b9fa914f))
* **charts:** add public Helm install chart ([85ad155](https://github.com/lobu-ai/lobu/commit/85ad15508ea3405a727155f34b75ecfb53862625))
* **cli:** `lobu apply` bootstraps a missing org from [memory].org ([#632](https://github.com/lobu-ai/lobu/issues/632)) ([9a493fe](https://github.com/lobu-ai/lobu/commit/9a493fe878764f41f46a65674ccf7742466cbbf6))
* **cli:** remove inline [memory.schema] from lobu.toml ([#630](https://github.com/lobu-ai/lobu/issues/630)) ([b5bee12](https://github.com/lobu-ai/lobu/commit/b5bee126700f6a1715f85aed7ee509466ada89d9))
* **cli:** support bundled memory model YAML ([#626](https://github.com/lobu-ai/lobu/issues/626)) ([e843d52](https://github.com/lobu-ai/lobu/commit/e843d5267d3398c6124b360647b8edcbf73dd560))
* **cli:** sync data-source connectors in lobu apply ([#624](https://github.com/lobu-ai/lobu/issues/624)) ([7fe4924](https://github.com/lobu-ai/lobu/commit/7fe492484efdc4e24fad553250f3c18db3bb7424))
* **connections:** cross-link devices ↔ connections, waiting-on-device state ([#670](https://github.com/lobu-ai/lobu/issues/670)) ([bebcbd1](https://github.com/lobu-ai/lobu/commit/bebcbd1339378bd65781e6f851f340ea049cf046)), closes [#597](https://github.com/lobu-ai/lobu/issues/597)
* **connections:** richer Run-on device picker ([#662](https://github.com/lobu-ai/lobu/issues/662)) ([b807e62](https://github.com/lobu-ai/lobu/commit/b807e629c4842b753fb6a244f2a32f10e7bb9ced))
* **connectors:** add Revolut transactions connector (browser/CDP) ([#589](https://github.com/lobu-ai/lobu/issues/589)) ([9774389](https://github.com/lobu-ai/lobu/commit/97743893aaa9d11f4371ebc170aab8e349553660))
* **connectors:** device-pinning follow-ups ([#620](https://github.com/lobu-ai/lobu/issues/620)) ([#628](https://github.com/lobu-ai/lobu/issues/628)) ([e77b2b0](https://github.com/lobu-ai/lobu/commit/e77b2b06cb5a57b8dedcd231bd78a836ae346da8))
* **connectors:** pin connections to a device worker (run-on-device + shared-org device connectors) ([#620](https://github.com/lobu-ai/lobu/issues/620)) ([df36418](https://github.com/lobu-ai/lobu/commit/df3641839451eb67fb29ffea258835d538a15131))
* **device-workers:** a device's home org follows the workspace picked on the OAuth page ([#645](https://github.com/lobu-ai/lobu/issues/645)) ([6323001](https://github.com/lobu-ai/lobu/commit/6323001d9f0c0f1fbffe6d3efd6f2a317b388e61))
* **device-workers:** device worker protocol and Lobu for Mac ([67c192b](https://github.com/lobu-ai/lobu/commit/67c192b2a2c14984106ec7622d6bb157d70995e3))
* **device-workers:** one workspace per device; removal + health on the Devices page ([#639](https://github.com/lobu-ai/lobu/issues/639)) ([4045cb8](https://github.com/lobu-ai/lobu/commit/4045cb8bceb1d00629b71046639262959c966531))
* **dev:** per-worktree port overrides via .env.local ([#580](https://github.com/lobu-ai/lobu/issues/580)) ([4fa213b](https://github.com/lobu-ai/lobu/commit/4fa213b6e629c4d42bedae27ef3ba1953fc76640))
* **examples:** add lobu-crm dogfood funnel CRM agent ([#592](https://github.com/lobu-ai/lobu/issues/592)) ([03d136f](https://github.com/lobu-ai/lobu/commit/03d136f8842240a32a76cddb3fd12e030fd3a9ae))
* **examples:** add office-bot project — food-ordering agent (Slack → Deliveroo) ([#631](https://github.com/lobu-ai/lobu/issues/631)) ([8de4318](https://github.com/lobu-ai/lobu/commit/8de431823626e14c7d25431ab9b862ba985a19ae))
* **mac+server:** WhatsApp voice notes — ingest + transcribe ([#708](https://github.com/lobu-ai/lobu/issues/708)) ([36f57a6](https://github.com/lobu-ai/lobu/commit/36f57a61bdd88ddc45b884d94038efefe18b9b85))
* **mac:** credential-store sign-in, menubar redesign, Sparkle, WhatsApp local ([#702](https://github.com/lobu-ai/lobu/issues/702)) ([49b66c0](https://github.com/lobu-ai/lobu/commit/49b66c0d8987e111ec633adf87010aaa92d70a19))
* **mac:** make HealthKit optional — drop the restricted entitlement ([#614](https://github.com/lobu-ai/lobu/issues/614)) ([30b5568](https://github.com/lobu-ai/lobu/commit/30b5568c126c23969c904e285b38e64b810b15b4))
* **mac:** menubar redesign + Sparkle auto-updates ([#700](https://github.com/lobu-ai/lobu/issues/700)) ([e519ba6](https://github.com/lobu-ai/lobu/commit/e519ba65187b7bc8fdd96f0d35a39509ace82c12))
* **mac:** unsigned-DMG stopgap for mac-release; auto-upgrades to signed ([#616](https://github.com/lobu-ai/lobu/issues/616)) ([d62a3c0](https://github.com/lobu-ai/lobu/commit/d62a3c0946f1f62844e1584cf5bf88887ade8960))
* **mac:** wire DMG build into release CD; "Check for Updates" in app ([#608](https://github.com/lobu-ai/lobu/issues/608)) ([78bb644](https://github.com/lobu-ai/lobu/commit/78bb6445cb37035ea292a3665c33d2ba302d9ff7))
* master-detail Agents page (assistant-ui chat) + sidebar restore ([#578](https://github.com/lobu-ai/lobu/issues/578)) ([92df339](https://github.com/lobu-ai/lobu/commit/92df3396d8474db3f7350e6b6178f707b2c239b3))
* **notifications:** unify with events; per-user delivery via notification_targets ([#707](https://github.com/lobu-ai/lobu/issues/707)) ([048a402](https://github.com/lobu-ai/lobu/commit/048a40214c2041f24146c6092638f76c69e2cd65))
* Notion-style nav shell behind navV2 flag ([#705](https://github.com/lobu-ai/lobu/issues/705)) ([8d4b3e5](https://github.com/lobu-ai/lobu/commit/8d4b3e5664ff9c30d73daed6f69dba8ab4ccae9c))
* **openclaw-plugin:** publish Lobu plugin to ClawHub ([#584](https://github.com/lobu-ai/lobu/issues/584)) ([8fa158b](https://github.com/lobu-ai/lobu/commit/8fa158b1a3a9857721d7c1a9fb279836032e9184))
* **openclaw:** memory-wiki compatibility spike + harness ([#569](https://github.com/lobu-ai/lobu/issues/569)) ([a8babfd](https://github.com/lobu-ai/lobu/commit/a8babfd96c5cd121e16a7f609de497866374ed91))
* **preview:** /lobu try — self-serve demo agents in the public preview bot ([#664](https://github.com/lobu-ai/lobu/issues/664)) ([c799bb5](https://github.com/lobu-ai/lobu/commit/c799bb5560d71f5509e38ab0784465d10b6e70fb))
* **preview:** record chat-user→Lobu-user identity on /lobu link; codeless re-link by agent id ([#652](https://github.com/lobu-ai/lobu/issues/652)) ([3a33486](https://github.com/lobu-ai/lobu/commit/3a33486ee9aec02db6a952d528e3d3495bff94f1))
* **scheduled-jobs:** user-driven cron / one-shot via TaskScheduler + scheduled_jobs table ([#710](https://github.com/lobu-ai/lobu/issues/710)) ([fa6a105](https://github.com/lobu-ai/lobu/commit/fa6a105d3285c6f22b72891c341dc37bb1202be1))
* **server:** add stable slug to connections ([#619](https://github.com/lobu-ai/lobu/issues/619)) ([0a35349](https://github.com/lobu-ai/lobu/commit/0a3534929eafb22d81a636d68e5c53c8aa3073d2))
* **server:** drop connector_key gating from browser_session profiles ([#720](https://github.com/lobu-ai/lobu/issues/720)) ([539831b](https://github.com/lobu-ai/lobu/commit/539831b7299d632047a698d99c5edbbc98238924))
* **server:** get_content semantic_type accepts string or array ([#719](https://github.com/lobu-ai/lobu/issues/719)) ([cfcb80e](https://github.com/lobu-ai/lobu/commit/cfcb80e3636688635da7061f9a88a5b3d4af8479))
* **sidebar:** agents & devices counts via bootstrap summary ([#650](https://github.com/lobu-ai/lobu/issues/650)) ([570a6c7](https://github.com/lobu-ai/lobu/commit/570a6c76a102af14391064914e88dfa4595378fa))
* Slack Preview — try a Lobu agent via the hosted "Lobu Developer" Slack with no bot token ([#627](https://github.com/lobu-ai/lobu/issues/627)) ([7d66977](https://github.com/lobu-ai/lobu/commit/7d6697700afe2a41a43dc4fd02ea25c25826e668))
* **slack-preview:** deterministic "link this chat" reply for unlinked DMs/channels ([#644](https://github.com/lobu-ai/lobu/issues/644)) ([837f3a7](https://github.com/lobu-ai/lobu/commit/837f3a75c4a0362b90506e2170664aa6bd0da601))
* **slack:** App Home tab — integrations list + per-user Connect/Disconnect ([#653](https://github.com/lobu-ai/lobu/issues/653)) ([562d071](https://github.com/lobu-ai/lobu/commit/562d071b8d2ae1470de54701fa5cc754b8df1146))
* support workspace visibility updates ([#574](https://github.com/lobu-ai/lobu/issues/574)) ([179b512](https://github.com/lobu-ai/lobu/commit/179b512354e7e66ee0b62166041aae3f7c1d1f09))
* **watchers:** allow org-scoped watchers + sync them in lobu apply ([#596](https://github.com/lobu-ai/lobu/issues/596)) ([86eaf90](https://github.com/lobu-ai/lobu/commit/86eaf9099689f62a8fa533e8339472e8bc2a04d0))
* web "Try in chat" + agent channel-bindings (A1+A2) ([#660](https://github.com/lobu-ai/lobu/issues/660)) ([2976b15](https://github.com/lobu-ai/lobu/commit/2976b1561ff23cf9574cefe72bbf95d6340778c4))
* **web:** reserve /inbox path; bump web submodule for Home/Inbox/Search nav ([#599](https://github.com/lobu-ai/lobu/issues/599)) ([3537630](https://github.com/lobu-ai/lobu/commit/353763026972a655f4cdeed226647e0129dcebca))
* **web:** sidebar — nest focused entity under its type, hoist workspace nav, compact counts ([#675](https://github.com/lobu-ai/lobu/issues/675)) ([26b8f34](https://github.com/lobu-ai/lobu/commit/26b8f34e400a1e43d11801176f8e19e5c5e4cef8))
* **web:** surface connector actions on detail + empty state ([#711](https://github.com/lobu-ai/lobu/issues/711)) ([f732081](https://github.com/lobu-ai/lobu/commit/f732081d26df5469b5e9c490877830249dcd142d))


### Bug Fixes

* **agents:** coerce list-agents platforms to a string[] ([#659](https://github.com/lobu-ai/lobu/issues/659)) ([4122ff9](https://github.com/lobu-ai/lobu/commit/4122ff991b7909e70dd3f93b77e1ca5d51a4779b))
* **apply:** userinfo returns org id; dry-run is read-only; fix plan heading ([#636](https://github.com/lobu-ai/lobu/issues/636)) ([82d2afb](https://github.com/lobu-ai/lobu/commit/82d2afb01e11329c224a8ea1d7638f8316e2967c))
* **auth:** stamp personal_org_for_user_id on manual org creation + default device tokens to it ([#703](https://github.com/lobu-ai/lobu/issues/703)) ([9049955](https://github.com/lobu-ai/lobu/commit/9049955d43c01e7aca25982a82fcf5ba25141af8))
* bug-fix sweep ([#673](https://github.com/lobu-ai/lobu/issues/673)) ([7c1500b](https://github.com/lobu-ai/lobu/commit/7c1500b82eb3facbb8a283be64af7bb0777eb51c))
* bug-hunt sweep — OAuth exchange, watcher versions, dead code ([#642](https://github.com/lobu-ai/lobu/issues/642)) ([a1a6abf](https://github.com/lobu-ai/lobu/commit/a1a6abf5e1befe95dd200700cea1e0f59093a761))
* **cli:** chat/eval target the gateway Agent API under /lobu ([#637](https://github.com/lobu-ai/lobu/issues/637)) ([4535b79](https://github.com/lobu-ai/lobu/commit/4535b798352de9b64cde0be094dc3052a4bc7840))
* **cli:** lobu apply resolves the org via userinfo; no headless org-create ([#634](https://github.com/lobu-ai/lobu/issues/634)) ([e140a9c](https://github.com/lobu-ai/lobu/commit/e140a9cbb819292c780873db922ff02fc0c152c7))
* **cli:** resolve providers.json + worker entry relative to enclosing monorepo root ([#669](https://github.com/lobu-ai/lobu/issues/669)) ([2458494](https://github.com/lobu-ai/lobu/commit/24584942610777bd2347eac8cb700a5d77ca7940)), closes [#656](https://github.com/lobu-ai/lobu/issues/656) [#657](https://github.com/lobu-ai/lobu/issues/657)
* **connectors:** always recompile bundled connectors from disk, ignore stale persisted artifact ([#666](https://github.com/lobu-ai/lobu/issues/666)) ([dab5e49](https://github.com/lobu-ai/lobu/commit/dab5e493bf5690e271065fa2d20e13cd3c4205e2))
* **core/tests:** unblock Docker tsc — typecheck failures in [#685](https://github.com/lobu-ai/lobu/issues/685) tests ([#696](https://github.com/lobu-ai/lobu/issues/696)) ([a972de9](https://github.com/lobu-ai/lobu/commit/a972de9f51ea22911ebf5c9349d03b7bf580a418))
* **db:** make local PGlite dev reliable; bump owletto-web ([#607](https://github.com/lobu-ai/lobu/issues/607)) ([67b3c58](https://github.com/lobu-ai/lobu/commit/67b3c585e0bb68fb74c9a6c64eeb13fb0d7f5c53))
* **examples:** office-bot models as a version: 2 bundle ([#633](https://github.com/lobu-ai/lobu/issues/633)) ([7db2157](https://github.com/lobu-ai/lobu/commit/7db2157dfb63c9cb9cab9588c3a40d112e91b9db))
* **gateway:** guard optional agentSettingsStore in agentOwnerResolver closure ([#611](https://github.com/lobu-ai/lobu/issues/611)) ([537f383](https://github.com/lobu-ai/lobu/commit/537f3832835297b7157183fc28a7c28b69e419cc))
* **gateway:** resolve agent provider credentials via the agent owner ([#609](https://github.com/lobu-ai/lobu/issues/609)) ([abec8de](https://github.com/lobu-ai/lobu/commit/abec8de30a7f1fe8bab903b16fdca5135bb17bd0))
* **gateway:** resolve provider credentials in the agent's org context for chat-webhook runs ([#641](https://github.com/lobu-ai/lobu/issues/641)) ([df6c08d](https://github.com/lobu-ai/lobu/commit/df6c08da255c2f21b2f8acab25614bb78e499c0b))
* **lobu:** persist agent api-key auth profiles from PATCH /config ([#601](https://github.com/lobu-ai/lobu/issues/601)) ([d3c3bb8](https://github.com/lobu-ai/lobu/commit/d3c3bb8f6e6a3805808724b179f69e5fc7e5c89b))
* **mac:** always publish the Homebrew cask; fail loudly if no token ([#621](https://github.com/lobu-ai/lobu/issues/621)) ([9812b2c](https://github.com/lobu-ai/lobu/commit/9812b2c7d3fb803dfb2706d97de60754a8178096))
* **mac:** push the Homebrew cask via a dedicated deploy key, not a PAT ([#622](https://github.com/lobu-ai/lobu/issues/622)) ([903a516](https://github.com/lobu-ai/lobu/commit/903a516a3a74901b36846997771c7cd0907e83ec))
* **mac:** tap-token fallback to RELEASE_PLEASE_TOKEN; tidy cask template ([#617](https://github.com/lobu-ai/lobu/issues/617)) ([ef010fd](https://github.com/lobu-ai/lobu/commit/ef010fd5f84d88dd4f54b3862edafdd2e39d60f1))
* **openclaw-plugin:** declare contracts.tools and bound recall hook ([#585](https://github.com/lobu-ai/lobu/issues/585)) ([9f46e5f](https://github.com/lobu-ai/lobu/commit/9f46e5f3bf2afae42e4fcd0d95bfb05bb73a12ca))
* **openclaw-plugin:** warn loudly when host has no tools.* policy ([#590](https://github.com/lobu-ai/lobu/issues/590)) ([271d49a](https://github.com/lobu-ai/lobu/commit/271d49ad29441af2ce80517dd620415049593712))
* **openclaw:** bound memory-wiki compat fanouts with per-call timeout ([8c15420](https://github.com/lobu-ai/lobu/commit/8c154209d498dacfea191bd248f45f81b307cbf7))
* restore packages/web entries in bun.lock ([#654](https://github.com/lobu-ai/lobu/issues/654)) ([26d16ce](https://github.com/lobu-ai/lobu/commit/26d16cecdeed5742fda8f1679d612e9fb408b048))
* **sentry:** stop polluting Sentry with tool-validation noise + sweeper info ([#612](https://github.com/lobu-ai/lobu/issues/612)) ([be1732b](https://github.com/lobu-ai/lobu/commit/be1732b609b1c56daa6fc865c519b2c5e861e3c2))
* **server:** capture all 5xx responses + thrown HTTP errors in Sentry ([#701](https://github.com/lobu-ai/lobu/issues/701)) ([9bfb626](https://github.com/lobu-ai/lobu/commit/9bfb626a5077c2ecc3f17e7be311d285ad7d7cdb))
* **server:** device-reconcile adopts orphan connections + web bump ([#714](https://github.com/lobu-ai/lobu/issues/714)) ([76fc6e9](https://github.com/lobu-ai/lobu/commit/76fc6e9881de62bc05014cded25d5f27c75eb018))
* **server:** no-store on unknown-path discovery JSON (stop CDN caching it) ([#603](https://github.com/lobu-ai/lobu/issues/603)) ([cc89429](https://github.com/lobu-ai/lobu/commit/cc894293646560587c8f237506fa7e72589ef963))
* **server:** orchestration-harden test no longer wipes shared DATABASE_URL ([#716](https://github.com/lobu-ai/lobu/issues/716)) ([24fdbb9](https://github.com/lobu-ai/lobu/commit/24fdbb95ac40c4f527f0b31690c96bc5ff5239e6))
* **server:** remove duplicate getClientIp export in rate-limiter ([#699](https://github.com/lobu-ai/lobu/issues/699)) ([36baed1](https://github.com/lobu-ai/lobu/commit/36baed145a4c47f5767afd8be77572a777d81770))
* **server:** restore getClientIp helper for secret-proxy legacy path ([#694](https://github.com/lobu-ai/lobu/issues/694)) ([0faa2f7](https://github.com/lobu-ai/lobu/commit/0faa2f7d09a45efb7a5ecb10edbfe30455e398b5))
* **server:** semantic_type array support in scored path + bump owletto-web ([#721](https://github.com/lobu-ai/lobu/issues/721)) ([e5a3c9c](https://github.com/lobu-ai/lobu/commit/e5a3c9caaa5804ded8ae1875b7441aea2571a5e3))
* **server:** unify content search on hybrid index-driven candidate path ([#586](https://github.com/lobu-ai/lobu/issues/586)) ([bc43385](https://github.com/lobu-ai/lobu/commit/bc43385d215bcea8d8c82da11c094378f9b6a1bb))
* **slack-preview:** store /lobu link bindings under the canonical slack: channel key ([#638](https://github.com/lobu-ai/lobu/issues/638)) ([840cb3c](https://github.com/lobu-ai/lobu/commit/840cb3c813089935b8a706b191dab0e08862041a))
* **slack:** publish the Home view through the initialized adapter ([#665](https://github.com/lobu-ai/lobu/issues/665)) ([e1e549f](https://github.com/lobu-ai/lobu/commit/e1e549f2b49f4b7eb2a65fbf68c1c6233915b553))
* **slack:** surface the real error when the Home view fails + fall back to a minimal view ([#663](https://github.com/lobu-ai/lobu/issues/663)) ([12dcdcb](https://github.com/lobu-ai/lobu/commit/12dcdcbfe0345dcd9df57ca7bd6ed749188a9296))
* **test:** list connections.device_worker_id in QUERYABLE_SCHEMA ([#625](https://github.com/lobu-ai/lobu/issues/625)) ([3e4e994](https://github.com/lobu-ai/lobu/commit/3e4e9948f8c414fe85f543466300c5257f3c09c8))
* update Lobu logo assets ([fc28fb2](https://github.com/lobu-ai/lobu/commit/fc28fb2f00f6430c2ce410586faeaa332502059d))
* **watchers:** enforce org access for scoped watchers ([#598](https://github.com/lobu-ai/lobu/issues/598)) ([b652f10](https://github.com/lobu-ai/lobu/commit/b652f1092a4c3e5448b6194defb4462aa817e8b5))
* **web:** SEO meta + favicon; dedupe server-rendered public-page head ([#600](https://github.com/lobu-ai/lobu/issues/600)) ([6dd598b](https://github.com/lobu-ai/lobu/commit/6dd598bc927fe1cfdff20058652926f1fef6d07b))
* **whatsapp:** cross-connector dedup, voice-note diagnostics, schema survey ([#713](https://github.com/lobu-ai/lobu/issues/713)) ([2267f58](https://github.com/lobu-ai/lobu/commit/2267f5882e83be552e91b5948d7a9cea0eac0225))


### Performance Improvements

* performance sweep — caching, batching, fewer round-trips ([#674](https://github.com/lobu-ai/lobu/issues/674)) ([1fbdd62](https://github.com/lobu-ai/lobu/commit/1fbdd6243c5e2f39deb11eaadeefebe843a6bbf6))

## [6.1.1](https://github.com/lobu-ai/lobu/compare/lobu-v6.1.0...lobu-v6.1.1) (2026-05-10)


### Bug Fixes

* **cli:** make lobu run self-contained ([4e5c86b](https://github.com/lobu-ai/lobu/commit/4e5c86ba4c7fe19931d2f83b4094e33bc16efa71))
* preflight production database migrations ([#563](https://github.com/lobu-ai/lobu/issues/563)) ([c51a85b](https://github.com/lobu-ai/lobu/commit/c51a85b7b4d98af7b5b64ab34977d4d5ef118645))
* scaffold provider and platform env placeholders ([#565](https://github.com/lobu-ai/lobu/issues/565)) ([587074d](https://github.com/lobu-ai/lobu/commit/587074d0f5cd8e3f6651ee990ba38902efeeebdc))
* workspace membership consistency ([668fe06](https://github.com/lobu-ai/lobu/commit/668fe060b2341d4c6422fe81043fc332c62d0502))

## [6.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v6.0.1...lobu-v6.1.0) (2026-05-09)


### Features

* **auth:** send welcome email on signup ([d687938](https://github.com/lobu-ai/lobu/commit/d68793865d5933b79fe862eae9c71e739075bc95))
* **cli:** non-interactive init, project link, beefier doctor ([#521](https://github.com/lobu-ai/lobu/issues/521)) ([1b02761](https://github.com/lobu-ai/lobu/commit/1b027610b2075a2fbd73c7ada1cc6a57ad3f7bd4))
* **connectors:** add normalized GitHub stargazer identities ([f59f5ef](https://github.com/lobu-ai/lobu/commit/f59f5ef6208962a7c8722f80a7fdd6680711c959))
* **mcp:** add dry-run preview for SDK run tool ([b991ef9](https://github.com/lobu-ai/lobu/commit/b991ef9ac824c30bb9eac4fe9e6db839439ad76d))
* **mcp:** add memory tool aliases ([d61846b](https://github.com/lobu-ai/lobu/commit/d61846bedce1fa909643e840309416fd4ab4cb35))
* **mcp:** normalize tool names and audit sharp calls ([864acb0](https://github.com/lobu-ai/lobu/commit/864acb05da37935a0f020fd2dc0570031a65b861))


### Bug Fixes

* address unaddressed Codex review comments from [#478](https://github.com/lobu-ai/lobu/issues/478) / [#498](https://github.com/lobu-ai/lobu/issues/498) / [#521](https://github.com/lobu-ai/lobu/issues/521) ([#535](https://github.com/lobu-ai/lobu/issues/535)) ([1c704f0](https://github.com/lobu-ai/lobu/commit/1c704f0e2612df47d3665ecb12a857c88699e2ed))
* **build:** build embeddings before connector-worker ([#528](https://github.com/lobu-ai/lobu/issues/528)) ([1979f5c](https://github.com/lobu-ai/lobu/commit/1979f5cda459a8355a8ee835feefb996b23a0a0d))
* **chat-instance:** self-bind org context in startInstance for boot + webhooks ([#522](https://github.com/lobu-ai/lobu/issues/522)) ([5257162](https://github.com/lobu-ai/lobu/commit/5257162e0db4fc8a9cbd2f3522e56cef2404d1f9))
* **ci:** restore patches directory for docker builds ([4ffe1c9](https://github.com/lobu-ai/lobu/commit/4ffe1c95fe4c0b22f7e827b824bdeb71ad5705cd))
* cluster of bugs surfaced by parallel bug-hunting subagents ([#523](https://github.com/lobu-ai/lobu/issues/523)) ([680fe4d](https://github.com/lobu-ai/lobu/commit/680fe4d78793ad7322798c375c9de11f74095add))
* complete memory config flattening ([4154651](https://github.com/lobu-ai/lobu/commit/415465137c06411c59b0e59443eff1ff26927a36))
* **connectors:** recover reddit sync and watcher memory auth ([#542](https://github.com/lobu-ai/lobu/issues/542)) ([48adcb4](https://github.com/lobu-ai/lobu/commit/48adcb4a1516f2f246e9671966ae53e48309dc45))
* **connectors:** use claimed_at instead of nonexistent started_at on runs ([#515](https://github.com/lobu-ai/lobu/issues/515)) ([5db2c86](https://github.com/lobu-ai/lobu/commit/5db2c865571646636341ca3fe1cd0410af916155))
* **db:** guard chat_connections copy on table existence ([#525](https://github.com/lobu-ai/lobu/issues/525)) ([7d95910](https://github.com/lobu-ai/lobu/commit/7d95910630bc7db64c7b1674e660f86426d6c027))
* **docker/worker:** build @lobu/core before connector-sdk in worker image ([#530](https://github.com/lobu-ai/lobu/issues/530)) ([3d8e233](https://github.com/lobu-ai/lobu/commit/3d8e233de150a02c6dfd9987b5e0960160cc93ec))
* **docker:** build embeddings before connector worker in app image ([#541](https://github.com/lobu-ai/lobu/issues/541)) ([9169103](https://github.com/lobu-ai/lobu/commit/9169103434b308a827084c9d8ebbc557538578f0))
* **docker:** remove deleted owletto package copies from app image ([#539](https://github.com/lobu-ai/lobu/issues/539)) ([2e0f092](https://github.com/lobu-ai/lobu/commit/2e0f0922b0b52467b67964396932d837b0dc72da))
* dogfood workflow + auth bug allowing cross-org OAuth ([#536](https://github.com/lobu-ai/lobu/issues/536)) ([feae13a](https://github.com/lobu-ai/lobu/commit/feae13aa680213a05baf6b3120a9b02a99921e4f))
* drop @types/node override, align embeddings to 20.19.9 ([#524](https://github.com/lobu-ai/lobu/issues/524)) ([b28530d](https://github.com/lobu-ai/lobu/commit/b28530d5c87bdf82d488e41f744cc0567272777c))
* format tools.ts (collapse stripEnv to one line) ([#518](https://github.com/lobu-ai/lobu/issues/518)) ([a0ecd6e](https://github.com/lobu-ai/lobu/commit/a0ecd6e0c59b9ed91bd4c67e29bffbd9461353d9))
* **gateway:** handle missing Lobu org context ([b513001](https://github.com/lobu-ai/lobu/commit/b513001d5e41177ec3bc4ef61990334f273a9d99))
* **gateway:** initialize memory tool listing ([#545](https://github.com/lobu-ai/lobu/issues/545)) ([f1614d7](https://github.com/lobu-ai/lobu/commit/f1614d72e87a94e26c5fd5b496807626225da0c2))
* **gateway:** unscoped agent route + fake LLM e2e harness + validateUrlDomain bypass ([#532](https://github.com/lobu-ai/lobu/issues/532)) ([04036b5](https://github.com/lobu-ai/lobu/commit/04036b5151af84317ddc760f443c1ed2e94e2df6))
* **server:** speed up event thread context lookups ([#558](https://github.com/lobu-ai/lobu/issues/558)) ([adcf965](https://github.com/lobu-ai/lobu/commit/adcf9659e6f867d194d6d48eabf24851aca9c673))
* unblock npx install ([#500](https://github.com/lobu-ai/lobu/issues/500)) and onboard DeepSeek V4 default ([#503](https://github.com/lobu-ai/lobu/issues/503)) ([#519](https://github.com/lobu-ai/lobu/issues/519)) ([98bd94e](https://github.com/lobu-ai/lobu/commit/98bd94e97cb9f75abdb0b06e55793fd5a907cfbf))
* **watchers:** accept ISO datetime aliases ([#549](https://github.com/lobu-ai/lobu/issues/549)) ([53dcc4a](https://github.com/lobu-ai/lobu/commit/53dcc4aab04147ff91a54f8248015db6e55a7db9))
* **watchers:** infer running completion run ([#550](https://github.com/lobu-ai/lobu/issues/550)) ([b0e816a](https://github.com/lobu-ai/lobu/commit/b0e816a1e7997a28ea4f6a878e6d6e150be12460))
* **watchers:** link exact window content ids ([#551](https://github.com/lobu-ai/lobu/issues/551)) ([da3f7c9](https://github.com/lobu-ai/lobu/commit/da3f7c91a702fe18fd7072925ff734704f637a0d))
* **watchers:** page source reads by cursor ([#556](https://github.com/lobu-ai/lobu/issues/556)) ([2507773](https://github.com/lobu-ai/lobu/commit/2507773429323c9dba9db4a3eff92cea2a25900a))
* **web:** redirect root visitors to login ([#555](https://github.com/lobu-ai/lobu/issues/555)) ([91091b6](https://github.com/lobu-ai/lobu/commit/91091b65fcb144646d0ac7daf42ceb18fcb5a3d0))
* **worker:** accept nested platform metadata ([#547](https://github.com/lobu-ai/lobu/issues/547)) ([0e8769c](https://github.com/lobu-ai/lobu/commit/0e8769cbbdc918e0edfb46c40b674384118bd396))

## [6.0.1](https://github.com/lobu-ai/lobu/compare/lobu-v6.0.0...lobu-v6.0.1) (2026-05-04)


### Bug Fixes

* **ci:** restore lobu-* image names so prod can pull them ([#512](https://github.com/lobu-ai/lobu/issues/512)) ([f4f841c](https://github.com/lobu-ai/lobu/commit/f4f841c34c95be9068173a8efee026cc9ac886ca))
* **connectors:** replace Deno-style 'npm:' specifiers with real deps ([#513](https://github.com/lobu-ai/lobu/issues/513)) ([ecdeb7c](https://github.com/lobu-ai/lobu/commit/ecdeb7ce4269d4be3d500cdc111278b9f0b2fff8))
* **publish:** add re-export shims to deprecated redirect packages ([#510](https://github.com/lobu-ai/lobu/issues/510)) ([cb499fc](https://github.com/lobu-ai/lobu/commit/cb499fcac01ae7cb20ae09c1c44496655bb77155))

## [6.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v5.0.0...lobu-v6.0.0) (2026-05-01)


### ⚠ BREAKING CHANGES

* external MCP clients calling `manage_connections` or `manage_auth_profiles` directly will receive `Tool not found`. Move those callers to the REST proxy at `POST /api/{orgSlug}/{toolName}`.
* **lobu-backend:** the `execute` MCP tool is removed. External MCP clients must switch to `run` (mutating scripts) or `query` (read-only scripts). The internal `manage_connections` and `manage_auth_profiles` tools are no longer visible on the public MCP surface; CLI/web flows continue to reach them via the REST proxy.

### Features

* **cli:** align agent management with web API ([#491](https://github.com/lobu-ai/lobu/issues/491)) ([86e0b25](https://github.com/lobu-ai/lobu/commit/86e0b254186a6cb0fc24b6837499723547572b5c))
* **cli:** replace bespoke device login with OAuth 2.0 device-code flow ([#489](https://github.com/lobu-ai/lobu/issues/489)) ([3a8ec73](https://github.com/lobu-ai/lobu/commit/3a8ec7396e14edaa6a4c4dc4911a388dc8113e4b))
* **connectors:** add reddit user_activity feed ([#445](https://github.com/lobu-ai/lobu/issues/445)) ([f53c6a1](https://github.com/lobu-ai/lobu/commit/f53c6a1ce6ee63a548a0ef67dadd0dc06f529675))
* drop Docker/K8s deployment modes — embedded-only ([5fef6c2](https://github.com/lobu-ai/lobu/commit/5fef6c27a4ce3474a6935ddd702c1f9233f46e5c))
* **identity:** facts-as-events identity engine ([475baab](https://github.com/lobu-ai/lobu/commit/475baab3da2d13d1f45834e3f572ceb97fdc4ce3))
* **landing:** Attio-style landing redesign with use-case-driven hero ([0e7af50](https://github.com/lobu-ai/lobu/commit/0e7af505acd6e16ec8a7284edff41d861709d12a))
* **landing:** dark mode support with system preference detection ([#497](https://github.com/lobu-ai/lobu/issues/497)) ([da7f8cd](https://github.com/lobu-ai/lobu/commit/da7f8cd8f3fb148ad41d7ee2670c58915d8099ee))
* migrate browser-auth to REST, demote manage_* to internal MCP ([#439](https://github.com/lobu-ai/lobu/issues/439)) ([9f883a5](https://github.com/lobu-ai/lobu/commit/9f883a5d56c92665da27bce37886d97e665565d5))
* **lobu-backend:** 401 + WWW-Authenticate for unauth /mcp ([#438](https://github.com/lobu-ai/lobu/issues/438)) ([ae703fa](https://github.com/lobu-ai/lobu/commit/ae703fa69478fc3d54a464ef3e7c99a51c3bff7c))
* **lobu-backend:** split MCP execute into query (read-only) + run (full) ([#432](https://github.com/lobu-ai/lobu/issues/432)) ([aef8254](https://github.com/lobu-ai/lobu/commit/aef825435dbc4a5015b5f6cc35419940e245e6a5))
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
* **lobu-backend:** make classification reconciliation candidate query selective ([#454](https://github.com/lobu-ai/lobu/issues/454)) ([4b83739](https://github.com/lobu-ai/lobu/commit/4b837390d0de44a6003ffd0a10354512558091fc))
* **lobu-backend:** MCP rough edges — org scope, paginated SDK examples, knowledge.delete tombstone ([#442](https://github.com/lobu-ai/lobu/issues/442)) ([6f2ae98](https://github.com/lobu-ai/lobu/commit/6f2ae988b802393f6653485cacac3727c91452c9))
* **lobu-backend:** re-register list_watchers/get_watcher/read_knowledge for REST ([#434](https://github.com/lobu-ai/lobu/issues/434)) ([dac1603](https://github.com/lobu-ai/lobu/commit/dac1603f7e3c5988e3656e4753539351fd510308))
* **public-pages:** serve scrapeable HTML for generic clients ([#415](https://github.com/lobu-ai/lobu/issues/415)) ([818c804](https://github.com/lobu-ai/lobu/commit/818c804fde615724d6b02c3a278345508b465919))
* **public-pages:** skip SSR shell for signed-in users ([4c31a04](https://github.com/lobu-ai/lobu/commit/4c31a04543035ac0928bc22c623025031062dfbb))
* **reddit:** request identity scope so /api/v1/me works ([#449](https://github.com/lobu-ai/lobu/issues/449)) ([2fc08d8](https://github.com/lobu-ai/lobu/commit/2fc08d80e3fa61eff7c6c386c4f63374cf16f4f7))
* **watchers:** connector dep hygiene + dispatcher fail-closed ([#444](https://github.com/lobu-ai/lobu/issues/444)) ([b4bb37f](https://github.com/lobu-ai/lobu/commit/b4bb37fd62c26b085d0490972d3b261cab445db5))
* **watchers:** include watcher_group_id in list response; bump lobu-web for inline version chip ([#435](https://github.com/lobu-ai/lobu/issues/435)) ([4f9db5a](https://github.com/lobu-ai/lobu/commit/4f9db5a1437d531e5263bf431dcefa076156c087))
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
* **lobu-backend:** multi-org execute + search MCP tools ([#348](https://github.com/lobu-ai/lobu/issues/348)) ([bb4ff94](https://github.com/lobu-ai/lobu/commit/bb4ff94d046acc4c8db74e5585764bb592e925a9))
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
* **embedded-lobu:** make the embedded gateway boot cleanly in the lobu app image ([#332](https://github.com/lobu-ai/lobu/issues/332)) ([c378015](https://github.com/lobu-ai/lobu/commit/c378015e51adf7fbf688684bcb1684680b2f38d3))
* **events:** tolerate stale client_id refs on insert + relax FK ([#339](https://github.com/lobu-ai/lobu/issues/339)) ([5c19d26](https://github.com/lobu-ai/lobu/commit/5c19d26bdf6604aba88c44ee437773abb2e9f071))
* **gateway,dev-native:** thread worker entryPoint through config, unblock native dev ([#347](https://github.com/lobu-ai/lobu/issues/347)) ([e5ff4d8](https://github.com/lobu-ai/lobu/commit/e5ff4d8d5bd73b02cf010d64a668610a4fde7767))
* **mcp-handler,entity-management:** SSE close race + classify entity-type errors ([#340](https://github.com/lobu-ai/lobu/issues/340)) ([4b4649a](https://github.com/lobu-ai/lobu/commit/4b4649aef22db89f8a4fe6abe787ec7bd321b01b))
* **lobu-backend:** unblock image builds after dead-code refactor ([#329](https://github.com/lobu-ai/lobu/issues/329)) ([5619e1f](https://github.com/lobu-ai/lobu/commit/5619e1f338c312cff299e73170e6d247a4382704))
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
* **lobu-backend:** accept entity_link_overrides at install/create/connect ([#318](https://github.com/lobu-ai/lobu/issues/318)) ([c08e052](https://github.com/lobu-ai/lobu/commit/c08e0521df83b78fd669ce794110e61e49429443))

## [4.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v4.0.1...lobu-v4.1.0) (2026-04-23)


### Features

* add separate Lobu and Lobu starter skill installs ([#304](https://github.com/lobu-ai/lobu/issues/304)) ([d0a4bc4](https://github.com/lobu-ai/lobu/commit/d0a4bc4d7ef61c56250b698805ae854396391469))
* **landing:** rewrite hero headline and subhead for agent-first pitch ([#312](https://github.com/lobu-ai/lobu/issues/312)) ([044b1ed](https://github.com/lobu-ai/lobu/commit/044b1ed5eb2fa1ea578701673cc1922afeee1e3d))
* **lobu-backend:** centralize transactional email + rebrand to Lobu ([#314](https://github.com/lobu-ai/lobu/issues/314)) ([4db7a1e](https://github.com/lobu-ai/lobu/commit/4db7a1e2e3dc7c214f13fa5d0bea885db080617a))
* **lobu-backend:** gate $member list to members, emails to admins ([#309](https://github.com/lobu-ai/lobu/issues/309)) ([c37c72f](https://github.com/lobu-ai/lobu/commit/c37c72f6473838163149b12c8677d8dda6acabb2))
* **lobu-backend:** public-org read access + self-serve join ([#296](https://github.com/lobu-ai/lobu/issues/296)) ([38cf00f](https://github.com/lobu-ai/lobu/commit/38cf00f09c51d57fbe5d1fb3f8811f84b2d35756))


### Bug Fixes

* **landing:** move outcome channel into outcome box ([#306](https://github.com/lobu-ai/lobu/issues/306)) ([885ab61](https://github.com/lobu-ai/lobu/commit/885ab6171bbc3e347e32c3dbf36583eef2b4f215))
* **lobu-backend:** add missing memberRole to internal ToolContext literals ([#311](https://github.com/lobu-ai/lobu/issues/311)) ([dce8105](https://github.com/lobu-ai/lobu/commit/dce8105ba0de3c4e03ba7ce268cd3e2899cc2a61))
* **lobu-backend:** exclude watcher runs from worker poll claims ([#313](https://github.com/lobu-ai/lobu/issues/313)) ([afd5d7b](https://github.com/lobu-ai/lobu/commit/afd5d7b78ed5f2125e655349079aff3b0658106e))

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

* **docker:** include lobu workspaces in Dockerfile.worker ([#274](https://github.com/lobu-ai/lobu/issues/274)) ([2aa042b](https://github.com/lobu-ai/lobu/commit/2aa042bce577fd4c498a5defbaa532515b39dd23))
* **gateway:** escape user input in MCP OAuth callback to prevent XSS ([#284](https://github.com/lobu-ai/lobu/issues/284)) ([ab19e8a](https://github.com/lobu-ai/lobu/commit/ab19e8ac569df321866921fd64b59bca9d01920d))
* **gateway:** require worker auth on /api/bedrock/* to prevent unauthenticated AWS spend ([#287](https://github.com/lobu-ai/lobu/issues/287)) ([5e6e91c](https://github.com/lobu-ai/lobu/commit/5e6e91c32a75e872a052705854277d8114b5c240))
* **landing:** repair broken links surfaced by audit ([#275](https://github.com/lobu-ai/lobu/issues/275)) ([1de4aee](https://github.com/lobu-ai/lobu/commit/1de4aee458e9039396f62b6d357c1c5450040b27))
* **landing:** resolve zod parse error on connect-from route ([#271](https://github.com/lobu-ai/lobu/issues/271)) ([cef2284](https://github.com/lobu-ai/lobu/commit/cef2284ab1c1e10f1406f43301378036767dbafa))
* **landing:** wire benchmark methodology link and add tables to memory + comparison ([#276](https://github.com/lobu-ai/lobu/issues/276)) ([39a0436](https://github.com/lobu-ai/lobu/commit/39a043696a4910f931d885dfe6baa48f5570d0fe))
* **lobu-backend:** use parameter binding in content-search to prevent SQL injection ([#286](https://github.com/lobu-ai/lobu/issues/286)) ([65511c1](https://github.com/lobu-ai/lobu/commit/65511c1fc2eb13a3ebd180ca341a8d74ea57a877))


### Code Refactoring

* **core, worker:** drop unused public exports from @lobu/core ([#281](https://github.com/lobu-ai/lobu/issues/281)) ([7c5ffa4](https://github.com/lobu-ai/lobu/commit/7c5ffa40139add5f100cb34fcda4aa173b3180f2))

## [3.7.0](https://github.com/lobu-ai/lobu/compare/lobu-v3.6.0...lobu-v3.7.0) (2026-04-21)


### Features

* inline memory config into lobu.toml and rename devops→engineering ([#247](https://github.com/lobu-ai/lobu/issues/247)) ([1daf272](https://github.com/lobu-ai/lobu/commit/1daf2728bec2b374a52c2212231ae641f439e89a))
* **landing:** add memory benchmarks section + methodology docs ([#242](https://github.com/lobu-ai/lobu/issues/242)) ([28e2980](https://github.com/lobu-ai/lobu/commit/28e2980796ed037aca37f90ab7785f95050c83d0))
* **lobu-backend:** allow lobu.ai to embed app via CSP frame-ancestors ([#246](https://github.com/lobu-ai/lobu/issues/246)) ([6cbf3d2](https://github.com/lobu-ai/lobu/commit/6cbf3d29aafee5b5c80f389c25e54c9eb3afc267))
* **lobu:** absorb skills, benchmarks, and dev scripts from deprecated lobu repo ([#231](https://github.com/lobu-ai/lobu/issues/231)) ([ccef71e](https://github.com/lobu-ai/lobu/commit/ccef71e1b2e3c58d79a767a84f919777b724cc44))
* **lobu:** consolidate CLI profiles into lobu.toml ([#233](https://github.com/lobu-ai/lobu/issues/233)) ([577ec37](https://github.com/lobu-ai/lobu/commit/577ec3731c70faea3272128b26ad2787d4198a99))
* subdomain-aware SPA + SSR routing ([#234](https://github.com/lobu-ai/lobu/issues/234)) ([9c66f16](https://github.com/lobu-ai/lobu/commit/9c66f16cd4b16d96356de05e3aa401e6499f0d5e))


### Bug Fixes

* **ci:** initialize lobu-web submodule in landing deploy ([#229](https://github.com/lobu-ai/lobu/issues/229)) ([0dee7bc](https://github.com/lobu-ai/lobu/commit/0dee7bc8c229562b9335aa226f765af563fe25f5))
* **deps:** sync bun.lock with release-please 3.6.0 version bump ([#227](https://github.com/lobu-ai/lobu/issues/227)) ([e14500c](https://github.com/lobu-ai/lobu/commit/e14500c1ab0d60e50ad38c5c59b8b4f8fa45362b))
* **landing:** restore campaign description from runtime.request ([#250](https://github.com/lobu-ai/lobu/issues/250)) ([56eac67](https://github.com/lobu-ai/lobu/commit/56eac673486777867c5115ba174f019a0dbe245b))
* **lobu-backend:** resolve default org when loading social credentials ([#235](https://github.com/lobu-ai/lobu/issues/235)) ([90419cc](https://github.com/lobu-ai/lobu/commit/90419ccd931328f402f9dfbc16b97fb7f355a1a9))
* ship app.lobu.ai SPA + retire lobu.com defaults ([#230](https://github.com/lobu-ai/lobu/issues/230)) ([e3817d4](https://github.com/lobu-ai/lobu/commit/e3817d41732b51fcbde1b56e69b0da85a1fb51d8))
* **web:** bump lobu-web for history adapter import fix ([#237](https://github.com/lobu-ai/lobu/issues/237)) ([279a3ed](https://github.com/lobu-ai/lobu/commit/279a3edabeb32080168180f33cf42ccae11f9ef0))
* **web:** bump lobu-web for public-org auth-redirect fix ([#240](https://github.com/lobu-ai/lobu/issues/240)) ([f4641eb](https://github.com/lobu-ai/lobu/commit/f4641eb163bdc78fdc90dcd5d826f62360144e69))
* **web:** bump lobu-web for sidebar auth gating ([#238](https://github.com/lobu-ai/lobu/issues/238)) ([e51458e](https://github.com/lobu-ai/lobu/commit/e51458e2998705c987c4de84478719d34d093c3e))
* **web:** bump lobu-web for sidebar gating + add reserved-subdomain parity test ([#241](https://github.com/lobu-ai/lobu/issues/241)) ([8961e58](https://github.com/lobu-ai/lobu/commit/8961e5865e99d12996e70df1679188f38ad95458))
* **web:** bump lobu-web for subdomain history adapter ([#236](https://github.com/lobu-ai/lobu/issues/236)) ([a53c978](https://github.com/lobu-ai/lobu/commit/a53c978331acb9fff5b0b2eda2830dc68a6f42e5))

## [3.6.0](https://github.com/lobu-ai/lobu/compare/lobu-v3.5.0...lobu-v3.6.0) (2026-04-20)


### Features

* **backend:** wildcard trusted origins + reserved subdomain skip-list ([#214](https://github.com/lobu-ai/lobu/issues/214)) ([7656f2b](https://github.com/lobu-ai/lobu/commit/7656f2bf465a0cb2ea7eb91ec123c42ae015bb02))
* consolidate lobu into the lobu monorepo (PRs 1–4) ([#212](https://github.com/lobu-ai/lobu/issues/212)) ([a6d0d3f](https://github.com/lobu-ai/lobu/commit/a6d0d3f9a46696b5874e1a4029ab8f73e579a4e3))
* **gateway:** file-driven agent schedules in lobu.toml ([#211](https://github.com/lobu-ai/lobu/issues/211)) ([6b2eb51](https://github.com/lobu-ai/lobu/commit/6b2eb5128584d0d7d7cfaa38f203684ce422709f))
* **landing:** architecture diagram badges, blog section, and use-case chat examples ([#206](https://github.com/lobu-ai/lobu/issues/206)) ([969e5ee](https://github.com/lobu-ai/lobu/commit/969e5ee6e96858521187c7af8aaeeb35786516d3))
* **landing:** consolidate use-case demo into unified trace view ([#226](https://github.com/lobu-ai/lobu/issues/226)) ([c030fa7](https://github.com/lobu-ai/lobu/commit/c030fa709bcd9423224214276e3cd315cce67cff))
* **landing:** per-use-case chat switcher on platform pages ([#202](https://github.com/lobu-ai/lobu/issues/202)) ([f65cc35](https://github.com/lobu-ai/lobu/commit/f65cc3567a30059c8589264610f4531ec11e89e8))
* **landing:** publish agent-readiness signals for lobu.ai ([#208](https://github.com/lobu-ai/lobu/issues/208)) ([8360cef](https://github.com/lobu-ai/lobu/commit/8360cefd6401afa1271f21a01f11a09231aada09))


### Bug Fixes

* **ci:** skip web build when lobu-web is stubbed ([#222](https://github.com/lobu-ai/lobu/issues/222)) ([acee38a](https://github.com/lobu-ai/lobu/commit/acee38aae91b8389553800ccdbbace542460b89f))
* **docker:** build gateway dist + exclude tests from backend typecheck ([#219](https://github.com/lobu-ai/lobu/issues/219)) ([96b0033](https://github.com/lobu-ai/lobu/commit/96b00332c637262d6a22bc624ddee802e938d519))
* **docker:** name lobu-cli stub package as 'lobu' (unscoped) ([#215](https://github.com/lobu-ai/lobu/issues/215)) ([17fba3f](https://github.com/lobu-ai/lobu/commit/17fba3fac7b910f39d3bad256befa85e9ad9876c))
* **docker:** unzip in runtime + worker chromium install via bunx ([#216](https://github.com/lobu-ai/lobu/issues/216)) ([019253e](https://github.com/lobu-ai/lobu/commit/019253e8977cf8b0c14b38d5045abd6952b25a5c))
* **docker:** use bun run build for lobu-web (local vite) ([#221](https://github.com/lobu-ai/lobu/issues/221)) ([7734259](https://github.com/lobu-ai/lobu/commit/7734259b4886b2ab1cbb44468a689b8b5aff33f2))
* **gateway,worker:** deliver provider base URLs via session context only ([#225](https://github.com/lobu-ai/lobu/issues/225)) ([9171d37](https://github.com/lobu-ai/lobu/commit/9171d37d34cbe07fd004ee2e7842b8a66328e46b))
* **gateway:** isolate tsconfig from root bun-types ([#220](https://github.com/lobu-ai/lobu/issues/220)) ([c533e27](https://github.com/lobu-ai/lobu/commit/c533e274217d2af6177f902fd4cf0502f73192b5))
* **gateway:** Lobu MCP sync, Slack markdown/threading, tool-approval lifecycle, deployment coalescing ([#210](https://github.com/lobu-ai/lobu/issues/210)) ([92ce0eb](https://github.com/lobu-ai/lobu/commit/92ce0eb3308e4d4b476c96b60d5f8e45803d9597))
* **landing:** refine Lobu memory section copy ([#205](https://github.com/lobu-ai/lobu/issues/205)) ([9075d6c](https://github.com/lobu-ai/lobu/commit/9075d6c74f33716429b030c4406b10e28450b63d))
* **lobu-backend:** resolve *.lobu.ai as org subdomain under AUTH_COOKIE_DOMAIN ([#224](https://github.com/lobu-ai/lobu/issues/224)) ([c893aae](https://github.com/lobu-ai/lobu/commit/c893aaedb64ac3437e081641947dca297f390f79))
* **lobu-backend:** resolve typecheck errors blocking build-images ([#218](https://github.com/lobu-ai/lobu/issues/218)) ([7ce6271](https://github.com/lobu-ai/lobu/commit/7ce62711bd2c35d763d01f35426e24e07dc88bf4))
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
* make examples/ single source of truth for use cases and Lobu orgs ([3fc5380](https://github.com/lobu-ai/lobu/commit/3fc5380a720681d4b54ca88ff401dcaa7462db70))
* make Hero GitHub button contextual to active use case ([f1ca9fe](https://github.com/lobu-ai/lobu/commit/f1ca9fed7cfbe4326599e546109eca7f6a45bb05))
* make skills page init preview contextual to selected use-case ([146e87a](https://github.com/lobu-ai/lobu/commit/146e87ad8838c5dd03c5f27900636e05c527823f))
* **mcp-auth:** surface login prompts as platform link buttons ([9ca5449](https://github.com/lobu-ai/lobu/commit/9ca5449a48321db1e6a81f3ab1172b8768f272fc))
* migrate gateway to Hono and remove Express from worker ([#94](https://github.com/lobu-ai/lobu/issues/94)) ([499ab1b](https://github.com/lobu-ai/lobu/commit/499ab1b992267017872e90ecb2a662186cd574e3))
* migrate lobu examples to models/ directory with type field ([3deeb77](https://github.com/lobu-ai/lobu/commit/3deeb77f5eea1cd9d1124691e42430e3bb6fa496))
* migrate Lobu plugin to published @lobu/lobu-openclaw package ([b4666c5](https://github.com/lobu-ai/lobu/commit/b4666c50c375331aaf5fd2b8802b6891974459e0))
* migrate to Chat SDK platform adapters with typed OpenAPI schemas ([89573db](https://github.com/lobu-ai/lobu/commit/89573dbf3242249034f37543671db26493ccbd88))
* move workspace files to worker filesystem, fix CI, lint cleanup ([142d0c8](https://github.com/lobu-ai/lobu/commit/142d0c8c96a7eb9a0d6792809bbefbd2bbb7027e))
* multi-auth settings UX, base provider module refactor, and infra improvements ([1c61b30](https://github.com/lobu-ai/lobu/commit/1c61b30e931f68ee37b9d8775fcae66c1e95643c))
* multi-provider auth, MCP REST API, workspace instructions, dev tooling ([2e08491](https://github.com/lobu-ai/lobu/commit/2e084912a65f495d16f090a7abe2e37f08a356c8))
* **oauth:** add PKCE, RFC 8707 resource, auto-grants, and MCP token endpoint ([63336a7](https://github.com/lobu-ai/lobu/commit/63336a78d92999384fa873216668467a2787666c))
* **observability:** vendor-neutral OTEL tracing + opt-in Sentry ([#172](https://github.com/lobu-ai/lobu/issues/172)) ([f3345d3](https://github.com/lobu-ai/lobu/commit/f3345d364cfa28c9cc8f9c801041ccb1fd492b5c))
* **otel:** switch from OTLP HTTP to gRPC exporter (port 4317) ([60178db](https://github.com/lobu-ai/lobu/commit/60178db403596efadcd3124e367b06287f7696ba))
* Lobu memory plugin, plugin hooks/services, test infrastructure, and misc improvements ([89c27f0](https://github.com/lobu-ai/lobu/commit/89c27f0736e74fe83de6b1664017b21130cd489f))
* **proxy:** resolve provider credentials via URL path agentId ([1dbcb8c](https://github.com/lobu-ai/lobu/commit/1dbcb8c3c3a9ee6471733cedfcadf9ee5e1b3f6d))
* re-enable custom tools and remove unused claudeSessionId tracking ([2adb766](https://github.com/lobu-ai/lobu/commit/2adb766077f1d688ba93ca1994b260aff3f6e4b8))
* refactor settings page to Alpine.js with pre-compiled Tailwind ([2126001](https://github.com/lobu-ai/lobu/commit/2126001d4e720eae0b99c7b22cd9fcb342ea174a))
* refresh cli docs and restore release publish chain ([#179](https://github.com/lobu-ai/lobu/issues/179)) ([1ee0595](https://github.com/lobu-ai/lobu/commit/1ee0595d354b0dee1a85d4b3015fd1c9adcab4a0))
* refresh landing pages and pricing UX ([c8d8b58](https://github.com/lobu-ai/lobu/commit/c8d8b58fd6ea4b16583d67259e61839dc9ee1f52))
* rename CTA to "Open in Lobu" and open in new tab ([179fc23](https://github.com/lobu-ai/lobu/commit/179fc239b240a31aabd3d412a98035353b638924))
* settings page rewrite (Alpine→Preact), history page, Telegram enhancements, landing page ([b2cba55](https://github.com/lobu-ai/lobu/commit/b2cba551671812f2c54e9188fa74cc77ecd2f27c))
* **settings:** add generic OpenAI provider ([fcae8c3](https://github.com/lobu-ai/lobu/commit/fcae8c30497d52263787930588763b64934160ae))
* **settings:** add generic OpenAI provider ([f60e93a](https://github.com/lobu-ai/lobu/commit/f60e93af00324191d7f842cb4f99ec8501aa5e04))
* **settings:** post-install callback with agent resume ([d96e99b](https://github.com/lobu-ai/lobu/commit/d96e99b120054cebad862f788eef427faefb4e40))
* show nix packages in landing skill previews ([6095e13](https://github.com/lobu-ai/lobu/commit/6095e13447d9d7c3e6214a9995b9994645ee8bf9))
* **skills:** add scoring, URI, and system skill search to SearchSkills ([d63d7a8](https://github.com/lobu-ai/lobu/commit/d63d7a8e1a0b16dfcd8761a1ed54690cd84616c6))
* support Telegram webhooks when PUBLIC_GATEWAY_URL is set ([c3d266e](https://github.com/lobu-ai/lobu/commit/c3d266e59ef45c386bcf7ccbe3808dbf18abb3f4))
* wire file-first lobu memory config ([46c7554](https://github.com/lobu-ai/lobu/commit/46c7554d27284724333d5aa043316fe208f278b1))
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
* deduplicate lobu URL logic, fix skills card title, add skills link to memory reuse step ([78ad65e](https://github.com/lobu-ai/lobu/commit/78ad65e75faa689fbaa3715c0cc3eec1496c8527))
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
* **landing:** correct lobu demo links ([150a7c9](https://github.com/lobu-ai/lobu/commit/150a7c94f26b04e51271e6dc9074a649eb178099))
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
* make examples/ single source of truth for use cases and Lobu orgs ([3fc5380](https://github.com/lobu-ai/lobu/commit/3fc5380a720681d4b54ca88ff401dcaa7462db70))
* make Hero GitHub button contextual to active use case ([f1ca9fe](https://github.com/lobu-ai/lobu/commit/f1ca9fed7cfbe4326599e546109eca7f6a45bb05))
* migrate lobu examples to models/ directory with type field ([3deeb77](https://github.com/lobu-ai/lobu/commit/3deeb77f5eea1cd9d1124691e42430e3bb6fa496))
* rename CTA to "Open in Lobu" and open in new tab ([179fc23](https://github.com/lobu-ai/lobu/commit/179fc239b240a31aabd3d412a98035353b638924))
* wire file-first lobu memory config ([46c7554](https://github.com/lobu-ai/lobu/commit/46c7554d27284724333d5aa043316fe208f278b1))
* **worker:** redact sandbox leaks, replace base prompt identity, use signed artifact URLs ([a5c33d8](https://github.com/lobu-ai/lobu/commit/a5c33d818d9de4e0bef8fd1710a2244f8592e33f))


### Bug Fixes

* **eval:** isolate trials + feat(worker): MCP-as-CLI for embedded mode ([#184](https://github.com/lobu-ai/lobu/issues/184)) ([c256d6d](https://github.com/lobu-ai/lobu/commit/c256d6d2604b514df9eb2c5658524079286e73b9))
* **landing:** clarify use-case source CTA ([d0b64f2](https://github.com/lobu-ai/lobu/commit/d0b64f2367c4c0f7e8c815c2ae89d92047ae38d8))
* **landing:** correct lobu demo links ([150a7c9](https://github.com/lobu-ai/lobu/commit/150a7c94f26b04e51271e6dc9074a649eb178099))
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
* deduplicate lobu URL logic, fix skills card title, add skills link to memory reuse step ([78ad65e](https://github.com/lobu-ai/lobu/commit/78ad65e75faa689fbaa3715c0cc3eec1496c8527))
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
* migrate Lobu plugin to published @lobu/lobu-openclaw package ([b4666c5](https://github.com/lobu-ai/lobu/commit/b4666c50c375331aaf5fd2b8802b6891974459e0))
* migrate to Chat SDK platform adapters with typed OpenAPI schemas ([89573db](https://github.com/lobu-ai/lobu/commit/89573dbf3242249034f37543671db26493ccbd88))
* multi-auth settings UX, base provider module refactor, and infra improvements ([1c61b30](https://github.com/lobu-ai/lobu/commit/1c61b30e931f68ee37b9d8775fcae66c1e95643c))
* **oauth:** add PKCE, RFC 8707 resource, auto-grants, and MCP token endpoint ([63336a7](https://github.com/lobu-ai/lobu/commit/63336a78d92999384fa873216668467a2787666c))
* Lobu memory plugin, plugin hooks/services, test infrastructure, and misc improvements ([89c27f0](https://github.com/lobu-ai/lobu/commit/89c27f0736e74fe83de6b1664017b21130cd489f))
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
