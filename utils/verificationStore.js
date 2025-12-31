/**
 * 验证码内存存储模块
 * 使用 Map 存储验证码，自动清理过期记录
 * 验证码有效期：10分钟
 */

class VerificationStore {
  constructor() {
    // 存储格式: Map<key, { code, expiresAt, used }>
    // key = `${email}:${type}`
    this.store = new Map();
    
    // 发送频率限制: Map<email, lastSendTime>
    this.rateLimitStore = new Map();
    
    // 过期时间：10分钟
    this.EXPIRE_TIME = 10 * 60 * 1000;
    
    // 发送间隔：60秒
    this.RATE_LIMIT_INTERVAL = 60 * 1000;
    
    // 启动定时清理（每5分钟清理一次过期记录）
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000);
    
    console.log('[VerificationStore] 验证码内存存储已启动');
  }

  /**
   * 生成存储键
   */
  _getKey(email, type) {
    return `${email.toLowerCase()}:${type}`;
  }

  /**
   * 生成10位随机验证码（大小写字母+数字）
   */
  generateCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let code = '';
    for (let i = 0; i < 10; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  /**
   * 检查发送频率限制
   * @param {string} email - 邮箱地址
   * @returns {boolean} - true 表示可以发送，false 表示发送太频繁
   */
  checkRateLimit(email) {
    const lastSendTime = this.rateLimitStore.get(email.toLowerCase());
    if (lastSendTime && Date.now() - lastSendTime < this.RATE_LIMIT_INTERVAL) {
      return false;
    }
    return true;
  }

  /**
   * 获取剩余等待时间（秒）
   * @param {string} email - 邮箱地址
   * @returns {number} - 剩余秒数，0 表示可以发送
   */
  getRateLimitRemaining(email) {
    const lastSendTime = this.rateLimitStore.get(email.toLowerCase());
    if (!lastSendTime) return 0;
    const remaining = Math.ceil((this.RATE_LIMIT_INTERVAL - (Date.now() - lastSendTime)) / 1000);
    return remaining > 0 ? remaining : 0;
  }

  /**
   * 保存验证码
   * @param {string} email - 邮箱地址
   * @param {string} type - 类型（register/reset）
   * @param {string} code - 验证码
   * @param {string} ip - 客户端IP（可选，用于日志）
   */
  save(email, type, code, ip = null) {
    const key = this._getKey(email, type);
    const emailLower = email.toLowerCase();
    
    // 保存验证码
    this.store.set(key, {
      code,
      expiresAt: Date.now() + this.EXPIRE_TIME,
      used: false,
      ip,
      createdAt: Date.now()
    });
    
    // 更新发送时间（用于频率限制）
    this.rateLimitStore.set(emailLower, Date.now());
    
    console.log(`[VerificationStore] 已保存验证码: ${emailLower} (${type}), 10分钟后过期`);
  }

  /**
   * 验证验证码
   * @param {string} email - 邮箱地址
   * @param {string} code - 验证码
   * @param {string} type - 类型（register/reset）
   * @returns {boolean} - 验证是否成功
   */
  verify(email, code, type) {
    const key = this._getKey(email, type);
    const record = this.store.get(key);
    
    if (!record) {
      console.log(`[VerificationStore] 验证失败: 未找到记录 ${email} (${type})`);
      return false;
    }
    
    // 检查是否已使用
    if (record.used) {
      console.log(`[VerificationStore] 验证失败: 验证码已使用 ${email} (${type})`);
      return false;
    }
    
    // 检查是否过期
    if (Date.now() > record.expiresAt) {
      console.log(`[VerificationStore] 验证失败: 验证码已过期 ${email} (${type})`);
      this.store.delete(key);
      return false;
    }
    
    // 检查验证码是否匹配（区分大小写）
    if (record.code !== code) {
      console.log(`[VerificationStore] 验证失败: 验证码不匹配 ${email} (${type})`);
      return false;
    }
    
    // 标记为已使用
    record.used = true;
    this.store.set(key, record);
    
    console.log(`[VerificationStore] 验证成功: ${email} (${type})`);
    return true;
  }

  /**
   * 删除验证码
   * @param {string} email - 邮箱地址
   * @param {string} type - 类型
   */
  delete(email, type) {
    const key = this._getKey(email, type);
    this.store.delete(key);
  }

  /**
   * 清理过期记录
   */
  cleanup() {
    const now = Date.now();
    let cleanedCount = 0;
    
    // 清理过期验证码
    for (const [key, record] of this.store.entries()) {
      if (now > record.expiresAt) {
        this.store.delete(key);
        cleanedCount++;
      }
    }
    
    // 清理过期的发送频率记录（超过1小时的）
    const oneHourAgo = now - 60 * 60 * 1000;
    for (const [email, lastSendTime] of this.rateLimitStore.entries()) {
      if (lastSendTime < oneHourAgo) {
        this.rateLimitStore.delete(email);
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`[VerificationStore] 已清理 ${cleanedCount} 条过期记录`);
    }
  }

  /**
   * 获取存储统计
   */
  getStats() {
    return {
      totalCodes: this.store.size,
      rateLimitEntries: this.rateLimitStore.size
    };
  }

  /**
   * 关闭存储（清理定时器）
   */
  close() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
    this.rateLimitStore.clear();
    console.log('[VerificationStore] 已关闭');
  }
}

// 导出单例
module.exports = new VerificationStore();
