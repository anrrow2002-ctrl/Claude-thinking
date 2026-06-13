/**
 * Claude 思考控制器 (Claude Thinking Controller)
 *
 * 把 Claude 的"思考开关"重新交到你手里。
 * 从 Opus 4.7 开始，思考变成自适应的——模型自己决定要不要深想。
 * 这个扩展让你强制开启思考、手动调节思考强度或预算，
 * 通过往请求体里填官方公开的 API 参数实现，不碰任何内容层、不做任何越权操作。
 *
 * 原理：监听酒馆的 CHAT_COMPLETION_SETTINGS_READY 事件，
 * 在请求发出前往请求体注入 thinking 相关参数。
 *
 * Author: Anrrow
 * License: AGPL-3.0
 */

import { extension_settings } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { chat_completion_sources } from '../../../openai.js';

const EXT_ID = 'claude-thinking-controller';
const TAG = '[Claude思考控制器]';

// 思考模式
const MODE = {
    OFF: 'off',           // 不干预，让模型自己决定
    ADAPTIVE: 'adaptive', // 自适应思考（4.7+ 推荐）
    BUDGET: 'budget',     // 固定预算思考（thinking.type=enabled）
};

const DEFAULTS = {
    on: false,
    mode: MODE.ADAPTIVE,
    effort: 'high',       // 自适应强度：low / medium / high / xhigh / max
    budget: 16000,        // 固定预算模式下的 token 数
    matchRegex: 'claude', // 只对名字里含 claude 的模型生效
};

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function cfg() {
    return extension_settings[EXT_ID];
}

// 判断当前模型名是否匹配
function modelMatches(modelName) {
    const pattern = cfg().matchRegex || 'claude';
    try {
        return new RegExp(pattern, 'i').test(String(modelName || ''));
    } catch (e) {
        console.warn(TAG, '正则无效，回退到默认 claude 匹配：', pattern);
        return /claude/i.test(String(modelName || ''));
    }
}

// 把一段 YAML 文本追加到已有的 YAML 字段后面
function joinYaml(base, addition) {
    const head = String(base || '').replace(/\s+$/, '');
    return head ? head + '\n' + addition : addition;
}

// 从 YAML 文本里删掉指定的顶层键（含其下属缩进块）
function stripYamlKeys(yaml, keys) {
    if (!yaml) return '';
    const escaped = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const headRe = new RegExp('^(' + escaped + ')\\s*:');
    const out = [];
    let dropping = false;

    for (const line of String(yaml).split(/\r?\n/)) {
        if (dropping) {
            // 空行或缩进行 = 仍在被删的块内
            if (line.trim() === '' || /^\s/.test(line)) continue;
            dropping = false;
        }
        if (headRe.test(line)) {
            dropping = true;
            continue;
        }
        out.push(line);
    }
    return out.join('\n').trim();
}

// 往"排除参数"列表里加键（去重）
function addExclusions(yaml, keys) {
    const have = String(yaml || '').replace(/\s+$/, '');
    const existing = new Set(
        have.split(/\r?\n/).map(l => l.replace(/^\s*-\s*/, '').trim()),
    );
    const toAdd = keys.filter(k => !existing.has(k)).map(k => '- ' + k);
    if (toAdd.length === 0) return have;
    return have ? have + '\n' + toAdd.join('\n') : toAdd.join('\n');
}

/* ------------------------------------------------------------------ */
/* 参数注入                                                            */
/* ------------------------------------------------------------------ */

// 自适应思考：通过自定义端点 YAML 注入
function injectAdaptive(data) {
    const effort = cfg().effort || 'high';
    const yaml = [
        'thinking:',
        '  type: adaptive',
        '  display: summarized',
        'output_config:',
        '  effort: ' + effort,
    ].join('\n');

    // 自适应思考要求 temperature=1，且不能带 top_p / top_k
    data.temperature = 1;
    data.custom_include_body = stripYamlKeys(data.custom_include_body, ['thinking', 'output_config', 'temperature', 'top_p', 'top_k']);
    data.custom_include_body = joinYaml(data.custom_include_body, yaml + '\ntemperature: 1');
    data.custom_exclude_body = addExclusions(data.custom_exclude_body, ['top_p', 'top_k']);
}

// 固定预算思考
function injectBudget(data) {
    let budget = Math.max(Number(cfg().budget) || 16000, 1024);

    // max_tokens 必须大于 budget_tokens
    if (data.max_tokens && data.max_tokens <= budget) {
        data.max_tokens = budget + 1024;
        console.info(TAG, '已自动把 max_tokens 提到', data.max_tokens, '（必须大于思考预算）');
    }

    const yaml = [
        'thinking:',
        '  type: enabled',
        '  budget_tokens: ' + budget,
    ].join('\n');

    data.custom_include_body = stripYamlKeys(data.custom_include_body, ['thinking']);
    data.custom_include_body = joinYaml(data.custom_include_body, yaml);
    // 开思考时这些采样参数会冲突，排除掉
    data.custom_exclude_body = addExclusions(data.custom_exclude_body, ['temperature', 'top_p', 'top_k']);
}

// 原生 Anthropic 端点：直接设字段
function injectNativeAdaptive(data) {
    data.claude_thinking_mode = 'adaptive';
    data.claude_thinking_effort = cfg().effort || 'high';
    data.temperature = 1;
    delete data.top_p;
    delete data.top_k;
}

function injectNativeBudget(data) {
    let budget = Math.max(Number(cfg().budget) || 16000, 1024);
    if (data.max_tokens && data.max_tokens <= budget) {
        data.max_tokens = budget + 1024;
    }
    data.claude_thinking_mode = 'enabled';
    data.claude_thinking_budget = budget;
    delete data.temperature;
    delete data.top_p;
    delete data.top_k;
}

/* ------------------------------------------------------------------ */
/* 主钩子                                                              */
/* ------------------------------------------------------------------ */

function onSettingsReady(data) {
    const s = cfg();
    if (!s || !s.on) return;
    if (s.mode === MODE.OFF) return;

    const source = data.chat_completion_source;
    const isCustom = source === chat_completion_sources.CUSTOM;
    const isClaude = source === chat_completion_sources.CLAUDE;
    if (!isCustom && !isClaude) return;

    if (!modelMatches(data.model)) return;

    if (isCustom) {
        if (s.mode === MODE.ADAPTIVE) injectAdaptive(data);
        else injectBudget(data);
    } else {
        if (s.mode === MODE.ADAPTIVE) injectNativeAdaptive(data);
        else injectNativeBudget(data);
    }

    console.info(TAG, '已注入', s.mode, '思考，模型=', data.model);
}

/* ------------------------------------------------------------------ */
/* 界面                                                                */
/* ------------------------------------------------------------------ */

function refreshVisibility() {
    const mode = cfg().mode;
    $('#ctc_adaptive_box').toggle(mode === MODE.ADAPTIVE);
    $('#ctc_budget_box').toggle(mode === MODE.BUDGET);
}

function loadUI() {
    extension_settings[EXT_ID] = Object.assign({}, DEFAULTS, extension_settings[EXT_ID] || {});
    const s = cfg();

    $('#ctc_on').prop('checked', s.on);
    $('#ctc_mode').val(s.mode);
    $('#ctc_effort').val(s.effort);
    $('#ctc_budget').val(s.budget);
    $('#ctc_regex').val(s.matchRegex);

    refreshVisibility();
}

function bindUI() {
    $('#ctc_on').on('change', function () {
        cfg().on = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#ctc_mode').on('change', function () {
        cfg().mode = String($(this).val());
        refreshVisibility();
        saveSettingsDebounced();
    });
    $('#ctc_effort').on('change', function () {
        cfg().effort = String($(this).val());
        saveSettingsDebounced();
    });
    $('#ctc_budget').on('input', function () {
        cfg().budget = Number($(this).val()) || 16000;
        saveSettingsDebounced();
    });
    $('#ctc_regex').on('input', function () {
        cfg().matchRegex = String($(this).val());
        saveSettingsDebounced();
    });
}

const PANEL = `
<div id="claude-thinking-controller-panel">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Claude 思考控制器</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="flex-container flexFlowColumn">
                <small>把 Claude 的思考开关重新交到你手里。仅注入官方公开的 API 参数，不碰内容层。</small>
                <br>
                <label class="checkbox_label" for="ctc_on">
                    <input type="checkbox" id="ctc_on" />
                    <span>启用</span>
                </label>
                <br>
                <label for="ctc_mode">思考模式</label>
                <select id="ctc_mode" class="text_pole">
                    <option value="off">不干预（模型自己决定）</option>
                    <option value="adaptive">自适应（推荐，4.7+）</option>
                    <option value="budget">固定预算</option>
                </select>
                <br>
                <div id="ctc_adaptive_box">
                    <label for="ctc_effort">思考强度</label>
                    <select id="ctc_effort" class="text_pole">
                        <option value="low">低</option>
                        <option value="medium">中</option>
                        <option value="high">高</option>
                        <option value="xhigh">超高</option>
                        <option value="max">最大</option>
                    </select>
                    <small>自适应模式会注入 thinking.display=summarized、output_config.effort，并把温度设为 1。</small>
                </div>
                <div id="ctc_budget_box">
                    <label for="ctc_budget">思考预算 (tokens)</label>
                    <input type="number" id="ctc_budget" class="text_pole" min="1024" max="1000000" step="1024" value="16000" />
                    <small>最小 1024。固定预算模式下，max_tokens 会被自动调到大于此值。</small>
                </div>
                <br>
                <label for="ctc_regex">模型匹配（正则）</label>
                <input type="text" id="ctc_regex" class="text_pole" value="claude" />
                <small>只有模型名匹配此正则时才注入。默认匹配所有含 claude 的模型。</small>
            </div>
        </div>
    </div>
</div>`;

jQuery(async () => {
    $('#extensions_settings2').append(PANEL);
    loadUI();
    bindUI();
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
    console.info(TAG, '扩展已加载');
});
