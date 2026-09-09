# Job Autofill MVP

用于秋招网页表单的本机辅助填写工具。FastAPI、SQLite 和浏览器扩展均在本机运行，不调用任何外部模型或网络服务。

## 启动

```bash
bash install.sh
bash start.sh
```

在 Chrome/Edge 的扩展管理页开启开发者模式，加载 `extension/` 目录。首次使用扩展会打开 `http://127.0.0.1:8765/pair`，核对显示的扩展来源后点击允许；令牌仅保存在浏览器本地存储。

个人资料保存在本机 `data/autofill.db`，认证状态保存在 `data/auth.json`。两者均不应提交或共享。可参考 `data.example/profile_seed.json` 创建不含敏感信息的资料模板。

## 填写策略

工具优先复用已确认的同表单映射，其次复用同一网站的兼容映射，再使用本地规则。历史映射可自动填写；规则匹配会标记为“需要确认”。不会自动处理登录、验证码、下一步或最终提交。

本地接口仅接受已配对扩展的 Bearer 令牌。映射可通过 `/api/mappings` 查看、删除单项或按网站清空。
