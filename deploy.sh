#!/usr/bin/env bash
set -e

APP_NAME="lunafirpay"
CONFIG_FILE="config.yaml"

echo "========================================="
echo " LunaFirPay 一键部署脚本"
echo " - 不包含 Nginx"
echo "========================================="

# -----------------------------
# 工具函数：检测包管理器
# -----------------------------
PM=""
if command -v apt >/dev/null 2>&1; then PM="apt"; fi
if command -v dnf >/dev/null 2>&1; then PM="dnf"; fi
if command -v yum >/dev/null 2>&1; then PM="yum"; fi
if command -v pacman >/dev/null 2>&1; then PM="pacman"; fi
if command -v apk >/dev/null 2>&1; then PM="apk"; fi

if [ -z "$PM" ]; then
    echo "❌ 不支持的系统：未检测到 apt/yum/dnf/pacman/apk"
    exit 1
fi

echo "✔ 检测到包管理器：$PM"

# -----------------------------
# 架构检测（用于 yq）
# -----------------------------
ARCH="$(uname -m)"
case "$ARCH" in
    x86_64|amd64) YQ_ARCH="amd64" ;;
    aarch64|arm64) YQ_ARCH="arm64" ;;
    *)
        echo "❌ 不支持的架构：$ARCH"
        exit 1
        ;;
esac
echo "✔ 架构：$ARCH -> $YQ_ARCH"

# -----------------------------
# 安装基础依赖
# -----------------------------
install_pkgs() {
    case "$PM" in
        apt)
            sudo apt update
            sudo apt install -y "$@"
            ;;
        dnf)
            sudo dnf install -y "$@"
            ;;
        yum)
            sudo yum install -y "$@"
            ;;
        pacman)
            sudo pacman -Sy --noconfirm "$@"
            ;;
        apk)
            sudo apk add --no-cache "$@"
            ;;
    esac
}

echo
echo "📦 安装基础依赖（curl/wget/git）..."
# 有些系统 wget 可能没有，所以两个都装
install_pkgs curl wget git || true

# -----------------------------
# 输入 MySQL 信息
# -----------------------------
echo
echo "📌 请输入 MySQL 信息"
read -p "MySQL Host: " DB_HOST
read -p "MySQL Port (默认 3306): " DB_PORT
read -p "MySQL 用户名: " DB_USER
read -s -p "MySQL 密码: " DB_PASS
echo ""
read -p "数据库名称: " DB_NAME

DB_PORT=${DB_PORT:-3306}

if [ -z "$DB_HOST" ] || [ -z "$DB_USER" ] || [ -z "$DB_NAME" ]; then
    echo "❌ DB_HOST / DB_USER / DB_NAME 不能为空"
    exit 1
fi

# -----------------------------
# 安装 Node.js
# -----------------------------
if ! command -v node >/dev/null 2>&1; then
    echo
    echo "📦 Node.js 未安装，正在安装..."

    case "$PM" in
        apt)
            # 优先 NodeSource 18
            curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
            sudo apt install -y nodejs
            ;;
        dnf|yum)
            # NodeSource for RHEL/CentOS
            curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
            install_pkgs nodejs
            ;;
        pacman)
            install_pkgs nodejs npm
            ;;
        apk)
            # Alpine 官方源
            install_pkgs nodejs npm
            ;;
    esac
fi

echo "✔ Node: $(node -v)"
echo "✔ NPM : $(npm -v)"

# -----------------------------
# 安装 yq（用于精准修改 YAML）
# -----------------------------
if ! command -v yq >/dev/null 2>&1; then
    echo
    echo "📦 安装 yq..."

    # 如果系统仓库里有 yq，可以优先用包管理器
    case "$PM" in
        apt|dnf|yum|pacman|apk)
            if install_pkgs yq >/dev/null 2>&1; then
                echo "✔ 已通过包管理器安装 yq"
            else
                echo "⚠️ 仓库无法安装 yq，改用二进制安装"
                sudo wget -qO /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${YQ_ARCH}"
                sudo chmod +x /usr/local/bin/yq
            fi
            ;;
    esac
fi

echo "✔ yq: $(yq --version 2>/dev/null || echo installed)"

# -----------------------------
# 安装项目依赖
# -----------------------------
echo
echo "📦 安装项目 npm 依赖..."
npm install

# -----------------------------
# 修改 config.yaml（不覆盖其他配置）
# -----------------------------
echo
if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ 未找到 $CONFIG_FILE（请确认脚本在仓库根目录执行）"
    exit 1
fi

echo "🧷 备份配置文件 -> ${CONFIG_FILE}.bak"
cp "$CONFIG_FILE" "${CONFIG_FILE}.bak"

echo "✍️ 替换 config.yaml 中的 database 配置..."
yq -i "
    .database.host = \"${DB_HOST}\" |
    .database.port = ${DB_PORT} |
    .database.user = \"${DB_USER}\" |
    .database.password = \"${DB_PASS}\" |
    .database.database = \"${DB_NAME}\"
" "$CONFIG_FILE"

echo "✔ database 配置更新完成"

# -----------------------------
# 启动：systemd 优先，否则 nohup
# -----------------------------
echo
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    echo "🛠 检测到 systemd，配置守护进程（开机自启）..."

    SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
    WORKDIR="$(pwd)"

    sudo bash -c "cat > ${SERVICE_FILE}" <<EOF
[Unit]
Description=LunaFirPay Node Service
After=network.target

[Service]
Type=simple
WorkingDirectory=${WORKDIR}
ExecStart=$(command -v node) app.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable "${APP_NAME}"
    sudo systemctl restart "${APP_NAME}"

    echo "✅ systemd 部署完成"
    echo "查看状态：sudo systemctl status ${APP_NAME}"
    echo "查看日志：sudo journalctl -u ${APP_NAME} -f"

else
    echo "⚠️ 未检测到 systemd（例如 Alpine/OpenWrt/容器环境）"
    echo "➡️ 改用 nohup 后台运行（不会开机自启）"

    # 停掉旧进程（如果存在）
    pkill -f "node app.js" >/dev/null 2>&1 || true

    nohup node app.js > "${APP_NAME}.log" 2>&1 &
    echo "✅ 已后台启动：nohup node app.js"
    echo "查看日志：tail -f ${APP_NAME}.log"
fi

echo
echo "========================================="
echo "✅ 部署完成！"
echo "🔧 配置文件已备份：${CONFIG_FILE}.bak"
echo "========================================="
