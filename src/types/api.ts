/**
 * 订单照片锁定状态查询响应类型
 */
export interface OrderPhotoLockInfo {
  /** 是否已锁定 */
  locked: boolean;
  /** 锁定原因（可选） */
  reason?: string;
  /** 最后操作时间 */
  lastOperateTime?: number;
  /** 当前操作人ID */
  currentOperatorId?: number;
}

/**
 * 锁定订单照片参数类型
 */
export interface LockOrderParams {
  /** 订单ID */
  orderId: number | string;
  /** 操作人ID */
  operatorId: number | string;
  /** 锁定原因（可选） */
  lockReason?: string;
}

/**
 * 解锁订单照片参数类型
 */
export interface UnlockOrderParams extends LockOrderParams {
  /** 解锁原因 */
  unlockReason: string;
}

/**
 * 审计日志记录参数类型
 */
export interface AuditLogParams {
  /** 操作人ID */
  operatorId: number | string;
  /** 订单ID */
  orderId: number | string;
  /** 操作类型：lock/unlock/delete_modify */
  actionType: 'lock' | 'unlock' | 'delete_modify';
  /** 操作描述 */
  description?: string;
  /** 额外备注信息 */
  remark?: string;
}

/**
 * 照片下载状态枚举
 */
export enum PhotoDownloadStatus {
  UNLOCKED = 'unlocked',
  LOCKED = 'locked',
  DOWNLOADING = 'downloading'
}