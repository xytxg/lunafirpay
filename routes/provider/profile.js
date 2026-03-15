/**
 * Provider 资料设置 + Telegram绑定 + 通道自动关闭配置
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const crypto = require('crypto');
const telegramService = require('../../Telegram');
const telegramBindStore = require('../../utils/telegramBindStore');
const systemConfig = require('../../utils/systemConfig');
const { syncSitePublicConfigFromSystem } = require('../../utils/sitePublicConfig');
const { requireProviderRamPermission } = require('../auth');

// 获取服务商资料（所有用户可访问，RAM 用户返回部分信息）
router.get('/profile', async (req, res) => {
  try {
    const { user_id } = req.user;
    const ramUser = req.ramUser;

    // 获取系统配置
    const [configs] = await db.query('SELECT config_key, config_value FROM system_config');
    const configMap = {};
    configs.forEach(c => { configMap[c.config_key] = c.config_value; });

    // 检查是否有 settings 权限
    const hasSettingsPermission = !ramUser || 
      (ramUser.permissions && (ramUser.permissions.includes('admin') || ramUser.permissions.includes('settings')));

    // RAM 用户返回 RAM 账户信息
    if (ramUser) {
      const responseData = {
        isRam: true,
        hasSettingsPermission,
        ramInfo: {
          user_id: ramUser.user_id,
          display_name: ramUser.display_name,
          permissions: ramUser.permissions,
          created_at: ramUser.created_at,
          last_login_at: ramUser.last_login_at
        }
      };

      // 有 settings 权限时返回 API 节点信息
      if (hasSettingsPermission) {
        responseData.profile = {
          api_endpoint: configMap.api_endpoint || ''
        };
      }

      return res.json({ code: 0, data: responseData });
    }

    // 主账户返回完整信息
    const [users] = await db.query(
      'SELECT id, username, email, created_at FROM users WHERE id = ?',
      [user_id]
    );

    if (users.length === 0) {
      return res.json({ code: -1, msg: '用户不存在' });
    }

    // 获取统计数据
    const [[orderStats]] = await db.query(
      `SELECT 
        COUNT(*) as orderCount,
        COALESCE(SUM(CASE WHEN status = 1 THEN money ELSE 0 END), 0) as totalMoney,
        COALESCE(SUM(CASE WHEN status = 1 THEN fee_money ELSE 0 END), 0) as totalFee
       FROM orders`
    );

    const [[merchantStats]] = await db.query(
      'SELECT COUNT(*) as merchantCount FROM merchants WHERE status IN ("active", "approved")'
    );

    res.json({ 
      code: 0, 
      data: {
        isRam: false,
        hasSettingsPermission: true,
        profile: {
          username: users[0].username,
          email: users[0].email,
          api_endpoint: configMap.api_endpoint || '',
          site_name: configMap.site_name || '支付平台',
          created_at: users[0].created_at
        },
        stats: {
          merchantCount: merchantStats.merchantCount,
          totalMoney: orderStats.totalMoney,
          totalFee: orderStats.totalFee,
          orderCount: orderStats.orderCount
        }
      } 
    });
  } catch (error) {
    console.error('获取资料错误:', error);
    res.json({ code: -1, msg: '获取资料失败' });
  }
});

// 更新平台设置（需要 settings 权限）
router.post('/profile/update', requireProviderRamPermission('settings'), async (req, res) => {
  try {
    const { api_endpoint, site_name } = req.body;
    let shouldSyncSiteConfig = false;

    // 更新系统配置
    if (api_endpoint !== undefined) {
      await systemConfig.setConfig('api_endpoint', String(api_endpoint || ''), 'API端点地址');
      shouldSyncSiteConfig = true;
    }

    if (site_name !== undefined) {
      await systemConfig.setConfig('site_name', String(site_name || ''), '站点名称');
      shouldSyncSiteConfig = true;
    }

    if (shouldSyncSiteConfig) {
      try {
        await syncSitePublicConfigFromSystem(systemConfig);
      } catch (syncError) {
        console.error('更新资料后同步站点配置文件失败:', syncError);
      }
    }

    res.json({ code: 0, msg: '更新成功' });
  } catch (error) {
    console.error('更新设置错误:', error);
    res.json({ code: -1, msg: '更新失败' });
  }
});

// 获取通道自动关闭配置
router.get('/channel-auto-close/config', requireProviderRamPermission('settings'), async (req, res) => {
  try {
    const systemConfig = require('../../utils/systemConfig');
    const checkPaymsg = await systemConfig.getConfig('check_paymsg', '');
    const checkPaymsgNotice = await systemConfig.getConfig('check_paymsg_notice', '0');
    
    res.json({
      code: 0,
      data: {
        keywords: checkPaymsg,
        noticeEnabled: checkPaymsgNotice === '1'
      }
    });
  } catch (error) {
    console.error('获取通道自动关闭配置错误:', error);
    res.json({ code: -1, msg: '获取配置失败' });
  }
});

// 更新通道自动关闭配置
router.post('/channel-auto-close/config', requireProviderRamPermission('settings'), async (req, res) => {
  try {
    const { keywords, noticeEnabled } = req.body;
    
    // 更新关键词配置
    if (keywords !== undefined) {
      await db.query(
        'INSERT INTO system_config (config_key, config_value, description) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE config_value = ?',
        ['check_paymsg', keywords, '通道自动关闭关键词（用|分隔）', keywords]
      );
    }
    
    // 更新通知开关
    if (noticeEnabled !== undefined) {
      await db.query(
        'INSERT INTO system_config (config_key, config_value, description) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE config_value = ?',
        ['check_paymsg_notice', noticeEnabled ? '1' : '0', '通道关闭时是否发送通知', noticeEnabled ? '1' : '0']
      );
    }
    
    // 清除缓存
    const systemConfig = require('../../utils/systemConfig');
    systemConfig.clearCache();
    
    res.json({ code: 0, msg: '配置保存成功' });
  } catch (error) {
    console.error('更新通道自动关闭配置错误:', error);
    res.json({ code: -1, msg: '保存失败' });
  }
});

// ============ Telegram 绑定管理 ============

// 获取 Telegram 绑定状态
router.get('/telegram/status', async (req, res) => {
  try {
    const userId = req.ramUser ? req.ramUser.user_id : req.user.user_id;
    const userType = req.ramUser ? 'ram' : 'admin';

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
router.post('/telegram/bindToken', requireProviderRamPermission('settings'), async (req, res) => {
  try {
    const userId = req.ramUser ? req.ramUser.user_id : req.user.user_id;
    const userType = req.ramUser ? 'ram' : 'admin';

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
router.post('/telegram/unbind', requireProviderRamPermission('settings'), async (req, res) => {
  try {
    const userId = req.ramUser ? req.ramUser.user_id : req.user.user_id;
    const userType = req.ramUser ? 'ram' : 'admin';

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
    const userType = req.ramUser ? 'ram' : 'admin';

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

module.exports = router;
