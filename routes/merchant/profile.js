/**
 * 商户个人资料 & Telegram 绑定路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const crypto = require('crypto');
const telegramService = require('../../Telegram');
const telegramBindStore = require('../../utils/telegramBindStore');

const { requireMerchantMainAccount, requireMerchantRamPermission } = require('../auth');

const isEnabledStatus = (status) => status === 'active' || status === 'approved';

function getDisplayLength(value) {
  return Array.from(value || '').reduce((sum, ch) => sum + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
}

// 获取个人资料（RAM 子账户可访问，但只能看到有限信息用于修改密码）
router.get('/profile', async (req, res) => {
  try {
    const { user_id } = req.user;
    const merchant = req.merchant;
    const ramUser = req.ramUser;

    // RAM 子账户只返回基本信息，用于修改密码
    if (ramUser) {
      return res.json({
        code: 0,
        data: {
          isRam: true,
          user_id: ramUser.user_id,
          username: ramUser.user_id,
          display_name: ramUser.display_name
        }
      });
    }

    const [users] = await db.query(
      'SELECT id, username, email, merchant_name, created_at FROM users WHERE id = ?',
      [user_id]
    );

    if (users.length === 0) {
      return res.json({ code: -1, msg: '用户不存在' });
    }

    const [pmRows] = await db.query(
      'SELECT id as merchant_id, status as provider_status, pid, rsa_public_key, rsa_private_key, balance FROM merchants WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      [user_id]
    );
    const merchantId = pmRows.length > 0 ? pmRows[0].merchant_id : null;
    const providerStatus = pmRows.length > 0 ? pmRows[0].provider_status : 'inactive';
    const pid = pmRows.length > 0 ? pmRows[0].pid : null;
    const rsaPublicKey = pmRows.length > 0 ? pmRows[0].rsa_public_key : null;
    const rsaPrivateKey = pmRows.length > 0 ? pmRows[0].rsa_private_key : null;
    const balance = pmRows.length > 0 ? parseFloat(pmRows[0].balance || 0) : 0;

    // 从数据库获取系统配置和 API 端点
    const [[apiConfig]] = await db.query(
      "SELECT config_value FROM system_config WHERE config_key = 'api_endpoint'"
    );
    const apiEndpoint = apiConfig?.config_value || null;

    res.json({ 
      code: 0, 
      data: {
        ...users[0],
        merchant_id: merchantId,
        provider_status: providerStatus,
        pid,
        balance,
        // V1 接口信息
        api_key: isEnabledStatus(providerStatus) ? merchant.api_key : null,
        // V2 接口信息（RSA）
        rsa_public_key: isEnabledStatus(providerStatus) ? rsaPublicKey : null,
        rsa_private_key: isEnabledStatus(providerStatus) ? rsaPrivateKey : null,
        api_endpoint: isEnabledStatus(providerStatus) ? apiEndpoint : null,
        api_endpoint_not_set: isEnabledStatus(providerStatus) && !apiEndpoint,
        notify_url: merchant.notify_url,
        return_url: merchant.return_url,
        status: merchant.status
      }
    });
  } catch (error) {
    console.error('获取资料错误:', error);
    res.json({ code: -1, msg: '获取资料失败' });
  }
});

// 更新商户资料（仅主账户）- 修改邮箱
router.post('/profile', requireMerchantMainAccount, async (req, res) => {
  try {
    const { user_id } = req.user;
    const { email, merchant_name } = req.body;

    if (merchant_name !== undefined) {
      const merchantName = String(merchant_name || '').trim();
      if (merchantName && getDisplayLength(merchantName) > 16) {
        return res.json({ code: -1, msg: '商户名称不能超过16个字符（中文按2个字符计算）' });
      }

      await db.query('UPDATE users SET merchant_name = ? WHERE id = ?', [merchantName || null, user_id]);
    }

    if (email) {
      // 检查邮箱是否被其他用户使用
      const [existing] = await db.query(
        'SELECT id FROM users WHERE email = ? AND id != ?',
        [email, user_id]
      );
      if (existing.length > 0) {
        return res.json({ code: -1, msg: '邮箱已被其他用户使用' });
      }

      await db.query('UPDATE users SET email = ? WHERE id = ?', [email, user_id]);
    }

    res.json({ code: 0, msg: '资料更新成功' });
  } catch (error) {
    console.error('更新资料错误:', error);
    res.json({ code: -1, msg: '更新资料失败' });
  }
});

// ============ Telegram 绑定管理 ============

// 获取 Telegram 绑定状态
router.get('/telegram/status', async (req, res) => {
  try {
    const userId = req.ramUser ? req.ramUser.user_id : req.user.user_id;
    const userType = req.ramUser ? 'ram' : 'merchant';

    const [rows] = await db.query(
      `SELECT chat_id, username, nickname, notify_payment, notify_balance, notify_settlement, enabled, created_at
       FROM telegram_bindings
       WHERE user_type = ? AND user_id = ?`,
      [userType, String(userId)]
    );

    if (rows.length === 0) {
      return res.json({ code: 0, data: { bound: false } });
    }

    const binding = rows[0];
    res.json({
      code: 0,
      data: {
        bound: true,
        username: binding.username,
        nickname: binding.nickname,
        notifyPayment: binding.notify_payment === 1,
        notifyBalance: binding.notify_balance === 1,
        notifySettlement: binding.notify_settlement === 1,
        enabled: binding.enabled === 1,
        createdAt: binding.created_at
      }
    });
  } catch (error) {
    console.error('获取 Telegram 绑定状态错误:', error);
    res.json({ code: -1, msg: '获取绑定状态失败' });
  }
});

// 生成 Telegram 绑定码
router.post('/telegram/bindToken', requireMerchantRamPermission('settings'), async (req, res) => {
  try {
    const userId = req.ramUser ? req.ramUser.user_id : req.user.user_id;
    const userType = req.ramUser ? 'ram' : 'merchant';

    // 检查是否已绑定
    const [existing] = await db.query(
      'SELECT id FROM telegram_bindings WHERE user_type = ? AND user_id = ?',
      [userType, String(userId)]
    );
    if (existing.length > 0) {
      return res.json({ code: -1, msg: '已绑定 Telegram，请先解绑' });
    }

    // 使用内存存储生成新的绑定码（5分钟过期）
    const token = telegramBindStore.generateToken(userId, userType);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const botName = telegramService.config.botName || 'your_bot';
    const bindUrl = `https://t.me/${botName}?start=${token}`;

    res.json({
      code: 0,
      data: { token, bindUrl, expiresAt: expiresAt.toISOString() }
    });
  } catch (error) {
    console.error('生成 Telegram 绑定码错误:', error);
    res.json({ code: -1, msg: '生成绑定码失败' });
  }
});

// 解除 Telegram 绑定
router.post('/telegram/unbind', requireMerchantRamPermission('settings'), async (req, res) => {
  try {
    const userId = req.ramUser ? req.ramUser.user_id : req.user.user_id;
    const userType = req.ramUser ? 'ram' : 'merchant';

    const [result] = await db.query(
      'DELETE FROM telegram_bindings WHERE user_type = ? AND user_id = ?',
      [userType, String(userId)]
    );

    if (result.affectedRows === 0) {
      return res.json({ code: -1, msg: '未找到绑定记录' });
    }

    res.json({ code: 0, msg: '解绑成功' });
  } catch (error) {
    console.error('解除 Telegram 绑定错误:', error);
    res.json({ code: -1, msg: '解绑失败' });
  }
});

// 发送 Telegram 测试消息
router.post('/telegram/test', async (req, res) => {
  try {
    const userId = req.ramUser ? req.ramUser.user_id : req.user.user_id;
    const userType = req.ramUser ? 'ram' : 'merchant';

    const [rows] = await db.query(
      'SELECT chat_id FROM telegram_bindings WHERE user_type = ? AND user_id = ? AND enabled = 1',
      [userType, String(userId)]
    );

    if (rows.length === 0) {
      return res.json({ code: -1, msg: '未绑定或已禁用通知' });
    }

    telegramService.sendMessage(
      rows[0].chat_id,
      `🔔 *测试通知*\n\n这是一条测试消息，如果您收到此消息，说明 Telegram 通知功能正常工作！\n\n发送时间：${new Date().toLocaleString('zh-CN')}`
    );

    res.json({ code: 0, msg: '测试消息已发送' });
  } catch (error) {
    console.error('发送 Telegram 测试消息错误:', error);
    res.json({ code: -1, msg: '发送测试消息失败' });
  }
});

// 重置 API Key（不允许商户自行重置）
router.post('/reset-api-key', requireMerchantMainAccount, async (req, res) => {
  res.json({ code: -1, msg: '不支持商户自行重置密钥：请联系管理员' });
});

// 设置手续费承担方 - 单服务商模式
router.post('/fee-bearer', requireMerchantRamPermission('settings'), async (req, res) => {
  try {
    const { user_id } = req.user;
    const { feeBearer } = req.body;

    if (!['merchant', 'buyer'].includes(feeBearer)) {
      return res.json({ code: -1, msg: '无效的手续费承担方' });
    }

    // 检查商户是否存在（单服务商模式：不按 provider_id 过滤）
    const [existing] = await db.query(
      'SELECT * FROM merchants WHERE user_id = ? AND status IN ("active", "approved")',
      [user_id]
    );

    if (existing.length === 0) {
      return res.json({ code: -1, msg: '商户记录不存在或未审核通过' });
    }

    // 更新手续费承担方（单服务商模式：更新所有记录）
    await db.query(
      'UPDATE merchants SET fee_payer = ? WHERE user_id = ?',
      [feeBearer, user_id]
    );

    res.json({ code: 0, msg: '设置成功' });
  } catch (error) {
    console.error('设置手续费承担方错误:', error);
    res.json({ code: -1, msg: '设置失败' });
  }
});

module.exports = router;
