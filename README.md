# 废都物语 · 网页版

用 [EasyRPG Player](https://easyrpg.org/) 的 Web 版在浏览器里运行《Ruina 废都物语》ver1.21 个人汉化版，通过 GitHub Pages 发布。
参考：[EasyRPG Player for the Web](https://wiki.easyrpg.org/development/player/web)

## 目录结构

```
web/                     ← 整个网站（发布到 GitHub Pages）
├── index.html           ← EasyRPG Web 播放器（CI 构建版，2026-09-20）
├── index.js             ← 〃
├── index.wasm           ← 〃
└── games/
    └── default/         ← 废都物语的游戏文件放这里（打开首页即运行）
        ├── RPG_RT.ldb
        ├── RPG_RT.lmt
        ├── RPG_RT.ini       ← 已含 [EasyRPG] Encoding=936
        ├── Map0001.lmu …
        ├── Font/            ← 汉化版附带的专用字体
        ├── easyrpg.soundfont  ← MIDI 音色库
        ├── CharSet/ ChipSet/ Music/ Sound/ Picture/ …
        └── index.json   ← 由 gencache 生成（部署时自动生成）
tools/gencache.py        ← gencache 的 Python 版（输出与官方 C++ 版一致）
tools/gen_offline_manifest.py  ← 生成离线清单 offline-manifest.json（部署时运行）
.github/workflows/deploy-web.yml  ← 自动生成 index.json 和离线清单并部署到 Pages
```

## 上线步骤

播放器和游戏文件都已放入本分支（去掉了网页版用不到的 `RPG_RT.exe`、`RPG_RT.exe.bak` 和 `Thumbs.db`），
只需完成第 3、4 步。以后更换游戏或升级播放器时参照第 1、2 步。

> 注意：游戏素材的文件名看起来像乱码（如 `System/攑搒僔僗僥儉.xyz`），这是正常的——
> 它们是日文原名按 GBK 读出来的样子，和数据库按 936 编码解码后的引用完全一致，**不要改名**。

1. **放入播放器**：从 <https://easyrpg.org/player/downloads/> 下载 Web 版播放器压缩包，
   把其中的 `index.html`、`index.js`、`index.wasm` 解压到 `web/` 目录。
2. **放入游戏**：把游戏目录（含 `RPG_RT.ldb` 的那一层）里的全部内容复制到 `web/games/default/`，
   然后删除 `web/games/default/.gitkeep`。
   - 不需要 `RPG_RT.exe`、`Harmony.dll` 等 Windows 程序文件，可以不上传。
   - 如果游戏依赖 RTP（运行时素材包），需要把用到的 RTP 素材一并复制进游戏目录，网页版不会自动加载 RTP。
   - 文件名必须和游戏数据库里的引用一致（按 `RPG_RT.ini` 里的 Encoding 解码后）。换游戏时，若读不到素材，多半是解压工具用错了编码。
3. **开启 Pages**：仓库 Settings → Pages → Source 选 **GitHub Actions**。
4. **合并到 `main`**：推送到 `main` 后工作流会为 `web/games/` 下每个游戏生成 `index.json` 并部署。
   也可以在 Actions 页手动运行 “Deploy web player”。

> 单个文件不能超过 100 MB（GitHub 限制），整个站点建议控制在 1 GB 以内。

## 离线游玩 / 存档备份 / 虚拟键盘

- **离线**：第一次联网打开时会自动下载整个游戏（约 41 MB）并校验，完成后断网也能玩。
  iPhone 上可用 Safari「添加到主屏幕」当作 App 使用。注意主屏幕 App 和 Safari 的存储是分开的，
  添加后需要联网打开一次。每次重新部署后会自动只下载有变化的文件。
- **💾 导出存档**：把所有存档打包成 `ruina-save-日期.zip`，可存到「文件」App。
  **📂 导入存档**：选择之前导出的 zip（或单个 `.lsd`），覆盖前会确认，导入后游戏自动重新载入。
- **🎮 虚拟键盘**：屏幕上的 Shift / Ctrl / Alt / Esc / Tab / Enter / Space / 方向键 / Z X C A，
  可多指同时按（例如按住 Shift 再点 Z）。

技术细节和测试情况见 [HANDOFF.md](HANDOFF.md)。

## 本地预览

浏览器不能直接用 `file://` 打开，需要起一个 HTTP 服务：

```sh
python3 tools/gencache.py web/games/default
python3 -m http.server -d web 8000
# 打开 http://localhost:8000/
```

## 常用网址参数

- `?game=<目录名>`：运行 `web/games/<目录名>/` 里的游戏（不带参数时运行 `default`）。
- `?encoding=936`：若游戏文字显示乱码，强制按 GBK（简体中文）解码。

存档保存在浏览器本地（IndexedDB）。在存档/读档界面按 Shift 可下载或上传存档文件。
