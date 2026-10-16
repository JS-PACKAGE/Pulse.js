# AGENTS.md — Pulse.js 撰寫規範

本檔是所有實作者（人或 AI 執行 Agent）的撰寫硬規則。需求真值來源為 [`PLAN.md`](PLAN.md)；本檔與 `PLAN.md` 衝突時以 `PLAN.md` 為準並同步修正本檔。

## 1. 語言與執行環境

- 全端 **TypeScript**，執行環境 **Node.js v24 以上**（`package.json` `engines`）。
- `strict`、`noUncheckedIndexedAccess`；`tsc` 只做型別檢查（`noEmit`），建置交給 esbuild／Vite。
- ES modules；相對 import 一律帶 `.ts` 副檔名（web 端元件可省略，由 Vite 解析）。
- 依賴最少化：伺服器只用 `express`、`better-sqlite3`、`yaml`；面板只用 `react`、`react-dom`；**Agent 零第三方 runtime 依賴**（Node 標準庫＋子行程）。新增依賴前須說明理由並釘版。
- 版本一律釘死（無 `^`/`~`），`package-lock.json` 必須提交。

## 2. 建置與測試指令

| 指令 | 作用 |
|---|---|
| `npm ci` | 依 lockfile 安裝 |
| `npm run typecheck` | `tsc` 檢查 server／agent／shared／tests 與 web 兩個專案 |
| `npm test` | `vitest run`（契約測試＋伺服器整合測試，含 Mock Agent 流程） |
| `npm run build` | `dist/server/main.mjs`、`dist/agent/pulse-agent.mjs`（單檔）、`dist/web/` |
| `npm start` | 以 repo 內 `config.yaml` 啟動伺服器 |
| `npm run dev:web` | Vite 開發伺服器（`/api`、`/agent` 代理到 `127.0.0.1:8080`） |
| `npm audit` | 交付前必跑，不得有 high／critical |

提交前至少跑 `npm run typecheck && npm test && npm run build`。

## 3. 結構對應

| 路徑 | 內容 | PLAN.md |
|---|---|---|
| `src/shared/types.ts` | 協定（wire contract）與資料型別，三端共用 | §4、§5 |
| `src/shared/validate.ts` | 所有入站 payload 的 schema 驗證、hostname／群組名正規化 | §6-5 |
| `src/server/config.ts` | `config.yaml` 載入與驗證（每個鍵都必填，不偷偷給預設值） | R5 |
| `src/server/db.ts` | SQLite schema（WAL、busy_timeout、外鍵） | §5、§6-10 |
| `src/server/store.ts` | **唯一**放 SQL 的地方，全部 prepared statement | §6-7 |
| `src/server/monitor.ts` | 註冊、上報、異常／離線判定、頻率限制、保留清理 | §1、§5 |
| `src/server/alerts.ts` | 閾值比對（warn 起即 alert，crit 提升嚴重度） | §1 |
| `src/server/app.ts` | Express 路由、SSE、錯誤處理、靜態面板與 agent bundle | §4 |
| `src/agent/collectors/` | `SystemCollector` 契約、Linux（/proc）、macOS（sysctl/netstat/route）、OS 更新檢查 `UpdateChecker`（apt-get／dnf／softwareupdate，只查不裝）、Mock | §3.2 |
| `src/agent/gpu/` | `GpuCollector` 契約、NVIDIA／AMD／Apple adapter、Mock（四案例） | §3.1 |
| `src/agent/agent.ts`、`client.ts`、`main.ts` | 上報迴圈、HTTP client、進入點 | §4 |
| `web/` | React 面板（hash 路由、i18n 三語、暗／亮主題、SSE） | §1 |
| `install.sh`／`host-install.sh` | Agent 端／host 端一鍵安裝 | R4、R11、R13 |
| `test/` | vitest 測試 | Gate 0／1 |

## 4. 外部工具一律經 adapter＋Mock

- 系統工具（`nvidia-smi`、`rocm-smi`、`ioreg`、`sysctl`、`netstat`、`route`、`apt-get -s`、`dnf -C check-update`、`softwareupdate -l`、`/proc/*`）**只能**在 `src/agent/collectors/` 與 `src/agent/gpu/` 的 adapter 內呼叫，其他地方不得直接 spawn 或讀取。
- 每個 adapter 實作同一契約（`SystemCollector.snapshot()`／`GpuCollector.list()`／`UpdateChecker.check()`），並有對應 Mock（`MockSystemCollector`、`MockGpuCollector`、`MockUpdateChecker`）；新增 adapter 時同步新增解析器契約測試（餵真實輸出樣本）。
- OS 更新檢查只讀：不得 `apt-get update`、不得下載 metadata（dnf 一律 `-C`）、不得安裝；每 6 小時在背景跑一次，上報不等它；失敗只記 warning，保留上一次成功結果（帶 `checkedAt`）。
- 子行程一律經 `createRunCommand()`（`execFile`，有逾時，不經 shell）。
- **fail-closed**：逾時、非零結束、輸出格式不符 → 拋例外，由 Agent 記錄 warning，該週期該欄位為 `null`；**不得靜默改用其他來源、不得填猜測值**。工具未安裝（ENOENT）→ GPU 回 `[]`（無 GPU）。
- 單位：CPU＝1 分鐘 loadavg ÷ 邏輯 CPU 數 ×100；記憶體 MB，已用量排除可回收快取（Linux `MemTotal − MemAvailable`；macOS `總量 × (100 − kern.memorystatus_level)%`）；磁碟 GB（`df` 口徑）；網路 kbps（1000 bit）。

## 5. 安全性（PLAN.md §6，逐條對應，不得放寬）

1. **傳輸強制 TLS**：上報與 API 一律 HTTPS（經 Cloudflare Tunnel）；明文 HTTP 僅限本機開發。→ Agent 設定只接受 `https://`，`http://` 僅限 loopback 主機（`src/agent/config.ts`、`install.sh`）。
2. **驗證於 Cloudflare Zero Trust 層進行**：對外流量經 Tunnel＋Access 以 Service Token 驗證（`CF-Access-Client-Id`／`CF-Access-Client-Secret` header），缺／錯一律該層拒絕；App 端完全信任該層結果、不做任何比對；且 App 不得繞過該層直達（監聽綁定 loopback 或防火牆限定 Tunnel 來源）；服務金鑰不得放 URL query 或 body，不入日誌。→ `server.host` 預設 `127.0.0.1`，非 loopback 需明確 `allowExternalBind: true` 否則拒絕啟動；伺服器程式**不得讀取** `CF-Access-*` 與 `Authorization` header。
3. **面板存取由 Cloudflare Zero Trust Access 驗證；App 端預設關閉匿名存取**。→ 預設只綁 loopback，唯一入口是同機的 cloudflared。
4. **驗證唯一真值來源＝Cloudflare Zero Trust 層**：Service Token 只存在該層設定，App 端不儲存、不比對、不重複實作驗證邏輯；同一組 token 全端共用，輪替＝改 Zero Trust 設定＋各端重跑 `install.sh` 更新。→ 只有 Agent 端 `agent.json`（0640／0600）保存用戶端識別碼與服務金鑰以便送出 header。
5. **輸入驗證＋尺寸上限**：JSON schema 驗證、payload 上限 64KB、hostname 正規化防注入。→ `src/shared/validate.ts`；`limits.maxPayloadBytes` 上限 65536（超過拒絕啟動），超限回 413。
6. **每 host 回報頻率限制**（預設每 10 秒 1 筆上限）；伺服器端容忍亂序、以 ts 遞增寫入。→ `agent.minReportIntervalSec`，超頻回 429＋`Retry-After`；狀態永遠依 ts 最新的樣本判定，遲到的舊樣本只入庫不覆蓋狀態。
7. **SQL 一律 prepared statement，禁字串拼接**。→ SQL 只寫在 `src/server/store.ts`／`db.ts`，參數一律綁定。
8. **憑證（服務金鑰／密碼）不入日誌；對外錯誤一律 generic，不洩內部堆疊**。→ 錯誤 body 只有 `{error, details?}`；500 細節只寫伺服器日誌；Agent 與安裝腳本不得印出服務金鑰（含 JSON 解析錯誤訊息）。
9. **依賴釘版＋lockfile；`npm audit` 納入 Gate 檢核**。
10. **資源防護**：SQLite 設 WAL 與 busy_timeout、樣本表滾動清理、上報端點背壓（429）。→ `retention.days`、`retention.cleanupIntervalHours`；SSE 每 25 秒 keep-alive。

## 6. 其他撰寫規則

- 設定只來自 `config.yaml`（伺服器）與 `agent.json`（Agent）；程式內不得寫死連線參數、路徑、閾值。
- 面板不得使用 `dangerouslySetInnerHTML`；所有 UI 字串走 i18n 字典（zh-TW／en／ja 三語 key 必須一致，由型別強制）。
- 文件與註解使用繁體中文或英文，**不得出現簡體字**。
- 不得提交 `dist/`、`data/`、`*.db`。
- 變更協定時同步更新 `src/shared/types.ts`、README 協定摘要與測試。
