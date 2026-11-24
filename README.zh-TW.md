# Agent Orchestra

[English](README.md) · **繁體中文**

[![test](https://github.com/Yanzzz42/agent-orchestra/actions/workflows/test.yml/badge.svg)](https://github.com/Yanzzz42/agent-orchestra/actions/workflows/test.yml)

讓你付費的每一個 AI 訂閱都派上用場。Agent Orchestra 把 Claude Code 變成團隊領導：Claude 拆解任務，分派給 **Codex**、**Gemini**、**Gemini Flash**、**透過 Antigravity 的 Claude Opus** 和 **GitHub Copilot**，驗收它們的成果，並接手其他人做不完的工作。即時儀表板會顯示誰在做什麼、每個模型還剩多少額度。

## 功能

- **Claude Code 的 `/team` 指令**：在任何專案輸入 `/team <任務>`，Claude 就會規劃、派工、驗收。
- **額度用完自動交接**：「用量不足」不算失敗。任務會交給下一個還有額度的模型，並告訴它從前一位中斷的地方接著做；最後一棒是 Claude 自己。
- **等待重置後接續**：加上 `--wait`，任務會暫停到該模型的額度重置，再自動接續原本的對話。
- **即時儀表板**（`http://localhost:4747`）：每個模型一欄，顯示任務、token、額度狀態與重置時間，加上 Claude 的決策時間軸。
- **用量查詢**：`/team 用量` 列出各模型剩餘額度（Codex 官方的 5 小時與每週百分比、Copilot credits、每日 token）。
- **多專案自動駕駛**（選用）：在儀表板勾選專案，Claude 每 3 小時輪流優化，直到額度用完。每個專案可選「測試通過自動發佈」或「只 commit 不發佈」。
- **用量守護**：Claude 每週用量達到你設定的門檻時，自動駕駛會暫停，每週額度重置後自動恢復。

## 需求

- macOS、Linux 或 Windows 10/11（Windows 為實驗性支援）、[Node.js](https://nodejs.org) 18 以上（不需要安裝任何 npm 套件）
- [Claude Code](https://claude.com/claude-code)
- 下列 CLI 至少一個，並登入你自己的帳號：

| Agent | CLI | 適合做什麼 |
|---|---|---|
| `codex` | [Codex CLI](https://github.com/openai/codex)（ChatGPT 桌面版也內建） | 寫程式、跑測試、修 bug |
| `opus` | Antigravity CLI `agy`（Google Antigravity／Gemini 桌面版內建） | 用 Google AI 方案「Claude and GPT models」的額度呼叫 Claude Opus，不扣你的 Claude 訂閱用量 |
| `gemini` | `agy` | 長文件、研究、code review、第二意見 |
| `flash` | `agy` | 便宜快速的雜事：摘要、翻譯、產生測試資料 |
| `copilot` | [GitHub Copilot CLI](https://github.com/github/copilot-cli) | 備援寫手（每次呼叫扣 AI credits） |

沒有安裝的模型會自動跳過。

## 安裝

```bash
git clone https://github.com/Yanzzz42/agent-orchestra.git
cd agent-orchestra
./install.sh        # Windows 用 install.cmd
```

安裝程式會把 `/team` skill 複製到 `~/.claude/skills/team`（路徑會自動填好），並執行 `doctor` 列出找到哪些 CLI。之後隨時可以再跑 `node orchestra/dispatch.mjs doctor`。

## 使用方式

在 Claude Code 裡、任何專案中：

```
/team 幫解析器補上測試，並修好測出來的問題
/team 用量
/team 儀表板
/team 設定自動駕駛
```

也可以直接派工：

```bash
node orchestra/dispatch.mjs codex --write --cwd ~/code/my-app --title "補測試" "幫 src/parser.ts 寫單元測試並讓它們通過"
node orchestra/dispatch.mjs flash "用 5 點摘要 CHANGELOG.md"
node orchestra/dispatch.mjs usage
```

沒有加 `--write` 的任務都是唯讀。結束碼：`0` 完成、`1` 失敗、`3` 等待額度重置、`4` 交給 Claude 接手。

### 額度用完時的接手順序

| 原本 | 依序交給 |
|---|---|
| codex | opus → gemini → copilot → Claude |
| opus | codex → flash → Claude |
| gemini | opus → flash → Claude |
| flash | opus → gemini → Claude |
| copilot | codex → opus → Claude |

每個任務可以用 `--fallback a,b` 自訂順序，或用 `--wait`／`--fallback none` 改成等額度重置。

## 儀表板

```bash
node orchestra/server.mjs   # http://localhost:4747
```

工作時讓它開著：等待額度重置的任務也是靠它自動接續。它只開放給本機（`127.0.0.1`）。

## 自動駕駛（選用）

1. 輸入 `/team 設定自動駕駛`。在 Claude 桌面版會建立每 3 小時喚醒一次的排程任務；其他環境 Claude 會給你 prompt，用 cron 搭配 `claude -p` 執行。
2. 在儀表板加入專案資料夾，選擇 **只 commit 不發佈** 或 **測試通過自動發佈**，再逐一開啟。
3. 設定用量守護門檻（預設 Claude 每週用量 80%）。

每個專案在 `autopilot/<專案>.md` 有自己的規則檔與可以自行編輯的待辦清單。共通的安全規則在 [`autopilot/RULES.md`](autopilot/RULES.md)：有未 commit 修改的專案會跳過、絕不 force push、不碰金鑰，發佈後健康檢查失敗會自動 revert。

> ⚠️ 「測試通過自動發佈」會在沒有人審查的情況下上線。建議先用 **只 commit 不發佈**，確認它在你的專案上表現可靠再改。

## 設定

把 `orchestra/config.example.json` 複製成 `orchestra/config.json`，就可以修改 CLI 路徑、預設模型、Copilot credits 上限。環境變數 `CODEX_BIN`、`AGY_BIN`、`COPILOT_BIN` 優先於設定檔。

Claude 的分工規則寫在 [`CLAUDE.md`](CLAUDE.md)，想調整誰做什麼就改這份。

## 運作方式

```
orchestra/
  dispatch.mjs   執行 CLI、偵測用量不足、交接、記錄事件
  quota.mjs      冷卻時間、等待佇列、用量報表
  autopilot.mjs  專案清單、開關、用量守護
  server.mjs     儀表板伺服器（SSE）＋自動接續等待中的任務
  index.html     儀表板
  runs/          事件紀錄與輸出（只在本機，不進 git）
autopilot/       共通規則、專案範本、排程任務 prompt
skill/team/      /team skill（由 install.sh 安裝）
```

## 限制

- 作者每天在 macOS 上使用。Linux 與 Windows 每次推送都會跑自動測試，但 Windows 上登入帳號的實際使用還沒有回報，遇到問題歡迎開 issue。
- 儀表板與給 Claude 的指示是繁體中文，Claude 會用你的語言回覆。
- 用量不足的偵測依賴各 CLI 的錯誤訊息。Codex 會給確切的重置時間；其他 CLI 沒給時會用估計值（預設 1 小時）。
- Antigravity 的剩餘額度無法用程式查詢，請到 Antigravity 的 **Settings › Models** 查看。
- 請自行遵守各服務的使用條款。

## 授權

[MIT](LICENSE)
