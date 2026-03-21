#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCK_FILE="$ROOT_DIR/.update.lock"
CONFIG_FILE="${CONFIG_FILE:-$ROOT_DIR/config.yaml}"
INIT_SQL="${INIT_SQL:-$ROOT_DIR/initialization.sql}"
GIT_REF="${GIT_REF:-origin/main}"
SERVICE_NAME="${SERVICE_NAME:-lunafirpay}"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[ERROR] 已有更新任务在运行，退出"
  exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "[ERROR] 配置文件不存在: $CONFIG_FILE"
  exit 1
fi

if [[ ! -f "$INIT_SQL" ]]; then
  echo "[ERROR] initialization.sql 不存在: $INIT_SQL"
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "[ERROR] 未安装 git"
  exit 1
fi

if ! command -v mysql >/dev/null 2>&1; then
  echo "[ERROR] 未安装 mysql 客户端"
  exit 1
fi

cd "$ROOT_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[ERROR] 当前目录不是 git 仓库: $ROOT_DIR"
  exit 1
fi

yaml_db_value() {
  local key="$1"
  awk -F: -v key="$key" '
    /^database:[[:space:]]*$/ {in_db=1; next}
    in_db && /^[^[:space:]]/ {in_db=0}
    in_db {
      k=$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", k)
      if (k == key) {
        sub(/^[^:]*:[[:space:]]*/, "", $0)
        gsub(/^["'\'' ]+|["'\'' ]+$/, "", $0)
        print $0
        exit
      }
    }
  ' "$CONFIG_FILE"
}

hash_file() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$f" | awk '{print $NF}'
  else
    echo "[ERROR] 无可用哈希命令（sha256sum/shasum/openssl）"
    exit 1
  fi
}

DB_HOST="$(yaml_db_value host)"
DB_PORT="$(yaml_db_value port)"
DB_USER="$(yaml_db_value user)"
DB_PASSWORD="$(yaml_db_value password)"
DB_NAME="$(yaml_db_value database)"

DB_PORT="${DB_PORT:-3306}"

if [[ -z "$DB_HOST" || -z "$DB_USER" || -z "$DB_PASSWORD" || -z "$DB_NAME" ]]; then
  echo "[ERROR] config.yaml 数据库配置不完整"
  exit 1
fi

export MYSQL_PWD="$DB_PASSWORD"

echo "[INFO] 拉取远端代码..."
git fetch --all --prune

CURRENT_COMMIT="$(git rev-parse HEAD)"
TARGET_COMMIT="$(git rev-parse "$GIT_REF")"

if [[ "$CURRENT_COMMIT" != "$TARGET_COMMIT" ]]; then
  echo "[INFO] 发现新版本: $CURRENT_COMMIT -> $TARGET_COMMIT"
else
  echo "[INFO] 代码已是最新，继续检查数据库迁移"
fi

CONFIG_BAK="$(mktemp)"
cp "$CONFIG_FILE" "$CONFIG_BAK"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "[INFO] 检测到本地改动，自动 stash 以避免覆盖冲突"
  git stash push --include-untracked -m "auto-update-stash-$(date +%s)" >/dev/null
  STASHED=1
else
  STASHED=0
fi

git reset --hard "$TARGET_COMMIT"

cp "$CONFIG_BAK" "$CONFIG_FILE"
rm -f "$CONFIG_BAK"

if [[ "$STASHED" == "1" ]]; then
  echo "[INFO] 跳过自动恢复 stash，避免把旧代码改动带回新版本"
fi

echo "[INFO] 安装依赖..."
npm install --omit=dev

LOCAL_HASH="$(hash_file "$INIT_SQL")"

DB_HASH="$(mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -Nse "SELECT config_value FROM system_config WHERE config_key='baremetal_init_sql_sha256' LIMIT 1" "$DB_NAME" 2>/dev/null || true)"

if [[ "$LOCAL_HASH" != "$DB_HASH" ]]; then
  echo "[INFO] 检测到 initialization.sql 变化，开始平滑迁移数据库..."
  mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" < "$INIT_SQL"
  mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -e \
    "INSERT INTO system_config (config_key, config_value, description) VALUES ('baremetal_init_sql_sha256', '$LOCAL_HASH', 'baremetal initialization.sql sha256') ON DUPLICATE KEY UPDATE config_value=VALUES(config_value), description=VALUES(description), updated_at=NOW()" \
    "$DB_NAME"
  echo "[INFO] 数据库迁移完成"
else
  echo "[INFO] initialization.sql 未变化，跳过数据库迁移"
fi

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q "^${SERVICE_NAME}\.service"; then
  echo "[INFO] 重启 systemd 服务: $SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
elif command -v pm2 >/dev/null 2>&1 && pm2 list | grep -q "app.js"; then
  echo "[INFO] 使用 pm2 reload app.js"
  pm2 reload app.js || pm2 restart app.js
else
  echo "[INFO] 使用 nohup 方式重启 node app.js"
  pkill -f "node app.js" >/dev/null 2>&1 || true
  nohup node app.js > "$ROOT_DIR/lunafirpay.log" 2>&1 &
fi

echo "[INFO] 更新完成"
echo "       当前提交: $(git rev-parse --short HEAD)"
echo "       SQL hash : $LOCAL_HASH"
