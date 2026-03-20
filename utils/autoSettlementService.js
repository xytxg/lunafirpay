/**
 * 自动结算服务
 * - 实时模式: 支付成功后触发
 * - 日结模式: 每天 0 点触发
 */
const db = require('../config/database');
const telegramService = require('../Telegram');

function toNumber(value, defaultValue = 0) {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : defaultValue;
}

function round2(value) {
  return Math.round(toNumber(value, 0) * 100) / 100;
}

function generateSettleNo() {
  const ts = Date.now().toString();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `AS${ts}${random}`.slice(0, 32);
}

function normalizeSettleType(value) {
  const type = (value || '').trim();
  return ['alipay', 'wxpay', 'bank', 'crypto'].includes(type) ? type : '';
}

class AutoSettlementService {
  constructor() {
    this.timer = null;
    this.running = false;
    this.lastDailyRunDate = '';
  }

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this._tick().catch((error) => {
        console.error('[AutoSettlement] 定时检查失败:', error.message);
      });
    }, 30000);

    this._tick().catch((error) => {
      console.error('[AutoSettlement] 启动检查失败:', error.message);
    });

    console.log('[AutoSettlement] 调度器已启动');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[AutoSettlement] 调度器已停止');
    }
  }

  async triggerRealtime(merchantId) {
    return this._run({ trigger: 'realtime', merchantId });
  }

  async triggerManualBatch() {
    return this._run({ trigger: 'manual' });
  }

  async _tick() {
    const [[dbNow]] = await db.query(
      "SELECT DATE_FORMAT(NOW(), '%H:%i') AS hm, DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS date_key"
    );

    if (!dbNow) {
      return;
    }

    if (dbNow.hm === '00:00' && this.lastDailyRunDate !== dbNow.date_key) {
      this.lastDailyRunDate = dbNow.date_key;
      await this._run({ trigger: 'daily' });
    }
  }

  async _run({ trigger, merchantId = null } = {}) {
    if (this.running) {
      return { code: 0, skipped: true, reason: 'running' };
    }

    this.running = true;
    try {
      const [optionRows] = await db.query('SELECT * FROM settlement_options LIMIT 1');
      if (optionRows.length === 0) {
        return { code: 0, skipped: true, reason: 'no_options' };
      }

      const options = optionRows[0];
      const autoSettleEnabled = Number(options.auto_settle) === 1;
      if (!autoSettleEnabled) {
        return { code: 0, skipped: true, reason: 'disabled' };
      }

      const cycle = Number(options.auto_settle_cycle ?? 0);
      if (trigger === 'realtime' && cycle !== -1) {
        return { code: 0, skipped: true, reason: 'not_realtime_cycle' };
      }
      if (trigger === 'daily' && (cycle < 0 || cycle > 1)) {
        return { code: 0, skipped: true, reason: 'not_daily_cycle' };
      }
      if (trigger === 'manual' && (cycle < 0 || cycle > 1)) {
        return { code: 0, skipped: true, reason: 'not_daily_cycle' };
      }

      const autoSettleAmount = toNumber(options.auto_settle_amount, 0);
      const minSettleAmount = toNumber(options.min_settle_amount, 10);
      const settleRate = toNumber(options.settle_rate, 0);
      const settleFeeMin = toNumber(options.settle_fee_min, 0);
      const settleFeeMax = toNumber(options.settle_fee_max, 0);
      const forcedSettleType = normalizeSettleType(options.auto_settle_type);

      let merchantSql = "SELECT user_id FROM merchants WHERE status IN ('active', 'approved')";
      const merchantParams = [];

      if (merchantId) {
        merchantSql += ' AND user_id = ?';
        merchantParams.push(merchantId);
      }

      const [merchantRows] = await db.query(merchantSql, merchantParams);
      if (merchantRows.length === 0) {
        return { code: 0, skipped: true, reason: 'no_merchants' };
      }

      let settleCount = 0;
      let merchantCount = 0;
      let totalAmount = 0;

      for (const merchant of merchantRows) {
        const result = await this._createSettlementForMerchant({
          merchantId: merchant.user_id,
          cycle,
          autoSettleAmount,
          minSettleAmount,
          settleRate,
          settleFeeMin,
          settleFeeMax,
          forcedSettleType
        });

        if (result.created) {
          settleCount += 1;
          merchantCount += 1;
          totalAmount += result.amount;

          try {
            await telegramService.notifySettlementToMerchant({
              settle_no: result.settleNo,
              merchant_id: result.merchantId,
              amount: result.amount,
              real_amount: result.realAmount,
              provider_name: '系统自动结算'
            });
          } catch (notifyError) {
            console.error('[AutoSettlement] 发送商户结算通知失败:', notifyError.message);
          }
        }
      }

      if (settleCount > 0) {
        await this._notifyAdmins({
          settleCount,
          merchantCount,
          totalAmount: round2(totalAmount)
        });

        console.log(`[AutoSettlement] 自动结算完成: count=${settleCount}, merchants=${merchantCount}, amount=${round2(totalAmount)}`);
      }

      return {
        code: 0,
        settleCount,
        merchantCount,
        totalAmount: round2(totalAmount)
      };
    } catch (error) {
      console.error('[AutoSettlement] 执行失败:', error);
      return { code: -1, skipped: false, msg: error.message };
    } finally {
      this.running = false;
    }
  }

  async _createSettlementForMerchant({
    merchantId,
    cycle,
    autoSettleAmount,
    minSettleAmount,
    settleRate,
    settleFeeMin,
    settleFeeMax,
    forcedSettleType
  }) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [merchantRows] = await conn.query(
        'SELECT balance FROM merchants WHERE user_id = ? FOR UPDATE',
        [merchantId]
      );

      if (merchantRows.length === 0) {
        await conn.rollback();
        return { created: false, reason: 'merchant_not_found' };
      }

      const currentBalance = round2(merchantRows[0].balance);
      if (currentBalance <= 0) {
        await conn.rollback();
        return { created: false, reason: 'balance_empty' };
      }

      const settlement = await this._getSettlementAccount(conn, merchantId, forcedSettleType);
      if (!settlement) {
        await conn.rollback();
        return { created: false, reason: 'settlement_account_missing' };
      }

      let frozenAmount = 0;
      if (cycle === 0) {
        const [orderRows] = await conn.query(
          `SELECT COALESCE(SUM(real_money - fee_money), 0) AS frozen
           FROM orders
           WHERE merchant_id = ? AND status = 1 AND paid_at >= CURDATE()`,
          [merchantId]
        );
        frozenAmount = round2(orderRows[0].frozen || 0);
      } else if (cycle === 1) {
        const [orderRows] = await conn.query(
          `SELECT COALESCE(SUM(real_money - fee_money), 0) AS frozen
           FROM orders
           WHERE merchant_id = ? AND status = 1 AND paid_at >= DATE_SUB(CURDATE(), INTERVAL 1 DAY)`,
          [merchantId]
        );
        frozenAmount = round2(orderRows[0].frozen || 0);
      }

      const availableBalance = round2(currentBalance - frozenAmount);
      if (availableBalance <= 0) {
        await conn.rollback();
        return { created: false, reason: 'available_balance_empty' };
      }

      if (autoSettleAmount > 0 && availableBalance < autoSettleAmount) {
        await conn.rollback();
        return { created: false, reason: 'below_auto_threshold' };
      }

      if (availableBalance < minSettleAmount) {
        await conn.rollback();
        return { created: false, reason: 'below_min_settle_amount' };
      }

      const settleAmount = availableBalance;

      let fee = 0;
      if (settleRate > 0) {
        fee = Math.round(settleAmount * settleRate) / 100;
        if (settleFeeMin > 0 && fee < settleFeeMin) fee = settleFeeMin;
        if (settleFeeMax > 0 && fee > settleFeeMax) fee = settleFeeMax;
      }
      fee = round2(fee);

      const realAmount = round2(settleAmount - fee);
      if (realAmount <= 0) {
        await conn.rollback();
        return { created: false, reason: 'real_amount_invalid' };
      }

      const newBalance = round2(currentBalance - settleAmount);
      const settleNo = generateSettleNo();

      await conn.query(
        'UPDATE merchants SET balance = ? WHERE user_id = ?',
        [newBalance, merchantId]
      );

      await conn.query(
        `INSERT INTO merchant_balance_logs
          (merchant_id, type, amount, before_balance, after_balance, related_no, remark)
         VALUES (?, 'withdraw', ?, ?, ?, ?, ?)`,
        [merchantId, -settleAmount, currentBalance, newBalance, settleNo, '自动结算']
      );

      await conn.query(
        `INSERT INTO settle_records
          (settle_no, merchant_id, settle_type, amount, fee, real_amount,
           account_name, account_no, bank_name, bank_branch, crypto_network, crypto_address, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          settleNo,
          merchantId,
          settlement.settle_type,
          settleAmount,
          fee,
          realAmount,
          settlement.account_name,
          settlement.account_no,
          settlement.bank_name,
          settlement.bank_branch,
          settlement.crypto_network,
          settlement.crypto_address
        ]
      );

      await conn.commit();

      try {
        await telegramService.notifyBalance(merchantId, 'merchant', {
          type: 'settlement',
          amount: settleAmount,
          balance: newBalance,
          reason: `自动结算: ${settleNo}`
        });
      } catch (balanceNotifyError) {
        console.error(`[AutoSettlement] 发送余额变动通知失败 merchant=${merchantId}:`, balanceNotifyError.message);
      }

      return {
        created: true,
        settleNo,
        merchantId,
        amount: settleAmount,
        realAmount
      };
    } catch (error) {
      await conn.rollback();
      console.error(`[AutoSettlement] 商户 ${merchantId} 自动结算失败:`, error.message);
      return { created: false, reason: 'exception', msg: error.message };
    } finally {
      conn.release();
    }
  }

  async _getSettlementAccount(conn, merchantId, forcedSettleType) {
    if (forcedSettleType) {
      const [rows] = await conn.query(
        `SELECT *
         FROM merchant_settlements
         WHERE merchant_id = ? AND settle_type = ?
         ORDER BY is_default DESC, id ASC
         LIMIT 1`,
        [merchantId, forcedSettleType]
      );
      return rows[0] || null;
    }

    const [rows] = await conn.query(
      `SELECT *
       FROM merchant_settlements
       WHERE merchant_id = ?
       ORDER BY is_default DESC, id ASC
       LIMIT 1`,
      [merchantId]
    );

    return rows[0] || null;
  }

  async _notifyAdmins({ settleCount, merchantCount, totalAmount }) {
    try {
      const [adminRows] = await db.query(
        'SELECT id FROM users WHERE is_admin = 1 AND status = 1'
      );

      for (const admin of adminRows) {
        await telegramService.notifyAutoSettlement({
          provider_id: admin.id,
          merchant_count: merchantCount,
          total_amount: totalAmount,
          settle_count: settleCount
        });
      }
    } catch (error) {
      console.error('[AutoSettlement] 发送管理员通知失败:', error.message);
    }
  }
}

module.exports = new AutoSettlementService();
