"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHarnessDir = getHarnessDir;
exports.appendHarnessLog = appendHarnessLog;
exports.appendHarnessJsonl = appendHarnessJsonl;
exports.summarizeText = summarizeText;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
function getHarnessDir() {
    const harnessDir = path_1.default.join(process.cwd(), ".harness");
    if (!fs_1.default.existsSync(harnessDir)) {
        fs_1.default.mkdirSync(harnessDir, { recursive: true });
    }
    return harnessDir;
}
function appendHarnessLog(fileName, message) {
    const logPath = path_1.default.join(getHarnessDir(), fileName);
    fs_1.default.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf-8");
}
function appendHarnessJsonl(fileName, payload) {
    const logPath = path_1.default.join(getHarnessDir(), fileName);
    const entry = Object.assign({ ts: new Date().toISOString() }, payload);
    fs_1.default.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
}
function summarizeText(value, maxLen = 160) {
    if (typeof value !== "string")
        return "";
    const singleLine = value.replace(/\s+/g, " ").trim();
    if (singleLine.length <= maxLen)
        return singleLine;
    return `${singleLine.slice(0, maxLen)}...`;
}
