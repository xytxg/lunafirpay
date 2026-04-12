/**
 * 记录清理服务
 * - 支持手动清理与每日定时清理
 * - 商户范围支持 all 或 ids
 * - 订单状态允许 0(未支付)、1(支付成功)、4(已退款)
 */
const db = require('../config/database');

const ALLOWED_ORDER_STATUSES = [0, 1, 4];
const ALLOWED_SETTLEMENT_CLEANUP_SCOPES = ['completed', 'unfinished'];

function parseJsonArray(value, fallback = []) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
      return fallback;
    }
  }
  return fallback;
}

function uniqueIntArray(values) {
  return [...new Set((values || []).map((v) => parseInt(v, 10)).filter((v) => Number.isFinite(v) && v > 0))];
}

function uniqueStatusArray(values) {
  const normalized = [...new Set((values || [])
    .map((v) => parseInt(v, 10))
    .filter((v) => Number.isFinite(v) && v >= 0))];
  return normalized.filter((v) => ALLOWED_ORDER_STATUSES.includes(v));
}

function normalizeSettlementCleanupScopes(values, includeSettlementsFallback = false) {
  const normalized = [...new Set((values || [])
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => ALLOWED_SETTLEMENT_CLEANUP_SCOPES.includes(v)))];

  if (normalized.length > 0) return normalized;
  if (includeSettlementsFallback) return ['completed'];
  return [];
}

function toNonNegativeInt(value, fallback = 30) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function pushRetentionCondition(conditions, params, cleanupRetentionDays) {
  const days = toNonNegativeInt(cleanupRetentionDays, 30);
  if (days === 0) {
    conditions.push('created_at < NOW()');
    return;
  }
  conditions.push('created_at < DATE_SUB(CURDATE(), INTERVAL ? DAY)');
  params.push(days);
}

function normalizeDateInput(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return trimmed;
}

class RecordCleanupService {
  constructor() {
    this.timer = null;
    this.running = false;
    this.lastScheduleDateInMemory = '';
  }

  async ensureConfigRow() {
    await db.query(
      `INSERT IGNORE INTO cleanup_task_config
       (id, enabled, run_time, merchant_scope, merchant_ids, cleanup_orders, order_statuses, cleanup_settlements)
       VALUES (1, 0, '02:00', 'all', JSON_ARRAY(), 0, JSON_OBJECT('statuses', JSON_ARRAY(), 'cleanup_retention_days', 30), 0)`
    );
  }

  async getConfig() {
    await this.ensureConfigRow();
    const [rows] = await db.query('SELECT * FROM cleanup_task_config WHERE id = 1 LIMIT 1');
    const row = rows[0] || {};
    const rawOrderConfig = row.order_statuses;
    let orderStatuses = [];
    let cleanupRetentionDays = 30;
    let cleanupTestOrders = false;
    let cleanupUnnotifiedPaid = false;
    let cleanupSettlementScopes = [];

    if (rawOrderConfig) {
      const parsed = typeof rawOrderConfig === 'string' ? (() => {
        try {
          return JSON.parse(rawOrderConfig);
        } catch (e) {
          return null;
        }
      })() : rawOrderConfig;

      if (Array.isArray(parsed)) {
        orderStatuses = uniqueStatusArray(parsed);
      } else if (parsed && typeof parsed === 'object') {
        orderStatuses = uniqueStatusArray(parsed.statuses || []);
        cleanupRetentionDays = toNonNegativeInt(
          parsed.cleanup_retention_days,
          toNonNegativeInt(parsed.order_retention_days, toNonNegativeInt(parsed.settlement_retention_days, 30))
        );
        cleanupTestOrders = parsed.cleanup_test_orders === true || parsed.cleanup_test_orders === 1;
        cleanupUnnotifiedPaid = parsed.cleanup_unnotified_paid === true || parsed.cleanup_unnotified_paid === 1;
        cleanupSettlementScopes = normalizeSettlementCleanupScopes(
          parsed.cleanup_settlement_statuses,
          Number(row.cleanup_settlements) === 1
        );
      }
    }

    if (cleanupSettlementScopes.length === 0 && Number(row.cleanup_settlements) === 1) {
      cleanupSettlementScopes = ['completed'];
    }

    return {
      id: 1,
      enabled: Number(row.enabled) === 1,
      run_time: row.run_time || '02:00',
      merchant_scope: row.merchant_scope === 'ids' ? 'ids' : 'all',
      merchant_ids: uniqueIntArray(parseJsonArray(row.merchant_ids, [])),
      cleanup_orders: Number(row.cleanup_orders) === 1,
      order_statuses: orderStatuses,
      cleanup_retention_days: cleanupRetentionDays,
      cleanup_test_orders: cleanupTestOrders,
      cleanup_unnotified_paid: cleanupUnnotifiedPaid,
      cleanup_settlements: cleanupSettlementScopes.length > 0,
      cleanup_settlement_statuses: cleanupSettlementScopes,
      last_run_date: row.last_run_date || null,
      last_run_at: row.last_run_at || null,
      updated_at: row.updated_at || null
    };
  }

  normalizeConfigInput(payload = {}) {
    // 定时配置固定全商户执行，不允许保存为指定商户范围
    const merchantScope = 'all';
    const merchantIds = [];
    const orderStatuses = uniqueStatusArray(payload.order_statuses);
    const cleanupRetentionDays = Math.max(1, toNonNegativeInt(
      payload.cleanup_retention_days,
      toNonNegativeInt(payload.order_retention_days, toNonNegativeInt(payload.settlement_retention_days, 30))
    ));
    const cleanupTestOrders = payload.cleanup_test_orders === true || payload.cleanup_test_orders === 1;
    const cleanupSettlementScopes = normalizeSettlementCleanupScopes(
      payload.cleanup_settlement_statuses,
      payload.cleanup_settlements === true || payload.cleanup_settlements === 1
    );
    // 定时清理不支持“已支付未回调”项
    const cleanupUnnotifiedPaid = false;

    return {
      enabled: payload.enabled ? 1 : 0,
      run_time: typeof payload.run_time === 'string' && /^\d{2}:\d{2}$/.test(payload.run_time)
        ? payload.run_time
        : '02:00',
      merchant_scope: merchantScope,
      merchant_ids: JSON.stringify(merchantIds),
      cleanup_orders: payload.cleanup_orders ? 1 : 0,
      order_statuses: JSON.stringify({
        statuses: orderStatuses,
        cleanup_retention_days: cleanupRetentionDays,
        cleanup_test_orders: cleanupTestOrders
        ,cleanup_unnotified_paid: cleanupUnnotifiedPaid,
        cleanup_settlement_statuses: cleanupSettlementScopes
      }),
      cleanup_settlements: cleanupSettlementScopes.length > 0 ? 1 : 0
    };
  }

  async saveConfig(payload = {}) {
    const normalized = this.normalizeConfigInput(payload);
    await this.ensureConfigRow();

    await db.query(
      `UPDATE cleanup_task_config SET
        enabled = ?,
        run_time = ?,
        merchant_scope = ?,
        merchant_ids = ?,
        cleanup_orders = ?,
        order_statuses = ?,
        cleanup_settlements = ?,
        updated_at = NOW()
      WHERE id = 1`,
      [
        normalized.enabled,
        normalized.run_time,
        normalized.merchant_scope,
        normalized.merchant_ids,
        normalized.cleanup_orders,
        normalized.order_statuses,
        normalized.cleanup_settlements
      ]
    );

    return this.getConfig();
  }

  async resolveMerchantIds(scope, merchantIds = []) {
    if (scope === 'all') {
      const [rows] = await db.query(
        `SELECT m.user_id
         FROM merchants m
         JOIN users u ON m.user_id = u.id
         WHERE u.is_admin = 0`
      );
      return rows.map((r) => parseInt(r.user_id, 10)).filter((v) => Number.isFinite(v) && v > 0);
    }

    const ids = uniqueIntArray(merchantIds);
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await db.query(
      `SELECT m.user_id
       FROM merchants m
       JOIN users u ON m.user_id = u.id
       WHERE u.is_admin = 0 AND m.id IN (${placeholders})`,
      ids
    );

    return rows.map((r) => parseInt(r.user_id, 10)).filter((v) => Number.isFinite(v) && v > 0);
  }

  buildFilterClause({
    merchantScope = 'all',
    merchantIds = [],
    merchantNoIds = [],
    includeOrders = false,
    orderStatuses = [],
    includeUnnotifiedPaid = false,
    includeTestOrders = false,
    includeSettlementCompleted = false,
    includeSettlementUnfinished = false,
    cleanupRetentionDays = 30,
    startDate = null,
    endDate = null
  }) {
    const orderConditionBlocks = [];
    const orderParams = [];

    if (includeOrders) {
      const orderBlock = [];
      if (merchantIds.length > 0) {
        orderBlock.push(`merchant_id IN (${merchantIds.map(() => '?').join(',')})`);
        orderParams.push(...merchantIds);
      }
      if (orderStatuses.length > 0) {
        orderBlock.push(`status IN (${orderStatuses.map(() => '?').join(',')})`);
        orderParams.push(...orderStatuses);
      }
      if (startDate && endDate) {
        orderBlock.push('created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)');
        orderParams.push(startDate, endDate);
      } else {
        pushRetentionCondition(orderBlock, orderParams, cleanupRetentionDays);
      }
      orderConditionBlocks.push(`(${orderBlock.join(' AND ')})`);
    }

    if (includeUnnotifiedPaid) {
      const unnotifiedBlock = [];
      if (merchantScope === 'ids' && merchantIds.length > 0) {
        const unnotifiedMerchantConditions = [];
        unnotifiedMerchantConditions.push(`merchant_id IN (${merchantIds.map(() => '?').join(',')})`);
        orderParams.push(...merchantIds);
        if (merchantNoIds.length > 0) {
          unnotifiedMerchantConditions.push(`merchant_id IN (${merchantNoIds.map(() => '?').join(',')})`);
          orderParams.push(...merchantNoIds);
        }
        unnotifiedBlock.push(`(${unnotifiedMerchantConditions.join(' OR ')})`);
      }
      unnotifiedBlock.push(`status = 1 AND (notify_status IS NULL OR notify_status <> 1)`);
      if (startDate && endDate) {
        unnotifiedBlock.push('created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)');
        orderParams.push(startDate, endDate);
      } else {
        pushRetentionCondition(unnotifiedBlock, orderParams, cleanupRetentionDays);
      }
      orderConditionBlocks.push(`(${unnotifiedBlock.join(' AND ')})`);
    }

    if (includeTestOrders) {
      const testBlock = [];
      // 测试支付数据按全局口径清理：不受商户筛选影响（勾选即命中）
      testBlock.push(`order_type = 'test'`);
      if (startDate && endDate) {
        testBlock.push('created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)');
        orderParams.push(startDate, endDate);
      } else {
        pushRetentionCondition(testBlock, orderParams, cleanupRetentionDays);
      }
      orderConditionBlocks.push(`(${testBlock.join(' AND ')})`);
    }

    const settleConditions = [];
    const settleParams = [];

    if (merchantIds.length > 0) {
      settleConditions.push(`merchant_id IN (${merchantIds.map(() => '?').join(',')})`);
      settleParams.push(...merchantIds.map(String));
    }

    if (includeSettlementCompleted || includeSettlementUnfinished) {
      if (includeSettlementCompleted && !includeSettlementUnfinished) {
        settleConditions.push('status = 1');
      }
      if (!includeSettlementCompleted && includeSettlementUnfinished) {
        settleConditions.push('status <> 1');
      }

      if (startDate && endDate) {
        settleConditions.push('created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)');
        settleParams.push(startDate, endDate);
      } else {
        pushRetentionCondition(settleConditions, settleParams, cleanupRetentionDays);
      }
    }

    return {
      orderWhere: orderConditionBlocks.join(' OR '),
      orderParams,
      settleWhere: settleConditions.join(' AND '),
      settleParams
    };
  }

  async preview(options = {}) {
    const scope = options.merchant_scope === 'ids' ? 'ids' : 'all';
    const orderStatuses = uniqueStatusArray(options.order_statuses || []);
    const cleanupUnnotifiedPaid = options.cleanup_unnotified_paid === true || options.cleanup_unnotified_paid === 1;
    const cleanupOrders = !!options.cleanup_orders;
    const includeStatusOrders = cleanupOrders && orderStatuses.length > 0;
    const includeOrderCleanup = cleanupOrders || cleanupUnnotifiedPaid;
    const cleanupTestOrders = options.cleanup_test_orders === true || options.cleanup_test_orders === 1;
    const cleanupSettlementScopes = normalizeSettlementCleanupScopes(
      options.cleanup_settlement_statuses,
      options.cleanup_settlements === true || options.cleanup_settlements === 1
    );
    const includeSettlementCompleted = cleanupSettlementScopes.includes('completed');
    const includeSettlementUnfinished = cleanupSettlementScopes.includes('unfinished');
    const cleanupSettlements = includeSettlementCompleted || includeSettlementUnfinished;
    const cleanupRetentionDays = toNonNegativeInt(options.cleanup_retention_days, 30);
    const startDate = normalizeDateInput(options.start_date);
    const endDate = normalizeDateInput(options.end_date);

    if ((startDate && !endDate) || (!startDate && endDate)) {
      return { code: -1, msg: '日期区间参数不完整' };
    }

    if (startDate && endDate && startDate > endDate) {
      return { code: -1, msg: '开始日期不能晚于结束日期' };
    }

    if (!includeOrderCleanup && !cleanupSettlements && !cleanupTestOrders) {
      return { code: -1, msg: '请至少选择一种清理操作' };
    }

    if (includeOrderCleanup && !cleanupTestOrders && !cleanupUnnotifiedPaid && orderStatuses.length === 0) {
      return { code: -1, msg: '请至少选择一个订单状态' };
    }

    const merchantIds = await this.resolveMerchantIds(scope, options.merchant_ids || []);
    const merchantNoIds = scope === 'ids' ? uniqueIntArray(options.merchant_ids || []) : [];
    if (scope === 'ids' && merchantIds.length === 0) {
      return { code: -1, msg: '未选择有效商户' };
    }

    const filter = this.buildFilterClause({
      merchantScope: scope,
      merchantIds,
      merchantNoIds,
      includeOrders: includeStatusOrders,
      orderStatuses,
      includeUnnotifiedPaid: cleanupUnnotifiedPaid,
      includeTestOrders: cleanupTestOrders,
      includeSettlementCompleted,
      includeSettlementUnfinished,
      cleanupRetentionDays,
      startDate,
      endDate
    });

    let orderCount = 0;
    let settlementCount = 0;
    const breakdown = {
      paid_success: 0,
      unpaid: 0,
      refunded: 0,
      unnotified_paid: 0,
      test_orders: 0,
      settlements: 0,
      settlements_completed: 0,
      settlements_unfinished: 0
    };

    if (includeStatusOrders || cleanupTestOrders || cleanupUnnotifiedPaid) {
      const [rows] = await db.query(`SELECT COUNT(*) AS total FROM orders WHERE ${filter.orderWhere}`, filter.orderParams);
      orderCount = Number(rows[0]?.total || 0);
    }

    if (cleanupSettlements) {
      const [rows] = await db.query(`SELECT COUNT(*) AS total FROM settle_records WHERE ${filter.settleWhere}`, filter.settleParams);
      settlementCount = Number(rows[0]?.total || 0);
    }

    // 预估明细拆分，方便定位具体命中项
    const orderBaseConditions = [];
    const orderBaseParams = [];
    if (merchantIds.length > 0) {
      orderBaseConditions.push(`merchant_id IN (${merchantIds.map(() => '?').join(',')})`);
      orderBaseParams.push(...merchantIds);
    }
    if (startDate && endDate) {
      orderBaseConditions.push('created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      orderBaseParams.push(startDate, endDate);
    } else {
      pushRetentionCondition(orderBaseConditions, orderBaseParams, cleanupRetentionDays);
    }
    const orderBaseWhere = orderBaseConditions.join(' AND ');

    const unnotifiedBaseConditions = [];
    const unnotifiedBaseParams = [];
    if (scope === 'ids' && merchantIds.length > 0) {
      const unnotifiedMerchantConditions = [];
      unnotifiedMerchantConditions.push(`merchant_id IN (${merchantIds.map(() => '?').join(',')})`);
      unnotifiedBaseParams.push(...merchantIds);
      if (merchantNoIds.length > 0) {
        unnotifiedMerchantConditions.push(`merchant_id IN (${merchantNoIds.map(() => '?').join(',')})`);
        unnotifiedBaseParams.push(...merchantNoIds);
      }
      unnotifiedBaseConditions.push(`(${unnotifiedMerchantConditions.join(' OR ')})`);
    }
    if (startDate && endDate) {
      unnotifiedBaseConditions.push('created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      unnotifiedBaseParams.push(startDate, endDate);
    } else {
      pushRetentionCondition(unnotifiedBaseConditions, unnotifiedBaseParams, cleanupRetentionDays);
    }
    const unnotifiedBaseWhere = unnotifiedBaseConditions.join(' AND ');

    const testBaseConditions = [];
    const testBaseParams = [];
    // 测试支付拆分统计按全局口径，不受商户筛选影响
    if (startDate && endDate) {
      testBaseConditions.push('created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      testBaseParams.push(startDate, endDate);
    } else {
      pushRetentionCondition(testBaseConditions, testBaseParams, cleanupRetentionDays);
    }
    const testBaseWhere = testBaseConditions.join(' AND ');

    const countByStatus = async (status) => {
      if (!orderBaseWhere) return 0;
      const [rows] = await db.query(
        `SELECT COUNT(*) AS total FROM orders WHERE ${orderBaseWhere} AND status = ?`,
        [...orderBaseParams, status]
      );
      return Number(rows[0]?.total || 0);
    };

    if (orderStatuses.includes(1)) {
      breakdown.paid_success = await countByStatus(1);
    }
    if (orderStatuses.includes(0)) {
      breakdown.unpaid = await countByStatus(0);
    }
    if (orderStatuses.includes(4)) {
      breakdown.refunded = await countByStatus(4);
    }
    if (cleanupUnnotifiedPaid && unnotifiedBaseWhere) {
      const [rows] = await db.query(
        `SELECT COUNT(*) AS total
         FROM orders
         WHERE ${unnotifiedBaseWhere} AND status = 1 AND (notify_status IS NULL OR notify_status <> 1)`,
        unnotifiedBaseParams
      );
      breakdown.unnotified_paid = Number(rows[0]?.total || 0);
    }
    if (cleanupTestOrders) {
      const [rows] = await db.query(
        `SELECT COUNT(*) AS total FROM orders WHERE ${testBaseWhere} AND order_type = 'test'`,
        testBaseParams
      );
      breakdown.test_orders = Number(rows[0]?.total || 0);
    }
    if (cleanupSettlements) {
      const settleBaseConditions = [];
      const settleBaseParams = [];
      if (merchantIds.length > 0) {
        settleBaseConditions.push(`merchant_id IN (${merchantIds.map(() => '?').join(',')})`);
        settleBaseParams.push(...merchantIds.map(String));
      }
      if (startDate && endDate) {
        settleBaseConditions.push('created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)');
        settleBaseParams.push(startDate, endDate);
      } else {
        pushRetentionCondition(settleBaseConditions, settleBaseParams, cleanupRetentionDays);
      }
      const settleBaseWhere = settleBaseConditions.join(' AND ');
      if (includeSettlementCompleted) {
        const [rows] = await db.query(
          `SELECT COUNT(*) AS total FROM settle_records WHERE ${settleBaseWhere} AND status = 1`,
          settleBaseParams
        );
        breakdown.settlements_completed = Number(rows[0]?.total || 0);
      }
      if (includeSettlementUnfinished) {
        const [rows] = await db.query(
          `SELECT COUNT(*) AS total FROM settle_records WHERE ${settleBaseWhere} AND status <> 1`,
          settleBaseParams
        );
        breakdown.settlements_unfinished = Number(rows[0]?.total || 0);
      }
    }
    breakdown.settlements = settlementCount;

    return {
      code: 0,
      data: {
        merchant_scope: scope,
        merchant_count: scope === 'all' ? merchantIds.length : merchantIds.length,
        cleanup_orders: includeOrderCleanup,
        order_statuses: orderStatuses,
        cleanup_unnotified_paid: cleanupUnnotifiedPaid,
        cleanup_test_orders: cleanupTestOrders,
        cleanup_settlements: cleanupSettlements,
        cleanup_settlement_statuses: cleanupSettlementScopes,
        start_date: startDate,
        end_date: endDate,
        preview_breakdown: breakdown,
        preview: {
          orders: orderCount,
          settlements: settlementCount,
          total: orderCount + settlementCount
        }
      }
    };
  }

  async writeExecutionLog({
    triggerType,
    operatorId,
    merchantScope,
    merchantCount,
    cleanupOrders,
    orderStatuses,
    cleanupSettlements,
    ordersAffected,
    settlementsAffected,
    success,
    errorMessage = null
  }) {
    await db.query(
      `INSERT INTO cleanup_execution_logs
       (trigger_type, operator_id, merchant_scope, merchant_count, cleanup_orders, order_statuses, cleanup_settlements,
        orders_affected, settlements_affected, success, error_message, executed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        triggerType,
        operatorId || 'system',
        merchantScope,
        merchantCount,
        cleanupOrders ? 1 : 0,
        JSON.stringify(orderStatuses || []),
        cleanupSettlements ? 1 : 0,
        ordersAffected,
        settlementsAffected,
        success ? 1 : 0,
        errorMessage
      ]
    );
  }

  async runCleanup(options = {}) {
    if (this.running) {
      return { code: -1, msg: '已有清理任务正在执行，请稍后重试' };
    }

    this.running = true;
    let conn;

    const triggerType = options.trigger_type || 'manual';
    const operatorId = options.operator_id || 'system';
    const scope = options.merchant_scope === 'ids' ? 'ids' : 'all';
    const cleanupUnnotifiedPaid = options.cleanup_unnotified_paid === true || options.cleanup_unnotified_paid === 1;
    const cleanupOrders = !!options.cleanup_orders;
    const orderStatuses = uniqueStatusArray(options.order_statuses || []);
    const includeStatusOrders = cleanupOrders && orderStatuses.length > 0;
    const includeOrderCleanup = cleanupOrders || cleanupUnnotifiedPaid;
    const cleanupTestOrders = options.cleanup_test_orders === true || options.cleanup_test_orders === 1;
    const cleanupSettlementScopes = normalizeSettlementCleanupScopes(
      options.cleanup_settlement_statuses,
      options.cleanup_settlements === true || options.cleanup_settlements === 1
    );
    const includeSettlementCompleted = cleanupSettlementScopes.includes('completed');
    const includeSettlementUnfinished = cleanupSettlementScopes.includes('unfinished');
    const cleanupSettlements = includeSettlementCompleted || includeSettlementUnfinished;
    const cleanupRetentionDays = toNonNegativeInt(options.cleanup_retention_days, 30);
    const startDate = normalizeDateInput(options.start_date);
    const endDate = normalizeDateInput(options.end_date);

    if ((startDate && !endDate) || (!startDate && endDate)) {
      this.running = false;
      return { code: -1, msg: '日期区间参数不完整' };
    }

    if (startDate && endDate && startDate > endDate) {
      this.running = false;
      return { code: -1, msg: '开始日期不能晚于结束日期' };
    }

    if (!includeOrderCleanup && !cleanupSettlements && !cleanupTestOrders) {
      this.running = false;
      return { code: -1, msg: '请至少选择一种清理操作' };
    }

    if (includeOrderCleanup && !cleanupTestOrders && !cleanupUnnotifiedPaid && orderStatuses.length === 0) {
      this.running = false;
      return { code: -1, msg: '请至少选择一个订单状态' };
    }

    try {
      const merchantIds = await this.resolveMerchantIds(scope, options.merchant_ids || []);
      const merchantNoIds = scope === 'ids' ? uniqueIntArray(options.merchant_ids || []) : [];
      if (scope === 'ids' && merchantIds.length === 0) {
        this.running = false;
        return { code: -1, msg: '未选择有效商户' };
      }

      const filter = this.buildFilterClause({
        merchantScope: scope,
        merchantIds,
        merchantNoIds,
        includeOrders: includeStatusOrders,
        orderStatuses,
        includeUnnotifiedPaid: cleanupUnnotifiedPaid,
        includeTestOrders: cleanupTestOrders,
        includeSettlementCompleted,
        includeSettlementUnfinished,
        cleanupRetentionDays,
        startDate,
        endDate
      });

      conn = await db.getConnection();
      await conn.beginTransaction();

      let ordersAffected = 0;
      let settlementsAffected = 0;

      if (includeStatusOrders || cleanupTestOrders || cleanupUnnotifiedPaid) {
        const [result] = await conn.query(
          `DELETE FROM orders WHERE ${filter.orderWhere}`,
          filter.orderParams
        );
        ordersAffected = Number(result.affectedRows || 0);
      }

      if (cleanupSettlements) {
        const [result] = await conn.query(
          `DELETE FROM settle_records WHERE ${filter.settleWhere}`,
          filter.settleParams
        );
        settlementsAffected = Number(result.affectedRows || 0);
      }

      await conn.commit();

      await this.writeExecutionLog({
        triggerType,
        operatorId,
        merchantScope: scope,
        merchantCount: merchantIds.length,
        cleanupOrders: includeOrderCleanup,
        orderStatuses,
        cleanupSettlements,
        ordersAffected,
        settlementsAffected,
        success: true
      });

      return {
        code: 0,
        msg: '清理执行完成',
        data: {
          ordersAffected,
          settlementsAffected,
          totalAffected: ordersAffected + settlementsAffected,
          merchantCount: merchantIds.length
        }
      };
    } catch (error) {
      if (conn) {
        try {
          await conn.rollback();
        } catch (rollbackError) {
          console.error('[RecordCleanup] 回滚失败:', rollbackError.message);
        }
      }

      await this.writeExecutionLog({
        triggerType,
        operatorId,
        merchantScope: scope,
        merchantCount: 0,
        cleanupOrders: includeOrderCleanup,
        orderStatuses,
        cleanupSettlements,
        ordersAffected: 0,
        settlementsAffected: 0,
        success: false,
        errorMessage: error.message
      });

      return { code: -1, msg: `清理执行失败: ${error.message}` };
    } finally {
      if (conn) conn.release();
      this.running = false;
    }
  }

  async listLogs(page = 1, pageSize = 20) {
    const current = Number.isFinite(parseInt(page, 10)) ? parseInt(page, 10) : 1;
    const size = Number.isFinite(parseInt(pageSize, 10)) ? parseInt(pageSize, 10) : 20;

    const [countRows] = await db.query('SELECT COUNT(*) AS total FROM cleanup_execution_logs');
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await db.query(
      `SELECT id, trigger_type, operator_id, merchant_scope, merchant_count, cleanup_orders, order_statuses,
              cleanup_settlements, orders_affected, settlements_affected, success, error_message, executed_at
       FROM cleanup_execution_logs
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [size, (current - 1) * size]
    );

    return { list: rows, total, page: current, pageSize: size };
  }

  start() {
    if (this.timer) return;

    this._tick().catch((error) => {
      console.error('[RecordCleanup] 启动检查失败:', error.message);
    });

    this.timer = setInterval(() => {
      this._tick().catch((error) => {
        console.error('[RecordCleanup] 定时检查失败:', error.message);
      });
    }, 30000);

    console.log('[RecordCleanup] 调度器已启动');
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    console.log('[RecordCleanup] 调度器已停止');
  }

  async _tick() {
    const config = await this.getConfig();
    if (!config.enabled) return;

    const [[dbNow]] = await db.query(
      "SELECT DATE_FORMAT(NOW(), '%H:%i') AS hm, DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS date_key"
    );

    if (!dbNow || dbNow.hm !== config.run_time) {
      return;
    }

    if (this.lastScheduleDateInMemory === dbNow.date_key || config.last_run_date === dbNow.date_key) {
      return;
    }

    const result = await this.runCleanup({
      trigger_type: 'schedule',
      operator_id: 'system',
      merchant_scope: config.merchant_scope,
      merchant_ids: config.merchant_ids,
      cleanup_orders: config.cleanup_orders,
      order_statuses: config.order_statuses,
      cleanup_unnotified_paid: config.cleanup_unnotified_paid,
      cleanup_test_orders: config.cleanup_test_orders,
      cleanup_retention_days: config.cleanup_retention_days,
      cleanup_settlements: config.cleanup_settlements
    });

    if (result.code === 0) {
      this.lastScheduleDateInMemory = dbNow.date_key;
      await db.query(
        'UPDATE cleanup_task_config SET last_run_date = ?, last_run_at = NOW(), updated_at = NOW() WHERE id = 1',
        [dbNow.date_key]
      );
    }
  }
}

module.exports = new RecordCleanupService();
