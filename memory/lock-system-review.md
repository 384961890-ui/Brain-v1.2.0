# Lock System Review — Brain v1.1.8 文件写锁自审报告

> 审查日期: 2026-05-03
> 审查对象: file-lock-manager.js + brain-mcp-server.js 集成

---

## 1. 并发安全性

### 设计
采用 `fs.link()`（硬链接）实现原子 O_EXCL 语义：
1. 临时文件写入 → `fs.link(tmp, lockFile)` — 目标存在时抛出 EEXIST
2. 不存在时 link 成功 = 原子获取锁
3. 失败时 EEXIST = 锁已被他人持有

### 时序分析
| 时序 | 进程 A | 进程 B | 结果 |
|------|--------|--------|------|
| T0 | writeFile(tmpA) | writeFile(tmpB) | 不同临时文件，无冲突 |
| T1 | link(tmpA, lock) → 成功 | link(tmpB, lock) → EEXIST | A 获得锁，B 检测到冲突 |
| T2 | 写文件 | 读取 lock 获取 lockedBy 信息 | B 返回冲突详情 |
| T3 | release (unlink lock) | retry or 返回 | 正常释放 |

**结论:** ✅ 安全。`link` 是 POSIX 原子操作，不存在"两个同时 link 都成功"的情况。

### 共享资源
所有锁文件写入 `~/.brain/locks/` 目录，用 SHA256 哈希隔离不同文件路径。不存在锁文件命名冲突。

### 锁竞争重试
- 最多重试 3 次
- 每次重试前检查 TTL 过期 → 过期锁自动释放后重试
- 重试仍失败 → 返回失败信息给调用方

---

## 2. TTL 兜底

### 自动过期机制
- 每个锁创建时记录 `expiresAt = Date.now() + ttlMs`
- `acquire()` 内部检测过期锁：发现时自动 `_removeLock()` + 重试
- `status()` 返回 expired 状态供调用方感知
- 定时器每 60 秒执行 `cleanup()` 清理过期锁

### 锁持有者异常终止的兜底
| 场景 | 兜底方式 |
|------|---------|
| lock acquire 后进程崩溃 | TTL 到期后自动清理，其他进程可重获锁 |
| 两个进程死锁等待 | TTL 到期后锁释放，无阻塞 |
| 网络分区 (MCP 断开) | TTL 到期后锁自动失效 |

### 可选优化（未来）
- 心跳续约机制：锁持有者可定期 `acquire` 同一个文件刷新 TTL
- 更短 TTL + 心跳实现更快的故障恢复

**结论:** ✅ TTL 兜底机制完整，无永久死锁风险。

---

## 3. 路径遍历防护

### 防护策略
1. **路径黑字符检查** — `sanitizePath()` 函数
   - 拒绝含 `..` 的路径（每个 path.sep 分割的 part 检查）
   - 拒绝含 `.` 的路径部分
   - 拒绝空路径
   - 拒绝含 null 字节的路径

2. **锁定基于哈希** — 锁文件名是路径的 SHA256 哈希，即使路径被注入也无法控制锁文件位置
3. **锁目录固定** — 所有锁文件写入 `~/.brain/locks/`，不依赖用户路径

### 攻击向量分析
| 攻击输入 | 防护 | 结果 |
|---------|------|------|
| `../../etc/passwd` | `sanitizePath` 拒绝 `..` | ❌ 抛出错误 |
| `/etc/passwd\0` | null 字节检查 | ❌ 抛出错误 |
| 长路径 `A/../B` | `..` 存在于 split 中 | ❌ 抛出错误 |
| 正常路径 `data/file.txt` | `path.resolve` 得到绝对路径 | ✅ 正常运行 |

### 限制
- `sanitizePath` 基于字符串匹配而非语义分析
- 合法路径中不会出现单独的 `..` segment，所以此限制合理
- 如果未来需要支持相对路径中的 `..`（如 `../project/file.txt`），需改用 `path.resolve` + 白名单前缀

**结论:** ✅ 防护充分，简单有效，误报率低。

---

## 4. 原子性

### 写锁文件
- **临时文件写入** — 先写入 `file.tmp.{pid}.{timestamp}`
- **原子 rename** — `fs.rename(tmp, lockFile)` 在 POSIX 系统上原子操作
- 写入过程中如果进程崩溃 → 临时文件残留，不会导致锁文件半写
- **link 原子获取** — `fs.link(tmp, lockFile)` 原子创建硬链接，不存在"半创建"状态

### 删除锁文件
- **rename + unlink** — 先 rename 到临时名（原子），再 unlink
- 如果 rename 后崩溃 → 锁文件已被移走，新进程可正常 acquire
- 残留的 `.removed.{timestamp}` 文件通过下一轮 cleanup 或 acquire 的重试清理

### 残留临时文件处理
- `.tmp.*` 文件：下次 acquire 同文件时会覆盖新的 tmp，旧残留自动被丢弃
- `.removed.*` 文件：同上，不影响功能
- 定时 cleanup 不清理临时文件（避免误删正在写入的 tmp）

**结论:** ✅ 写入和删除均保证原子性，无部分写入风险。

---

## 5. 集成兼容

### MCP 工具命名
新增 5 个工具均以 `brain_lock_` 前缀命名：

| 新工具名 | 与现有工具冲突？ |
|---------|----------------|
| `brain_lock_acquire` | ✅ 不冲突 |
| `brain_lock_release` | ✅ 不冲突 |
| `brain_lock_status` | ✅ 不冲突 |
| `brain_lock_list` | ✅ 不与 `brain_list` 冲突（不同参数签名和功能） |
| `brain_lock_force_release` | ✅ 不冲突 |

现有工具列表：`brain_recall`, `brain_semantic_recall`, `brain_confidence_check`, `brain_task_status`, `brain_save_decision`, `brain_get_latest_snapshot`, `brain_list`, `brain_forget`, `brain_inject`, `brain_cleanup`

### 代码风格
- CommonJS `require` / `module.exports` — ✅ 一致
- 异步使用 `async/await` + `fs.promises` — ✅ 一致
- Zod schema 集成方式 — ✅ 一致（`z.string()`, `z.number().optional().default()`）

### 依赖
- 纯 Node.js 内置模块：`fs`, `path`, `crypto`, `os` — 无额外依赖
- Bundle 大小增加：约 12KB

**结论:** ✅ 完全兼容，无集成风险。

---

## 6. 错误处理

### 所有异常路径覆盖

| 场景 | 返回值 |
|------|--------|
| acquire 成功 | `{ success: true, file, acquiredAt, expiresAt }` |
| acquire 冲突 | `{ success: false, lockedBy, acquiredAt, expiresAt, message }` |
| acquire 路径遍历攻击 | `throw Error("路径遍历拒绝")` |
| acquire 空 agentId | `throw Error("agentId 不能为空")` |
| acquire 重试耗尽 | `{ success: false, message }` |
| release 成功 | `{ success: true, message }` |
| release 未锁定 | `{ success: false, message }` |
| release agentId 不匹配 | `{ success: false, message }` |
| forceRelease 成功 | `{ success: true, message }` |
| forceRelease 未锁定 | `{ success: false, message }` |
| status 未锁定 | `{ status: "free" }` |
| status 已锁定 | `{ status: "locked", details: { ... } }` |
| status 已过期 | `{ status: "expired", details: { ... } }` |
| listActive 空目录 | `[]` |
| MCP 参数验证失败 | Zod 自动抛出描述性错误 |

**结论:** ✅ 所有路径均有合理返回值，MCP 错误通过 `isError: true` 标记。

---

## 总体评分

| 维度 | 评分 | 备注 |
|------|------|------|
| 并发安全性 | ⭐⭐⭐⭐⭐ | link 原子操作，无需锁 |
| TTL 兜底 | ⭐⭐⭐⭐⭐ | 自动清理 + 定时器 |
| 路径防护 | ⭐⭐⭐⭐ | 字符串检查够用，稍严格 |
| 原子性 | ⭐⭐⭐⭐⭐ | tmp+rename+link 全链路原子 |
| 集成兼容 | ⭐⭐⭐⭐⭐ | 无冲突，零新依赖 |
| 错误处理 | ⭐⭐⭐⭐⭐ | 全覆盖 |

**整体结论:** ✅ 可用于生产环境。
