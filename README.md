# Claude 思考控制器 (Claude Thinking Controller)

把 Claude 的"思考开关"重新交到你手里的 SillyTavern 扩展。

## 这是什么

从 Claude Opus 4.7 开始，思考变成了**自适应**的——模型自己决定一个问题要不要深想、想多深。对日常使用很方便，但在角色扮演里，很多人发现**开启思考的回复质量明显更好**：逻辑更连贯、人物更细腻、长程一致性更强。

这个扩展让你**强制控制思考行为**，不再被动等模型自己决定。

## 原理

扩展监听 SillyTavern 官方的 `CHAT_COMPLETION_SETTINGS_READY` 事件，在请求发出前往请求体里注入 Anthropic **官方公开的** thinking 参数。

它**只动参数层，不碰内容层**：
- 不修改你的预设 / system prompt
- 不往对话里偷塞任何文字
- 不使用任何"越权""覆盖"类的话术
- 用的全是 [Anthropic API 文档](https://docs.claude.com)里公开的合法参数

换句话说，它做的事你完全可以在酒馆"自定义端点 → 附加包含/排除主体参数"里手动填，扩展只是把这套操作做成了下拉菜单，方便、不易出错、换模型不用重填。

## 功能

- **三种模式**：不干预 / 自适应 / 固定预算
- **自适应强度**：低 / 中 / 高 / 超高 / 最大
- **固定预算**：自定义 thinking budget tokens，自动处理 max_tokens 约束
- **模型匹配正则**：只对你指定的模型生效
- 支持自定义 (OpenAI 兼容) 端点 和 原生 Anthropic 端点

## 安装

### 方式一：通过酒馆扩展安装器

1. 打开 SillyTavern → 扩展面板 → Install extension
2. 粘贴本仓库的 Git URL
3. 安装后在扩展设置里找到「Claude 思考控制器」

### 方式二：手动安装

把整个文件夹放进：
```
SillyTavern/data/<你的用户名>/extensions/
```
或
```
SillyTavern/public/scripts/extensions/third-party/
```

## 使用

1. 在扩展设置里勾选「启用」
2. 选择思考模式（推荐**自适应**）
3. 调节思考强度
4. 开聊

## 注意

- 自适应思考要求 `temperature=1`，扩展会自动设置，并排除冲突的 `top_p` / `top_k`
- 固定预算模式下 `max_tokens` 必须大于 budget，扩展会自动调整
- 思考会增加 token 消耗和响应时间，按需开启

## License

AGPL-3.0
