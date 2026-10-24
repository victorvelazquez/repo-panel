# Changelog

## [0.1.0](https://github.com/victorvelazquez/repo-panel/compare/v0.0.2...v0.1.0) (2026-10-24)


### Features

* **autostart:** add Windows logon scheduled task scripts ([580ba53](https://github.com/victorvelazquez/repo-panel/commit/580ba539dacd30933e56b46c7c00ad64a311d3cf))
* **board:** assign group chip colors by config order ([fe3815e](https://github.com/victorvelazquez/repo-panel/commit/fe3815ee85a1adcfa3b6fbe58c58b2a8abce1c7f))
* **board:** compact cards and move merge options to the header ([86d2f4c](https://github.com/victorvelazquez/repo-panel/commit/86d2f4ce07be104850c7e44bb7b1c2af7e597d66))
* **board:** flag merged branches that still need /flow-branch (RP4) ([#13](https://github.com/victorvelazquez/repo-panel/issues/13)) ([cd9e1dd](https://github.com/victorvelazquez/repo-panel/commit/cd9e1dda0a21062cfba93238e815fabe0db0e3b3))
* **board:** link repo names to GitHub and fold needs-attention into open PRs ([5452cab](https://github.com/victorvelazquez/repo-panel/commit/5452cab5197af1b7b4c626d70ece6f84083a7cfb))
* **board:** show behind-remote count in clean rows and keep ready PRs snoozed ([#10](https://github.com/victorvelazquez/repo-panel/issues/10)) ([3369ef3](https://github.com/victorvelazquez/repo-panel/commit/3369ef3470e6c39a586c33ac3bc5d0e848eab7cb))
* **board:** show group chip before repo name and wrap long chips ([2bfbc35](https://github.com/victorvelazquez/repo-panel/commit/2bfbc351560bf0e224c2ea3a5ea8ffa2867693ef))
* **board:** snooze PRs and fit all columns on screen ([d558c36](https://github.com/victorvelazquez/repo-panel/commit/d558c363bfa865040519da9f957101fcf29906ad))
* **conformity:** add roadmap conformity drawer view (RP6) ([7b389bf](https://github.com/victorvelazquez/repo-panel/commit/7b389bf1d77cc41db25518fecf34910dea18da02))
* **pi:** add button to type /flow-commit into the open pi session (RP8) ([e0295a7](https://github.com/victorvelazquez/repo-panel/commit/e0295a70bfd99a3008c47a41956c5aa1fbe0f7d1))
* **queue:** add Go work on strip with ordered action list (RP5) ([bdcc517](https://github.com/victorvelazquez/repo-panel/commit/bdcc51710972bbb3a1626a6e6cec49dfa92b5dd5))
* **requirements:** add put-in-conditions order and dismissible warning ([c419df0](https://github.com/victorvelazquez/repo-panel/commit/c419df02ffc7f9c0bba248d6ce2ff2ebe22f986d))
* **requirements:** RP10a add machine-checkable requirements registry ([#26](https://github.com/victorvelazquez/repo-panel/issues/26)) ([9aadd01](https://github.com/victorvelazquez/repo-panel/commit/9aadd015380b8c8979a942182577c7da39f21aa7))
* **roadmap:** add pure parseRoadmap parser (RP1) ([94b7658](https://github.com/victorvelazquez/repo-panel/commit/94b7658d6e3161bb8ac5754aa0c999e4d444f04d))
* **roadmap:** compute Lista, En revisión and derived En curso unit states (RP3b) ([6a7a409](https://github.com/victorvelazquez/repo-panel/commit/6a7a40932b583feeac8f94b9a25c753bc55fd496))
* **roadmap:** serve GET /api/roadmap from the remote base branch (RP2) ([3452991](https://github.com/victorvelazquez/repo-panel/commit/345299188ba7da59db7425a8a7951545d7569623))
* **roadmap:** show unit progress and problems on repo cards (RP3) ([548b95d](https://github.com/victorvelazquez/repo-panel/commit/548b95d4fd702c64e8d9dc29d061346a56f8d1fc))
* **rooms:** RP11a add rooms with membership, requirements and presence ([#28](https://github.com/victorvelazquez/repo-panel/issues/28)) ([bc37320](https://github.com/victorvelazquez/repo-panel/commit/bc373209a31331b7f097b9666748b8ca4e82d259))
* **rooms:** RP11b create, assign and remove rooms from the panel ([#29](https://github.com/victorvelazquez/repo-panel/issues/29)) ([502b819](https://github.com/victorvelazquez/repo-panel/commit/502b819fb4540782b8db463e6ad97c406c1404ee))
* **server:** detect a running panel on port conflict via /health ([64485da](https://github.com/victorvelazquez/repo-panel/commit/64485da8cf94b48940e1aff7eb8680763ddb8c4c))


### Bug Fixes

* **ui:** warn on outdated server and stop false conformity claims ([c4798ac](https://github.com/victorvelazquez/repo-panel/commit/c4798ac1e6f83d938240cfd68c9943627709d1e3))

## [0.0.2](https://github.com/victorvelazquez/repo-panel/compare/v0.0.1...v0.0.2) (2026-10-22)


### Bug Fixes

* **test:** run tests on Node 20 by dropping the unsupported glob argument ([6c5274b](https://github.com/victorvelazquez/repo-panel/commit/6c5274bcbd4b6f0e8da86312d3c8efbb735954b8))
