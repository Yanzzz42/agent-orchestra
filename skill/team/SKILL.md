---
name: team
description: 啟動多模型協作：Claude 當決策者也親自接工作，把子任務派給 Codex / Gemini / Gemini Flash / Opus（Antigravity）/ Copilot，用量不足時自動交接，並可開啟即時儀表板、查看各模型用量、設定多專案自動駕駛。只在使用者輸入 /team 時使用。
argument-hint: <任務描述> | 儀表板 | 用量 | 檢查 | 設定自動駕駛
disable-model-invocation: true
---

# 多模型團隊模式

協作環境位於 `{{ORCHESTRA_HOME}}`。
D=`{{ORCHESTRA_HOME}}/orchestra/dispatch.mjs`

使用者的輸入：$ARGUMENTS

用使用者的語言回覆。

## 1. 檢查安裝

若輸入包含「檢查」「doctor」「安裝」，或這是第一次使用：執行 `node $D doctor`，說明哪些 CLI 找得到、哪些沒裝與怎麼裝。只問檢查就做到這裡。

## 2. 用量

若輸入包含「用量」「額度」「token」「usage」：執行 `node $D usage`，用表格向使用者說明每個 agent 是否可用、何時重置、今天與 7 天用了多少。只問用量就做到這裡。

## 3. 開儀表板

若輸入為空，或包含「儀表板」「dashboard」，或接下來要派工：
- 先用 `lsof -i :4747` 檢查伺服器是否已在執行；沒有就用背景 Bash 執行
  `node {{ORCHESTRA_HOME}}/orchestra/server.mjs`。等待重置的任務也靠它自動接續。
- 有內建瀏覽器工具就用它開 http://localhost:4747，否則請使用者自己用瀏覽器打開。
- 若輸入只要求開儀表板，做到這裡就結束。

## 4. 設定自動駕駛

若輸入包含「自動駕駛」「autopilot」：
1. 讀 `{{ORCHESTRA_HOME}}/autopilot/SCHEDULED_TASK.md`，把裡面所有 `{{ORCHESTRA_HOME}}` 換成上面的實際路徑。
2. 有建立排程任務的工具（例如 Claude 桌面版的 scheduled tasks）就用它建立每 3 小時（`0 */3 * * *`）執行的任務，prompt 用換好路徑的內容；沒有的話把內容給使用者，說明可以用 cron 搭配 `claude -p` 執行。
3. 告訴使用者：到儀表板上方加入專案、逐一開啟，並設定用量守護門檻；所有專案預設是關閉的。

## 5. 派工

1. 讀 `{{ORCHESTRA_HOME}}/CLAUDE.md`，依照裡面的分工原則、額度與「Claude 自己接工作」規則行事。
2. 先跑 `node $D usage`，冷卻中或沒安裝的 agent 不排工作。
3. 派工指令一律用絕對路徑，並用 `--cwd` 指向目前的專案目錄，結尾加 `</dev/null`：
   ```bash
   node $D <codex|opus|gemini|flash|copilot> [--write] [--wait] --cwd "<目前專案>" --title "短標題" "prompt" </dev/null
   node $D note "分工理由"
   ```
4. 自己接的工作用 `node $D claude start --cwd "<目前專案>" --title "..." "..."` 開始、`node $D claude end <id> "摘要"` 結束。
5. dispatch 結束碼 4（印出 `>>> 交給 Claude 接手`）表示其他 agent 都用量不足，由你親自完成那個任務再 `claude end`；結束碼 3 表示已排隊等額度重置，告訴使用者重置時間。
6. 若專案是 git repo 且有未提交的變更，派出 `--write` 任務前先提醒使用者是否要 commit。
7. 互不相依的子任務用背景 Bash 同時派出。
8. 結果回來後自己驗收（看 diff、跑測試），再整合後回報使用者，並說明各 agent 做了什麼、有沒有發生用量不足與交接。
