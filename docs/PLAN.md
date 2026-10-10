# 项目公用代码对比系统 — 实施计划

> 目标：对比两个项目的公共（共享）代码，量化重合度，找出"完全相同 / 仅项目名不同 / 小幅差异"的代码，为后续抽取公共模块或更新脚手架模板提供依据。

- 项目A：`D:\sizai\projects\lottery-fund`
- 项目B：`D:\sizai\projects\sport-asset`

---

## 1. 调研结论（已实测）

两个项目出自**同一套代码生成器/脚手架**，目录结构完全对应：

| 项目A | 项目B | 说明 |
|---|---|---|
| lottery-fund-api | sport-asset-api | 后端 API 模块（Maven） |
| lottery-fund-service | sport-asset-service | 后端业务模块 |
| lottery-fund-web | sport-asset-web | 后端 Web 模块 |
| lottery-fund-vue | sport-asset-vue | 前端 Vue3 工程 |

### 实测数据（已排除 node_modules / target / dist / .git / .idea）

| 指标 | 数量 |
|---|---|
| 归一化路径后两边都存在的文件 | **692** |
| ├ 字节级完全相同 | **528（76%）** |
| └ 内容有差异 | **164（24%）** |
| 仅存在于 lottery-fund 的文件 | 1657（业务代码为主） |
| 仅存在于 sport-asset 的文件 | 607（业务代码为主） |

### 抽样验证：164 个"有差异"的文件中，多数只是项目名不同

对文件内容做项目名归一化（`lottery-fund`/`sport-asset`、`lotteryFund`/`sportAsset`、`LotteryFund`/`SportAsset` → 占位符）后抽查 12 个典型差异文件：

- 仅 **2 个**还存在真实差异（如 api/pom.xml 只差 artifactId 之外还有依赖差异）
- 其余差异基本都是"同一份代码、不同项目名"，例如 `application.yaml`、`request.ts`、`Navbar.vue`、各 `sys` 页面等

### 结论

1. 两个项目的**框架级代码（utils / components / hooks / layout / sys 管理页面 / 后端模板）高度同源**，528 个文件可直接视为公共代码。
2. 真正需要关注的是 **164 个"疑似公共但有差异"的文件**——它们是"本应公共却各自漂移"的高风险代码，也是本系统的核心产出。
3. 业务差异集中在各自独有的 1657 / 607 个文件里（views、entity、controller 等），对比价值较低。

---

## 2. 方案选项

### 方案A：现成工具一次性对比（快，但不可复用）

- `git diff --no-index` / Beyond Compare / WinMerge，人工对比目录。
- 优点：零开发成本。
- 缺点：不会做"项目名归一化"，164 个文件里大量假差异需要人工甄别；无法沉淀为可重复运行的系统。

### 方案B：自建轻量对比工具（推荐 ✅）

针对"同源脚手架"场景定制，核心是**两层归一化 + 分级报告**：

1. **路径归一化**：把相对路径中的 `lottery-fund` / `sport-asset` 替换为 `{PROJECT}`，解决模块前缀不同的问题。
2. **内容归一化**：把文件内容中的项目名（连字符/驼峰/大驼峰三种形态）替换为占位符。
3. **分级**：
   - `IDENTICAL`：字节级完全相同 → 纯公共代码
   - `SAME_BY_RENAME`：仅项目名不同 → 也是公共代码，只是没参数化
   - `SIMILAR`：归一化后仍有差异 → 公共代码发生漂移，**重点审查对象**（按差异行数排序）
   - `ONLY_A` / `ONLY_B`：单边独有 → 业务代码
4. **输出**：`report.json` + 自包含的 `report.html`（可交互筛选、内嵌 diff 视图）。

优点：结果精准、可重复运行、可扩展为持续集成的一部分。
缺点：需要 1~2 天开发。

### 方案C：代码克隆检测工具（补充手段）

- `jscpd`（支持 Java/TS/Vue，可跨目录检测 copy-paste）或 PMD CPD（Java 为主）。
- 解决方案B覆盖不到的问题：**路径不同但内容相似**的代码（例如 A 的 `tools/xxx.ts` 在 B 里叫 `helpers/yyy.ts`）。
- 建议在方案B之后作为二期补充。

### 方案D：架构收敛（对比之后的落地动作）

对比只是手段，最终建议：

1. 把 528 + 归一化后相同的文件抽成 **common 基线**（Maven common 模块 + npm 私有包），或更新**代码生成器模板**，让两个项目引用同一份源码。
2. 对 164 个 `SIMILAR` 文件逐个决策：合并回公共基线 / 承认为项目定制并记录。

---

## 3. 推荐落地：方案B（+ 方案C 二期）

### 3.1 系统架构

```
Scanner（文件扫描，排除 node_modules/target/dist/.git/.idea）
   ↓
Normalizer（路径归一化 + 内容归一化）
   ↓
Comparator（MD5 快筛 → 逐行 diff，计算相似度）
   ↓
Classifier（IDENTICAL / SAME_BY_RENAME / SIMILAR / ONLY_A / ONLY_B）
   ↓
Reporter（report.json + report.html + 控制台摘要）
```

### 3.2 技术选型

- **Node.js 脚本，零 npm 依赖**（Node ≥ 16，仅用 `fs` / `path` / `crypto`；自带简易 glob 与 LCS diff 实现）：
  - 配置来自 `.env`（自带极简解析，无需 dotenv）
  - 单入口 CLI：`node src/compare.js [项目A 项目B] [--include 规则] [--exclude 规则]`

### 3.3 相似度算法

1. MD5 相同 → `IDENTICAL`
2. 归一化后 MD5 相同 → `SAME_BY_RENAME`
3. 否则按行做 LCS diff，相似度 = 1 - (变更行数 / 两文件最大行数)：
   - ≥ 80% → `SIMILAR`（漂移的公共代码，按相似度降序输出 diff）
   - < 80% → 视为各自演化，归入 `DIVERGED`（不展开）

### 3.4 报告内容（report.html）

自包含单文件 HTML，**左右双树布局**：

- 顶部：概览卡片（各分类数量）+ 搜索框 + 范围过滤下拉（全部 / 两边共有 / 有差异 / 无差异 / 仅单边）+ 图例
- 左右两栏：各项目的**文件树**，可展开/折叠，文件按状态打点着色，右上角显示"可见 / 总数"
- **点击任一文件 → 弹窗显示左右双栏 diff**（左红右绿，`@@` hunk 分段），共有文件在对侧树同步高亮
  - `IDENTICAL` / `SAME_BY_RENAME`：弹窗说明性质，不展示 diff
  - `SIMILAR` / `DIVERGED`：展示双栏 diff
  - `ONLY_A` / `ONLY_B`：说明为单边业务代码，不做对比

### 3.5 实施步骤

| 阶段 | 内容 | 工作量 |
|---|---|---|
| M1 | Scanner + 两层归一化 + MD5 分类，输出 JSON | 0.5 天 |
| M2 | diff 相似度分级 + HTML 报告 | 1 天 |
| M3 | jscpd 跨路径克隆检测（可选二期） | 1 天 |
| M4 | 基于报告输出《公共代码抽取建议》 | 0.5 天 |

### 3.6 本仓库（project-compare）目录结构

```
project-compare/
├── docs/PLAN.md           # 本文档
├── .env                   # 运行配置（gitignore，复制 .env.example）
├── .env.example           # 配置模板
├── src/
│   ├── compare.js         # CLI 入口：扫描→过滤→归一化→比较→报告
│   ├── config.js          # .env 解析与配置合并（默认 < .env < CLI）
│   ├── scanner.js         # 文件扫描（固定排除 node_modules/target/dist/.git/.idea）
│   ├── normalizer.js      # 路径/内容归一化（识别项目名五种形态）
│   ├── exclude.js         # include 白名单 + exclude 黑名单（简易 glob）
│   ├── comparator.js      # MD5 快筛 → LCS 逐行 diff → 相似度
│   └── reporter.js        # JSON/HTML 输出
├── templates/report.html  # 报告模板（双树 + 弹窗 diff）
└── output/                # 运行产物（gitignore）
```

---

## 4. 使用方法（已实现 ✅）

```powershell
# 全部参数取自 .env（复制 .env.example 为 .env 并修改）
node src/compare.js

# 或命令行直接指定
node src/compare.js <项目A目录> <项目B目录> --include "{PROJECT}-vue/src/utils/**"
```

### 配置（.env）

| 键 | 说明 |
|---|---|
| `PROJECT_A` / `PROJECT_B` | 两个项目目录 |
| `OUT_DIR` | 输出目录（默认 `./output`） |
| `THRESHOLD` | SIMILAR 阈值，默认 0.8 |
| `MAX_DIFF_LINES` | 每文件内嵌 diff 最大行数，默认 300 |
| `INCLUDE_DIRS` / `INCLUDE_FILES` | **白名单**，逗号分隔；非空则只对比命中范围 |
| `EXCLUDE_DIRS` / `EXCLUDE_FILES` | **黑名单**，在白名单基础上再剔除 |

**过滤顺序**：先按 INCLUDE 圈定范围（为空 = 全量），再按 EXCLUDE 剔除。

规则语法：`*` 不跨目录、`**` 跨目录、`?` 单字符；命中目录即包含/排除其下全部文件。
`{PROJECT}` 为项目名占位符，一条规则同时作用于两个项目（写具体项目名则只作用于单侧）。

```ini
# 例：只对比前端公共部分
INCLUDE_DIRS={PROJECT}-vue/src/utils/**, {PROJECT}-vue/src/components/**, {PROJECT}-vue/src/hooks/**
# 例：再剔除某项目的临时目录
EXCLUDE_DIRS=sport-asset-vue/temp
```

- 输出：`output/report.html`（自包含，可直接分发）+ `output/report.json`（供后续处理）
- 依赖：Node.js ≥ 16，零 npm 依赖

### 首次运行结果（lottery-fund ↔ sport-asset）

| 分类 | 数量 |
|---|---|
| 归一化后共有文件 | 692 |
| 完全相同 | 528 |
| 仅项目名不同 | 4 |
| 相似（有漂移，≥80%） | 84 |
| 差异较大（<80%） | 76 |

漂移公共代码 Top：`UpdatePwdPage.vue`(80.3%)、各 `@entities/*.d.ts`(81~85%，由各自数据库实体生成，属正常业务差异)、`controller.java.ftl`(83.1%)、`download.ts`(83.3%) 等。

## 5. 风险与注意事项

- 归一化只处理项目名本身；若两项目还有其他系统性命名差异（如包名 `com.jiujie.xxx`），需把替换规则做成可配置列表。
- 二进制文件（图片、favicon 等）只做哈希比较，不参与 diff。
- 报告中的 diff 可能很大，HTML 报告需按需懒加载或只展示前 N 行。
