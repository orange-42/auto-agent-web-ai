import request from '@/utils/request'

/**
 * 查询订单照片锁定状态
 * @param {Object} params - 查询参数，包含orderId等
 * @returns {Promise}
 */
export function getOrderPhotoLockInfo(params) {
  return request({
    url: '/himo_product_store_v2/order_photo_lock/info',
    method: 'get',
    params
  })
}

/**
 * 锁定订单照片下载权限
 * @param {Object} data - 锁定参数，包含orderId、operatorId等
 * @returns {Promise}
 */
export function lockOrderPhoto(data) {
  return request({
    url: '/himo_product_store_v2/order_photo_lock/lock',
    method: 'post',
    data
  })
}

/**
 * 解锁订单照片下载权限
 * @param {Object} data - 解锁参数，包含orderId、operatorId、unlockReason等
 * @returns {Promise}
 */
export function unlockOrderPhoto(data) {
  return request({
    url: '/himo_product_store_v2/order_photo_lock/unlock',
    method: 'put',
    data
  })
}

/**
 * 记录照片锁定操作审计日志
 * @param {Object} logData - 日志数据，包含operatorId、actionType、orderId等
 * @returns {Promise}
 */
export function recordPhotoLockAuditLog(logData) {
  return request({
    url: '/himo_product_store_v2/order_photo_lock/audit_log',
    method: 'post',
    data: logData
  })
}