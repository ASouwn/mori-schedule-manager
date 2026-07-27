# Mori 日程管理器

基于 Tauri 2、React、TypeScript 和 Vite 的跨平台桌面日程管理工具。

Windows 正式安装版以桌面 GUI 模式启动，不会额外显示 PowerShell 或命令行窗口。

## 功能

- Outlook 风格月历
- 创建、编辑和删除任务
- 创建任务时拆解子任务
- 最多四级嵌套子任务，支持添加下级、升级、降级和级联完成
- 任务复制后编辑复用，并可整体平移主任务与子任务日期
- 日、周、月定时循环任务，支持预估周期、增加周期和提前结束系列
- 任务星标，可在甘特图和任务详情中快速标记重点任务
- 任务甘特图支持通过专用手柄拖动排序，并支持 `Alt + ↑/↓` 键盘排序，结果自动保存在本地
- 甘特图任务名称区域自适应宽度，星标与操作按钮不会挤压标题
- 项目级甘特图
- 任务内部的子任务甘特图
- 子任务甘特图支持正文、浮窗和主任务展开三种显示方式
- 项目分类筛选与新建分类
- 按项目分组的任务列表和详情面板
- 分类新增、改名、改色、删除和拖动排序
- 日/周/月时间缩放
- 子任务长周期自动切换日、周、月刻度并独立横向滚动
- 短周期任务保持最小可见宽度，兼顾日期准确性与点击操作
- 甘特图适应任务、本月、本季度与自定义日期范围
- 甘特图任务隐藏、集中管理、搜索与批量恢复
- 限定窗口外任务的边缘方向和超出天数提示
- 逾期任务自动延长、提前闭环自动缩短
- 字号、界面密度、侧栏和详情栏显示设置
- JSON 数据备份、恢复与安全清空
- 子任务完成状态和总体进度
- 本地优先：任务、分类和显示偏好写入系统应用数据目录的 `tasks.json`
- macOS 与 Windows 桌面安装包

## 项目结构

```text
.
├── src/                    # React + TypeScript 前端
│   ├── App.tsx             # 主界面和业务交互
│   ├── main.tsx            # React 入口
│   └── styles.css          # 全局样式
├── src-tauri/              # Tauri/Rust 桌面层
│   ├── src/lib.rs          # 本地任务读写命令
│   ├── capabilities/       # Tauri 权限配置
│   ├── icons/              # 各平台应用图标
│   └── tauri.conf.json     # 窗口与打包配置
├── scripts/
│   └── build-windows.ps1   # Windows 本机构建脚本
├── .github/workflows/
│   └── build-windows.yml   # GitHub Actions 自动生成 Windows 安装程序
├── index.html
├── package.json
└── vite.config.ts
```

## 开发

要求：

- Node.js 20 或更高版本
- Rust stable
- macOS：Xcode Command Line Tools
- Windows：Microsoft C++ Build Tools 和 WebView2

```bash
npm install
npm run desktop:dev
```

只预览前端：

```bash
npm run dev
```

## 构建桌面安装包

在目标系统上运行：

```bash
npm run desktop:build
```

- macOS 构建 `.app` 和 `.dmg`
- Windows 构建 NSIS `.exe` 安装程序

Tauri 默认在当前操作系统上生成对应平台的原生安装包。Windows 安装包应在
Windows 构建机或 Windows CI runner 上生成。

### Windows 一键构建

在 Windows PowerShell 中运行：

```powershell
.\scripts\build-windows.ps1
```

安装程序生成在：

```text
src-tauri\target\release\bundle\nsis\*-setup.exe
```

### GitHub 自动构建

推送到 `main`、推送 `v*` 标签，或在仓库的
**Actions → Build desktop installers → Run workflow** 手动运行，都会触发构建。
完成后可从该次运行的 Artifacts 下载：

- `Mori-Windows-x64`：Windows NSIS `.exe` 安装程序
- `Mori-macOS-arm64`：Apple Silicon Mac `.dmg`
- `Mori-macOS-x64`：Intel Mac `.dmg`

未配置代码签名时，系统首次启动可能显示安全提醒；这不影响安装包生成。

## 数据位置

应用通过 Rust 将任务写入 Tauri 的系统应用数据目录：

- macOS：`~/Library/Application Support/com.mori.schedule/tasks.json`
- Windows：系统应用数据目录下的 `com.mori.schedule/tasks.json`

浏览器调试模式下，如果没有 Tauri 运行环境，会自动回退到 `localStorage`。
