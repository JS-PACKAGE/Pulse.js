#!/usr/bin/env bash
set +x
set -euo pipefail

usage() {
  cat <<'HELP'
[pulse] Pulse.js 面板安裝／升級（僅支援 Ubuntu，需 root 與 systemd）
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
[[ $(uname -s) == Linux && -r /etc/os-release ]] || die '面板安裝僅支援 Ubuntu'
. /etc/os-release
[[ ${ID:-} == ubuntu ]] || die '面板安裝僅支援 Ubuntu'
log "偵測到 Ubuntu ${VERSION_ID:-未知版本}"
if ((EUID != 0)); then
  if command -v sudo >/dev/null 2>&1; then
    die '需要 root。請使用 curl -fsSL https://raw.githubusercontent.com/JS-PACKAGE/Pulse.js/main/host-install.sh | sudo bash'
  fi
  die '需要 root，請以 root 執行（系統未提供 sudo）'
fi
command -v systemctl >/dev/null 2>&1 || die '面板安裝需要 systemd'
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
        systemctl restart pulse >/dev/null 2>&1 || true
      else
        printf '[pulse] 錯誤：自動回滾失敗；舊版仍保留於 /opt/pulse/app.prev\n' >&2
      fi
    else
      systemctl stop pulse >/dev/null 2>&1 || true
    fi
  fi
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log '=== 安裝前置工具 ==='
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates tar xz-utils
node_ok() { [[ -x $1 ]] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; }
ensure_node() {
  local candidate filename='' checksum='' sum file extra actual
  candidate=$(command -v node || true)
  if [[ -n $candidate ]] && node_ok "$candidate"; then
    node_bin=$("$candidate" -p 'process.execPath')
    # nvm-style installs under home directories are invisible to the service (ProtectHome / other user).
    case $node_bin in
      /home/*|/root/*) log "略過家目錄中的 Node.js（${node_bin}），改用私有版本" ;;
      *) return ;;
    esac
  fi
  if node_ok /opt/pulse/node/bin/node; then node_bin=/opt/pulse/node/bin/node; return; fi
  log '下載並校驗官方 Node.js 22'
  curl -fsSL --proto '=https' https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$work/SHASUMS256.txt"
  while read -r sum file extra; do
    if [[ $file == node-v22.*-linux-"$arch".tar.xz && $sum =~ ^[[:xdigit:]]{64}$ && -z ${extra:-} ]]; then
      filename=$file; checksum=$sum; break
    fi
  done <"$work/SHASUMS256.txt"
  [[ -n $filename && $filename != */* ]] || die '官方清單中沒有相容的 Node.js 套件'
  curl -fsSL --proto '=https' "https://nodejs.org/dist/latest-v22.x/$filename" -o "$work/node-archive"
  actual=$(sha256sum "$work/node-archive")
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
  npm ci
  npm run build
  npm prune --omit=dev
)
[[ -f $work/staging/dist/server/main.mjs && -f $work/staging/config.yaml ]] || die '建置輸出或設定範本缺失'
chmod 755 "$work/staging"
getent group pulse >/dev/null 2>&1 || groupadd --system pulse
if ! id -u pulse >/dev/null 2>&1; then useradd --system --gid pulse --no-create-home --shell /usr/sbin/nologin pulse; fi
install -d -o pulse -g pulse -m 750 /var/lib/pulse
install -d -o root -g pulse -m 750 /etc/pulse
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
  cp /opt/pulse/app/config.yaml "$work/config.yaml"
  sed -i 's|^  path: ./data/pulse\.db$|  path: /var/lib/pulse/pulse.db|' "$work/config.yaml"
  grep -qx '  path: /var/lib/pulse/pulse.db' "$work/config.yaml" || die '無法修改範本 database.path；請檢查設定格式'
  install -o root -g pulse -m 640 "$work/config.yaml" /etc/pulse/config.yaml
fi
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
  journalctl -u pulse -n 50 --no-pager >&2 || true
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
  printf '[pulse] 錯誤：健康檢查失敗。服務日誌如下（journalctl -u pulse -n 50 --no-pager）：\n' >&2
  journalctl -u pulse -n 50 --no-pager >&2 || true
  exit 1
fi
systemctl is-enabled --quiet pulse || die 'pulse.service 未設定開機自動啟動（systemctl is-enabled pulse）'
deployment_pending=0
if ((had_previous)); then rm -rf -- /opt/pulse/app.prev; fi
log '面板安裝完成，已設定開機自動啟動（systemd pulse.service，enabled）。'
log "程式：/opt/pulse/app　Node.js：${node_bin}　設定：/etc/pulse/config.yaml　資料：/var/lib/pulse"
log '查看日誌：journalctl -u pulse -f'
log '=== Cloudflare Tunnel + Access ==='
if ! command -v cloudflared >/dev/null 2>&1; then
  log '警告：未安裝 cloudflared。面板預設只綁 loopback；請自行安裝並設定 Cloudflare Tunnel + Access，見 README（本腳本不代裝）。'
else
  log "請確認 tunnel ingress 指向 http://127.0.0.1:${port}，並以 Cloudflare Access 保護。"
fi
