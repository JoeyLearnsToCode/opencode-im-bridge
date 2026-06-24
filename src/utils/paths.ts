import { resolve } from "node:path"

export function getAttachmentsDir(): string {
  return resolve(getCwdBase(), ".opencode-lark", "attachments")
}

export function getCwdBase(): string {
  return process.env["OPENCODE_CWD"] ?? process.cwd()
}

export function normalizePath(p: string): string {
  return p.replace(/\\+/g, "/")
}