# 多模型協作環境

Claude 是決策者：拆解任務、決定派給誰、整合與驗收結果。
實際的大量產出盡量交給 Codex / Gemini / Copilot，以節省 Claude 的 token。

## 派工指令

```bash
node orchestra/dispatch.mjs <codex|gemini|flash|copilot> [--write] [--model M] [--cwd DIR] [--title 短標題] "prompt"
node orchestra/dispatch.mjs note "為什麼這樣分工"
```

- 從 Bash 工具呼叫且沒有用管線餵 prompt 時，結尾加 `</dev/null`，否則 dispatch 會一直等 stdin。
- 預設唯讀；需要改檔才加 `--write`（Codex 用 workspace-write 沙盒，Gemini 用 accept-edits，Copilot 開放所有工具但路徑限於 cwd；唯讀時 Copilot 會拿掉 write / shell 工具）。
- Gemini / Flash 在派工模式下不能執行終端指令（沒人能核准，跑了會中斷任務），dispatch 已在 prompt 裡禁止。需要跑指令或測試的任務派給 Codex 或 Copilot。
- 互不相依的子任務用背景 Bash 同時派出，完成後再整合。
- 每次派工前先用 `note` 記一句分工理由，儀表板會顯示。
- 儀表板：`node orchestra/server.mjs` → http://localhost:4747（等待重置的任務也靠它自動接續，派工時要讓它開著）

## 額度與用量不足

```bash
node orchestra/dispatch.mjs usage            # 各 agent 是否可用、何時重置、今天 / 7 天 token、Codex 官方百分比、Copilot credits
```

- 大批派工前先跑 `usage`，正在冷卻的 agent 不要排它的工作。
- 用量不足不算失敗（儀表板顯示「用量不足」）。dispatch 會自動交給下一個有額度的 agent 接手，並把「前一位做到一半、先檢查現況再接續」寫進 prompt：
  - codex → opus → gemini → copilot → Claude；opus → codex → flash → Claude；copilot → codex → opus → Claude；gemini → opus → flash → Claude；flash → opus → gemini → Claude
  - Antigravity 有兩個額度池：Gemini Models（Neon、Carbon、Argon、Hydrogen、3.8 Flash 共用，有 5 小時與每週上限；gemini 與 flash 都扣這池）、Claude and GPT models（opus）。使用者可在 Antigravity 的 Settings › Models 看剩餘百分比。
  - `--fallback a,b` 自訂接手順序；`--fallback none` 或 `--wait` 則不交接，排隊等該 agent 額度重置後由 server 接續原本的對話。
  - 要接續同一段對話脈絡（大型改寫做到一半）用 `--wait`；趕時間用預設交接。
- 冷卻中的 agent 會被直接跳過（不浪費呼叫），重置時間一過就自動恢復派給它。
- 結束碼：0 完成、1 失敗、3 等待重置、4 交給 Claude 接手。

## 自動駕駛

儀表板上方的專案清單控制 `orchestra/autopilot.json`：可加入任何專案資料夾、逐一開關、各自選「測試通過自動發佈」或「只 commit 不發佈」。
排程任務「多專案自動駕駛」每 3 小時喚醒 Claude，先跑 `dispatch.mjs autopilot check`：沒有開啟的專案就立刻結束；
有的話照 `autopilot/RULES.md`（共通）和 `autopilot/<專案id>.md`（各專案資訊、待辦、紀錄）在專案間輪流優化，直到額度用完。

用量守護：儀表板可設定「Claude 每週用量達 N% 時暫停」（預設 80%）。每輪開始與每做完一項，排程都用 `mcp__ccd_session_mgmt__get_usage` 讀用量並執行 `autopilot guard`；達到門檻就暫停到每週額度重置後自動恢復，讀不到用量則該輪不執行。

```bash
node orchestra/dispatch.mjs autopilot guard <每週%> <每週重置時間 ISO> [5 小時%]   # 回報用量，結束碼 12 = 已達門檻
node orchestra/dispatch.mjs autopilot add <資料夾> [--title 名稱] [--publish auto|commit]   # 也可以在儀表板加
node orchestra/dispatch.mjs autopilot on|off|remove <專案id>
```

## Claude 自己接工作

Claude 不只決策，也是第五個工作者。適合自己做的：
- 需要精準判斷或跟使用者來回確認的部分、跨多個檔案的整合、驗收時發現的小修正
- 其他 agent 都用量不足時被交接過來的任務（dispatch 印出 `>>> 交給 Claude 接手` 並結束碼 4）

做之前、做完後都要記錄，儀表板的 Claude 欄才看得到：

```bash
id=$(node orchestra/dispatch.mjs claude start --cwd DIR --title "短標題" "要做什麼")
node orchestra/dispatch.mjs claude end $id "結果摘要"        # 失敗加 --fail
```

被交接的任務已經有 id（印在 `>>>` 那段），做完直接 `claude end <id>`。
仍以省 Claude token 為原則：大量產出優先派給有額度的 agent，Claude 接的是需要判斷、量小或沒人能接的工作。

## 分工原則

| Agent | 擅長 / 適合派給它的工作 |
|---|---|
| `codex` | 寫程式、改檔、重構、跑測試修 bug、code review（`--write`） |
| `gemini` | 長文件/大量程式碼閱讀、研究與比較、架構建議、第二意見、code review（預設 gemini-4-neon-xhigh；所有 Gemini 4 模型與 Flash 共用一個額度池，額度充裕時大量派給它，包含 `--write` 寫新檔案，但它不能跑指令，測試要由別人驗收） |
| `copilot` | Copilot CLI（`--model auto` 由它自選模型）。當 Codex 額度用完或想要另一個寫手時的備援；可寫程式、改檔、review。**每次呼叫扣 AI credits（每期上限在 `orchestra/config.json` 的 `copilotCredits` 設定）**，不拿來做 flash 能做的雜事 |
| `opus` | 經 Antigravity 呼叫 Claude Opus 5.5。算 Google AI Pro 的「Claude and GPT models」額度（跟 Gemini 分開、通常全滿），**不扣使用者的 Claude 訂閱用量**。寫程式（`--write`，但不能跑指令）、review、大量閱讀都可以，優先用它分擔 Claude 自己的工作 |
| `flash` | 便宜快速：摘要、翻譯、格式轉換、產生測試資料、簡單問答。Gemini Models 額度池通常很充裕，大量閱讀也可以派給它 |
| Claude（自己） | 拆任務、寫給子代理的精確 prompt、整合結果、最終驗收與跟使用者溝通；也親自接需要判斷的工作與最後一棒的交接（見下方） |

## 規則

- 給子代理的 prompt 要自足：目標、相關檔案路徑、限制、完成的定義、輸出格式。
- 子代理的結果是「回報」不是事實：重要改動要自己看 diff 或跑測試驗收。
- 同一組檔案一次只讓一個 agent 寫，避免互相覆蓋。
- 小事（幾行修改、一個問題）直接自己做，派工成本比較高。
