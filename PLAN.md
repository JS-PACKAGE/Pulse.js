# Pulse.js 多主機中央監控面板 企劃書 v1.8

一句話：以 **TypeScript（Node.js）** 為形態的多主機中央監控系統（**Pulse.js**），面板以遠端 `host-install.sh` 一鍵安裝並自動啟動，Agent 經遠端 `install.sh` 一鍵安裝並自動偵測系統，各端以 header 帶 Auth 驗證碼 POST 回報五項主機指標（含多卡 GPU）至 host 端（SQLite 持久化，驗證由 Cloudflare Zero Trust 層進行），Web 面板首頁只列異常中主機、詳情頁依主機系統與自訂群組分組檢視。

### 基本資料

| 欄位 | 內容 |
|---|---|
| 套件名稱 | **Pulse.js** |
| 程式語言 | **TypeScript**（Node.js） |
| 執行環境 | Node.js **v22 以上**（本機實測 `node -v` = v26.10.0，見假設 1） |
| 介面 | Web 監控面板（SPA）＋ REST API ＋ 各端 POST 上報端點（header 帶 Auth 驗證碼） |
| 安裝腳本 | `host-install.sh`（host 端＝面板，一鍵安裝＋自動啟動，支援 Ubuntu 與 macOS）、`install.sh`（Agent 端，一鍵安裝＋自動偵測系統，三平台） |
| 邊緣驗證 | Cloudflare Zero Trust（Cloudflare Tunnel＋Access）；驗證於該層進行，App 端完全信任、不做比對（已裁示） |
| 核心依賴 | `express` 5.3.0（MIT）、`better-sqlite3` 13.0.3（MIT）、`react` 19.3.1（MIT）、`vite` 8.3.4（MIT）、`vitest` 5.0.5（MIT）、`esbuild` 0.28.2（MIT）（npm 查證 2026-10-16） |
| 遠端倉庫 | https://github.com/JS-PACKAGE/Pulse.js（main） |
| 介紹網址 | 未另設（以倉庫頁為準） |
| 授權 | Apache License 2.0（`LICENSE` **已在 main**，2026-10-16 經 GitHub API 檔案清單＋raw 取檔驗證為標準全文） |
| 前置檔案 | `host-install.sh` 與 `install.sh` 尚未在 main（raw 查證 404，2026-10-16）→ 列 Phase 0（見 Gate 0） |
| 目標平台 | 受監控端（Agent）：Linux 兩系（Debian/Ubuntu 系、RHEL 系）＋ macOS；host 端（面板）：Ubuntu 與 macOS；Windows 第一版不做（已裁示，見假設 2） |
| i18n 語系 | 繁體中文（zh-TW）／English（en）／日本語（ja）（已裁示） |
| 佈景主題 | 暗色／亮色雙主題（已裁示） |

結構：〇 概述 → 一 需求總表 → 二 系統架構 → 三 外部工具介接 → 四 通訊協定 → 五 資料模型 → 六 安全性 → 七 必要文件 → 八 倉庫與部署 → 九 風險與因應 → 十 里程碑與 Gate → 十一 已知假設。全程以「執行 Agent」泛指實作方，不綁定特定工具。

---

## 〇、專案概述

### 目標
- 多主機集中監控：各主機安裝 Agent，回報**主記憶體、CPU 負載、GPU（多卡）、主磁碟空間、網路上下行流量**五項指標。
- **首頁只放異常中的主機**——正常主機不出現在首頁，一眼即見待處理清單。
- **詳情頁依主機系統與自訂群組分組**：系統分組自動（Linux-Deb／Linux-RPM／macOS），自訂群組由使用者建立與指派。
- Agent 以**遠端 `install.sh` 一鍵安裝**，安裝時自動偵測系統（平台、發行版、硬體），免手動設定。
- 面板（host 端）以**遠端 `host-install.sh` 一鍵安裝並自動啟動**；對外經 **Cloudflare Zero Trust**（Tunnel＋Access）保護，驗證於該層進行。
- 各端 POST 上報以 header 帶 **Auth 驗證碼**；`install.sh` 結尾取得 POST 目標主機名稱與 Auth 驗證碼。
- 面板內建 i18n 三語切換（zh-TW／en／ja）與暗色／亮色雙主題。

### 範圍外
- Windows 主機監控（第一版不做，已裁示；架構預留 port 層，見假設 2）。
- 歷史報表匯出（CSV／PDF）、容量預測、告警通知（Email／Webhook）——另案。
- 帳號多租戶與權限分級（驗證由 Cloudflare Zero Trust 處理，見假設 6）。
- Agent 自動更新機制（第一版手動重跑 `install.sh` 升級）。
- 自動修復動作（重啟服務、清理磁碟等）。

### 硬性要求
| 編號 | 要求 |
|---|---|
| R1 | 程式語言 TypeScript；執行環境 Node.js v22 以上；遠端倉庫 JS-PACKAGE/Pulse.js |
| R2 | 監控五指標：主記憶體、CPU 負載、GPU（多卡逐卡列舉，NVIDIA＋AMD＋Apple Silicon 全支援，已裁示）、主磁碟空間、網路上下行流量 |
| R3 | 首頁只顯示異常中主機；詳情頁依主機系統＋自訂群組分組 |
| R4 | Agent 以遠端 `install.sh` 安裝並自動偵測系統；支援 Linux 兩系（Debian/Ubuntu 系、RHEL 系）＋ macOS；Windows 第一版不做 |
| R5 | 資料持久化一律 SQLite（`better-sqlite3`）；程式不得寫死連線參數（見 `config.yaml`） |
| R6 | i18n 三語：繁體中文／English／日本語，可即時切換 |
| R7 | 佈景主題暗色／亮色，可即時切換 |
| R8 | 安全性硬規則見六節，須完整寫入 `AGENTS.md` |
| R9 | 實作順序：先必要文件與契約 Mock（Gate 0）→ 再寫程式 |
| R10 | 授權 Apache License 2.0；README 附第三方授權聲明 |
| R11 | 面板（host 端）以遠端 `host-install.sh` 一鍵安裝並自動啟動（systemd／launchd 開機自啟）；支援 Ubuntu 與 macOS，其他系統明確提示後中止；只裝面板——cloudflared 由使用者自備、腳本不代裝 |
| R12 | 各端 POST 上報至 host 端一律以 `Authorization` header 攜帶 Auth 驗證碼；驗證由 Cloudflare Zero Trust 層進行，缺／錯一律該層即拒；App 端完全信任該層驗證結果、不做任何比對（已裁示） |
| R13 | `install.sh` 結尾須取得 POST 目標主機名稱與 Auth 驗證碼（互動詢問或參數），寫入 Agent 設定、不入日誌；驗證碼為**單一碼全端共用**（已裁示），輪替＝改 Zero Trust 設定＋各端重跑 `install.sh` 更新 |

---

## 一、需求總表

| 面向 | 需求 |
|---|---|
| 安裝（Agent 端） | 遠端 `install.sh` 一鍵安裝；自動偵測平台（Linux-Deb／Linux-RPM／macOS）、架構、GPU 數、網路介面；以 systemd（Linux）／launchd（macOS）註冊為服務；結尾詢問 POST 目標主機名稱與 Auth 驗證碼後寫入 Agent 設定（R13） |
| 安裝（host 端） | 遠端 `host-install.sh` 一鍵安裝面板並自動啟動；支援 Ubuntu（註冊 systemd）與 macOS（註冊 launchd LaunchDaemon，系統帳號 `_pulse`），自動偵測平台與版本並開機自啟；其他系統明確提示後中止；只裝面板不代裝 cloudflared（由使用者自備，已裁示）；重跑即更新 |
| Agent 回報 | 五指標週期上報（預設 30 秒）；上報 POST 一律以 `Authorization` header 帶 Auth 驗證碼；心跳逾時（預設 90 秒）判定離線＝異常 |
| GPU | 多卡逐卡列舉（index、名稱、廠商、使用率、記憶體用量）；NVIDIA＋AMD＋Apple Silicon 全支援（已裁示）；缺驅動或無 GPU 型別標 N/A 不中斷 |
| 異常判定 | 閾值（CPU、記憶體、磁碟、GPU、流量）＋離線判定；閾值在 `config.yaml` 可調 |
| 首頁 | 僅列異常中主機卡片：主機名、系統、異常項目與數值、持續時間；點擊進詳情頁 |
| 詳情頁 | 依主機系統自動分組＋自訂群組分組；單機檢視五指標即時值與近期曲線 |
| 自訂群組 | 建立／改名／刪除群組；主機指派／移出；與系統分組並存不衝突 |
| i18n | zh-TW／en／ja 三語字典檔切換，選擇記於 localStorage |
| 主題 | 暗色／亮色即時切換，選擇記於 localStorage |
| 設定 | `config.yaml`：上報閾值、週期、保留天數、監聽埠、TLS 設定；程式不得寫死 |
| 文件 | `README.md`／`AGENTS.md`／`CLAUDE.md`／`PLAN.md` 依七節規格 |
| 安全 | 見六節十條硬規則 |

---

## 二、系統架構

```
[受監控主機 Linux／macOS]                  [host 端＝中央伺服器 Node.js/TS]
  pulse-agent（TypeScript）  ──HTTPS POST＋header 驗證──▶  Express REST API
    ├─ collectors/ cpu、mem、disk、net                    ├─ SQLite（better-sqlite3，WAL）
    └─ gpu/ GPU adapter（nvidia-smi／mock）                └─ Web 面板（React + Vite）
  install.sh（Agent 端：一鍵安裝、自動偵測平台）                  ├─ 首頁：僅異常主機卡片
  host-install.sh（host 端：一鍵安裝面板、自動啟動，Ubuntu／macOS）     ├─ 詳情頁：系統分組＋自訂群組
                                                                ├─ i18n：zh-TW／en／ja
                                                                └─ 主題：暗色／亮色
對外：Cloudflare Tunnel＋Access（Zero Trust）——驗證於該層進行，App 端僅辨識結果
外部工具：nvidia-smi（GPU）、/proc、vm_stat、netstat——契約見三節，皆以 adapter 介面抽象＋Mock 先行
```

- **語言與建置**：全端 TypeScript；`tsc` 型別檢查；建置 `esbuild`（Agent 單檔打包，利於遠端分發）＋`vite`（面板）；測試 `vitest`。
- **依賴策略**：最少相依——伺服器 `express`＋`better-sqlite3`；面板 `react`＋`vite`；Agent 盡量零第三方（系統指標以 Node 標準庫與子行程呼叫系統工具取得）。版本釘於 lockfile（見假設 7）。
- **狀態儲存**：SQLite 單檔（WAL 模式）；路徑與參數在 `config.yaml`，程式不得寫死。
- **部署形態**：host 端＝中央伺服器單機（Node 22+，Ubuntu 或 macOS），以 `host-install.sh` 一鍵安裝並自動啟動；對外以 Cloudflare Tunnel 暴露並由 Zero Trust Access 驗證；Agent 分佈各受監控主機（Linux 兩系＋macOS），以 `install.sh` 一鍵安裝。

---

## 三、外部工具介接（皆系統工具，先定契約＋Mock）

> 本節先定**本系統需要的最小契約**；實作期以 Mock 落地、實機到位後換實串接，程式碼不得散落直接呼叫系統工具（一律經 adapter 介面）。

### 3.1 GPU adapter（多卡、全廠商）
- 契約：`GpuCollector.list() → GpuInfo[]`，元素含 `index`、`name`、`utilPercent`、`memUsedMB`、`memTotalMB`、`vendor`（nvidia|amd|apple）；無 GPU 或工具缺失回空陣列。
- **NVIDIA**：`NvidiaSmiGpuCollector`——子行程呼叫 `nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits` 逐卡解析（多卡＝多列）。
- **AMD**：`AmdRocmSmiGpuCollector`——子行程呼叫 `rocm-smi` 系列指令逐卡解析（多卡＝多列）；契約與 NVIDIA 同形。
- **Apple Silicon**：`AppleGpuCollector`——macOS 需 root 權限取 GPU 指標（已裁示接受）；Agent 服務以 root 執行或授權專屬指令，缺權限時該欄位標 N/A 並記錄 warning（見假設 3）。
- `MockGpuCollector`：固定回多廠商多卡樣本，供契約測試（單卡、雙卡、空陣列、跨廠商四案例）。

### 3.2 CPU／記憶體／磁碟／網路 collector
- 契約：`SystemCollector.snapshot() → SystemMetrics`（`cpuLoadPercent`、`memUsedMB`／`memTotalMB`、`diskUsedGB`／`diskTotalGB`、`netRxKbps`／`netTxKbps`）。
- Linux 實作讀 `/proc`（`/proc/loadavg`、`/proc/meminfo`、`/proc/diskstats`、`/proc/net/dev`）；macOS 實作子行程 `sysctl`／`vm_stat`／`netstat`。
- 網路流量取「主對外介面」合計（自動偵測，`config.yaml` 可指定介面）。
- `MockSystemCollector`：固定樣本供契約測試。
- 失敗 fail-closed：子行程逾時／輸出格式不符 → 拋例外由 Agent 記錄，該週期缺值不亂填；**不靜默降級換來源**。

---

## 四、通訊協定（各端 ⇄ host 端 ⇄ 面板）

- 傳輸一律 HTTPS（TLS 終止於 Cloudflare Tunnel 邊緣）；JSON 訊息，單筆上限 64KB（見六節第 5 條）。
- **驗證於 Cloudflare Zero Trust 層進行（已裁示）**：對外流量經 Cloudflare Tunnel＋Access，`Authorization` header 攜帶 Auth 驗證碼、由該層驗證；App 端完全信任該層結果、不做任何比對；驗證碼不得放 URL query 或 body（見六節第 2 條）。

| 訊息 | 方向 | 內容 |
|---|---|---|
| `register` | Agent→Server | header 帶 Auth 驗證碼；hostname、osFamily、osVersion、arch、cpuModel、gpuCount、agentVersion；Server 回 hostId |
| `report` | Agent→Server | header 帶 Auth 驗證碼；hostId、ts、五指標＋GpuInfo[]（心跳併入，更新 lastSeen） |
| `listHosts` | 面板→Server | 主機清單含 status（ok／alert／offline） |
| `hostDetail` | 面板→Server | 單機五指標即時值＋近期序列 |
| `createGroup`／`renameGroup`／`deleteGroup` | 面板→Server | 自訂群組管理 |
| `assignHost` | 面板→Server | 主機指派／移出自訂群組 |
| `event` (SSE) | Server→面板 | 狀態變更即時推送（異常出現／解除） |

- 錯誤碼表：`400` 欄位驗證失敗、`401` Auth 驗證碼缺失或錯誤（Zero Trust 層回絕）、`404` 主機／群組不存在、`409` 註冊衝突、`413` payload 過大、`429` 過頻、`500` 伺服器內部（對外 generic）。
- **流程範例 1（安裝註冊）**：`curl -fsSL https://raw.githubusercontent.com/JS-PACKAGE/Pulse.js/main/install.sh | bash` → 偵測 macOS → 裝 Agent＋launchd → 結尾輸入 POST 目標主機名稱＋Auth 驗證碼寫入設定 → `register` 成功 → 面板出現新主機（狀態 ok）。
- **流程範例 2（異常判定）**：Agent `report` 磁碟使用率 92% → 超過閾值 → 狀態 alert → 該主機卡片出現在首頁。
- **流程範例 3（分組檢視）**：詳情頁依系統分組顯示三組（Linux-Deb／Linux-RPM／macOS）；使用者建自訂群組「生產環境」指派兩台 → 該群組區塊同步顯示。
- **流程範例 4（面板部署）**：`curl -fsSL https://raw.githubusercontent.com/JS-PACKAGE/Pulse.js/main/host-install.sh | sudo bash` → 偵測 Ubuntu／macOS → 裝面板＋註冊 systemd／launchd → 自動啟動 → 開啟面板首頁成功。

---

## 五、資料模型

```
Host {
  id, hostname, osFamily (linux-deb|linux-rpm|macos),
  osVersion, arch, cpuModel, gpuCount, agentVersion,
  firstSeen, lastSeen, status (ok|alert|offline)
}
MetricSample {
  id, hostId, ts,
  cpuLoadPercent, memUsedMB, memTotalMB,
  diskUsedGB, diskTotalGB, netRxKbps, netTxKbps
}
GpuSample { id, hostId, ts, gpuIndex, name, vendor (nvidia|amd|apple), utilPercent, memUsedMB, memTotalMB }
Group     { id, name, kind (system|custom) }
HostGroup { hostId, groupId }
Threshold { metric, warn, crit }        # 對應 config.yaml
```
- 保留策略：`MetricSample`／`GpuSample` 滾動保留預設 30 天（`config.yaml` 可調），每日排程清理。
- 併發／競態：Server 單一進程寫入 SQLite（WAL）；批次 insert；register 以 hostname＋osFamily 唯一約束防重複註冊。
- 系統分組（kind=system）由 Host.osFamily 派生自動維護，不手動編輯。

---

## 六、安全性架構（**須完整寫入 `AGENTS.md` 作為撰寫硬規則**）

1. 傳輸強制 TLS：上報與 API 一律 HTTPS（經 Cloudflare Tunnel）；明文 HTTP 僅限本機開發。
2. 驗證於 Cloudflare Zero Trust 層進行（已裁示）：對外流量經 Tunnel＋Access 以 Auth 驗證碼驗證（`Authorization` header），缺／錯一律該層拒絕；App 端完全信任該層結果、不做任何比對；且 App 不得繞過該層直達（監聽綁定 loopback 或防火牆限定 Tunnel 來源）；驗證碼不得放 URL query 或 body，不入日誌。
3. 面板存取由 Cloudflare Zero Trust Access 驗證；App 端預設關閉匿名存取。
4. 驗證唯一真值來源＝Cloudflare Zero Trust 層：Auth 驗證碼只存在該層設定，App 端不儲存、不比對、不重複實作驗證邏輯；驗證碼為單一碼全端共用（已裁示），輪替＝改 Zero Trust 設定＋各端重跑 `install.sh` 更新。
5. 輸入驗證＋尺寸上限：JSON schema 驗證、payload 上限 64KB、hostname 正規化防注入。
6. 每 host 回報頻率限制（預設每 10 秒 1 筆上限）；伺服器端容忍亂序、以 ts 遞增寫入。
7. SQL 一律 prepared statement，禁字串拼接。
8. 憑證（Auth 驗證碼／密碼）不入日誌；對外錯誤一律 generic，不洩內部堆疊。
9. 依賴釘版＋lockfile；`npm audit` 納入 Gate 檢核。
10. 資源防護：SQLite 設 WAL 與 busy_timeout、樣本表滾動清理、上報端點背壓（429）。

---

## 七、必要文件規格

| 檔案 | 內容要求 |
|---|---|
| `README.md` | **用途**：是什麼、系統圖、需求（Node 22+、cloudflared 自備並列前置安裝與設定步驟、Cloudflare Zero Trust）、host 端與 Agent 端安裝啟動（含 `host-install.sh`／`install.sh` 一鍵指令與結尾參數說明）、協定摘要、`config.yaml` 說明、測試指令、授權宣告（Apache 2.0＋第三方聲明） |
| `AGENTS.md` | **撰寫方式**：TypeScript 規範、建置測試指令、結構對應、**安全性章節＝六節全部規則逐條編號**、外部工具一律經 adapter＋Mock |
| `CLAUDE.md` | 僅**引用 `AGENTS.md`**（一行指向＋摘要），不重複內容避免雙真值來源 |
| `PLAN.md` | **本企劃書全文匯入之定案稿**（更新時同步） |

---

## 八、倉庫與部署

- **前置檔案**：`LICENSE`（Apache 2.0）**已在 main**（Gate 0 部分達成，2026-10-16 經 GitHub API＋raw 驗證）；`host-install.sh`（host 端）與 `install.sh`（Agent 端）尚未上傳（raw 404）→ 列 Phase 0。
- **面板安裝（host 端）**：`host-install.sh` 自 raw 取用；支援 Ubuntu 與 macOS——偵測平台後註冊 systemd／launchd 並開機自啟，其他系統明確提示後中止；只裝面板，cloudflared（Cloudflare Tunnel）由使用者自備安裝與設定（已裁示）；重跑即更新。
- **服務部署**：中央伺服器單機（Node 22+）；對外以 Cloudflare Tunnel 暴露並由 Zero Trust Access 驗證（已裁示，cloudflared 為前置自備項目）；`config.yaml` 隨 repo 提供範本。
- **Agent 分發**：`install.sh` 自 raw 取用；腳本依平台分支安裝（systemd／launchd），並註冊服務開機自啟。

---

## 九、風險與因應

| 風險 | 影響 | 因應 |
|---|---|---|
| GPU 廠商工具差異（nvidia-smi／rocm-smi／Apple） | GPU 指標缺值 | 三節 adapter＋Mock（三廠商各一實作）；缺值標 N/A 不中斷，不靜默降級 |
| Linux 兩系與 macOS 系統介面差異 | collector 維護成本 | 各平台獨立實作同一 `SystemCollector` 契約；契約測試共用 |
| `nvidia-smi` 輸出格式隨驅動變動 | 解析失敗 | 解析器寬容處理缺欄＋格式不符 fail-closed 記錄 |
| SQLite 單寫者瓶頸 | 上報尖峰延遲 | 單進程批次寫入＋WAL；主機規模超出上限時改佇列化（列入後續） |
| 指標資料量成長 | 磁碟佔用 | 滾動保留預設 30 天＋每日清理（見五節） |
| Auth 驗證碼洩漏 | 未授權端點存取 | 單一碼全端共用（已裁示）→洩漏即全面輪替：改 Zero Trust 設定＋各端重跑 `install.sh` 更新；Zero Trust 層單層拒絕（見六節第 4 條） |
| 繞過 Zero Trust 層直達 App | 未驗證請求進入 | App 監聽綁定 loopback／防火牆限定 Tunnel 來源（六節第 2 條）；列入 Gate 1 測試案例 |
| cloudflared 未裝／設定錯誤 | Zero Trust 層無法對外、面板與上報全斷 | `host-install.sh` 不代裝（已裁示，使用者自備）；README 列前置安裝與設定步驟；腳本啟動時偵測提示 |
| `host-install.sh` 需服務註冊權限 | 權限不足安裝中止 | 腳本偵測權限並明確提示；README 附手動安裝步驟 |
| macOS GPU 指標需 root 權限 | 權限不足時 GPU 欄缺值 | 已裁示接受（假設 3）：Agent 服務以 root 執行或授權專屬指令；缺權限標 N/A＋warning |

---

## 十、里程碑與 Gate（逐關通過才進下一階段）

### Phase 0 — 前置文件與 Mock
四份必要文件、`config.yaml` 範本、三節 adapter 介面＋Mock 實作、`host-install.sh` 與 `install.sh` 雛形並上傳 main。
**Gate 0**：① 四份文件齊備且 `AGENTS.md` 安全章節與六節逐條對應 ② `host-install.sh` 與 `install.sh` 已在 main（raw 各回 200）③ `LICENSE` 為 Apache 2.0——**已達成**（2026-10-16 經 GitHub API 檔案清單＋raw 取檔驗證）④ Mock 契約測試全綠（對應 R9）。

### Phase 1 — 伺服器核心＋SQLite
Express REST API、資料模型建表、register／report、異常判定與離線判定。
**Gate 1**：`vitest` 全綠；Mock Agent 依流程範例 1–2 走通（註冊→上報→超閾值→狀態 alert）；POST 端點驗證實測（缺／錯 Auth 驗證碼在 Zero Trust 層被拒、正確放行；App 端無比對邏輯）；App 直連測試確認非 Tunnel 來源不可達（對應 R2、R3、R5、R12）。

### Phase 2 — Agent 採集器＋install.sh
五指標 collectors、GPU adapter 實作、`install.sh` 平台自動偵測與服務註冊（systemd／launchd）。
**Gate 2**：Linux 兩系各一台＋macOS 一台實測 `install.sh` 一鍵安裝（含結尾輸入主機名稱與 Auth 驗證碼）→指標回報→面板可見；多卡機器逐卡列舉正確；NVIDIA／AMD／Apple Silicon 各至少一台 GPU 指標實測（對應 R2、R4、R13）。

### Phase 3 — Web 面板＋host-install.sh
首頁異常卡片、詳情頁系統＋自訂群組分組、即時曲線、i18n 三語、暗／亮主題；`host-install.sh` 面板一鍵安裝與自動啟動。
**Gate 3**：走完流程範例 1–4；`host-install.sh` 於 Ubuntu 實測安裝面板並自動啟動（cloudflared 為前置自備項，見假設 8），非 Ubuntu 執行明確提示後中止（對應 R11）；三語切換與雙主題切換實測；首頁在全正常時顯示「無異常」而非空列表（對應 R3、R6、R7）。

### Phase 4 — 交付
**Gate 4（交付關）**：① 遠端 main 含全部檔案 ② `host-install.sh` 與 `install.sh` 仍可取用 ③ 乾淨 clone→安裝→建置→啟動→走完流程範例 1–4 ④ README 指令逐條實跑 ⑤ `npm audit` 無 high／critical ⑥ 結構自檢：無簡體字、無佔位符殘留、R 編號連續。

---

## 十一、已知假設與未定項

1. **Node 版本**：鎖定 v22 以上；本機實測 `node -v` = v26.10.0（2026-10-16）。
2. **「Linux 兩個版本」已裁示定案（2026-10-16）**：兩大套件管理體系——Debian/Ubuntu 系（apt）與 RHEL 系（rpm／yum／dnf）；`install.sh`（Agent 端）依此分支，Gate 2 於兩系各實測一台；`host-install.sh`（host 端）支援 Ubuntu 與 macOS（見假設 10）。已落實至 R4、基本資料、三節、Gate 2。
3. **GPU 採集已裁示定案（2026-10-16）**：NVIDIA＋AMD＋Apple Silicon 全支援、多卡逐卡列舉；Apple Silicon 需 root 權限取指標（成本已接受）——Agent 服務於 macOS 以 root 執行或授權專屬指令；缺權限／缺工具時該欄位標 N/A 並記 warning，不虛構數值。
4. **指標數值來源**：Linux 讀 `/proc`、macOS 子行程系統工具；`nvidia-smi` 輸出格式隨驅動版本可能變動，解析器寬容處理（見九節）。
5. **上報與保留數值**：週期 30 秒、離線判定 90 秒、樣本保留 30 天——`config.yaml` 可調（可調整）。
6. **面板驗證已裁示定案（2026-10-16）**：面板與各端上報驗證皆於 Cloudflare Zero Trust 層進行（Access）；App 端完全信任該層、不做任何比對、不儲存驗證碼（原「單一管理員帳密」與「App 兜底比對」方案均已取消）；App 不得繞過該層直達（見六節第 2 條）。
7. **依賴策略為預設可改**：最少相依＋lockfile 釘版；若要換 ORM 或前端框架，須同步更新二節與 Gate。
8. **前置檔案現況**：`host-install.sh` 與 `install.sh` 尚未在 main（404，2026-10-16 查證）→ Phase 0 交付；`LICENSE` 已在 main（已達成，見 Gate 0）；cloudflared 為前置自備項目（`host-install.sh` 不代裝，已裁示，見裁示 15）。
9. **裁示紀錄（2026-10-16）**：Linux 兩版本定案＝Debian/Ubuntu 系（apt）與 RHEL 系（rpm／yum／dnf）兩大套件管理體系，已落實至基本資料、R4、二節、三節、Gate 2 與假設 2；無其他連動變更。
10. **裁示紀錄（2026-10-16）**：host 端定案＝新增 `host-install.sh` 一鍵安裝面板並自動啟動（R11），各端 POST 上報一律帶 `Authorization` header 驗證（R12）；已落實至基本資料、目標、一節、二節、四節、六節第 2 條、七節、八節、九節、流程範例 4、Gate 0／1／3／4 與假設 8。
11. **裁示紀錄（2026-10-16）**：`host-install.sh` 平台範圍定案＝預設只做 Ubuntu（偵測 Ubuntu 版本、註冊 systemd、非 Ubuntu 明確提示後中止），Agent 端 `install.sh` 三平台不變；已落實至基本資料（安裝腳本、目標平台）、R11、一節、二節、流程範例 4、八節、Gate 3 與假設 2。
12. **裁示紀錄（2026-10-16）**：驗證定案＝Cloudflare Zero Trust（Tunnel＋Access）於該層進行（含面板與各端上報），`Authorization` header 攜帶 Auth 驗證碼（「App 端兜底比對」部分已由裁示 13 取代）；`install.sh` 結尾須取得 POST 目標主機名稱與 Auth 驗證碼（R13 新增）。原 enrollment／per-agent token 與單一管理員帳密方案已取消並全文清除。已落實至基本資料（介面、邊緣驗證）、R12／R13、目標、一節、二節、四節、六節第 1／2／3／4／8 條、七節、八節、九節、流程範例 1、Gate 1／Gate 2 與假設 6。
13. **裁示紀錄（2026-10-16）**：App 端驗證定案＝完全信任 Zero Trust 層、不做任何比對（原「App 兜底比對」已取消），驗證碼不入 App、唯一真值來源為該層；App 不得繞過該層直達（監聽綁定 loopback／防火牆限定 Tunnel 來源）。已落實至基本資料（邊緣驗證）、R12、四節、六節第 2／4 條、九節、Gate 1 與假設 6。
14. **裁示紀錄（2026-10-16）**：GPU 廠商範圍定案＝NVIDIA＋AMD＋Apple Silicon 全支援、多卡逐卡列舉；macOS 需 root 權限取指標之成本已接受。已落實至 R2、一節（GPU 列）、三節 3.1（三廠商 adapter＋Mock 四案例）、九節、Gate 2 與假設 3。
15. **裁示紀錄（2026-10-16）**：cloudflared 歸屬定案＝由使用者自備安裝與設定，`host-install.sh` 只裝面板不代裝。已落實至 R11、一節（安裝 host 端列）、八節（面板安裝、服務部署）、九節（風險列）、假設 8；README 須列前置安裝步驟（七節）。
16. **裁示紀錄（2026-10-16）**：驗證碼粒度定案＝單一 Auth 驗證碼全端共用；輪替＝改 Zero Trust 設定＋各端重跑 `install.sh` 更新（無新舊碼過渡機制）。已落實至 R13、六節第 4 條、九節（驗證碼洩漏列）。

---

開始執行。
