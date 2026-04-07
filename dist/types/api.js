"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PhotoDownloadStatus = void 0;
/**
 * 照片下载状态枚举
 */
var PhotoDownloadStatus;
(function (PhotoDownloadStatus) {
    PhotoDownloadStatus["UNLOCKED"] = "unlocked";
    PhotoDownloadStatus["LOCKED"] = "locked";
    PhotoDownloadStatus["DOWNLOADING"] = "downloading";
})(PhotoDownloadStatus || (exports.PhotoDownloadStatus = PhotoDownloadStatus = {}));
