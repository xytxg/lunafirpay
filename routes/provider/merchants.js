/**
 * Provider 商户管理路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const {
  generateRandomMixedCaseAlnum,
  generateRandomUsername,
  generateRsaKeyPair,
  generateUniquePid
} = require('../../utils/helpers');
const { requireProviderRamPermission } = require('../auth');

// 支付类型配置
const payTypes = [
  { id: 1, name: 'alipay', showname: '支付宝', status: 1 },
  { id: 2, name: 'wxpay', showname: '微信支付', status: 1 },
  { id: 3, name: 'qqpay', showname: 'QQ钱包', status: 1 },
  { id: 4, name: 'bank', showname: '网银支付', status: 1 },
  { id: 5, name: 'jdpay', showname: '京东支付', status: 1 },
  { id: 6, name: 'paypal', showname: 'PayPal', status: 1 },
  { id: 7, name: 'ecny', showname: '数字人民币', status: 1 }
];

function getAllPayTypes() {
  return payTypes.filter(pt => pt.status === 1);
}

async function generateUniqueUsername() {
  while (true) {
    const candidate = generateRandomUsername(12);
    const [existing] = await db.query('SELECT id FROM users WHERE username = ? LIMIT 1', [candidate]);
    if (existing.length === 0) return candidate;
  }
}

// 获取商户列表（需要 merchant 权限）
router.get('/merchants', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { page = 1, pageSize = 20, merchantId, name, status } = req.query;

    // 单服务商模式：merchants 表直接存储商户信息，排除管理员用户
    let sql = `SELECT m.id, m.pid, m.user_id, m.fee_rate, m.fee_rates, m.fee_payer, m.status, m.pay_group_id,
               m.created_at, m.approved_at as joined_at,
               COALESCE(m.name, u.username) as name, m.remark, m.balance,
               u.username
               FROM merchants m
               JOIN users u ON m.user_id = u.id
           WHERE m.status IN ('pending', 'active', 'paused', 'disabled', 'banned')
             AND u.is_admin = 0`;
    const params = [];
    if (status) {
      sql += ' AND m.status = ?';
      params.push(status);
    }

    if (merchantId !== undefined && merchantId !== null && String(merchantId).trim() !== '') {
      // 仅按商户号（merchants.id）搜索，避免与 users.id 混淆
      const merchantNo = parseInt(String(merchantId).trim(), 10);
      if (!Number.isNaN(merchantNo) && merchantNo > 0) {
        sql += ' AND m.id = ?';
        params.push(merchantNo);
      } else {
        sql += ' AND 1=0';
      }
    }

    if (name) {
      sql += ' AND (m.name LIKE ? OR u.username LIKE ?)';
      params.push(`%${name}%`, `%${name}%`);
    }

    // 统计总数
    const [countResult] = await db.query(
      sql.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as total FROM'),
      params
    );
    const total = countResult[0]?.total || 0;

    sql += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize));

    const [merchants] = await db.query(sql, params);

    // 获取默认支付组
    const [defaultGroups] = await db.query(
      'SELECT * FROM provider_pay_groups WHERE is_default = 1 LIMIT 1'
    );
    const defaultGroup = defaultGroups.length > 0 ? defaultGroups[0] : null;
    const allPayTypes = getAllPayTypes();

    // 获取每个商户的交易统计和费率
    const list = await Promise.all(merchants.map(async (merchant) => {
      // 今日统计（orders.merchant_id 存的是 users.id）
      const [[dayStats]] = await db.query(
        `SELECT COALESCE(SUM(money), 0) as money
         FROM orders WHERE merchant_id = ? AND status = 1 AND DATE(created_at) = CURDATE()`,
        [merchant.user_id]
      );
      // 昨日统计
      const [[yesterdayStats]] = await db.query(
        `SELECT COALESCE(SUM(money), 0) as money
         FROM orders WHERE merchant_id = ? AND status = 1 AND DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)`,
        [merchant.user_id]
      );
      // 本周统计
      const [[weekStats]] = await db.query(
        `SELECT COALESCE(SUM(money), 0) as money
         FROM orders WHERE merchant_id = ? AND status = 1 AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)`,
        [merchant.user_id]
      );

      // 获取商户的支付组费率
      let payGroup = null;
      if (merchant.pay_group_id) {
        const [groups] = await db.query(
          'SELECT * FROM provider_pay_groups WHERE id = ?',
          [merchant.pay_group_id]
        );
        if (groups.length > 0) payGroup = groups[0];
      }
      // 如果没有指定支付组，使用默认组
      if (!payGroup) payGroup = defaultGroup;

      // 解析支付组配置，计算每个支付类型的费率
      let rates = {};
      if (payGroup && payGroup.config) {
        try {
          const config = typeof payGroup.config === 'string' 
            ? JSON.parse(payGroup.config) 
            : payGroup.config;
          
          for (const [payTypeId, typeConfig] of Object.entries(config)) {
            const pt = allPayTypes.find(p => p.id === parseInt(payTypeId));
            if (pt && typeConfig.rate !== undefined && typeConfig.rate !== null) {
              rates[pt.name] = {
                name: pt.showname,
                rate: typeConfig.rate / 100
              };
            }
          }
        } catch (e) {
          console.error('解析支付组配置错误:', e);
        }
      }

      // 解析商户独立费率 JSON
      let merchantFeeRates = null;
      if (merchant.fee_rates) {
        try {
          merchantFeeRates = typeof merchant.fee_rates === 'string' 
            ? JSON.parse(merchant.fee_rates) 
            : merchant.fee_rates;
        } catch (e) {
          console.error('解析商户费率JSON错误:', e);
        }
      }

      return {
        ...merchant,
        fee_rates: merchantFeeRates,
        day_money: dayStats?.money || 0,
        yesterday_money: yesterdayStats?.money || 0,
        week_money: weekStats?.money || 0,
        pay_group_name: payGroup?.name || null,
        rates // 支付组默认费率
      };
    }));

    res.json({ code: 0, data: { list, total } });
  } catch (error) {
    console.error('获取商户列表错误:', error);
    res.json({ code: -1, msg: '获取商户列表失败' });
  }
});

// 创建商户账号（随机 12位用户名 + 32位密码），默认未开通
router.post('/merchants/create-user', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { email } = req.body;
    
    // 邮箱必填
    if (!email) {
      return res.json({ code: -1, msg: '请填写邮箱' });
    }
    
    // 验证邮箱格式
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.json({ code: -1, msg: '邮箱格式不正确' });
    }
    
    // 检查邮箱是否已存在
    const [existingEmail] = await db.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    if (existingEmail.length > 0) {
      return res.json({ code: -1, msg: '邮箱已被注册' });
    }
    
    const username = await generateUniqueUsername();
    const password = generateRandomMixedCaseAlnum(32);

    // 插入用户（使用自增id）
    const [insertResult] = await db.query(
      'INSERT INTO users (username, password, email, is_admin) VALUES (?, ?, ?, 0)',
      [username, password, email]
    );
    const userId = insertResult.insertId;

    // 创建商户记录（user_id 引用 users.id），管理员创建的商户直接激活并生成 pid/key
    const pid = await generateUniquePid();
    const apiKey = generateRandomMixedCaseAlnum(32);
    const rsaKeyPair = generateRsaKeyPair();
    
    // 获取默认支付组ID
    const [defaultPayGroups] = await db.query(
      'SELECT id FROM provider_pay_groups WHERE is_default = 1 LIMIT 1'
    );
    const defaultPayGroupId = defaultPayGroups.length > 0 ? defaultPayGroups[0].id : null;
    
    await db.query(
      'INSERT INTO merchants (user_id, pid, api_key, rsa_public_key, rsa_private_key, status, approved_at, pay_group_id) VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)',
      [userId, pid, apiKey, rsaKeyPair.publicKey, rsaKeyPair.privateKey, 'active', defaultPayGroupId]
    );

    res.json({ code: 0, msg: '创建成功', data: { userId, username, password, email, pid, apiKey } });
  } catch (error) {
    console.error('创建商户账号错误:', error);
    res.json({ code: -1, msg: '创建失败: ' + error.message });
  }
});

// 重置商户登录密码（32位大小写数字混合）
router.post('/merchants/reset-password', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { merchantId } = req.body;
    if (!merchantId) {
      return res.json({ code: -1, msg: '缺少商户ID' });
    }

    const newPassword = generateRandomMixedCaseAlnum(32);
    const [result] = await db.query(
      'UPDATE users SET password = ? WHERE id = ? AND is_admin = 0',
      [newPassword, merchantId]
    );
    if (result.affectedRows === 0) {
      return res.json({ code: -1, msg: '商户不存在' });
    }

    res.json({ code: 0, msg: '重置成功', data: { password: newPassword } });
  } catch (error) {
    console.error('重置商户密码错误:', error);
    res.json({ code: -1, msg: '重置失败: ' + error.message });
  }
});

// 开通商户：生成 PID(12位数字) + KEY(32位大小写数字混合) + RSA密钥
router.post('/merchants/activate', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { merchantId } = req.body;

    if (!merchantId) {
      return res.json({ code: -1, msg: '缺少商户ID' });
    }

    // 单服务商模式，不按 provider_id 过滤
    const [rows] = await db.query(
      'SELECT * FROM merchants WHERE user_id = ? LIMIT 1',
      [merchantId]
    );
    if (rows.length === 0) {
      return res.json({ code: -1, msg: '商户不存在' });
    }

    const record = rows[0];
    if (record.status === 'active' || record.status === 'approved') {
      return res.json({ code: 0, msg: '商户已开通' });
    }

    // 生成12位随机 PID（API使用）
    const pid = await generateUniquePid();
    const apiKey = generateRandomMixedCaseAlnum(32);
    const rsaKeyPair = generateRsaKeyPair();

    await db.query(
      `UPDATE merchants
       SET status = 'active', approved_at = NOW(), pid = ?, api_key = ?, rsa_public_key = ?, rsa_private_key = ?
       WHERE user_id = ?`,
      [pid, apiKey, rsaKeyPair.publicKey, rsaKeyPair.privateKey, merchantId]
    );

    res.json({
      code: 0,
      msg: '已开通',
      data: {
        pid,  // API 使用的12位随机ID
        apiKey
      }
    });
  } catch (error) {
    console.error('开通商户错误:', error);
    res.json({ code: -1, msg: '开通失败：' + error.message });
  }
});

// 暂停商户（不允许删除）
router.post('/merchants/pause', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { merchantId } = req.body;
    if (!merchantId) return res.json({ code: -1, msg: '缺少商户ID' });

    // 单服务商模式，不按 provider_id 过滤
    await db.query(
      'UPDATE merchants SET status = ? WHERE user_id = ?',
      ['paused', merchantId]
    );
    res.json({ code: 0, msg: '已暂停' });
  } catch (error) {
    console.error('暂停商户错误:', error);
    res.json({ code: -1, msg: '暂停失败: ' + error.message });
  }
});

// 恢复商户（暂停 -> 正常；若未生成PID/KEY则提示先开通）
router.post('/merchants/restore', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { merchantId } = req.body;
    if (!merchantId) return res.json({ code: -1, msg: '缺少商户ID' });

    // 单服务商模式，不按 provider_id 过滤
    const [rows] = await db.query(
      'SELECT pid, api_key FROM merchants WHERE user_id = ? LIMIT 1',
      [merchantId]
    );
    if (rows.length === 0) return res.json({ code: -1, msg: '商户不存在' });

    if (!rows[0].pid || !rows[0].api_key) {
      return res.json({ code: -1, msg: '商户未开通，请先开通后再恢复' });
    }

    await db.query(
      'UPDATE merchants SET status = ? WHERE user_id = ?',
      ['active', merchantId]
    );
    res.json({ code: 0, msg: '已恢复' });
  } catch (error) {
    console.error('恢复商户错误:', error);
    res.json({ code: -1, msg: '恢复失败: ' + error.message });
  }
});

// 获取商户详情统计（需要 merchant 权限）
router.get('/merchants/stats', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { merchantId } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(50, parseInt(req.query.pageSize, 10) || 10));

    if (!merchantId) {
      return res.json({ code: -1, msg: '缺少商户ID' });
    }

    // 月统计（单服务商模式，不按 provider_id 过滤）
    const [[monthStats]] = await db.query(
      `SELECT COALESCE(SUM(money), 0) as money, COALESCE(SUM(fee_money), 0) as fee 
       FROM orders WHERE merchant_id = ? AND status = 1 
       AND YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())`,
      [merchantId]
    );
    
    // 累计统计
    const [[totalStats]] = await db.query(
      `SELECT COALESCE(SUM(money), 0) as money, COALESCE(SUM(fee_money), 0) as fee 
       FROM orders WHERE merchant_id = ? AND status = 1`,
      [merchantId]
    );

    const [userRows] = await db.query(
      'SELECT direct_pay_token FROM users WHERE id = ? LIMIT 1',
      [merchantId]
    );
    const defaultToken = userRows.length > 0 ? (userRows[0].direct_pay_token || '') : '';
    const defaultUrl = defaultToken
      ? `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}/direct/${defaultToken}`
      : '';

    const [[linksTotalRow]] = await db.query(
      'SELECT COUNT(*) AS total FROM direct_links WHERE merchant_user_id = ?',
      [merchantId]
    );
    const linksTotal = Number(linksTotalRow?.total || 0);

    const [linkRows] = await db.query(
      `SELECT id, token, fixed_amount, expire_hours, usage_mode, expires_at, is_enabled, created_at
       FROM direct_links
       WHERE merchant_user_id = ?
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [merchantId, pageSize, (page - 1) * pageSize]
    );

    const linkIds = linkRows.map((item) => item.id);
    const paidOrdersByLinkId = new Map();
    if (linkIds.length > 0) {
      const [paidRows] = await db.query(
        `SELECT direct_link_id, trade_no, paid_at
         FROM orders
         WHERE direct_mode = 'fixed' AND status = 1 AND direct_link_id IN (?)
         ORDER BY paid_at DESC, id DESC`,
        [linkIds]
      );

      paidRows.forEach((item) => {
        if (!paidOrdersByLinkId.has(item.direct_link_id)) {
          paidOrdersByLinkId.set(item.direct_link_id, []);
        }
        paidOrdersByLinkId.get(item.direct_link_id).push({
          trade_no: item.trade_no,
          paid_at: item.paid_at
        });
      });
    }

    const directLinks = linkRows.map((item) => ({
      ...item,
      usage_mode: item.usage_mode || 'single_use',
      url: `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}/direct/${item.token}`,
      is_expired: item.expires_at ? (new Date(item.expires_at).getTime() <= Date.now() ? 1 : 0) : 1,
      paid_orders: paidOrdersByLinkId.get(item.id) || [],
      paid_count: (paidOrdersByLinkId.get(item.id) || []).length
    }));

    res.json({
      code: 0,
      data: {
        month_money: monthStats?.money || 0,
        month_fee: monthStats?.fee || 0,
        total_money: totalStats?.money || 0,
        total_fee: totalStats?.fee || 0,
        direct_pay_token: defaultToken,
        direct_pay_url: defaultUrl,
        direct_links: {
          list: directLinks,
          total: linksTotal,
          page,
          pageSize
        }
      }
    });
  } catch (error) {
    console.error('获取商户统计错误:', error);
    res.json({ code: -1, msg: '获取统计失败' });
  }
});

// 更新商户信息（需要 merchant 权限）
// 注意：修改费率和支付组需要额外的 channel 权限
router.post('/merchants/update', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const ramUser = req.ramUser;
    const { merchant_id, merchant_user_id, merchant_record_id, remark, fee_rate, fee_rates, fee_payer, status, pay_group_id } = req.body;

    const merchantKey = parseInt(merchant_id, 10);
    const merchantUserId = parseInt(merchant_user_id, 10);
    const merchantRecordId = parseInt(merchant_record_id, 10);

    if (Number.isNaN(merchantKey) || merchantKey <= 0) {
      return res.json({ code: -1, msg: '无效的商户ID' });
    }

    // 解析要更新的 merchants.id，避免 merchant_id(可能是 user_id 或 merchants.id) 歧义更新到错误账号
    let targetMerchantId = null;
    if (!Number.isNaN(merchantRecordId) && merchantRecordId > 0) {
      const [rows] = await db.query('SELECT id FROM merchants WHERE id = ? LIMIT 1', [merchantRecordId]);
      if (rows.length === 0) {
        return res.json({ code: -1, msg: '商户不存在' });
      }
      targetMerchantId = merchantRecordId;
    } else if (!Number.isNaN(merchantUserId) && merchantUserId > 0) {
      const [rows] = await db.query('SELECT id FROM merchants WHERE user_id = ? LIMIT 1', [merchantUserId]);
      if (rows.length === 0) {
        return res.json({ code: -1, msg: '商户不存在' });
      }
      targetMerchantId = rows[0].id;
    } else {
      const [candidates] = await db.query(
        'SELECT id, user_id FROM merchants WHERE id = ? OR user_id = ? LIMIT 2',
        [merchantKey, merchantKey]
      );

      if (candidates.length === 0) {
        return res.json({ code: -1, msg: '商户不存在' });
      }
      if (candidates.length > 1) {
        return res.json({ code: -1, msg: '商户ID存在歧义，请刷新页面后重试' });
      }
      targetMerchantId = candidates[0].id;
    }

    // 检查是否有 channel 权限（用于修改费率和支付组）
    const hasChannelPermission = !ramUser || 
      (ramUser.permissions && (ramUser.permissions.includes('admin') || ramUser.permissions.includes('channel')));

    const updates = [];
    const params = [];

    // 备注可以直接修改
    if (remark !== undefined) {
      updates.push('remark = ?');
      params.push(remark || null);
    }

    // 费率和支付组需要 channel 权限
    if (fee_rate !== undefined && hasChannelPermission) {
      updates.push('fee_rate = ?');
      params.push(fee_rate);
    }
    // 支持每通道独立费率 (JSON)
    if (fee_rates !== undefined && hasChannelPermission) {
      updates.push('fee_rates = ?');
      params.push(fee_rates ? JSON.stringify(fee_rates) : null);
    }
    if (fee_payer !== undefined && hasChannelPermission) {
      updates.push('fee_payer = ?');
      params.push(fee_payer);
    }
    if (pay_group_id !== undefined && hasChannelPermission) {
      const normalizedPayGroupId = (pay_group_id === null || pay_group_id === '' || pay_group_id === undefined)
        ? null
        : parseInt(pay_group_id, 10);

      if (normalizedPayGroupId !== null) {
        if (Number.isNaN(normalizedPayGroupId) || normalizedPayGroupId <= 0) {
          return res.json({ code: -1, msg: '无效的支付组ID' });
        }
        const [groups] = await db.query('SELECT id FROM provider_pay_groups WHERE id = ? LIMIT 1', [normalizedPayGroupId]);
        if (groups.length === 0) {
          return res.json({ code: -1, msg: '支付组不存在' });
        }
      }

      updates.push('pay_group_id = ?');
      params.push(normalizedPayGroupId);
    }
    
    // 状态修改只需要 merchant 权限
    if (status !== undefined) {
      // 新状态：inactive/active/paused（兼容 approved/disabled）
      const allowed = new Set(['inactive', 'active', 'paused', 'approved', 'disabled']);
      if (!allowed.has(status)) {
        return res.json({ code: -1, msg: '无效的状态' });
      }
      updates.push('status = ?');
      params.push(status);
    }

    if (updates.length === 0) {
      return res.json({ code: -1, msg: '无更新内容' });
    }

    // 单服务商模式，不按 provider_id 过滤
    params.push(targetMerchantId);

    const [updateResult] = await db.query(
      `UPDATE merchants SET ${updates.join(', ')} WHERE id = ? LIMIT 1`,
      params
    );

    if (!updateResult || updateResult.affectedRows === 0) {
      return res.json({ code: -1, msg: '商户不存在或未更新' });
    }

    res.json({ code: 0, msg: '更新成功' });
  } catch (error) {
    console.error('更新商户错误:', error);
    res.json({ code: -1, msg: '更新失败' });
  }
});

// 管理员调整商户余额（正数增加，负数减少）
router.post('/merchants/adjust-balance', requireProviderRamPermission('finance'), async (req, res) => {
  const { user_id: adminUserId } = req.user;
  const { merchantId, amount } = req.body || {};

  const targetMerchantId = parseInt(merchantId, 10);
  const changeAmount = Math.round(parseFloat(amount) * 100) / 100;

  if (!targetMerchantId || Number.isNaN(targetMerchantId)) {
    return res.json({ code: -1, msg: '缺少商户ID' });
  }

  if (!Number.isFinite(changeAmount) || changeAmount === 0) {
    return res.json({ code: -1, msg: '请输入非0的调整金额' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [merchantRows] = await conn.query(
      `SELECT m.user_id, m.balance, u.is_admin
       FROM merchants m
       JOIN users u ON u.id = m.user_id
       WHERE m.user_id = ?
       FOR UPDATE`,
      [targetMerchantId]
    );

    if (merchantRows.length === 0 || merchantRows[0].is_admin === 1) {
      await conn.rollback();
      return res.json({ code: -1, msg: '商户不存在' });
    }

    const beforeBalance = Math.round(parseFloat(merchantRows[0].balance || 0) * 100) / 100;
    const afterBalance = Math.round((beforeBalance + changeAmount) * 100) / 100;
    const actionText = changeAmount > 0 ? '管理员增加余额' : '管理员减少余额';
    const relatedNo = `ADMIN_BAL_${Date.now()}_${targetMerchantId}`;

    await conn.query(
      'UPDATE merchants SET balance = ? WHERE user_id = ?',
      [afterBalance, targetMerchantId]
    );

    await conn.query(
      `INSERT INTO merchant_balance_logs
        (merchant_id, type, amount, before_balance, after_balance, related_no, remark)
       VALUES (?, 'adjust', ?, ?, ?, ?, ?)`,
      [
        targetMerchantId,
        changeAmount,
        beforeBalance,
        afterBalance,
        relatedNo,
        `${actionText}（管理员ID:${adminUserId}）`
      ]
    );

    await conn.commit();

    res.json({
      code: 0,
      msg: `${actionText}成功`,
      data: {
        merchantId: targetMerchantId,
        amount: changeAmount,
        beforeBalance,
        afterBalance
      }
    });
  } catch (error) {
    await conn.rollback();
    console.error('调整商户余额错误:', error);
    res.json({ code: -1, msg: '调整余额失败' });
  } finally {
    conn.release();
  }
});

module.exports = router;
