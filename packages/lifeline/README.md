# Life Line · float 自定义应用版说明

Life Line 是一个个人生活记录应用（Y2K 冰蓝千禧复古风格），用于录入考研任务、习惯打卡、错题、知识点、日记、饮食、身材、肠胃、经期与里程碑等数据。本目录是它适配 **float 虚拟手机** 作为自定义应用运行的版本。

> 记账功能已从 Life Line 拆分为独立应用（支持微信/支付宝分账、自动记账），Life Line 内不再记账；旧账目见下方「数据去哪了」的迁移说明。

## 1. 文件清单

| 文件 | 作用 |
| --- | --- |
| `index.html` | 主应用单文件页面（全部业务 UI 与逻辑），应用入口 |
| `manifest.json` | float 自定义应用清单：应用 id、名称、图标、入口、网络白名单 |
| `float-storage-shim.js` | float 沙盒存储代理：把应用对 localStorage 的读写代理到 float 自己的持久层（IndexedDB，集合 `lifeline`），保证页面代码不改一行即可运行 |
| `sync-inject.js` | Supabase 云端同步注入：打开时拉取云端最新数据，录入后自动推回云端，并在右上角显示同步状态圆点 |
| `help-inject.js` | 帮助面板注入：右下角冰蓝圆形 ? 按钮，点击弹出数据录入工作流说明（即本文档对应的应用内帮助） |
| `mobile-enhance.js` | 移动端体验增强（触控、视口、安全区等适配） |
| `assets/` | 图标、KaTeX 数学公式字体等静态资源 |
| `help-preview.html` | 帮助面板的独立预览测试页，仅供开发者本地打开核对样式，不需要打包进正式应用 |
| `../ledger/`（packages\ledger\） | 独立记账应用（由另一任务产出）：记账已从 Life Line 拆分至此，支持微信/支付宝分账与自动记账，详见其目录内 README |

## 2. 数据去哪了

- **float 本地持久层**：float 沙盒没有浏览器原生 localStorage，页面数据实际保存在 float 自己的存储里（IndexedDB，按应用 id/集合 `lifeline` 存储），由 `float-storage-shim.js` 代理完成，对页面透明。
- **云端 Supabase 备份**：`sync-inject.js` 同时把数据备份到 Supabase 表 `lifelinestate`（deviceid=`main`）。
- **数据价值优先级**：云端最新 > 本地备份文件 > 仅本地存储。
- **迁移顺序**：首次打开 float 版时会自动从云端拉取一次；云端没有记录就从空数据开始。之后所有录入先写入 float 本地，再由同步层推送到云端。
- **旧账目迁移**：Life Line 里的旧账（finances 字段）可迁移到独立记账应用：记账应用首次运行会自动从云端拉取，或用 Life Line 导出的备份 JSON 文件在记账应用内导入。迁移完成后 Life Line 侧不再新增账目。

> 注意：float 版数据保存在 float 自己的存储里，卸载应用时若勾选删除数据会一并清除，卸载前请先在应用内导出备份。

## 3. 安装到 float 的步骤（用户操作）

1. 在 float 里打开自定义应用安装入口。
2. 选择安装包 `lifeline.float.zip`（或由开发者通过创作/本地测试方式直接载入本目录）。
3. 等待安装完成。
4. 打开 Life Line 应用。
5. 首次打开会自动从云端恢复数据。
6. 查看右上角同步圆点：变绿即已同步；若显示离线/推送失败，检查网络后点一下同步按钮重试。

## 4. 日常使用提醒

- 一律用页面里的表单按钮录入，不要直接改存储。
- 录入后等右上角同步圆点变绿，再刷新页面。
- 批量改数据前先在应用内导出一次备份。
- **float 版与电脑网页版不要同时编辑同一份数据**：电脑端改完等同步变绿后，手机/float 端再操作，避免双向覆盖。
- 应用内点右下角 ? 按钮可随时查看完整录入工作流。

## 5. 数据迁移与备份

- **导出备份**：在应用内打开数据导出页，点「导出全部数据」，保存 JSON 文件（建议存到桌面考研文件夹，按日期命名）。
- **导入恢复**：在应用内导入页选择之前导出的 JSON 文件；导入前建议再导出现有数据一次，避免旧文件覆盖新数据。
- **本地备份目录**：`C:\Users\杨静茹\Desktop\考研\LifeLine数据备份_20260919\`（2026-09-19 快照）。
- **云端找回**：只要 deviceid=`main` 的云端记录还在，在任何设备首次打开应用都会自动拉取云端最新数据恢复。

## 6. 开发与维护

- **源码结构**：单页应用主体在 `index.html`；云同步、存储代理、帮助面板、移动端适配分别拆在 `sync-inject.js`、`float-storage-shim.js`、`help-inject.js`、`mobile-enhance.js`；应用配置在 `manifest.json`。
- **重新打包**：由 `build-float-package` 脚本完成（脚本由另一任务产出）。打包时在 `packages\lifeline` 目录下运行该构建脚本即可，产物为 `lifeline.float.zip`。
- **更新各科进度**：各科进度页的百分比/页码是在 `index.html` 中静态写死的，页面无编辑按钮。需要更新时直接修改 `index.html` 里对应的百分比/页码字段，然后重新打包。秘书窗口汇报进度的统一格式见应用内帮助面板。

## 7. 发布到 GitHub（仅指令，由本人执行）

仓库二选一：沿用已有仓库 `yjrlzx/ai-virtual-phone`，或新开一个仓库。以下命令在 `ai-virtual-phone-src` 根目录执行，推送需要本人的 Git 凭据。

```bash
# 首次提交
git add .
git commit -m "feat(lifeline): adapt lifeline as float custom app"

# 关联远程仓库（二选一）
git remote add origin git@github.com:yjrlzx/ai-virtual-phone.git
# 或新仓库：
# git remote add origin git@github.com:<新仓库路径>.git

# 推送
git branch -M main
git push -u origin main
```

> Operit 参考仓库（安卓 AI Agent 方向）因外网 `git clone` 暂不通，目前未引入代码，仅记录方向；后续可通过 `api.github.com` 文件树接口研究其结构后再补充。

## 8. 掌心窗 MCP 工具清理对照表

下列 MCP 工具与华为壳（掌心窗）原生能力重复，应在 float 工具箱里删除，避免重复调用与混乱：

| 应删除的 MCP 工具 | 重复的壳原生能力 | 说明 |
| --- | --- | --- |
| `getScreenNodes` / `dumpScreen` | `AndroidShell.dumpScreen` | 读屏/获取界面节点，壳已内建 |
| `clickText` | `AndroidShell.clickText` | 按文本点击，壳已内建 |
| `getPayments` | `AndroidShell.getPayments` | 支付记录解析，壳已内建 |
| `getNotifications` | `AndroidShell.getNotifications` | 通知读取，壳已内建 |

这些 MCP 工具来自用户在 float 工具箱（**设置 → 工具箱**）里配置的外部 MCP 服务器。删除步骤：

1. 进入 **设置 → 工具箱 → MCP 服务器**。
2. 找到提供上述重复工具的服务器条目，点编辑。
3. 移除重复工具，或直接删除整个重复的 MCP 服务器条目。
4. 只保留对话里能直接调用的现实桥/壳内建能力工具。

## 9. 注意事项与限制

- KaTeX 数学公式字体在 float 沙盒里以内联 dataURL 方式加载（构建时处理），无需联网拉取字体。
- 云端同步依赖网络与 Supabase 服务可用性；离线时数据仍先存 float 本地，联网后自动补推。
- 沙盒无原生 localStorage，所有对 localStorage 的访问都经过 `float-storage-shim.js` 代理，保证同步读写不崩溃；开发时不要在页面代码里假设 localStorage 直接可用。
- 帮助面板（`help-inject.js`）只注入自己创建的 DOM，不改动主应用的数据层、业务逻辑与主 UI 结构。
