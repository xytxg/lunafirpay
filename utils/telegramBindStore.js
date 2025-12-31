/**
 * Telegram 绑定令牌内存存储
 * 用于存储 Telegram 账号绑定的临时令牌
 * 令牌 5 分钟后自动过期
 */

const crypto = require('crypto');

// 内存存储: Map<token, { userId, userType, expiresAt }>
const tokenStore = new Map();

// 用户令牌映射: Map<`${userType}:${userId}`, token>
const userTokenMap = new Map();

// 令牌有效期（5分钟）
const TOKEN_EXPIRY = 5 * 60 * 1000;

// 定期清理过期令牌（每分钟）
setInterval(() => {
  cleanup();
}, 60 * 1000);

/**
 * 生成绑定令牌
 * @param {string|number} userId - 用户ID
 * @param {string} userType - 用户类型 (merchant/admin/ram)
 * @returns {string} 绑定令牌
 */
function generateToken(userId, userType) {
  const userKey = `${userType}:${userId}`;
  
  // 删除该用户之前的令牌
  const oldToken = userTokenMap.get(userKey);
  if (oldToken) {
    tokenStore.delete(oldToken);
  }
  
  // 生成新令牌
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + TOKEN_EXPIRY;
  
  // 保存令牌
  tokenStore.set(token, {
    userId: String(userId),
    userType,
    expiresAt
  });
  userTokenMap.set(userKey, token);
  
  return token;
}

/**
 * 验证并消费令牌
 * @param {string} token - 绑定令牌
 * @returns {{ userId: string, userType: string } | null} 用户信息或 null
 */
function verifyAndConsume(token) {
  const data = tokenStore.get(token);
  
  if (!data) {
    return null;
  }
  
  // 检查是否过期
  if (Date.now() > data.expiresAt) {
    tokenStore.delete(token);
    userTokenMap.delete(`${data.userType}:${data.userId}`);
    return null;
  }
  
  // 消费令牌（一次性使用）
  tokenStore.delete(token);
  userTokenMap.delete(`${data.userType}:${data.userId}`);
  
  return {
    userId: data.userId,
    userType: data.userType
  };
}

/**
 * 获取令牌信息（不消费）
 * @param {string} token - 绑定令牌
 * @returns {{ userId: string, userType: string, expiresAt: number } | null}
 */
function getTokenInfo(token) {
  const data = tokenStore.get(token);
  
  if (!data || Date.now() > data.expiresAt) {
    return null;
  }
  
  return {
    userId: data.userId,
    userType: data.userType,
    expiresAt: data.expiresAt
  };
}

/**
 * 删除用户的令牌
 * @param {string|number} userId - 用户ID
 * @param {string} userType - 用户类型
 */
function deleteUserToken(userId, userType) {
  const userKey = `${userType}:${userId}`;
  const token = userTokenMap.get(userKey);
  
  if (token) {
    tokenStore.delete(token);
    userTokenMap.delete(userKey);
  }
}

/**
 * 获取过期时间（ISO格式）
 * @param {string} token - 绑定令牌
 * @returns {string|null} 过期时间 ISO 字符串
 */
function getExpiresAt(token) {
  const data = tokenStore.get(token);
  if (!data) return null;
  return new Date(data.expiresAt).toISOString();
}

/**
 * 清理过期令牌
 */
function cleanup() {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [token, data] of tokenStore.entries()) {
    if (now > data.expiresAt) {
      tokenStore.delete(token);
      userTokenMap.delete(`${data.userType}:${data.userId}`);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[TelegramBindStore] 已清理 ${cleaned} 个过期令牌`);
  }
}

/**
 * 获取存储状态（调试用）
 */
function getStats() {
  return {
    tokenCount: tokenStore.size,
    userMappingCount: userTokenMap.size
  };
}

module.exports = {
  generateToken,
  verifyAndConsume,
  getTokenInfo,
  deleteUserToken,
  getExpiresAt,
  cleanup,
  getStats
};
