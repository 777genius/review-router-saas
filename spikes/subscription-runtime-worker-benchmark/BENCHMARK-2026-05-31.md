# Codex App-Server Worker Benchmark - 2026-05-31

Environment:

- Host: local macOS developer machine
- Codex CLI: `codex-cli 0.125.0`
- Auth: local `~/.codex/auth.json`
- Model: `gpt-5.5`
- Reasoning: `low`
- Prompt: `Return exactly OK.`
- Runtime path: file backend worker, lazy refresh, worker-cache materializer,
  app-server engine, `codex exec` fallback enabled.

Smoke:

| slots | tasks |  ok | failed | total ms | p50 ms | p95 ms | RSS delta MB | heap delta MB | CPU user ms | CPU system ms |
| ----: | ----: | --: | -----: | -------: | -----: | -----: | -----------: | ------------: | ----------: | ------------: |
|     1 |     1 |   1 |      0 |   27,209 | 18,490 | 18,490 |         -5.8 |           2.0 |         241 |         1,192 |

Matrix:

| slots | tasks |  ok | failed | total ms | p50 ms | p95 ms | max ms | RSS delta MB | heap delta MB | CPU user ms | CPU system ms |
| ----: | ----: | --: | -----: | -------: | -----: | -----: | -----: | -----------: | ------------: | ----------: | ------------: |
|     1 |     4 |   4 |      0 |   91,680 | 46,785 | 90,206 | 90,206 |         -1.4 |           2.8 |         801 |         5,627 |
|     2 |     4 |   4 |      0 |   36,707 | 14,878 | 35,894 | 35,894 |         -2.3 |          -1.0 |         310 |         2,575 |
|     4 |     4 |   4 |      0 |   32,104 | 19,627 | 27,086 | 27,086 |         25.2 |           4.2 |         783 |         7,082 |
|     8 |     8 |   8 |      0 |   58,450 | 41,549 | 48,827 | 48,827 |         71.4 |          29.6 |       1,594 |        12,830 |

Findings:

- The app-server worker path works end to end with real Codex auth.
- Two slots gave the best latency/cost balance in this short benchmark.
- Four slots worked, but CPU system time increased and RSS grew by about 25 MB.
- Eight slots worked without failures, but memory grew by about 71 MB and p50
  was worse than the 2-slot run.
- This is not yet a memory-leak proof. Before production high-throughput use,
  run a 50-100 task soak with fixed prompt/model and compare RSS after forced
  slot recycle.

Recommended beta defaults:

- Start with 2 slots per provider account.
- Allow 4 slots behind an explicit host config flag.
- Treat 8 slots as experimental until a 50-100 task soak is green.
