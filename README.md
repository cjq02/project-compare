# project-compare

对比两个同源项目的公共代码，量化重合度，找出「本应公共却各自漂移」的部分。

适用于**同一套脚手架/代码生成器**产出的项目：路径能一一对应，但项目名不同（`lottery-fund` ↔ `sport-asset`）。工具通过两层归一化消除项目名噪音，让真正的代码差异浮出来。

**零 npm 依赖**，Node.js ≥ 16 即可运行。

---

## 快速开始

```powershell
copy .env.example .env     # 改 PROJECT_A / PROJECT_B
node src/compare.js        # 跑一次对比
# 打开 output/report.html
```

需要实时跟踪项目变更时，起服务：

```powershell
node src/server.js         # 默认 http://localhost:18899
```

---

## 它做了什么

```
Scanner      扫描两个项目（固定排除 node_modules/target/dist/.git/.idea）
   ↓
Normalizer   路径归一化 + 内容归一化
   ↓
Comparator   MD5 快筛 → LCS 逐行 diff → 相似度
   ↓
Classifier   IDENTICAL / SAME_BY_RENAME / SIMILAR / DIVERGED / ONLY_A / ONLY_B
   ↓
Reporter     report.json + report.html + 控制台摘要
```

### 两层归一化

| 层 | 做什么 |
|---|---|
| 路径归一化 | 相对路径中的项目名 → `{PROJECT}`，让 `lottery-fund-vue/src/utils/a.ts` 与 `sport-asset-vue/src/utils/a.ts` 配上对 |
| 内容归一化 | 文件内容中的项目名 → 占位符，让「只改了项目名」的文件判为相同 |

项目名识别 **7 种形态**：`kebab`(`lottery-fund`)、`snake`(`lottery_fund`)、`upper`(`LOTTERY_FUND`)、`camel`(`lotteryFund`)、`pascal`(`LotteryFund`)、`dot`(`lottery.fund`，Java 包名)、`slash`(`lottery/fund`，Java 源路径)。

> 少认一种形态，两个项目的 Java 文件就永远配不上对 —— dot/slash 是后补的。

### 分类

| 分类 | 含义 |
|---|---|
| `IDENTICAL` | 归一化后内容完全相同 → 可直接抽公共 |
| `SAME_BY_RENAME` | 仅项目名不同（含 BOM/换行差异）→ 公共代码，只是没参数化 |
| `SIMILAR` | ≥ `THRESHOLD`（默认 0.8）→ **公共代码发生漂移，重点审查对象** |
| `DIVERGED` | < 阈值 → 各自演化，弹窗仍可看 diff |
| `ONLY_A` / `ONLY_B` | 单边独有 → 业务代码 |

---

## 报告怎么用

单棵合并树表格（参照 `MenuTreeDiffForm.vue` 的 el-table 树形结构），A/B 两列并排。

- **目录行**显示 `总数（实际可见）`：括号外是该目录两侧并集的文件总数，括号内是**当前筛选/搜索下展开后实际会显示的文件数**，随筛选实时变化
- **整行点击**展开/折叠子树；顶部工具栏可全部展开/折叠
- **单击文件行**直接拉起 IDE 原生对比窗口（见下）
- **右键**弹菜单：详情与同步 / 双工具对比 / 复制 A、B 路径
- **筛选**：全部 / 两边共有 / 有差异 / 无差异 / 仅单边；**搜索**框按路径模糊匹配，命中路径的祖先目录自动展开
- **详情弹窗**：默认完整内容视图，可切行级 diff；内容**现读磁盘**（`/api/live-diff`），不是报告快照
- 弹窗内可对**单个文件**做同步（预览 → 确认执行）

### 实时性

- SSE（`/api/events`）主动推送「项目文件有变更」提示
- 工具栏**手动刷新**重跑对比 —— 不会自动重绘报告
- 报告里的数字会随你编辑项目小幅浮动，属正常

---

## 配置（.env）

复制 `.env.example` 为 `.env`（`.env` 已 gitignore）。优先级：**CLI 参数 > .env > 默认值**。

| 键 | 说明 |
|---|---|
| `PROJECT_A` / `PROJECT_B` | 两个项目目录 |
| `OUT_DIR` | 输出目录，默认 `./output` |
| `PORT` | `server.js` 监听端口，默认 `18899` |
| `THRESHOLD` | SIMILAR 阈值，0~1，默认 `0.8` |
| `MAX_DIFF_LINES` | 每文件内嵌 diff 最大行数，默认 `300` |
| `DIFF_TOOL` | 单击行拉起的 IDE：`intellij`（默认）/ `vscode` / `none` |
| `IDEA_EXE` / `VSCODE_EXE` | 可执行文件路径，留空自动探测 |
| `INCLUDE_DIRS` / `INCLUDE_FILES` | 白名单 |
| `EXCLUDE_DIRS` / `EXCLUDE_FILES` | 黑名单 |
| `PATH_ALIAS` | 路径别名，两侧包段叫法不同时用于配对 |

### 列表值可以写多行

一条规则一行，自动以逗号拼接，便于逐条配说明：

```ini
EXCLUDE_FILES=
  # 锁文件与缓存
  **/pnpm-lock.yaml
  **/.eslintcache
  # 二进制资源
  **/*.png
  **/*.jpg
  # 各环境地址配置
  **/.env*                  # 行内 # 是该条规则的说明
```

- `KEY=` 值为空即进入多行模式；**块内空行与整行注释不影响块**，可以随便插分节注释
- 块在下一个 `KEY=`（大写变量名）处结束 —— 以此界定边界，所以含 `=` 的规则不会被误当成新键
- 行尾 `\` 表示「这一条还没写完」，用来把一条超长规则折行
- **单行逗号分隔的老写法完全兼容**

---

## 过滤规则

**顺序**：先按 INCLUDE 圈定范围（为空 = 全量），再按 EXCLUDE 剔除。

语法：`*` 不跨目录、`**` 跨目录、`?` 单字符；命中目录即包含/排除其下全部文件。

```ini
# {PROJECT} 为项目名占位符，一条规则同时作用于两个项目
INCLUDE_DIRS={PROJECT}-vue/**

EXCLUDE_DIRS=
  {PROJECT}-vue/public/**         # 第三方静态资源
  {PROJECT}-vue/src/api/**        # 由各自 swagger 生成，两边必然不同
```

三个要点：

1. **规则锚定路径开头** —— 裸文件名只匹配项目根目录。要匹配任意层级需写 `**/` 前缀，如 `**/pnpm-lock.yaml`。
2. **`!` 前缀可撤销排除**，按书写顺序后者覆盖前者（类似 `.gitignore`）。所以「排除整个目录、只留其中一个文件」写成：

   ```ini
   {PROJECT}-vue/src/common/*
   !{PROJECT}-vue/src/common/constants*
   ```
3. 写具体项目名（如 `sport-asset-vue/temp`）则只作用于单侧。

---

## 路径别名（PATH_ALIAS）

Java 包名的**项目前缀**已经被归一化了 —— `com/jiujie/lottery/fund/...` ↔ `com/jiujie/sport/asset/...` 会统一成 `com/jiujie/{pkgpath}/...`，不用再配。

但**子包名**也可能不同（A 的 `common` 包在 B 里叫 `base`），这时用别名把文件配成对：

```ini
PATH_ALIAS=
  A com/jiujie/{pkgpath}/  common => base
```

语法：`侧别(A|B)  锚点前缀  旧段 => 新段`

- **只作用于指定的一侧** —— A、B 各自归一化，所以必须带侧别
- **只在锚点之后命中「整段」时才替换** —— `commonx/` 不会被误伤
- **只影响配对** —— 不改文件内容，也不参与 INCLUDE/EXCLUDE 过滤（过滤已按真实路径完成）

### 为什么必须带侧别和锚点

不能做全局段替换，两个原因：

1. **A 项目同时存在 `common/` 与 `base/` 两个包**，两边都归一成同一个名字会在 A 内部撞车
2. `{PROJECT}-vue/src/common/` 也含 `common` 段，全局替换还会误伤前端目录

以 lottery-fund ↔ sport-asset 实测：

```
A 自身 common ∩ base    0 个   ← 别名不会在 A 内部撞车
A common     ∩ B base  71 个   ← 别名的收益
A base       ∩ B base   0 个   ← 不会误配
```

加上这条别名后，配对成功的 Java 文件 **121 → 194**（+73）。

### 报告里的表现

别名只改**配对键**，所以报告的 `key` 会显示别名后的形式，但 A/B 两列显示的仍是真实路径：

```
key = {PROJECT}-api/src/main/java/com/jiujie/{pkgpath}/base/Constants.java
  A = lottery-fund-api/.../com/jiujie/lottery/fund/common/Constants.java
  B = sport-asset-api/.../com/jiujie/sport/asset/base/Constants.java
```

---

## IDE 对比

`DIFF_TOOL=intellij` 时，单击文件行会用 `idea64.exe diff <A> <B>` 打开 IDEA 原生对比窗口（IDEA 已运行则作为标签页插入）；`vscode` 用 `Code.exe --diff`。

- 一律直接调用 `.exe`，绕开 `.bat` / shell 的引号问题
- 以 `detached + stdio:ignore + unref` 启动，不阻塞 HTTP（实测 ~20ms 返回）
- 路径只从报告数据推导并做 `safePath` 校验，客户端只传 `key` 与 `tool`（经白名单归一）
- 弹窗内也有「在 IDE 中对比」按钮，且可选双工具

---

## 单文件同步

弹窗内对**单个文件**做同步：先预览源→目标，确认后执行。每次都要显式选择方向（`A→B` / `B→A`）。

不做批量同步，不做删除。服务端校验路径穿越，并有 `SYNCABLE` 白名单 —— 只有 `SIMILAR` / `DIVERGED` 的文件可同步，`IDENTICAL` 与单边独有文件不开放。

---

## 服务端 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 摘要 + 是否有未刷新的变更 |
| GET | `/api/report` | 完整对比数据 |
| GET | `/api/events` | SSE：项目文件变更提示 |
| GET | `/api/live-diff?key=` | 现读磁盘计算对比（弹窗用，非快照） |
| GET | `/api/diff-tools` | 可用的 IDE 对比工具及默认值 |
| POST | `/api/refresh` | 重跑对比并生成报告 |
| POST | `/api/sync` | 单文件同步 `{ key, direction: 'A2B' \| 'B2A' }` |
| POST | `/api/open-diff` | 拉起 IDE diff 窗口 `{ key, tool? }` |

> **改完 `.env` 需重启服务** —— 服务在启动时读取配置。

---

## CLI

```
node src/compare.js [项目A目录 项目B目录] [选项]

  -e, --env <file>           .env 配置文件（默认 ./.env）
  -o, --out <dir>            输出目录（默认 ./output）
  -t, --threshold <0~1>      SIMILAR 相似度阈值（默认 0.8）
      --include <pattern>    白名单规则（可多次使用，与 .env 合并）
      --exclude <pattern>    黑名单规则（可多次使用，与 .env 合并）
      --max-diff-lines <n>   每个文件内嵌 diff 最大行数（默认 300）
      --diff-tool <tool>     intellij | vscode | none
      --idea-exe <path>      IntelliJ 可执行文件路径
      --vscode-exe <path>    VSCode 可执行文件路径
  -h, --help
```

---

## VSCode 集成

`.vscode/tasks.json` 提供三个任务：

| 任务 | 快捷键 |
|---|---|
| 启动对比服务 | `Ctrl+Shift+B`（默认构建任务，直接执行） |
| 停止对比服务 | `Ctrl+Shift+P` → `Tasks: Run Task` |
| 单次对比（生成静态报告） | `Ctrl+Shift+P` → `Tasks: Run Test Task` |

要弹任务下拉直接选：**`Ctrl+P` → 输入 `task␠`**（注意末尾空格）。

---

## 目录结构

```
project-compare/
├── docs/PLAN.md            # 实施计划与调研结论
├── .env                    # 运行配置（gitignore）
├── .env.example            # 配置模板（进版本库）
├── scripts/
│   ├── serve.ps1           # 起服务（先 kill 占用端口的进程）
│   └── stop.ps1            # 停服务
├── .vscode/tasks.json      # VSCode 任务
├── src/
│   ├── compare.js          # CLI 入口
│   ├── server.js           # HTTP + SSE + 同步 + IDE 对比
│   ├── config.js           # .env 解析与配置合并（默认 < .env < CLI）
│   ├── engine.js           # 组装流程
│   ├── scanner.js          # 文件扫描
│   ├── normalizer.js       # 路径/内容归一化（7 种项目名形态）
│   ├── exclude.js          # include 白名单 + exclude 黑名单
│   ├── comparator.js       # MD5 快筛 → LCS 逐行 diff → 相似度
│   └── reporter.js         # JSON/HTML 输出
├── templates/report.html   # 报告模板（每次生成时读取，改模板无需重启服务）
└── output/                 # 运行产物（gitignore）
```

---

## 已知限制

- **归一化只处理项目名本身**。其他系统性命名差异（如 A 的 `common` 子包在 B 中改名为 `base`）需要显式配 `PATH_ALIAS`，不能做全局段替换。
- **包段不同的业务代码无法归一化** —— 若两侧子包名对应的是不同业务域（如 A 的 `budget` 对 B 的 `rent`/`inventory`/`lend`），它们就是各自的业务代码，别名也无从映射。
- 二进制文件只做哈希比较，不参与 diff。
- 大文件的 LCS 有格数上限（2500 万格），超过则只给出摘要不内嵌 diff。
- BOM 与换行风格视为噪音，在解码阶段消除，两侧同等对待。

## 后续可选

- `jscpd` / PMD CPD 做**跨路径**克隆检测，覆盖「路径不同但内容相似」的场景（工具本身不做这个）
- 基于报告输出《公共代码抽取建议》
