# Pulse.js

多主機中央監控面板。各主機上的 **Agent** 週期回報五項指標（主記憶體、CPU 負載、GPU〔多卡、NVIDIA／AMD／Apple Silicon〕、主磁碟空間、網路上下行流量）到 **host 端**（Express＋SQLite），Web 面板首頁只列**異常中**的主機，詳情頁依主機系統與自訂群組分組檢視。Agent 另外每 6 小時檢查一次作業系統待安裝更新，面板首頁提醒有更新的主機（只提醒，不代裝）。對外由 **Cloudflare Zero Trust**（Tunnel＋Access）保護，驗證完全在該層進行。

```
[受監控主機 Linux／macOS]                         [host 端（Ubuntu／macOS）]
  pulse-agent ──HTTPS POST + Authorization──▶ Cloudflare Access ─▶ cloudflared ─▶ 127.0.0.1:8080
    collectors（/proc、sysctl、netstat）                                            Express REST API + SSE
    GPU adapters（nvidia-smi、rocm-smi、ioreg）                                     SQLite（WAL）
                                                                                    React 面板（zh-TW／en／ja、暗／亮）
```

完整需求與設計見 [`PLAN.md`](PLAN.md)；撰寫規則見 [`AGENTS.md`](AGENTS.md)。

## 需求

| 項目 | 說明 |
|---|---|
| Node.js | v22 以上（安裝腳本在缺少時會下載官方 Node 22 並以 SHA-256 校驗，裝在私有目錄） |
| host 端 | Ubuntu（systemd）或 macOS（launchd）；x64／arm64 |
| Agent 端 | Debian/Ubuntu 系、RHEL 系（Rocky／Alma／CentOS／Fedora／Amazon Linux）、macOS；x64／arm64 |
| cloudflared | **自備**，`host-install.sh` 不代裝 |
| Cloudflare Zero Trust | 一個 Access application 保護面板網域 |

### 前置：Cloudflare Tunnel＋Access（自備）

1. 在 host 上安裝 cloudflared（[官方說明](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)），建立 tunnel，ingress 指向面板：`service: http://127.0.0.1:8080`（埠號依 `config.yaml`）。
2. 在 Zero Trust 建立 **Self-hosted Access application** 涵蓋該網域；人員以 Access policy 登入面板。
3. Agent 上報用 **Service Token**：建立 service token，在 application 加一條 *Service Auth* policy 允許它，並把 application 的 `read_service_tokens_from_header` 設為 `Authorization`（[Cloudflare 文件](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)）。此時 **Auth 驗證碼**就是整段 header 值：

   ```
   {"cf-access-client-id": "<CLIENT_ID>", "cf-access-client-secret": "<CLIENT_SECRET>"}
   ```

   Agent 會把驗證碼**原樣**放進 `Authorization` header，因此也可用任何你在 Zero Trust 層設定的其他 header 規則。
4. 驗證碼為**全端共用單一碼**；輪替＝在 Zero Trust 換新 token 後，各 Agent 重跑 `install.sh` 輸入新碼。

App 只綁 `127.0.0.1`，不讀取、不比對 `Authorization`；繞過 Tunnel 的直連不可達。

## host 端（面板）安裝

```bash
curl -fsSL https://raw.githubusercontent.com/JS-PACKAGE/Pulse.js/main/host-install.sh | sudo bash
```

- 偵測平台（Ubuntu 或 macOS，其他系統會明確提示並中止）→ 補齊前置工具（Ubuntu：`apt-get install curl ca-certificates tar xz-utils`；macOS：使用內建工具）→ 確保 Node 22+（需要時裝私有版本到 `/opt/pulse/node`，SHA-256 校驗）→ 下載原始碼建置 → 部署到 `/opt/pulse/app` → 註冊並啟動服務 → 健康檢查 `GET /api/health` → 驗證開機自啟並列出安裝位置。
  - Ubuntu：systemd `pulse.service`（enabled），以系統使用者 `pulse` 執行；日誌 `journalctl -u pulse -f`
  - macOS：launchd `/Library/LaunchDaemons/js-package.pulse.plist`（RunAtLoad＋KeepAlive，安裝時解除先前的 `launchctl disable`），以隱藏系統帳號 `_pulse` 執行（不存在時以 `dscl` 建立，ID 取 300–499 未使用者）；日誌 `tail -f /var/log/pulse.log`
- 設定檔 `/etc/pulse/config.yaml`（首次安裝由範本複製，資料庫改到 `/var/lib/pulse/pulse.db`；之後重跑**不覆寫**）。
- 重跑即更新；建置或健康檢查失敗會回滾到舊版。
- 參數：`--ref <git ref>`（`PULSE_REF`，預設 `main`）、`--repo <owner/name>`（`PULSE_REPO`）。用 `sudo bash -s -- --ref v0.1.0` 傳入。

手動安裝（無法用腳本時）：

```bash
git clone https://github.com/JS-PACKAGE/Pulse.js.git && cd Pulse.js
npm ci --ignore-scripts && npm run build   # --ignore-scripts：使用 better-sqlite3 內建 prebuild，免編譯工具
cp config.yaml /etc/pulse/config.yaml   # 依需要修改 database.path 等
node dist/server/main.mjs --config /etc/pulse/config.yaml
```

## Agent 安裝

```bash
curl -fsSL https://raw.githubusercontent.com/JS-PACKAGE/Pulse.js/main/install.sh | sudo bash
```

1. 自動偵測平台（Linux-Deb／Linux-RPM／macOS）、架構、GPU 數、主網路介面並列出摘要。
2. 補齊系統工具、確保 Node 22+。
3. **結尾詢問 POST 目標主機名稱與 Auth 驗證碼**（驗證碼以隱藏輸入，不回顯、不寫日誌）。主機名稱如 `pulse.example.com`（自動補 `https://`），`http://` 只允許 `127.0.0.1`／`localhost`（本機開發）。
4. 經 Zero Trust 從面板下載 `GET /agent/pulse-agent.mjs`（與伺服器同版本）安裝到 `/opt/pulse-agent/`（私有 Node.js 在 `/opt/pulse-agent/node`），寫入 `/etc/pulse-agent/agent.json`，註冊服務並立即啟動、開機自動啟動（安裝結尾會驗證並列出安裝位置）：
   - Linux：systemd `pulse-agent.service`（enabled），以系統使用者 `pulse-agent` 執行；日誌 `journalctl -u pulse-agent -f`
   - macOS：launchd `/Library/LaunchDaemons/js-package.pulse-agent.plist`（RunAtLoad＋KeepAlive，安裝時解除先前的 `launchctl disable`），以 root 執行（Apple Silicon GPU 指標所需）；日誌 `tail -f /var/log/pulse-agent.log`

非互動安裝（驗證碼不要寫在命令列參數，會留在 shell history 與 process list）：

```bash
# 驗證碼放在只有 root 可讀的檔案，安裝後刪除
curl -fsSL https://raw.githubusercontent.com/JS-PACKAGE/Pulse.js/main/install.sh \
  | sudo bash -s -- --server pulse.example.com --auth-file /root/pulse-auth.txt
```

以 root 身分執行時也可改用環境變數 `PULSE_SERVER`、`PULSE_AUTH`。

重跑 `install.sh` 即升級 Agent／輪替驗證碼（`diskPath`、`netInterface` 會保留）。

`/etc/pulse-agent/agent.json`：

| 欄位 | 說明 |
|---|---|
| `serverUrl` | 面板網址（https） |
| `authorization` | `Authorization` header 原樣值（Auth 驗證碼） |
| `diskPath` | 主磁碟掛載點，預設 `/` |
| `netInterface` | 網路介面；空字串＝預設路由的介面 |

## 協定摘要

所有請求經 Cloudflare Zero Trust；錯誤 body 為 `{ "error": "<code>", "details"?: [...] }`。

| 方法與路徑 | 用途 | 回應 |
|---|---|---|
| `POST /api/agent/register` | `register`：hostname、osFamily、osVersion、arch、cpuModel、gpuCount、agentVersion | 201 新增／200 既有：`{hostId, reportIntervalSec}` |
| `POST /api/agent/report` | `report`：hostId、ts、metrics（7 欄，`null`＝N/A）、gpus（`null`＝採集失敗）、updates（`{checkedAt, pending, security}`；`null`／省略＝尚未成功檢查，伺服器保留既有值） | `{status}`；404 未知主機（Agent 會重新註冊）；429 過頻 |
| `GET /api/hosts` | `listHosts`：狀態 ok／alert／offline、異常項目、最新樣本、最近一次 OS 更新檢查 | `ListHostsResponse` |
| `GET /api/hosts/:id?minutes=60` | `hostDetail`：即時值＋近期序列（1–43200 分鐘，即最長 30 天；超過約 720 點時依時間分桶取平均） | `HostDetailResponse` |
| `DELETE /api/hosts/:id` | 刪除主機（面板詳情頁「刪除主機」）：連同歷史樣本、GPU 樣本、更新檢查與群組指派；id 不重複使用。Agent 若仍在執行，下次上報收到 404 後會以新主機重新註冊，請先停用該主機的 Agent | 204；404 不存在 |
| `GET /api/groups` | 系統群組＋自訂群組 | `{groups}` |
| `POST /api/groups`、`PATCH /api/groups/:id`、`DELETE /api/groups/:id` | `createGroup`／`renameGroup`／`deleteGroup`（系統群組不可改，400；名稱重複 409） | 201／200／204 |
| `PUT`／`DELETE /api/groups/:id/hosts/:hostId` | `assignHost` 指派／移出 | 204 |
| `GET /api/events` | `event`（SSE）：`status`／`report`／`host`／`hostDeleted`／`groups` | `text/event-stream` |
| `GET /api/health` | 健康檢查 | `{ok, version}` |
| `GET /agent/pulse-agent.mjs` | Agent 單檔 bundle（供 `install.sh`） | JavaScript |

錯誤碼：400 欄位驗證失敗、401／403 Zero Trust 層拒絕、404 主機／群組不存在、409 群組名稱衝突、413 payload 超過 64KB、429 過頻、500 內部錯誤（generic）。型別定義見 `src/shared/types.ts`。

## `config.yaml`

所有鍵皆必填（缺漏會拒絕啟動，不會默默套預設值）。相對路徑以設定檔所在目錄為基準。

| 鍵 | 預設範本 | 說明 |
|---|---|---|
| `server.host`／`server.port` | `127.0.0.1`／`8080` | 監聽位址；非 loopback 須另設 `allowExternalBind: true`（僅在防火牆限定 Tunnel 來源時） |
| `tls.enabled`／`certFile`／`keyFile` | `false` | 直接提供 HTTPS（通常 TLS 終止於 Cloudflare 邊緣，不需開） |
| `database.path`／`busyTimeoutMs` | `./data/pulse.db`／`5000` | SQLite 檔（WAL） |
| `agent.reportIntervalSec` | `30` | 註冊時下發給 Agent 的上報週期 |
| `agent.offlineAfterSec` | `90` | 超過即判定離線（異常） |
| `agent.minReportIntervalSec` | `10` | 每台主機上報頻率上限，超過回 429 |
| `retention.days`／`cleanupIntervalHours` | `30`／`24` | 樣本保留天數與清理週期 |
| `limits.maxPayloadBytes` | `65536` | 上報 payload 上限（最大 64KB） |
| `thresholds.*.warn`／`crit` | 見檔案 | CPU 負載%、記憶體%、磁碟%、GPU 使用率%、GPU 記憶體%、網路下行／上行 kbps；達 warn 即為異常，crit 為嚴重 |

CPU 負載%＝1 分鐘 load average ÷ 邏輯 CPU 數 ×100（可超過 100）。記憶體已用量不含可回收的快取：Linux 為 `MemTotal − MemAvailable`，macOS 為 `總量 × (100 − kern.memorystatus_level)%`（即 `memory_pressure` 的 free percentage，精度 1%）。

### 系統更新提醒

Agent 每 6 小時在背景檢查一次 OS 待安裝更新（不影響上報週期，也不影響 ok／alert 狀態），結果隨下一次上報送出；面板首頁列出有更新的主機，主機列表與詳情頁顯示數量與檢查時間。只查不裝，也不更新套件索引：

| 平台 | 指令 | 安全性更新 |
|---|---|---|
| Linux-Deb | `apt-get -s dist-upgrade`（模擬，數 `Inst` 行；索引由系統的 `apt-daily.timer` 更新） | 來源含 `-security` 者 |
| Linux-RPM | `dnf -q -C check-update`（只用快取；快取由 `dnf-makecache.timer` 更新） | `--security` 再查一次 |
| macOS | `softwareupdate -l`（向 Apple 查詢，最長 5 分鐘） | 不提供（顯示總數） |

檢查失敗只記 warning，面板保留上一次成功的結果與其檢查時間。

## 開發與測試

```bash
npm ci
npm run typecheck     # tsc：server／agent／shared／tests ＋ web
npm test              # vitest：GPU／系統 collector 契約測試、驗證、Mock Agent 註冊→上報→alert 整合測試、loopback 直連測試
npm run build         # dist/server、dist/agent（單檔）、dist/web
npm start             # 以 ./config.yaml 啟動（http://127.0.0.1:8080）
npm run dev:web       # 面板開發伺服器（代理到 127.0.0.1:8080）
```

本機試跑 Agent（不安裝服務）：

```bash
echo '{"serverUrl":"http://127.0.0.1:8080","authorization":"dev"}' > /tmp/agent.json
node dist/agent/pulse-agent.mjs --config /tmp/agent.json
```

## 授權

Copyright Pulse.js contributors. 依 [Apache License 2.0](LICENSE) 授權。

### 第三方授權聲明

伺服器 runtime 依賴（隨 `npm ci --omit=dev` 安裝）與打包進面板的套件：

| 套件 | 版本 | 授權 |
|---|---|---|
| express（及其相依 body-parser、router 等） | 5.3.0 | MIT |
| better-sqlite3（內含 SQLite，public domain） | 13.0.3 | MIT |
| yaml | 2.9.1 | ISC |
| qs（express 相依） | — | BSD-3-Clause |
| inherits、once、wrappy、setprototypeof（express 相依） | — | ISC |
| react、react-dom、scheduler（打包於 `dist/web`） | 19.3.1 | MIT |

其餘 express 遞移相依皆為 MIT。開發工具（TypeScript〔Apache-2.0〕、Vite、Vitest、esbuild、@vitejs/plugin-react、@types/*〔MIT〕）不隨產品散布。完整清單以 `package-lock.json` 為準。Agent bundle 不含任何第三方程式碼。
