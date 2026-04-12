/**
 * 直接收款公开路由
 */
const express = require('express');
const router = express.Router();
const db = require('../config/database');
const systemConfig = require('../utils/systemConfig');

function isValidDirectToken(token) {
  return /^[A-Za-z0-9]{24}$/.test(token) || /^[A-Za-z0-9]{32}$/.test(token);
}

// 直接收款页
router.get('/:token', async (req, res) => {
  try {
    const directPayFeatureEnabled = (await systemConfig.getConfig('direct_pay_feature_enabled', '1')) === '1';
    if (!directPayFeatureEnabled) {
      return res.render('error', { message: '系统已关闭直接收款功能', code: 'DIRECT_FEATURE_DISABLED', backUrl: null });
    }

    const token = (req.params.token || '').trim();

    if (!isValidDirectToken(token)) {
      return res.render('error', { message: '收款链接格式错误', code: 'DIRECT_TOKEN_INVALID', backUrl: null });
    }

    let merchant = null;
    let mode = 'default';
    let fixedAmount = null;
    let linkExpiresAt = null;
    let fixedReason = '';
    let fixedLinkId = null;

    if (token.length === 24) {
      const [rows] = await db.query(
        `SELECT u.id AS user_id, u.merchant_name, u.direct_pay_enabled, m.status AS merchant_status
         FROM users u
         INNER JOIN merchants m ON m.user_id = u.id
         WHERE u.direct_pay_token = ?
         LIMIT 1`,
        [token]
      );

      if (rows.length === 0) {
        return res.render('error', { message: '收款链接不存在', code: 'DIRECT_NOT_FOUND', backUrl: null });
      }

      merchant = rows[0];
      if (merchant.direct_pay_enabled !== 1) {
        return res.render('error', { message: '该商户未启用直接收款', code: 'DIRECT_DISABLED', backUrl: null });
      }
    } else {
      mode = 'fixed';
      const [rows] = await db.query(
        `SELECT dl.id, dl.merchant_user_id, dl.fixed_amount, dl.reason, dl.expires_at, dl.is_enabled,
                u.merchant_name, m.status AS merchant_status
         FROM direct_links dl
         INNER JOIN users u ON u.id = dl.merchant_user_id
         INNER JOIN merchants m ON m.user_id = u.id
         WHERE dl.token = ?
         LIMIT 1`,
        [token]
      );

      if (rows.length === 0) {
        return res.render('error', { message: '固定金额收款链接不存在', code: 'DIRECT_FIXED_NOT_FOUND', backUrl: null });
      }

      const link = rows[0];
      merchant = { user_id: link.merchant_user_id, merchant_name: link.merchant_name, merchant_status: link.merchant_status };
      fixedLinkId = link.id;

      if (link.is_enabled !== 1) {
        return res.render('error', { message: '该固定链接已停用', code: 'DIRECT_FIXED_DISABLED', backUrl: null });
      }

      const [expireRows] = await db.query(
        'SELECT NOW() >= expires_at AS expired FROM direct_links WHERE id = ? AND expires_at IS NOT NULL LIMIT 1',
        [link.id]
      );
      if (!link.expires_at || expireRows.length === 0 || Number(expireRows[0].expired) === 1) {
        return res.render('error', { message: '该固定链接已过期', code: 'DIRECT_FIXED_EXPIRED', backUrl: null });
      }

      fixedAmount = Number(link.fixed_amount || 0).toFixed(2);
      linkExpiresAt = link.expires_at;
      fixedReason = (link.reason || '').trim();
    }

    if (!merchant || !['active', 'approved'].includes(merchant.merchant_status)) {
      return res.render('error', { message: '商户状态不可用', code: 'DIRECT_MERCHANT_DISABLED', backUrl: null });
    }

    // 固定金额直链：已支付直接跳转成功页；已锁定支付方式则直接进收银台。
    if (mode === 'fixed' && fixedLinkId) {
      const [latestOrderRows] = await db.query(
        `SELECT trade_no, status, channel_id, pay_type, expire_at
         FROM orders
         WHERE direct_mode = 'fixed' AND direct_link_id = ?
         ORDER BY id DESC
         LIMIT 1`,
        [fixedLinkId]
      );

      if (latestOrderRows.length > 0) {
        const latestOrder = latestOrderRows[0];

        if (Number(latestOrder.status) === 1) {
          return res.redirect(`/api/pay/success?trade_no=${encodeURIComponent(latestOrder.trade_no)}`);
        }

        if (Number(latestOrder.status) === 0) {
          const [orderExpireRows] = await db.query(
            'SELECT NOW() >= expire_at AS expired FROM orders WHERE trade_no = ? AND status = 0 AND expire_at IS NOT NULL LIMIT 1',
            [latestOrder.trade_no]
          );
          const orderExpired = !latestOrder.expire_at || orderExpireRows.length === 0 || Number(orderExpireRows[0].expired) === 1;

          if (orderExpired) {
            await db.query('UPDATE orders SET status = 2 WHERE trade_no = ? AND status = 0', [latestOrder.trade_no]);
          } else {
            const hasSelectedChannel = !!latestOrder.channel_id || !!latestOrder.pay_type;
            if (hasSelectedChannel) {
              return res.redirect(`/api/pay/cashier?trade_no=${encodeURIComponent(latestOrder.trade_no)}`);
            }
          }
        }
      }
    }

    const siteName = await systemConfig.getSiteName();

    return res.render('direct', {
      siteName: siteName || '在线支付',
      token,
      mode,
      merchantName: (merchant.merchant_name || '').trim() || '在线支付',
      fixedAmount,
      linkExpiresAt,
      fixedReason
    });
  } catch (error) {
    console.error('打开直接收款页面失败:', error);
    return res.render('error', { message: '系统错误', code: 'DIRECT_SYSTEM_ERROR', backUrl: null });
  }
});

module.exports = router;
