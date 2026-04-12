/**
 * 商户直接收款管理路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { generateRandomMixedCaseAlnum } = require('../../utils/helpers');
const { requireMerchantRamPermission } = require('../auth');

async function generateUniqueToken(length, tableName, columnName) {
  for (let i = 0; i < 20; i++) {
    const token = generateRandomMixedCaseAlnum(length);
    const [rows] = await db.query(
      `SELECT 1 FROM ${tableName} WHERE ${columnName} = ? LIMIT 1`,
      [token]
    );
    if (rows.length === 0) return token;
  }
  throw new Error('生成收款链接失败，请稍后重试');
}

function buildDirectUrl(req, token) {
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}/direct/${token}`;
}

// 获取直接收款配置
router.get('/direct/config', requireMerchantRamPermission('settings'), async (req, res) => {
  try {
    const { user_id } = req.user;

    const [users] = await db.query(
      'SELECT direct_pay_token, direct_pay_enabled FROM users WHERE id = ? LIMIT 1',
      [user_id]
    );

    if (users.length === 0) {
      return res.json({ code: -1, msg: '商户不存在' });
    }

    const user = users[0];
    const defaultToken = user.direct_pay_token || '';

    res.json({
      code: 0,
      data: {
        enabled: user.direct_pay_enabled === 1,
        defaultToken,
        defaultUrl: defaultToken ? buildDirectUrl(req, defaultToken) : '',
        defaultQrUrl: defaultToken
          ? `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(buildDirectUrl(req, defaultToken))}`
          : ''
      }
    });
  } catch (error) {
    console.error('获取直接收款配置失败:', error);
    res.json({ code: -1, msg: '获取配置失败' });
  }
});

// 启用默认直接收款链接（24位Token，一经生成永久不变）
router.post('/direct/enable', requireMerchantRamPermission('settings'), async (req, res) => {
  try {
    const { user_id } = req.user;

    const [users] = await db.query(
      'SELECT direct_pay_token, direct_pay_enabled FROM users WHERE id = ? LIMIT 1',
      [user_id]
    );
    if (users.length === 0) {
      return res.json({ code: -1, msg: '商户不存在' });
    }

    let token = users[0].direct_pay_token;
    if (!token) {
      token = await generateUniqueToken(24, 'users', 'direct_pay_token');
      await db.query(
        'UPDATE users SET direct_pay_token = ?, direct_pay_enabled = 1 WHERE id = ?',
        [token, user_id]
      );
    } else if (users[0].direct_pay_enabled !== 1) {
      await db.query('UPDATE users SET direct_pay_enabled = 1 WHERE id = ?', [user_id]);
    }

    const url = buildDirectUrl(req, token);
    res.json({
      code: 0,
      msg: '已启用直接收款',
      data: {
        token,
        url,
        qrUrl: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}`
      }
    });
  } catch (error) {
    console.error('启用直接收款失败:', error);
    res.json({ code: -1, msg: error.message || '启用失败' });
  }
});

// 关闭默认直接收款链接
router.post('/direct/disable', requireMerchantRamPermission('settings'), async (req, res) => {
  try {
    const { user_id } = req.user;
    await db.query('UPDATE users SET direct_pay_enabled = 0 WHERE id = ?', [user_id]);
    res.json({ code: 0, msg: '已关闭直接收款' });
  } catch (error) {
    console.error('关闭直接收款失败:', error);
    res.json({ code: -1, msg: '关闭失败' });
  }
});

// 固定金额链接列表
router.get('/direct/links', requireMerchantRamPermission('settings'), async (req, res) => {
  try {
    const { user_id } = req.user;
    const [rows] = await db.query(
      `SELECT dl.id, dl.token, dl.fixed_amount, dl.expire_hours, dl.reason, dl.expires_at, dl.is_enabled, dl.created_at,
              CASE WHEN dl.expires_at IS NULL OR dl.expires_at <= NOW() THEN 1 ELSE 0 END AS is_expired,
              EXISTS(
                SELECT 1
                FROM orders o
                WHERE o.direct_mode = 'fixed' AND o.direct_link_id = dl.id AND o.status = 1
              ) AS is_paid,
              (
                SELECT o.trade_no
                FROM orders o
                WHERE o.direct_mode = 'fixed' AND o.direct_link_id = dl.id AND o.status = 1
                ORDER BY o.paid_at DESC, o.id DESC
                LIMIT 1
              ) AS paid_trade_no
      FROM direct_links dl
       WHERE dl.merchant_user_id = ?
       ORDER BY dl.id DESC`,
      [user_id]
    );

    const list = rows.map((item) => {
      const url = buildDirectUrl(req, item.token);
      return {
        ...item,
        reason: item.reason || '',
        url,
        success_url: item.paid_trade_no ? `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}/api/pay/success?trade_no=${encodeURIComponent(item.paid_trade_no)}` : '',
        qrUrl: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}`
      };
    });

    res.json({ code: 0, data: list });
  } catch (error) {
    console.error('获取固定金额链接失败:', error);
    res.json({ code: -1, msg: '获取列表失败' });
  }
});

// 创建固定金额链接（32位Token）
router.post('/direct/links', requireMerchantRamPermission('settings'), async (req, res) => {
  try {
    const { user_id } = req.user;
    const { amount, expireHours, reason } = req.body;

    const fixedAmount = Number(amount);
    const hours = parseInt(expireHours, 10);

    if (!Number.isFinite(fixedAmount) || fixedAmount <= 0) {
      return res.json({ code: -1, msg: '固定金额必须大于0' });
    }
    if (!Number.isInteger(hours) || hours < 1 || hours > 24) {
      return res.json({ code: -1, msg: '有效期小时必须在1-24之间' });
    }

    const reasonText = typeof reason === 'string' ? reason.trim() : '';
    if (reasonText.length > 255) {
      return res.json({ code: -1, msg: '理由不能超过255个字符' });
    }

    const token = await generateUniqueToken(32, 'direct_links', 'token');

    await db.query(
      `INSERT INTO direct_links (merchant_user_id, token, fixed_amount, expire_hours, reason, expires_at, is_enabled, created_at)
       VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR), 1, NOW())`,
      [user_id, token, fixedAmount.toFixed(2), hours, reasonText || null, hours]
    );

    const url = buildDirectUrl(req, token);
    res.json({
      code: 0,
      msg: '固定金额链接创建成功',
      data: {
        token,
        url,
        qrUrl: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}`
      }
    });
  } catch (error) {
    console.error('创建固定金额链接失败:', error);
    res.json({ code: -1, msg: error.message || '创建失败' });
  }
});

// 启用/停用固定金额链接
router.post('/direct/links/:id/toggle', requireMerchantRamPermission('settings'), async (req, res) => {
  try {
    const { user_id } = req.user;
    const id = parseInt(req.params.id, 10);
    const enabled = req.body && (req.body.enabled === 1 || req.body.enabled === true || req.body.enabled === '1') ? 1 : 0;

    if (!id || id <= 0) {
      return res.json({ code: -1, msg: '参数错误' });
    }

    const [rows] = await db.query(
      `SELECT dl.expires_at,
              EXISTS(
                SELECT 1
                FROM orders o
                WHERE o.direct_mode = 'fixed' AND o.direct_link_id = dl.id AND o.status = 1
              ) AS is_paid
       FROM direct_links dl
       WHERE dl.id = ? AND dl.merchant_user_id = ?
       LIMIT 1`,
      [id, user_id]
    );

    if (rows.length === 0) {
      return res.json({ code: -1, msg: '链接不存在' });
    }

    const link = rows[0];
    if (Number(link.is_paid) === 1) {
      return res.json({ code: -1, msg: '该链接已支付，状态已锁定' });
    }

    const isExpired = !link.expires_at || new Date(link.expires_at).getTime() <= Date.now();

    if (enabled === 1 && isExpired) {
      return res.json({ code: -1, msg: '链接已超时，不能启用' });
    }

    const [result] = await db.query(
      'UPDATE direct_links SET is_enabled = ? WHERE id = ? AND merchant_user_id = ?',
      [enabled, id, user_id]
    );

    if (result.affectedRows === 0) {
      return res.json({ code: -1, msg: '链接不存在' });
    }

    res.json({ code: 0, msg: enabled ? '已启用' : '已停用' });
  } catch (error) {
    console.error('切换固定金额链接状态失败:', error);
    res.json({ code: -1, msg: '操作失败' });
  }
});

module.exports = router;
