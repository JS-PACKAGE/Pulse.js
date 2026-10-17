#!/usr/bin/env bash
set +x
set -euo pipefail

usage() {
  cat <<'HELP'
[pulse] Pulse.js Agent 安裝／升級（需 root）
用法：bash install.sh [--server <host或URL>] [--client-id <用戶端識別碼>] [--client-secret-file <path>]
      curl -fsSL https://raw.githubusercontent.com/JS-PACKAGE/Pulse.js/main/install.sh | sudo bash -s -- [參數]
環境變數：PULSE_SERVER、PULSE_CLIENT_ID、PULSE_CLIENT_SECRET。
已安裝時沿用 /etc/pulse-agent/agent.json 自動更新（參數／環境變數優先）；仍缺的值從 /dev/tty 詢問。
更新失敗時自動回滾到先前的 Agent、設定與服務定義。
用戶端識別碼／服務金鑰＝Cloudflare Access Service Token 的 Client ID／Client Secret。
服務金鑰僅支援環境變數、檔案或隱藏輸入；不接受 --client-secret。
HELP
}
log() { printf '[pulse] %s\n' "$*"; }
die() { printf '[pulse] 錯誤：%s\n' "$*" >&2; exit 1; }
server=${PULSE_SERVER:-}
client_id=${PULSE_CLIENT_ID:-}
client_secret=${PULSE_CLIENT_SECRET:-}
unset PULSE_CLIENT_SECRET
export -n client_secret
_secret_file=''
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --server) (($# >= 2)) || die '--server 缺少值'; server=$2; shift 2 ;;
    --client-id) (($# >= 2)) || die '--client-id 缺少值'; client_id=$2; shift 2 ;;
    --client-secret-file) (($# >= 2)) || die '--client-secret-file 缺少路徑'; _secret_file=$2; shift 2 ;;
    *) die '未知參數；請使用 --help（不支援 --client-secret）' ;;
  esac
done
if ((EUID != 0)); then
  if command -v sudo >/dev/null 2>&1; then
    die '需要 root。請使用 curl -fsSL https://raw.githubusercontent.com/JS-PACKAGE/Pulse.js/main/install.sh | sudo bash'
  fi
  die '需要 root，請以 root 執行（系統未提供 sudo）'
fi
umask 077
work=$(mktemp -d)
# 升級時置 1：之後任何失敗（含中斷）都還原先前的 Agent、設定與服務定義並重啟舊版。
rollback_pending=0
cleanup() {
  local status=$?
  trap - EXIT
  if ((rollback_pending)); then
    printf '[pulse] 錯誤：更新失敗，正在回滾到先前的 Agent\n' >&2
    if restore_previous && service_reload >/dev/null 2>&1; then
      printf '[pulse] 已恢復先前的 Agent 與設定\n' >&2
    else
      # 備份含服務金鑰，僅 root 可讀（umask 077）；保留供手動還原。
      printf '[pulse] 錯誤：自動回滾失敗；先前的檔案備份保留在 %s\n' "$work/backup" >&2
      exit "$status"
    fi
  fi
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log '=== 偵測平台與硬體 ==='
os=$(uname -s)
case "$os" in
  Darwin) family=macos; node_os=darwin ;;
  Linux)
    [[ -r /etc/os-release ]] || die '不支援：無法讀取 /etc/os-release'
    # /etc/os-release 為作業系統提供的 root 管理檔案。
    . /etc/os-release
    case " ${ID:-} ${ID_LIKE:-} " in
      *debian*|*ubuntu*) family=linux-deb ;;
      *rhel*|*fedora*|*centos*|*rocky*|*almalinux*|*amzn*) family=linux-rpm ;;
      *) die '不支援的 Linux 發行版；僅支援 Debian/Ubuntu 或 RHEL 系列' ;;
    esac
    node_os=linux
    command -v systemctl >/dev/null 2>&1 || die 'Linux Agent 需要 systemd'
    ;;
  *) die '不支援的平台；僅支援 Linux 與 macOS' ;;
esac
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die '不支援的 CPU 架構；僅支援 x64 / arm64' ;;
esac
log "平台：${family}；架構：${arch}"
agent_bin=/opt/pulse-agent/pulse-agent.mjs
agent_config=/etc/pulse-agent/agent.json
launchd_label=js-package.pulse-agent
if [[ $family == macos ]]; then
  service_file=/Library/LaunchDaemons/$launchd_label.plist
else
  service_file=/etc/systemd/system/pulse-agent.service
fi
# 升級會改寫的檔案；備份檔名用索引對應。
managed=("$agent_bin" "$agent_config" "$service_file")
backup_previous() {
  local i
  mkdir "$work/backup"
  for i in "${!managed[@]}"; do
    if [[ -e ${managed[i]} ]]; then cp -p -- "${managed[i]}" "$work/backup/$i"; fi
  done
}
restore_previous() {
  local i failed=0
  for i in "${!managed[@]}"; do
    if [[ -e $work/backup/$i ]]; then
      cp -p -- "$work/backup/$i" "${managed[i]}" || failed=1
    else
      rm -f -- "${managed[i]}" || failed=1
    fi
  done
  return "$failed"
}
service_reload() {
  local waited=0
  if [[ $family == macos ]]; then
    launchctl bootout "system/$launchd_label" >/dev/null 2>&1 || true
    # bootout 是非同步的：舊行程（可能正等 softwareupdate 子行程）結束前 bootstrap 會失敗
    # （Bootstrap failed: 5: Input/output error），留下未載入的服務。等 launchd 完全卸載再載入；
    # launchd 預設 ExitTimeOut 20 秒後強制結束，故最多等 30 秒。
    while launchctl print "system/$launchd_label" >/dev/null 2>&1; do
      ((waited < 60)) || return 1
      sleep 0.5
      waited=$((waited + 1))
    done
    # 曾被 `launchctl disable` 的服務無法 bootstrap，也不會開機啟動；先解除停用。
    launchctl enable "system/$launchd_label"
    launchctl bootstrap system "$service_file"
  else
    systemctl daemon-reload
    systemctl enable pulse-agent
    systemctl restart pulse-agent
  fi
}
service_pid() {
  if [[ $family == macos ]]; then
    launchctl print "system/$launchd_label" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }'
  else
    systemctl show -p MainPID --value pulse-agent
  fi
}
# 啟動即失敗（設定錯誤、bundle 損毀）會在數秒內結束並被重啟；同一個 PID 撐過觀察期才算成功。
verify_running() {
  local pid='' tries=0
  until [[ $pid =~ ^[1-9][0-9]*$ ]]; do
    ((tries < 20)) || return 1
    sleep 0.5
    tries=$((tries + 1))
    pid=$(service_pid || true)
  done
  sleep 5
  [[ $(service_pid || true) == "$pid" ]]
}
service_logs() {
  if [[ $family == macos ]]; then tail -n 30 /var/log/pulse-agent.log; else journalctl -u pulse-agent -n 30 --no-pager; fi
}
gpu_detected=0
if command -v nvidia-smi >/dev/null 2>&1; then
  gpu_detected=1
  if nvidia-smi -L >"$work/nvidia" 2>/dev/null; then
    count=$(awk 'NF { n++ } END { print n+0 }' "$work/nvidia")
    log "NVIDIA GPU：$count 張"
  else
    log '偵測到 nvidia-smi，但無法計數 GPU'
  fi
fi
if command -v rocm-smi >/dev/null 2>&1; then
  gpu_detected=1
  if rocm-smi --showproductname >"$work/amd" 2>/dev/null; then
    count=$(awk '/GPU\[[0-9]+\]/ { card=$0; sub(/^.*GPU\[/,"",card); sub(/\].*$/,"",card); cards[card]=1 } END { for (card in cards) n++; print n+0 }' "$work/amd")
    if ((count > 0)); then log "AMD GPU：$count 張"; else log '偵測到 rocm-smi，但無法計數 GPU'; fi
  else
    log '偵測到 rocm-smi，但無法計數 GPU'
  fi
fi
if [[ $family == macos && $arch == arm64 ]]; then gpu_detected=1; log 'GPU：Apple Silicon GPU'; fi
if ((!gpu_detected)); then log 'GPU：未偵測到支援工具（N/A）'; fi
interface=''
if [[ $family == macos ]]; then
  interface=$(route -n get default 2>/dev/null | awk '$1 == "interface:" { print $2; exit }' || true)
elif command -v ip >/dev/null 2>&1; then
  interface=$(ip route show default 2>/dev/null | awk '{ for (i=1;i<NF;i++) if ($i=="dev") {print $(i+1); exit} }' || true)
fi
if [[ -z $interface && -r /proc/net/route ]]; then
  interface=$(awk '$2 == "00000000" {print $1; exit}' /proc/net/route)
fi
log "主網路介面：${interface:-無法偵測（執行時自動偵測）}"

log '=== 準備系統工具 ==='
missing=0
for tool in curl tar; do command -v "$tool" >/dev/null 2>&1 || missing=1; done
if [[ $family != macos ]]; then
  for tool in xz sha256sum; do command -v "$tool" >/dev/null 2>&1 || missing=1; done
  [[ -s /etc/ssl/certs/ca-certificates.crt || -s /etc/pki/tls/certs/ca-bundle.crt ]] || missing=1
fi
if ((missing)); then
  case "$family" in
    linux-deb) export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y curl ca-certificates tar xz-utils ;;
    linux-rpm)
      if command -v dnf >/dev/null 2>&1; then dnf install -y curl tar xz ca-certificates;
      elif command -v yum >/dev/null 2>&1; then yum install -y curl tar xz ca-certificates;
      else die '找不到 dnf 或 yum'; fi ;;
    macos) die '缺少 macOS 系統工具 curl / tar' ;;
  esac
fi

node_ok() { [[ -x $1 ]] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1; }
ensure_node() {
  local candidate filename='' checksum='' sum file extra actual extension
  candidate=$(command -v node || true)
  if [[ -n $candidate ]] && node_ok "$candidate"; then
    node_bin=$("$candidate" -p 'process.execPath')
    # nvm-style installs under home directories are invisible to the service (ProtectHome / other user).
    case $node_bin in
      /home/*|/root/*|/Users/*) log "略過家目錄中的 Node.js（${node_bin}），改用私有版本" ;;
      *) return ;;
    esac
  fi
  if node_ok /opt/pulse-agent/node/bin/node; then node_bin=/opt/pulse-agent/node/bin/node; return; fi
  log '下載並校驗官方 Node.js 24'
  extension=tar.xz
  [[ $node_os != darwin ]] || extension=tar.gz
  curl -fsSL --proto '=https' https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$work/SHASUMS256.txt"
  while read -r sum file extra; do
    if [[ $file == node-v24.*-"$node_os"-"$arch"."$extension" && $sum =~ ^[[:xdigit:]]{64}$ && -z ${extra:-} ]]; then
      filename=$file; checksum=$sum; break
    fi
  done <"$work/SHASUMS256.txt"
  [[ -n $filename && $filename != */* ]] || die '官方清單中沒有相容的 Node.js 套件'
  curl -fsSL --proto '=https' "https://nodejs.org/dist/latest-v24.x/$filename" -o "$work/node-archive"
  if [[ $node_os == darwin ]]; then actual=$(shasum -a 256 "$work/node-archive"); else actual=$(sha256sum "$work/node-archive"); fi
  [[ ${actual%% *} == "$checksum" ]] || die 'Node.js SHA256 校驗失敗，已中止'
  mkdir -p /opt/pulse-agent/node
  chmod 755 /opt/pulse-agent /opt/pulse-agent/node
  (umask 022; tar -xf "$work/node-archive" -C /opt/pulse-agent/node --strip-components=1)
  node_bin=/opt/pulse-agent/node/bin/node
  node_ok "$node_bin" || die 'Node.js 安裝後驗證失敗'
}
log '=== 準備 Node.js ==='
ensure_node
log "使用 Node.js：$("$node_bin" --version)"

log '=== 設定上報目標與 Service Token ==='
if [[ -n $_secret_file ]]; then
  [[ -r $_secret_file ]] || die '無法讀取 --client-secret-file'
  client_secret=$(cat -- "$_secret_file")
fi
had_previous=0
if [[ -e $agent_config ]]; then
  # 已安裝：沿用 agent.json 的目標與 Service Token，重跑即自動更新、不再詢問；
  # 參數或環境變數仍優先（輪替 Service Token、更換面板）。
  [[ -e $agent_bin ]] && had_previous=1
  if ! PULSE_INSTALL_CONFIG=$agent_config "$node_bin" -e '
const fs = require("node:fs");
try {
  const config = JSON.parse(fs.readFileSync(process.env.PULSE_INSTALL_CONFIG, "utf8"));
  if (typeof config !== "object" || config === null) throw Error();
  const pick = key => typeof config[key] === "string" && !/[\x00-\x1f\x7f]/.test(config[key]) ? config[key] : "";
  process.stdout.write(["serverUrl", "accessClientId", "accessClientSecret"].map(pick).join("\n") + "\n");
} catch { process.exit(1); }
' >"$work/previous"; then die "無法解析既有設定 ${agent_config}；請修正 JSON 或移除後重新安裝"; fi
  { IFS= read -r previous_server; IFS= read -r previous_client_id; IFS= read -r previous_client_secret; } <"$work/previous"
  rm -f -- "$work/previous"
  [[ -n $server ]] || server=$previous_server
  [[ -n $client_id ]] || client_id=$previous_client_id
  [[ -n $client_secret ]] || client_secret=$previous_client_secret
  unset previous_client_secret
  log "偵測到既有安裝：沿用 ${agent_config} 的設定自動更新"
fi
if [[ -z $server || -z $client_id || -z $client_secret ]]; then
  if ! { exec 3<>/dev/tty; } 2>/dev/null; then
    die '沒有可用終端；請提供 --server、--client-id、--client-secret-file（或 PULSE_SERVER、PULSE_CLIENT_ID、PULSE_CLIENT_SECRET）'
  fi
  if [[ -z $server ]]; then
    printf '[pulse] POST 目標主機名稱或 URL：' >&3
    IFS= read -r server <&3 || die '無法讀取主機名稱'
  fi
  if [[ -z $client_id ]]; then
    printf '[pulse] 用戶端識別碼（Client ID）：' >&3
    IFS= read -r client_id <&3 || die '無法讀取用戶端識別碼'
  fi
  if [[ -z $client_secret ]]; then
    printf '[pulse] 服務金鑰（Client Secret，不回顯）：' >&3
    IFS= read -rs client_secret <&3 || die '無法讀取服務金鑰'
    printf '\n' >&3
  fi
  exec 3>&-
fi
# 去除貼上時夾帶的前後空白。
client_id=${client_id#"${client_id%%[![:space:]]*}"}; client_id=${client_id%"${client_id##*[![:space:]]}"}
client_secret=${client_secret#"${client_secret%%[![:space:]]*}"}; client_secret=${client_secret%"${client_secret##*[![:space:]]}"}
[[ -n $client_id && $client_id != *[[:cntrl:]]* ]] || die '用戶端識別碼不可為空或包含控制字元'
[[ -n $client_secret && $client_secret != *[[:cntrl:]]* ]] || die '服務金鑰不可為空或包含控制字元'
export PULSE_INSTALL_SERVER=$server
if ! server=$("$node_bin" -e '
try {
  let value = process.env.PULSE_INSTALL_SERVER;
  if (!value || /[\s\x00-\x1f\x7f]/.test(value)) throw Error();
  if (!value.includes("://")) value = "https://" + value;
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash) throw Error();
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))) throw Error();
  process.stdout.write(u.href.replace(/\/+$/, ""));
} catch { process.exit(1); }
'); then die '主機 URL 無效：僅允許 HTTPS，HTTP 僅限 loopback；不可包含帳密、query 或 fragment'; fi
unset PULSE_INSTALL_SERVER
log "上報目標：${server}"
header=$(mktemp "$work/header.XXXXXX")
chmod 600 "$header"
printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n' "$client_id" "$client_secret" >"$header"
log '=== 下載 Agent ==='
if ! http_code=$(curl -sS --proto '=https,http' -H "@$header" -o "$work/pulse-agent.mjs" -w '%{http_code}' \
  "$server/agent/pulse-agent.mjs" 2>"$work/download-error"); then
  die 'Agent 下載失敗：無法連線到面板，請檢查主機名稱與網路'
fi
case $http_code in
  2??) ;;
  3??) die 'Cloudflare Access 轉向登入頁：Service Token 未被接受。請確認該 Access application 有一條 Action 為 Service Auth、包含此 token 的 policy，並檢查用戶端識別碼與服務金鑰' ;;
  401|403) die "Cloudflare Zero Trust 拒絕（HTTP ${http_code}）：請檢查用戶端識別碼、服務金鑰與 Service Auth policy" ;;
  *) die "Agent 下載失敗（HTTP ${http_code}）" ;;
esac
IFS= read -r first_line <"$work/pulse-agent.mjs" || true
[[ $first_line == '#!/usr/bin/env node' ]] || die '下載內容不是 Pulse Agent；請確認目標是 Pulse 面板'
"$node_bin" --check "$work/pulse-agent.mjs" 2>/dev/null || die '下載的 Agent 不完整或無法解析；未變更現有安裝'
mkdir -p /opt/pulse-agent /etc/pulse-agent
chmod 755 /opt/pulse-agent
if [[ $family != macos ]]; then
  getent group pulse-agent >/dev/null 2>&1 || groupadd --system pulse-agent
  if ! id -u pulse-agent >/dev/null 2>&1; then useradd --system --gid pulse-agent --no-create-home --shell /usr/sbin/nologin pulse-agent; fi
  # rocm-smi reads /dev/kfd and /dev/dri, which belong to these groups on ROCm hosts.
  for gpu_group in video render; do
    if getent group "$gpu_group" >/dev/null 2>&1; then usermod -aG "$gpu_group" pulse-agent; fi
  done
  chown root:pulse-agent /etc/pulse-agent
  chmod 750 /etc/pulse-agent
else
  chown root:wheel /etc/pulse-agent
  chmod 700 /etc/pulse-agent
fi
if ((had_previous)); then
  backup_previous
  rollback_pending=1
  completed='更新完成'
else
  completed='安裝完成'
fi
install -m 755 "$work/pulse-agent.mjs" /opt/pulse-agent/pulse-agent.mjs
export PULSE_INSTALL_SERVER=$server PULSE_INSTALL_CLIENT_ID=$client_id PULSE_INSTALL_CLIENT_SECRET=$client_secret
if ! "$node_bin" -e '
const fs = require("node:fs");
try {
  const path = "/etc/pulse-agent/agent.json";
  const old = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
  const config = { serverUrl: process.env.PULSE_INSTALL_SERVER,
    accessClientId: process.env.PULSE_INSTALL_CLIENT_ID, accessClientSecret: process.env.PULSE_INSTALL_CLIENT_SECRET,
    diskPath: typeof old.diskPath === "string" ? old.diskPath : "/",
    netInterface: typeof old.netInterface === "string" ? old.netInterface : "" };
  fs.writeFileSync(path + ".new", JSON.stringify(config, null, 2) + "\n", {mode: 0o600});
  fs.renameSync(path + ".new", path);
} catch { process.exit(1); }
'; then die '無法更新 Agent 設定；請檢查原設定 JSON 與目錄權限'; fi
unset PULSE_INSTALL_SERVER PULSE_INSTALL_CLIENT_ID PULSE_INSTALL_CLIENT_SECRET client_secret
rm -f -- "$header"

log '=== 啟用背景服務 ==='
if [[ $family != macos ]]; then
  chown root:pulse-agent /etc/pulse-agent/agent.json
  chmod 640 /etc/pulse-agent/agent.json
  cat >/etc/systemd/system/pulse-agent.service <<UNIT
[Unit]
Description=Pulse.js monitoring agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pulse-agent
ExecStart="$node_bin" /opt/pulse-agent/pulse-agent.mjs --config /etc/pulse-agent/agent.json
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
  chmod 644 /etc/systemd/system/pulse-agent.service
  service_reload
  if ! verify_running; then
    service_logs >&2 || true
    die 'Agent 服務啟動後未能持續執行；以上為 journalctl -u pulse-agent 最後 30 行'
  fi
  systemctl is-enabled --quiet pulse-agent || die 'pulse-agent.service 未設定開機自動啟動（systemctl is-enabled pulse-agent）'
  rollback_pending=0
  log "${completed}，已設定開機自動啟動（systemd pulse-agent.service，enabled）。"
  log "程式：/opt/pulse-agent/pulse-agent.mjs　Node.js：${node_bin}　設定：/etc/pulse-agent/agent.json"
  log '查看日誌：journalctl -u pulse-agent -f'
else
  chown root:wheel /etc/pulse-agent/agent.json
  chmod 600 /etc/pulse-agent/agent.json
  export PULSE_INSTALL_NODE=$node_bin
  "$node_bin" -e '
const fs = require("node:fs");
const escape = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
fs.writeFileSync("/Library/LaunchDaemons/js-package.pulse-agent.plist", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>js-package.pulse-agent</string>
<key>ProgramArguments</key><array><string>${escape(process.env.PULSE_INSTALL_NODE)}</string><string>/opt/pulse-agent/pulse-agent.mjs</string><string>--config</string><string>/etc/pulse-agent/agent.json</string></array>
<key>UserName</key><string>root</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>/var/log/pulse-agent.log</string>
<key>StandardErrorPath</key><string>/var/log/pulse-agent.log</string>
</dict></plist>\n`);
'
  unset PULSE_INSTALL_NODE
  chown root:wheel /Library/LaunchDaemons/js-package.pulse-agent.plist
  chmod 644 /Library/LaunchDaemons/js-package.pulse-agent.plist
  service_reload || die 'launchd 無法重新載入 Agent 服務（舊服務 30 秒內未卸載或 bootstrap 失敗）'
  launchctl print "system/$launchd_label" >/dev/null || die 'launchd Agent 服務未載入'
  if ! verify_running; then
    service_logs >&2 || true
    die 'Agent 服務啟動後未能持續執行；以上為 /var/log/pulse-agent.log 最後 30 行'
  fi
  rollback_pending=0
  log "${completed}，已設定開機自動啟動（LaunchDaemon js-package.pulse-agent，RunAtLoad）。"
  log "程式：/opt/pulse-agent/pulse-agent.mjs　Node.js：${node_bin}　設定：/etc/pulse-agent/agent.json"
  log '查看日誌：tail -f /var/log/pulse-agent.log'
fi
