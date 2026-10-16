#!/usr/bin/env bash
set +x
set -euo pipefail

usage() {
  cat <<'HELP'
[pulse] Pulse.js 面板安裝／升級（支援 Ubuntu〔systemd〕與 macOS〔launchd〕，需 root）
用法：bash host-install.sh [--ref <git ref>] [--repo <owner/name>]
      curl -fsSL https://raw.githubusercontent.com/JS-PACKAGE/Pulse.js/main/host-install.sh | sudo bash -s -- [參數]
環境變數：PULSE_REF（預設 main）、PULSE_REPO（預設 JS-PACKAGE/Pulse.js）。
不安裝 cloudflared；請自行設定 Cloudflare Tunnel + Access。
HELP
}
log() { printf '[pulse] %s\n' "$*"; }
die() { printf '[pulse] 錯誤：%s\n' "$*" >&2; exit 1; }
ref=${PULSE_REF:-main}
repo=${PULSE_REPO:-JS-PACKAGE/Pulse.js}
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --ref) (($# >= 2)) || die '--ref 缺少值'; ref=$2; shift 2 ;;
    --repo) (($# >= 2)) || die '--repo 缺少值'; repo=$2; shift 2 ;;
    *) die '未知參數；請使用 --help' ;;
  esac
done
case "$(uname -s)" in
  Darwin)
    family=macos; node_os=darwin; node_ext=tar.gz; svc_user=_pulse
    log "偵測到 macOS $(sw_vers -productVersion 2>/dev/null || printf '未知版本')"
    ;;
  Linux)
    [[ -r /etc/os-release ]] || die '面板安裝僅支援 Ubuntu 與 macOS'
    . /etc/os-release
    [[ ${ID:-} == ubuntu ]] || die '面板安裝僅支援 Ubuntu 與 macOS'
    family=ubuntu; node_os=linux; node_ext=tar.xz; svc_user=pulse
    log "偵測到 Ubuntu ${VERSION_ID:-未知版本}"
    ;;
  *) die '面板安裝僅支援 Ubuntu 與 macOS' ;;
esac
if ((EUID != 0)); then
  if command -v sudo >/dev/null 2>&1; then
    die '需要 root。請使用 curl -fsSL https://raw.githubusercontent.com/JS-PACKAGE/Pulse.js/main/host-install.sh | sudo bash'
  fi
  die '需要 root，請以 root 執行（系統未提供 sudo）'
fi
if [[ $family == ubuntu ]]; then command -v systemctl >/dev/null 2>&1 || die '面板安裝需要 systemd'; fi
launchd_label=js-package.pulse
launchd_plist=/Library/LaunchDaemons/$launchd_label.plist
service_restart() {
  if [[ $family == macos ]]; then launchctl kickstart -k "system/$launchd_label"; else systemctl restart pulse; fi
}
service_stop() {
  if [[ $family == macos ]]; then launchctl bootout "system/$launchd_label"; else systemctl stop pulse; fi
}
service_logs() {
  if [[ $family == macos ]]; then tail -n 50 /var/log/pulse.log; else journalctl -u pulse -n 50 --no-pager; fi
}
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die '--repo 必須是 owner/name'
[[ -n $ref && $ref != *$'\n'* && $ref != *$'\r'* ]] || die '--ref 無效'
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die '不支援的 CPU 架構；僅支援 x64 / arm64' ;;
esac
umask 022
mkdir -p /opt/pulse
chmod 755 /opt/pulse
# staging 與 app 放在相同檔案系統，使部署切換使用 rename。
work=$(mktemp -d /opt/pulse/.install.XXXXXX)
deployment_pending=0
had_previous=0
cleanup() {
  local status=$?
  trap - EXIT
  if ((deployment_pending)); then
    printf '[pulse] 錯誤：部署失敗，正在回滾應用程式\n' >&2
    if [[ -e /opt/pulse/app ]]; then
      mv /opt/pulse/app "$work/failed-app" || true
    fi
    if ((had_previous)); then
      if mv /opt/pulse/app.prev /opt/pulse/app; then
        service_restart >/dev/null 2>&1 || true
      else
        printf '[pulse] 錯誤：自動回滾失敗；舊版仍保留於 /opt/pulse/app.prev\n' >&2
      fi
    else
      service_stop >/dev/null 2>&1 || true
    fi
  fi
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log '=== 安裝前置工具 ==='
if [[ $family == macos ]]; then
  for tool in curl tar shasum; do command -v "$tool" >/dev/null 2>&1 || die "缺少 macOS 系統工具 ${tool}"; done
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y curl ca-certificates tar xz-utils
fi
node_ok() { [[ -x $1 ]] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1; }
ensure_node() {
  local candidate filename='' checksum='' sum file extra actual
  candidate=$(command -v node || true)
  if [[ -n $candidate ]] && node_ok "$candidate"; then
    node_bin=$("$candidate" -p 'process.execPath')
    # nvm-style installs under home directories are invisible to the service (ProtectHome / other user).
    case $node_bin in
      /home/*|/root/*|/Users/*) log "略過家目錄中的 Node.js（${node_bin}），改用私有版本" ;;
      *) return ;;
    esac
  fi
  if node_ok /opt/pulse/node/bin/node; then node_bin=/opt/pulse/node/bin/node; return; fi
  log '下載並校驗官方 Node.js 24'
  curl -fsSL --proto '=https' https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$work/SHASUMS256.txt"
  while read -r sum file extra; do
    if [[ $file == node-v24.*-"$node_os"-"$arch"."$node_ext" && $sum =~ ^[[:xdigit:]]{64}$ && -z ${extra:-} ]]; then
      filename=$file; checksum=$sum; break
    fi
  done <"$work/SHASUMS256.txt"
  [[ -n $filename && $filename != */* ]] || die '官方清單中沒有相容的 Node.js 套件'
  curl -fsSL --proto '=https' "https://nodejs.org/dist/latest-v24.x/$filename" -o "$work/node-archive"
  if [[ $family == macos ]]; then actual=$(shasum -a 256 "$work/node-archive"); else actual=$(sha256sum "$work/node-archive"); fi
  [[ ${actual%% *} == "$checksum" ]] || die 'Node.js SHA256 校驗失敗，已中止'
  mkdir -p /opt/pulse/node
  chmod 755 /opt/pulse/node
  tar -xf "$work/node-archive" -C /opt/pulse/node --strip-components=1
  node_bin=/opt/pulse/node/bin/node
  node_ok "$node_bin" || die 'Node.js 安裝後驗證失敗'
}
log '=== 準備 Node.js ==='
ensure_node
export PATH="${node_bin%/*}:$PATH"
command -v npm >/dev/null 2>&1 || die '所選 Node.js 沒有可用 npm'
log "使用 Node.js：$("$node_bin" --version)"

log '=== 下載並建置面板 ==='
export PULSE_INSTALL_REF=$ref
encoded_ref=$("$node_bin" -e 'process.stdout.write(encodeURIComponent(process.env.PULSE_INSTALL_REF))')
unset PULSE_INSTALL_REF
curl -fsSL --proto '=https' "https://codeload.github.com/$repo/tar.gz/$encoded_ref" -o "$work/source.tar.gz"
mkdir "$work/staging"
tar -xzf "$work/source.tar.gz" -C "$work/staging" --strip-components=1 --no-same-owner
(
  cd "$work/staging"
  # better-sqlite3 內建各平台 prebuild；npm 10 不理會其 "gypfile": false，
  # 會改跑 node-gyp rebuild（需要 make／編譯器）。略過 install script 也避免以 root 執行套件腳本。
  npm ci --ignore-scripts
  npm run build
  npm prune --omit=dev
)
[[ -f $work/staging/dist/server/main.mjs && -f $work/staging/config.yaml ]] || die '建置輸出或設定範本缺失'
chmod 755 "$work/staging"
if [[ $family == macos ]]; then
  # macOS 系統帳號慣例：底線開頭、隱藏、不可登入，ID 取 300–499 間未使用者。
  macos_free_id() {
    local used id
    used=$({ dscl . -list /Users UniqueID; dscl . -list /Groups PrimaryGroupID; } | awk '{ print $2 }')
    for ((id = 300; id < 500; id++)); do
      if ! grep -qx "$id" <<<"$used"; then printf '%s\n' "$id"; return 0; fi
    done
    return 1
  }
  if ! dscl . -read /Groups/_pulse >/dev/null 2>&1; then
    gid=$(macos_free_id) || die '找不到可用的系統群組 ID（300–499）'
    dscl . -create /Groups/_pulse
    dscl . -create /Groups/_pulse PrimaryGroupID "$gid"
    dscl . -create /Groups/_pulse RealName 'Pulse.js'
    dscl . -create /Groups/_pulse Password '*'
  fi
  gid=$(dscl . -read /Groups/_pulse PrimaryGroupID | awk '{ print $2 }')
  if ! dscl . -read /Users/_pulse >/dev/null 2>&1; then
    uid=$(macos_free_id) || die '找不到可用的系統使用者 ID（300–499）'
    dscl . -create /Users/_pulse
    dscl . -create /Users/_pulse UniqueID "$uid"
    dscl . -create /Users/_pulse PrimaryGroupID "$gid"
    dscl . -create /Users/_pulse UserShell /usr/bin/false
    dscl . -create /Users/_pulse NFSHomeDirectory /var/empty
    dscl . -create /Users/_pulse RealName 'Pulse.js'
    dscl . -create /Users/_pulse Password '*'
    dscl . -create /Users/_pulse IsHidden 1
  fi
  id -u _pulse >/dev/null 2>&1 || die '建立系統使用者 _pulse 失敗'
else
  getent group pulse >/dev/null 2>&1 || groupadd --system pulse
  if ! id -u pulse >/dev/null 2>&1; then useradd --system --gid pulse --no-create-home --shell /usr/sbin/nologin pulse; fi
fi
install -d -o "$svc_user" -g "$svc_user" -m 750 /var/lib/pulse
install -d -o root -g "$svc_user" -m 750 /etc/pulse
[[ ! -e /opt/pulse/app.prev && ! -L /opt/pulse/app.prev ]] || die '/opt/pulse/app.prev 已存在；請先檢查先前部署備份，避免覆蓋'
if [[ -e /opt/pulse/app || -L /opt/pulse/app ]]; then
  mv /opt/pulse/app /opt/pulse/app.prev
  had_previous=1
fi
deployment_pending=1
mv "$work/staging" /opt/pulse/app

log '=== 設定與背景服務 ==='
if [[ -e /etc/pulse/config.yaml ]]; then
  log '保留既有 /etc/pulse/config.yaml（不覆寫）'
else
  sed 's|^  path: ./data/pulse\.db$|  path: /var/lib/pulse/pulse.db|' /opt/pulse/app/config.yaml >"$work/config.yaml"
  grep -qx '  path: /var/lib/pulse/pulse.db' "$work/config.yaml" || die '無法修改範本 database.path；請檢查設定格式'
  install -o root -g "$svc_user" -m 640 "$work/config.yaml" /etc/pulse/config.yaml
fi
if [[ $family == macos ]]; then
  # launchd 以服務帳號開啟 StandardOutPath，先建立並交給 _pulse。
  touch /var/log/pulse.log
  chown _pulse:_pulse /var/log/pulse.log
  chmod 640 /var/log/pulse.log
  export PULSE_INSTALL_NODE=$node_bin PULSE_INSTALL_PLIST=$launchd_plist PULSE_INSTALL_LABEL=$launchd_label
  "$node_bin" -e '
const fs = require("node:fs");
const escape = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
fs.writeFileSync(process.env.PULSE_INSTALL_PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${process.env.PULSE_INSTALL_LABEL}</string>
<key>ProgramArguments</key><array><string>${escape(process.env.PULSE_INSTALL_NODE)}</string><string>/opt/pulse/app/dist/server/main.mjs</string><string>--config</string><string>/etc/pulse/config.yaml</string></array>
<key>WorkingDirectory</key><string>/opt/pulse/app</string>
<key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string></dict>
<key>UserName</key><string>_pulse</string>
<key>GroupName</key><string>_pulse</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>/var/log/pulse.log</string>
<key>StandardErrorPath</key><string>/var/log/pulse.log</string>
</dict></plist>\n`);
'
  unset PULSE_INSTALL_NODE PULSE_INSTALL_PLIST PULSE_INSTALL_LABEL
  chown root:wheel "$launchd_plist"
  chmod 644 "$launchd_plist"
  launchctl bootout "system/$launchd_label" >/dev/null 2>&1 || true
  # 曾被 `launchctl disable` 的服務無法 bootstrap，也不會開機啟動；先解除停用。
  launchctl enable "system/$launchd_label"
  launchctl bootstrap system "$launchd_plist"
else
  cat >/etc/systemd/system/pulse.service <<UNIT
[Unit]
Description=Pulse.js monitoring dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pulse
WorkingDirectory=/opt/pulse/app
ExecStart="$node_bin" /opt/pulse/app/dist/server/main.mjs --config /etc/pulse/config.yaml
Environment=NODE_ENV=production
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/pulse
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
  chmod 644 /etc/systemd/system/pulse.service
  systemctl daemon-reload
  systemctl enable pulse
  systemctl restart pulse
fi

log '=== 等待健康檢查（最多 30 秒） ==='
if ! "$node_bin" --input-type=module >"$work/health-target" <<'NODE'
import fs from 'node:fs';
import { parse } from '/opt/pulse/app/node_modules/yaml/dist/index.js';
try {
  const config = parse(fs.readFileSync('/etc/pulse/config.yaml', 'utf8'));
  let host = String(config.server.host);
  const port = Number(config.server.port);
  if (!host || /[\s\x00-\x1f\x7f/@?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw Error();
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  process.stdout.write(`http://${host}:${port}/api/health\n${port}\n`);
} catch {
  console.error('[pulse] 錯誤：無法從設定取得健康檢查位址');
  process.exit(1);
}
NODE
then
  service_logs >&2 || true
  exit 1
fi
{
  IFS= read -r health_url
  IFS= read -r port
} <"$work/health-target"
healthy=0
start=$SECONDS
while ((SECONDS - start < 30)); do
  remaining=$((30 - (SECONDS - start)))
  request_timeout=2
  ((remaining >= request_timeout)) || request_timeout=$remaining
  if curl -fsS --noproxy '*' --connect-timeout "$request_timeout" --max-time "$request_timeout" "$health_url" -o "$work/health.json" 2>/dev/null &&
    "$node_bin" -e 'try {process.exit(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).ok === true ? 0 : 1)} catch {process.exit(1)}' "$work/health.json"; then
    healthy=1; break
  fi
  ((SECONDS - start >= 30)) || sleep 1
done
if ((!healthy)); then
  printf '[pulse] 錯誤：健康檢查失敗。服務日誌最後 50 行：\n' >&2
  service_logs >&2 || true
  exit 1
fi
if [[ $family == macos ]]; then
  launchctl print "system/$launchd_label" >/dev/null || die "launchd 服務 ${launchd_label} 未載入"
  if launchctl print-disabled system | grep -Eq "\"$launchd_label\" => (true|disabled)"; then
    die "launchd 服務 ${launchd_label} 被停用，不會開機自動啟動"
  fi
else
  systemctl is-enabled --quiet pulse || die 'pulse.service 未設定開機自動啟動（systemctl is-enabled pulse）'
fi
deployment_pending=0
if ((had_previous)); then rm -rf -- /opt/pulse/app.prev; fi
if [[ $family == macos ]]; then
  log "面板安裝完成，已設定開機自動啟動（LaunchDaemon ${launchd_label}，RunAtLoad，帳號 _pulse）。"
else
  log '面板安裝完成，已設定開機自動啟動（systemd pulse.service，enabled）。'
fi
log "程式：/opt/pulse/app　Node.js：${node_bin}　設定：/etc/pulse/config.yaml　資料：/var/lib/pulse"
if [[ $family == macos ]]; then log '查看日誌：tail -f /var/log/pulse.log'; else log '查看日誌：journalctl -u pulse -f'; fi
log '=== Cloudflare Tunnel + Access ==='
if ! command -v cloudflared >/dev/null 2>&1; then
  log '警告：未安裝 cloudflared。面板預設只綁 loopback；請自行安裝並設定 Cloudflare Tunnel + Access，見 README（本腳本不代裝）。'
else
  log "請確認 tunnel ingress 指向 http://127.0.0.1:${port}，並以 Cloudflare Access 保護。"
fi
