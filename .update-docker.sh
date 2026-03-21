#!/usr/bin/env bash
set -euo pipefail

APP_CONTAINER="${APP_CONTAINER:-lunafirpay-app}"
DB_CONTAINER="${DB_CONTAINER:-lunafirpay-db}"
IMAGE_NAME="${IMAGE_NAME:-lunafirpay}"
DB_NAME="${DB_NAME:-lunafirpay}"
DB_ROOT_PASSWORD="${DB_ROOT_PASSWORD:-root_change_me}"
INIT_SQL="${INIT_SQL:-./initialization.sql}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"

if [[ ! -f "$INIT_SQL" ]]; then
  echo "[ERROR] initialization.sql 不存在: $INIT_SQL"
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "[ERROR] docker-compose.yml 不存在: $COMPOSE_FILE"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] 未找到 docker 命令"
  exit 1
fi

compose_cmd="docker compose"
if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    compose_cmd="docker-compose"
  else
    echo "[ERROR] 未找到 docker compose / docker-compose"
    exit 1
  fi
fi

apply_db_migration() {
  echo "[INFO] 直接执行 initialization.sql ..."
  docker exec -i "$DB_CONTAINER" sh -c \
    "mysql --default-character-set=utf8mb4 -uroot -p\"$DB_ROOT_PASSWORD\" $DB_NAME" < "$INIT_SQL"
  echo "[INFO] 数据库迁移执行完成"
}

ensure_services() {
  echo "[INFO] 确保 db 服务在线..."
  $compose_cmd -f "$COMPOSE_FILE" up -d db
}

current_image_ts() {
  local current_image_id
  current_image_id="$(docker inspect -f '{{.Image}}' "$APP_CONTAINER" 2>/dev/null || true)"
  if [[ -z "$current_image_id" ]]; then
    echo "0"
    return
  fi

  local ts
  ts="$(docker image inspect -f '{{ index .Config.Labels "com.lunafirpay.build_ts" }}' "$current_image_id" 2>/dev/null || true)"
  if [[ -z "$ts" || "$ts" == "<no value>" ]]; then
    echo "0"
  else
    echo "$ts"
  fi
}

build_new_image() {
  local new_ts="$1"
  echo "[INFO] 构建新镜像，版本时间戳: $new_ts"
  docker build \
    --build-arg IMAGE_BUILD_TS="$new_ts" \
    -t "$IMAGE_NAME:latest" \
    -t "$IMAGE_NAME:ts-$new_ts" \
    .
}

new_image_ts() {
  local ts
  ts="$(docker image inspect -f '{{ index .Config.Labels "com.lunafirpay.build_ts" }}' "$IMAGE_NAME:latest" 2>/dev/null || true)"
  if [[ -z "$ts" || "$ts" == "<no value>" ]]; then
    echo "0"
  else
    echo "$ts"
  fi
}

main() {
  ensure_services

  local old_ts
  old_ts="$(current_image_ts)"

  local new_ts
  new_ts="$(date +%Y%m%d%H%M%S)"

  build_new_image "$new_ts"

  local built_ts
  built_ts="$(new_image_ts)"

  if [[ "$built_ts" =~ ^[0-9]+$ ]] && [[ "$old_ts" =~ ^[0-9]+$ ]]; then
    if (( built_ts <= old_ts )); then
      echo "[INFO] 新镜像版本($built_ts) <= 当前版本($old_ts)，跳过升级"
      exit 0
    fi
  fi

  apply_db_migration

  echo "[INFO] 启动新版本 app 容器"
  $compose_cmd -f "$COMPOSE_FILE" up -d --no-deps app

  echo "[INFO] 升级完成"
  echo "       旧版本时间戳: $old_ts"
  echo "       新版本时间戳: $built_ts"
}

main "$@"
