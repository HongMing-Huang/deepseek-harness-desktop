import type { StartupErrorClassification } from '../../shared/ipc'

/**
 * dsh web 启动失败的纯函数分类器：
 * 依据 message 与 stderr 尾部关键词推断原因，给出中文提示与可执行动作。
 * 不做任何 IO，便于单测与复用。
 *
 * 分类优先级（特定性从高到低）：
 *   runtime-missing > port-in-use > eacces-or-quarantine > ready-timeout
 *   > credentials-missing > process-crash（兜底）
 */
export function classifyStartupError(input: {
  message: string
  stderrTail?: string
}): StartupErrorClassification {
  const message = input.message ?? ''
  const stderr = input.stderrTail ?? ''
  const haystack = `${message}\n${stderr}`.toLowerCase()

  // 内嵌/侧载运行时缺失：resolveRuntime 抛出的明确提示，或依赖文件 ENOENT
  if (message.includes('运行时缺失') || message.includes('prepare:runtime') || haystack.includes('enoent')) {
    return {
      cause: 'runtime-missing',
      hint: 'dsh 运行时文件不完整，可能安装包损坏或运行时目录被移动。请重新安装应用后重试。',
      actions: ['retry', 'open-logs']
    }
  }

  // 端口被占用：EADDRINUSE
  if (haystack.includes('eaddrinuse')) {
    return {
      cause: 'port-in-use',
      hint: '启动端口被其他进程占用。可尝试自动释放 dsh 残留进程占用的端口，或手动结束占用进程。',
      actions: ['retry', 'repair-port', 'open-logs']
    }
  }

  // 权限不足或 macOS 隔离属性：EACCES / quarantine
  if (haystack.includes('eacces') || haystack.includes('quarantine')) {
    return {
      cause: 'eacces-or-quarantine',
      hint: '系统拒绝执行运行时文件，可能由文件权限或 macOS 安全隔离引起。可在系统设置中允许运行，或对应用目录移除隔离属性后重试。',
      actions: ['retry', 'open-logs']
    }
  }

  // 就绪超时：supervisor 的明确超时文案
  if (message.includes('超时')) {
    return {
      cause: 'ready-timeout',
      hint: 'dsh web 启动过慢或卡住，未在时限内就绪。可重试；若反复出现请查看日志定位瓶颈。',
      actions: ['retry', 'open-logs']
    }
  }

  // 凭据缺失：dsh 侧未配置 API Key
  if (
    haystack.includes('credential') ||
    haystack.includes('deepseek_api_key') ||
    haystack.includes('api key') ||
    haystack.includes('api_key') ||
    haystack.includes('unauthorized') ||
    /\b401\b/.test(haystack)
  ) {
    return {
      cause: 'credentials-missing',
      hint: '尚未配置 DeepSeek API Key 或密钥无效。请在设置中填写有效密钥后重试。',
      actions: ['retry', 'open-logs']
    }
  }

  // 兜底：进程崩溃
  return {
    cause: 'process-crash',
    hint: 'dsh web 进程异常退出。可重试启动；若反复失败请查看日志获取详细错误。',
    actions: ['retry', 'open-logs']
  }
}
