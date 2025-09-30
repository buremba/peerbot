# Changelog

## [2.0.0](https://github.com/buremba/peerbot/compare/v1.0.6...v2.0.0) (2025-09-30)


### ⚠ BREAKING CHANGES

* Database schema changed - requires fresh migration

### Features

* add ENCRYPTION_KEY to orchestrator deployment ([61d1ba3](https://github.com/buremba/peerbot/commit/61d1ba3d76a90d131a477f816a9c3fb2b96b0dcb))
* add environment variable encryption and improve Slack handlers ([87fa08a](https://github.com/buremba/peerbot/commit/87fa08a673344423280494e85b7ea81eaf4ec6c7))
* add gVisor runtime support for enhanced Docker isolation ([90c4c5f](https://github.com/buremba/peerbot/commit/90c4c5f844e25d7d8d562b7116eb20efa52f7e13))
* add integration tests and fix type errors ([28e5229](https://github.com/buremba/peerbot/commit/28e522912c932806ee57ba82c0f727818a280014))
* add kata runtime support for enhanced container isolation ([60c3ee1](https://github.com/buremba/peerbot/commit/60c3ee136e1bd778f2a8c34c90e58854d66356e8))
* add PostgreSQL schema initialization to Helm chart ([1569127](https://github.com/buremba/peerbot/commit/1569127860d0dd7412e84d22c9e61c6ca2509cee))
* add slash commands and channel-aware environment storage ([f0abbd4](https://github.com/buremba/peerbot/commit/f0abbd4ddd9add116a5dfad839db4bc49c68933c))
* add subprocess deployment manager with bubblewrap sandboxing ([d877c74](https://github.com/buremba/peerbot/commit/d877c743b1ac79bd43bfed604bb1bb50ad82bbb8))
* add welcome message for new team members ([8f7b0b3](https://github.com/buremba/peerbot/commit/8f7b0b3d56d02ea40cb033137cd304097b169c06))
* cleanup deprecated code, implement TODOs, and improve logging ([2af7546](https://github.com/buremba/peerbot/commit/2af754678460529ed7907c1bb54f280cf8180c8d))
* cleanup deprecated code, implement TODOs, and improve logging ([f7b479d](https://github.com/buremba/peerbot/commit/f7b479da1d6e33d4795c8c7ec64b724b5e376d6d))
* consolidate error classes into shared package ([e29ab36](https://github.com/buremba/peerbot/commit/e29ab36825935ab6cadb84abe6f600e6ab8b71d7))
* consolidate error classes into shared package ([495c1f9](https://github.com/buremba/peerbot/commit/495c1f9ac89ee722c41319f6c8e90e7952254213)), closes [#56](https://github.com/buremba/peerbot/issues/56)
* enhance GitHub integration and update Docker configuration ([c777d7b](https://github.com/buremba/peerbot/commit/c777d7be4e1bac3354e71d34ee27ce1e970e4718))
* implement context-aware environment storage ([afb50cd](https://github.com/buremba/peerbot/commit/afb50cd9c29db912417eaa5c74c3103319b83636))
* implement direct environment variable storage for BlockKit forms ([87a749c](https://github.com/buremba/peerbot/commit/87a749cbbbd43bf53099561a9723f0ffe2e647d2))
* increase PVC quota limit from 5 to 100 ([154f3d6](https://github.com/buremba/peerbot/commit/154f3d6373b8392f099ff10217da048dec04fa9c))
* optimize worker resources and increase capacity for 30+ workers ([898d04c](https://github.com/buremba/peerbot/commit/898d04c09ca6b270ad9cfb2c0a9f35307def14c3))
* replace image-puller DaemonSet with Spegel P2P image distribution ([e8c78a3](https://github.com/buremba/peerbot/commit/e8c78a30f9663a0ae9201b17ee155228b871bb92))
* replace image-puller DaemonSet with Spegel P2P image distribution ([b49dce6](https://github.com/buremba/peerbot/commit/b49dce60e9646566125edc6f0e9cc5542e2956e8)), closes [#52](https://github.com/buremba/peerbot/issues/52)
* update slash commands and add global shortcuts ([bc4ca4f](https://github.com/buremba/peerbot/commit/bc4ca4f43c46ed6543857178c65b26a0076126c2))


### Bug Fixes

* add automatic handling of stuck Helm releases in deployment ([83963ae](https://github.com/buremba/peerbot/commit/83963ae4b18b995aa40a1a04b2a9b66959296565))
* add backward compatibility for environment variable encryption ([949fd58](https://github.com/buremba/peerbot/commit/949fd5828d7dc7a16b5726d7e84a25c7f59c9cc2))
* Add explicit npm authentication step in release workflow ([1fc0eab](https://github.com/buremba/peerbot/commit/1fc0eab307bf9ec9e361936e64affb8d0ea13a0d))
* add GitHub Container Registry authentication for OCI charts in workflows ([a15ebdc](https://github.com/buremba/peerbot/commit/a15ebdcf9f1e87d9cfb5369500b7dc58ff9b2d01))
* add resource limits to Spegel for quota compliance ([101d41e](https://github.com/buremba/peerbot/commit/101d41e18b893d2a8defa5852e8b0231bf067f7c))
* add slash commands to Slack app manifest ([eb4f5f3](https://github.com/buremba/peerbot/commit/eb4f5f37be861a422b6030fa269c52daa7d3bcb6))
* add timeout and debugging for stuck deployments ([cbd0218](https://github.com/buremba/peerbot/commit/cbd021895d97ba38939ae4ef91350f84f056c4e8))
* change slash command back to /peerbot ([55e8f15](https://github.com/buremba/peerbot/commit/55e8f15e9fe11f2f8c333272304cf36b04240117))
* cleanup more Helm release secrets to stay under quota ([48eefbe](https://github.com/buremba/peerbot/commit/48eefbef0c6076ae3c65da52ff0e277c3fed3744))
* completely remove imagePuller and fix Helm dependency management ([a96aeeb](https://github.com/buremba/peerbot/commit/a96aeeb814174d91ab8744b360943925cbebd83f))
* consolidate database schema initialization in Helm ConfigMap ([7a1fd29](https://github.com/buremba/peerbot/commit/7a1fd29902768644880c55cb89df12d478323988))
* correct deployment command syntax in GitHub workflow ([765b170](https://github.com/buremba/peerbot/commit/765b170ff7fff8e256b45f4c87a5b66abab02f51))
* correct Docker image repository names in Makefile ([3c4d535](https://github.com/buremba/peerbot/commit/3c4d5358bd51d03d2e1d06f577b8a8fa498ae9f4))
* correct Makefile syntax error in TARGET handling ([f53ece5](https://github.com/buremba/peerbot/commit/f53ece5d268413d77c55b0d50100adf2c5a74c91))
* correct Sentry postgres integration import ([25e9353](https://github.com/buremba/peerbot/commit/25e9353f5fd49126a411ca1603f5e07949dfc686))
* correct Sentry postgres integration import ([6d28818](https://github.com/buremba/peerbot/commit/6d28818d4b80c782e3f9cc232ebe3cc113d57659)), closes [#50](https://github.com/buremba/peerbot/issues/50)
* correct Spegel resource format to match chart structure ([c60eaf5](https://github.com/buremba/peerbot/commit/c60eaf543a4e5af03f71747897e77dc8167423ce))
* Create GitHub repositories in user's space instead of organization ([8624626](https://github.com/buremba/peerbot/commit/862462695811ce9d1ab325af131ec89dad2423dc))
* downgrade @kubernetes/client-node to 0.21.0 to fix build errors ([8195f6b](https://github.com/buremba/peerbot/commit/8195f6b72712ed4f00e36a1241a68413f190cac9))
* ensure PostgreSQL user exists when reusing K8s secrets ([d58569b](https://github.com/buremba/peerbot/commit/d58569b93f7405d75fa2160583bf0fbf1f516884))
* force clear stuck Helm releases by deleting state secrets ([b4b00ba](https://github.com/buremba/peerbot/commit/b4b00ba9e04e028dd336212baf73fbad4f623ce1))
* format code with biome ([83d81cc](https://github.com/buremba/peerbot/commit/83d81cc7bdb52f15489f68730d94672ef72f4611))
* format slack-app-manifest.json to pass CI checks ([cd2e119](https://github.com/buremba/peerbot/commit/cd2e119b3269bff2532b981ee905e6802ff5c1cf))
* handle PostgreSQL StatefulSet immutable field updates in deployment ([affaf10](https://github.com/buremba/peerbot/commit/affaf103f3f3c43ce4d06c43ae52161ec23a7753))
* handle PostgreSQL StatefulSet update conflicts in deployment ([7d88920](https://github.com/buremba/peerbot/commit/7d88920952c90d06de9a341b2ecbafba2edd6bf9))
* handle Try Demo button from home tab and database constraints ([7ad143a](https://github.com/buremba/peerbot/commit/7ad143ab31beb6066f929f8abddb8a12e1a9594d))
* improve error handling for PVC quota exceeded errors ([45ef739](https://github.com/buremba/peerbot/commit/45ef739c6702a0cb6a5759076502999becf3dc78))
* improve Helm release state handling in deployment workflow ([a878c28](https://github.com/buremba/peerbot/commit/a878c28011218f284175e5fe04b85b1ce3ee3db7))
* improve K8s deployment error handling and debugging ([024d4bc](https://github.com/buremba/peerbot/commit/024d4bc581f907b072ddd2879512d3b1d5d18f73))
* improve K8s deployment error handling with detailed PVC logging ([e5e809c](https://github.com/buremba/peerbot/commit/e5e809c58109adcbdbf0228f845e0b52d96d18a2))
* include all Helm releases in state check including failed/pending ([349a4b8](https://github.com/buremba/peerbot/commit/349a4b8924d306cedfec0a9951f7b58c1d0cde1e))
* increase secret quota to 100 for Helm releases ([663c181](https://github.com/buremba/peerbot/commit/663c1810da09745814f99568bf65697ba5603b4a))
* make GITHUB_TOKEN optional in dispatcher deployment ([ef1b004](https://github.com/buremba/peerbot/commit/ef1b004a296bbe91f1aada7392b3f784c1cf0e25))
* make github-token optional in worker deployments ([edadc33](https://github.com/buremba/peerbot/commit/edadc33d5f51f5a5f2307e751f64b97fb12e68ea))
* make Slack notifications optional in deployment workflow ([65fdce8](https://github.com/buremba/peerbot/commit/65fdce83eb6bb4f50c89fa6863708ac0715b6080))
* move GitHub Container Registry login to same step as helm commands ([358b241](https://github.com/buremba/peerbot/commit/358b241e3502ba8185c286ddd55e0c101ead0e52))
* preserve VALUES_FILE variable throughout Makefile deploy target ([b2022f7](https://github.com/buremba/peerbot/commit/b2022f7f22f327f45bdf348c67ac4fb0085558b1))
* remove duplicate ENCRYPTION_KEY environment variable ([f991fa5](https://github.com/buremba/peerbot/commit/f991fa56f4bcc5a3ad817ad41d6c2a2a2a2f264d))
* remove duplicate values file logic in Makefile ([24ad6f0](https://github.com/buremba/peerbot/commit/24ad6f08947082d5b7905eeadfcb96497b5bc1e6))
* remove K8s-specific database initialization ([4c7924f](https://github.com/buremba/peerbot/commit/4c7924f0e71d3842c589bd9d1c1ae50e92021386))
* remove Slack notifications from deployment workflow ([9d9d8bd](https://github.com/buremba/peerbot/commit/9d9d8bd1488b7d58eee52e6bb1ffd4db6eb3c9e9))
* resolve CI failures - correct Sentry import and format code ([4c27e7f](https://github.com/buremba/peerbot/commit/4c27e7fac84014c06f274cad3ea84880505a25b1))
* resolve CI failures and add pre-commit hooks ([0173fe3](https://github.com/buremba/peerbot/commit/0173fe36a5d775a8e74729059b6a117de7ab59f1))
* resolve critical issues from code review ([912232d](https://github.com/buremba/peerbot/commit/912232ddc46e9a25bed7f49f2823d1ffaa3fe15d))
* resolve PostgreSQL StatefulSet upgrade issues properly ([9a17db2](https://github.com/buremba/peerbot/commit/9a17db2853308e98e2cf1a184ef0d9ec22a6d65d))
* resolve Slack form submission timeout issues ([0238283](https://github.com/buremba/peerbot/commit/023828358c5139f18da3f14ab9483d6ae359ecb3))
* resolve TypeScript and formatting issues for CI pipeline ([1e7b3e2](https://github.com/buremba/peerbot/commit/1e7b3e2a65bb20ee2222a4cceaab964343a24a35))
* restore slack-qa-bot.js and update E2E test script ([f0f5bf5](https://github.com/buremba/peerbot/commit/f0f5bf59e67d631c591513cf5d7c3e29c45baad5))
* simplify deployment by using Makefile properly ([558af50](https://github.com/buremba/peerbot/commit/558af5088c7b340f57460e5f76269aee013a403a))
* TypeScript and lint errors in Slack handlers ([943fae6](https://github.com/buremba/peerbot/commit/943fae6d51f25fbebac213df11ddab89ac8a8991))
* update slack thread processor imports ([207a173](https://github.com/buremba/peerbot/commit/207a173230272bbdff8d315d96d1f79f4d80272d))
* update Spegel to v0.4.0 and add Helm artifacts to gitignore ([32a4964](https://github.com/buremba/peerbot/commit/32a4964e667e70f5c1d7e416b3281ba1dbf6af0f))
* use demo repository as default instead of creating user repos ([17d0303](https://github.com/buremba/peerbot/commit/17d030359a3ed3674f3e2cca21c0031d975fa434))
* use Helm directly in deployment workflow instead of make ([2320d4a](https://github.com/buremba/peerbot/commit/2320d4ab8686879b8215b29f51fbe2fcedca87e1))


### Code Refactoring

* consolidate environment variables and streamline CI/CD ([e24b185](https://github.com/buremba/peerbot/commit/e24b185a4f4edc775730ac759efbcf64a78ea58d))

## [1.0.6](https://github.com/buremba/peerbot/compare/v1.0.5...v1.0.6) (2025-09-16)


### Bug Fixes

* add Helm release cleanup to prevent quota exceeded errors ([cbe8762](https://github.com/buremba/peerbot/commit/cbe8762a94acca14fec7933b7705f56bf4184b13))
* enable OVH deployment and fix GitHub Actions workflows ([408c36b](https://github.com/buremba/peerbot/commit/408c36b2c3b94cff00f2a46998f1234efdbb01da))
* handle stuck Helm deployments and use correct image tags ([bf83c61](https://github.com/buremba/peerbot/commit/bf83c61cda61530dcc345006e640693a37523a86))
