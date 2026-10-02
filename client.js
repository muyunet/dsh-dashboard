/**
 * Client half of the usage dashboard: the sidebar entry and the panel.
 *
 * Styling follows the harness conventions: colours come only from the
 * `--dsw-alias-*` semantic tokens, so light and dark are handled by the token
 * layer and any change to that layer retints this panel with no code here. The
 * plugin's own custom properties hold geometry only. Styles are mounted through
 * one `<style data-plugin>` tag owned by `ctx.effect`, which is the pattern
 * every shipped UI package uses.
 *
 * @module @muyunet/dsh-dashboard/client
 */

window.__ModuleLoader__.load({
  id: '@muyunet/dsh-dashboard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /**
     * dsh's own React atoms, resolved from the module system's static table.
     *
     * Loading them cannot be allowed to fail the module: a throw here would cost
     * the whole client half — sidebar entry included — so an unavailable table
     * falls back to the plain elements below and the page still works, just
     * without the shipped look.
     */
    const primitives = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives');
      } catch {
        return null;
      }
    })();

    /** @param {object} props - forwarded to a native input. @returns {React.ReactElement} the control. */
    const Input = primitives?.Input ?? ((props) => h('input', { ...props, className: 'dshd-input' }));

    /**
     * @param {object} props - `id`, `value`, `options`, `onChange`, `label`, `disabled`.
     * @returns {React.ReactElement} the control.
     */
    const SegmentedControl =
      primitives?.SegmentedControl ??
      (({ value, options, onChange, disabled, label }) =>
        h(
          'select',
          {
            className: 'dshd-input',
            'aria-label': label,
            value,
            disabled,
            onChange: (event) => onChange(event.target.value),
          },
          options.map((option) => h('option', { key: option.value, value: option.value }, option.label ?? option.value)),
        ));

    /**
     * @param {object} props - `state`, `labels`, `onSave`, `onDiscard`, `children`.
     * @returns {React.ReactElement} the form frame.
     */
    const SettingsForm =
      primitives?.SettingsForm ??
      (({ labels, onSave, children }) =>
        h(
          'div',
          { className: 'dshd-config' },
          children,
          h(
            'div',
            { className: 'dshd-config-actions' },
            h('button', { type: 'button', className: 'dshd-btn is-primary', onClick: onSave }, labels?.save ?? 'Save'),
          ),
        ));

    /** Package identity; also the `data-plugin` marker on the injected stylesheet. */
    const PLUGIN_ID = '@muyunet/dsh-dashboard';
    /** Locale namespace owned by this plugin. */
    const NS = 'usage-dashboard';
    /** Sidebar entry id and `main` slot key: one id addresses both. */
    const PANEL_ID = 'dashboard';
    /**
     * Loader row id declared by this bundle's patch.
     *
     * The Plugins page keys a row's configuration page by
     * `<package name>#<row id>`, and dsh publishes the row's settings namespace
     * under the same row id — so this string has to match `cordis.patch.yml`
     * exactly or the page resolves to a namespace nobody serves.
     */
    const ROW_ID = 'usage-dashboard';
    /** Key the Plugins page dispatches a row's configuration page by. */
    const ROW_CONFIG_KEY = `${PLUGIN_ID}#${ROW_ID}`;
    /** Host route serving the snapshot. */
    const SNAPSHOT_URL = '/usage-dashboard/snapshot';
    /** Layout persistence key. */
    const LAYOUT_KEY = 'dsh-usage-dashboard:layout:v1';
    /**
     * Grid geometry shared by the renderer and the pointer math.
     *
     * Row gap is zero on purpose: with a gap, a span of `h` rows would measure
     * `h*rowHeight + (h-1)*gap`, so the same `h` would mean different heights
     * depending on how many rows a card crossed. A zero row gap makes one row
     * exactly `rowHeight` px and the pointer math linear; the visual gap comes
     * from the card being 12px shorter than the rows it spans.
     */
    const GRID = { columns: 12, rowHeight: 8, columnGap: 12, cardGap: 12 };
    /** Heatmap cell edge in pixels: the fallback size, and the clamp the fit uses. */
    const HEAT_CELL = 10;
    const HEAT_CELL_MIN = 5;
    const HEAT_CELL_MAX = 15;
    /** Gap between heatmap cells, in pixels. */
    const HEAT_GAP = 3;
    /** Smallest card height, in grid rows. */
    const MIN_CARD_ROWS = 8;
    /** Poll cadence, and the backoff ceiling after repeated failures. */
    const POLL_MS = 30000;
    const POLL_MAX_MS = 300000;
    /**
     * Loopback origins the snapshot may live on.
     *
     * An empty entry means "relative to the page", which is right when the shell
     * is served over http(s). The desktop shell is served from the `dsh-app://`
     * custom protocol instead, where a relative path resolves against that
     * protocol and never reaches the host's HTTP server — so that case retries
     * against loopback. The first origin that answers is remembered.
     */
    const SNAPSHOT_ORIGINS = ['', 'http://127.0.0.1:19387'];
    let snapshotOrigin = '';

    //#region styles

    const CSS = `
.dshd-root{
  --dshd-gap:${GRID.columnGap}px;
  --dshd-card-pad:16px;
  --dshd-cell:${HEAT_CELL}px;
  box-sizing:border-box;
  height:100%;
  width:100%;
  overflow:auto;
  padding:20px clamp(16px,3vw,32px) 40px;
  color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-base);
}
.dshd-root *,.dshd-root *::before,.dshd-root *::after{box-sizing:border-box}
.dshd-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 16px}
.dshd-toolbar-title{font-size:var(--dsw-font-l-20-font-size);line-height:var(--dsw-font-l-20-line-height);font-weight:var(--dsw-font-l-20-font-weight);margin:0 auto 0 0}
.dshd-btn{
  font:inherit;font-size:var(--dsw-font-xs-13-font-size);line-height:var(--dsw-font-xs-13-line-height);
  display:inline-flex;align-items:center;gap:6px;
  padding:5px 12px;border-radius:var(--dsw-radius-sm);
  border:.5px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  cursor:pointer;transition:background-color 120ms ease-out,border-color 120ms ease-out;
}
.dshd-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshd-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}
.dshd-btn[aria-pressed=true],.dshd-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);border-color:transparent}
.dshd-btn[aria-pressed=true]:hover,.dshd-btn-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.dshd-grid{display:grid;grid-template-columns:repeat(${GRID.columns},minmax(0,1fr));grid-auto-rows:${GRID.rowHeight}px;column-gap:var(--dshd-gap);row-gap:0;align-content:start}
.dshd-card{
  position:relative;display:flex;flex-direction:column;min-width:0;
  /* Scroll rather than clip: a card that is one row too short must not hide
     its own content silently. */
  overflow:auto;
  align-self:start;height:calc(100% - ${GRID.cardGap}px);
  padding:var(--dshd-card-pad);
  border-radius:var(--dsw-radius-lg);
  background:var(--dsw-alias-bg-layer-1);
  box-shadow:var(--dsw-elevation-panel);
  transition:box-shadow 120ms ease-out;
}
.dshd-card:hover{box-shadow:var(--dsw-elevation-soft)}
.dshd-card.is-editing{outline:1px dashed var(--dsw-alias-border-l2);outline-offset:2px}
.dshd-card.is-editing .dshd-card-head{padding-right:26px}
.dshd-card.is-dragging{box-shadow:var(--dsw-elevation-prominent);z-index:2}
.dshd-card-head{display:flex;align-items:center;gap:8px;flex:0 0 auto;margin:0 0 10px;min-height:20px}
.dshd-card-title{font-size:var(--dsw-font-xs-13-font-size);line-height:var(--dsw-font-xs-13-line-height);font-weight:var(--dsw-font-xxs-strong-12-font-weight);color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.dshd-card-head-spacer{margin-left:auto;display:flex;align-items:center;gap:6px}
.dshd-card-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:10px}
.dshd-grip{cursor:grab;display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary);touch-action:none}
.dshd-grip:active{cursor:grabbing}
.dshd-icon-btn{
  display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;
  border-radius:var(--dsw-radius-xs);border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;
}
.dshd-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshd-icon-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}
.dshd-resize{position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:nwse-resize;touch-action:none;color:var(--dsw-alias-label-tertiary);display:flex;align-items:flex-end;justify-content:flex-end}
.dshd-resize::after{content:"";width:8px;height:8px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;border-bottom-right-radius:3px}

.dshd-greeting-row{display:flex;align-items:center;gap:16px;flex:1;min-height:0}
.dshd-greeting-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:4px}
.dshd-greeting{font-size:var(--dsw-font-m-18-font-size);line-height:var(--dsw-font-m-18-line-height);font-weight:var(--dsw-font-m-18-font-weight);margin:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dshd-greeting-from{font-size:var(--dsw-font-xs-13-font-size);color:var(--dsw-alias-label-secondary);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* The action keeps its own width so a long greeting can never wrap its label. */
.dshd-greeting-action{flex:0 0 auto;white-space:nowrap;align-self:center}
.dshd-row{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}

.dshd-stat{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshd-stat-label{font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshd-stat-value{font-size:var(--dsw-font-m-18-font-size);line-height:var(--dsw-font-m-18-line-height);font-weight:var(--dsw-font-m-18-font-weight);font-variant-numeric:tabular-nums;white-space:nowrap}
.dshd-stat-value.is-xl{font-size:var(--dsw-font-xl-24-font-size);line-height:var(--dsw-font-xl-24-line-height)}
.dshd-stat-sub{font-size:var(--dsw-font-xxxs-11-font-size);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dshd-stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px 16px}

.dshd-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:var(--dsw-font-xxxs-11-font-size);line-height:16px;font-weight:var(--dsw-font-xxs-strong-12-font-weight)}
.dshd-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.dshd-badge.is-peak{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}
.dshd-badge.is-off{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}
.dshd-badge.is-quiet{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dshd-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxxs-11-font-size);line-height:16px}
.dshd-chip.is-warn{color:var(--dsw-alias-state-warn-primary)}
.dshd-chip.is-live{color:var(--dsw-alias-state-success-primary)}

.dshd-clock{font-size:var(--dsw-font-xl-24-font-size);line-height:var(--dsw-font-xl-24-line-height);font-weight:var(--dsw-font-xl-24-font-weight);font-variant-numeric:tabular-nums;letter-spacing:.02em}
.dshd-clock-note{font-size:var(--dsw-font-xxxs-11-font-size);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dshd-timeline{position:relative;height:22px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dshd-timeline-window{position:absolute;top:0;bottom:0;background:var(--dsw-alias-state-warn-tertiary)}
.dshd-timeline-now{position:absolute;top:0;bottom:0;width:2px;background:var(--dsw-alias-brand-primary)}

.dshd-heat-wrap{display:flex;flex-direction:row;align-items:center;gap:18px;flex:1;min-height:0}
.dshd-heat-left{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:8px;justify-content:center}
.dshd-heat-scroll{overflow:hidden;display:flex;justify-content:flex-start}
.dshd-heat-grid{display:grid;grid-auto-flow:column;width:max-content}
.dshd-heat-cell{width:100%;height:100%;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-2);border:.5px solid transparent}
.dshd-heat-cell.is-out{background:transparent;border-color:transparent}
.dshd-heat-cell.l0{background:var(--dsw-alias-bg-layer-2)}
.dshd-heat-cell.l1{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.dshd-heat-cell.l2{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent)}
.dshd-heat-cell.l3{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 66%,transparent)}
.dshd-heat-cell.l4{background:var(--dsw-alias-brand-primary)}
.dshd-heat-cell.is-hover{outline:2px solid var(--dsw-focus-ring-color);outline-offset:0}
.dshd-heat-panel{
  flex:0 0 auto;width:158px;display:flex;flex-direction:column;gap:8px;
  padding-left:18px;border-left:.5px solid var(--dsw-alias-border-l1);align-self:stretch;justify-content:center;
}
.dshd-heat-panel-date{font-size:var(--dsw-font-s-14-font-size);font-weight:var(--dsw-font-xxs-strong-12-font-weight);font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);min-height:20px}
.dshd-heat-stat{display:flex;flex-direction:column;gap:1px}
.dshd-heat-stat-label{font-size:var(--dsw-font-xxxs-11-font-size);color:var(--dsw-alias-label-secondary)}
.dshd-heat-stat-value{font-size:var(--dsw-font-m-18-font-size);line-height:var(--dsw-font-m-18-line-height);font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dshd-heat-legend{display:flex;align-items:center;gap:6px;font-size:var(--dsw-font-xxxs-11-font-size);color:var(--dsw-alias-label-secondary)}
.dshd-heat-legend .dshd-heat-cell{width:10px;height:10px;flex:0 0 auto}

.dshd-bar{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dshd-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary)}
.dshd-bar-fill.is-warn{background:var(--dsw-alias-state-warn-primary)}
.dshd-bar-fill.is-ok{background:var(--dsw-alias-state-success-primary)}
.dshd-bar-fill.is-danger{background:var(--dsw-alias-state-error-primary)}

.dshd-table{display:flex;flex-direction:column;gap:2px;min-height:0}
.dshd-table-row{display:grid;grid-template-columns:56px 1fr 1fr 1fr;gap:8px;align-items:baseline;padding:5px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dshd-table-row:last-child{border-bottom:none}
.dshd-table-head{font-size:var(--dsw-font-xxxs-11-font-size);color:var(--dsw-alias-label-secondary)}
.dshd-table-row.is-head{padding-bottom:2px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshd-cell-num{font-variant-numeric:tabular-nums;font-size:var(--dsw-font-s-14-font-size)}
.dshd-cell-dim{color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xs-13-font-size)}
.dshd-delta{font-size:var(--dsw-font-xxxs-11-font-size);font-variant-numeric:tabular-nums}
.dshd-delta.is-up{color:var(--dsw-alias-state-warn-primary)}
.dshd-delta.is-down{color:var(--dsw-alias-state-success-primary)}
.dshd-delta.is-flat{color:var(--dsw-alias-label-secondary)}

.dshd-model-row{display:grid;grid-template-columns:1fr auto;gap:4px 10px;align-items:baseline}
.dshd-model-name{font-size:var(--dsw-font-xs-13-font-size);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshd-model-fig{font-size:var(--dsw-font-xs-13-font-size);font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dshd-model-bar{grid-column:1/-1}

.dshd-svg{width:100%;height:100%;display:block;min-height:0}
.dshd-empty{display:flex;align-items:center;justify-content:center;flex:1;color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xs-13-font-size)}
.dshd-error{display:flex;flex-direction:column;gap:8px;align-items:flex-start;justify-content:center;flex:1;color:var(--dsw-alias-state-error-primary);font-size:var(--dsw-font-xs-13-font-size)}
.dshd-link{color:var(--dsw-alias-link);text-decoration:none;font-size:var(--dsw-font-xs-13-font-size)}
.dshd-link:hover{text-decoration:underline}
.dshd-note{font-size:var(--dsw-font-xxxs-11-font-size);color:var(--dsw-alias-label-secondary);line-height:16px}

.dshd-vis-list{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0 0 14px;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.dshd-vis-item{display:inline-flex;align-items:center;gap:6px;font-size:var(--dsw-font-xs-13-font-size)}
.dshd-vis-item input{accent-color:var(--dsw-alias-brand-primary)}
.dshd-import{display:flex;flex-direction:column;gap:8px;margin:0 0 14px;padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.dshd-import textarea{
  font:inherit;font-family:var(--dsw-font-markdown-code-font-family);font-size:var(--dsw-font-xxs-12-font-size);
  min-height:88px;resize:vertical;padding:8px;border-radius:var(--dsw-radius-sm);
  border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
}
.dshd-import textarea:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}
.dshd-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

/* Configuration page the Plugins page opens for this bundle's row. It renders
   outside the panel, so it carries its own layout rather than the grid's. */
.dshd-config{display:flex;flex-direction:column;gap:16px;padding:4px 0 8px;max-width:640px}
.dshd-config-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px 20px}
.dshd-config-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dshd-config-label{font-size:var(--dsw-font-xs-13-font-size);color:var(--dsw-alias-label-primary);font-weight:var(--dsw-font-xxs-strong-12-font-weight)}
.dshd-config-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
/* Narrow window: the twelve-column canvas stops being readable, so every card
   takes the full width and its own natural height instead. The declarations are
   important because the span is set inline per card, which a media query cannot
   otherwise override. */
@media (max-width:900px){
  .dshd-root{padding:16px 12px 32px}
  .dshd-grid{grid-template-columns:minmax(0,1fr);grid-auto-rows:auto;row-gap:var(--dshd-gap)}
  .dshd-card{grid-column:1/-1!important;grid-row:auto!important;height:auto;min-height:140px}
  .dshd-heat-wrap{flex-direction:column;align-items:stretch;gap:12px}
  .dshd-heat-scroll{overflow-x:auto;justify-content:flex-start}
  .dshd-heat-panel{width:auto;flex-direction:row;flex-wrap:wrap;align-items:baseline;gap:14px;padding:10px 0 0;border-left:0;border-top:.5px solid var(--dsw-alias-border-l1)}
  .dshd-heat-panel-date{flex:1 0 100%}
}
@media (prefers-reduced-motion:reduce){
  .dshd-root *{transition:none!important;animation:none!important}
}
`;

    /**
     * Mount the plugin stylesheet for exactly the owning plugin lifetime.
     * @param {object} ctx - the plugin context.
     */
    function installStyles(ctx) {
      if (typeof document === 'undefined') return;
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = PLUGIN_ID;
        tag.dataset.pluginCss = `${PLUGIN_ID}/dashboard.css`;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'usage-dashboard: dashboard stylesheet');
    }

    //#endregion

    //#region locale

    const zh = {
      panel: '数据看板',
      'config.summary': '欢迎语、热力图、峰谷、用量与余额',
      'config.summaryBudget': '预算模式，总额 {amount}',
      'config.save': '保存',
      'config.saving': '保存中…',
      'config.saved': '已保存',
      'config.saveFailed': '保存失败',
      'config.readOnly': '当前无法写入配置',
      'config.unavailable': '配置尚未就绪',
      'config.budgetTotal': '预算总额',
      'config.budgetTotal.hint': '单位元。0 表示不使用预算模式',
      'config.baselineCost': '安装前已花费',
      'config.baselineCost.hint': '单位元，预算模式下会加到已用金额里',
      'config.currencySymbol': '金额符号',
      'config.currencySymbol.hint': '例如 ¥ 或 $',
      'config.currency': '币种代码',
      'config.currency.hint': '用于匹配平台钱包',
      'config.balanceRefreshSeconds': '余额刷新间隔',
      'config.balanceRefreshSeconds.hint': '余额接口读不到时会在每次轮询重试',
      'config.balanceRefreshSeconds.unit': '{value} 秒',
      'config.fallbackModel': '兜底模型',
      'config.fallbackModel.hint': '日志里认不出模型名时按它的价格计算',
      'config.holidays': '法定节假日',
      'config.holidays.hint': '逗号分隔的 YYYY-MM-DD，填了之后峰谷判定会排除这些日期',
      'config.refreshHours': '价格抓取间隔',
      'config.refreshHours.hint': '从官方价格文档重新抓取的间隔',
      'config.refreshHours.unit': '{value} 小时',
      'config.pricingUrl': '价格文档地址',
      'config.pricingUrl.hint': '官方价格页 URL',
      'greeting.change': '换一条',
      'greeting.from': '—— {from}',
      'greeting.pending': '正在获取…',
      'heatmap.title': 'DSH 热力图',
      'heatmap.less': '少',
      'heatmap.more': '多',
      'heatmap.cell': '{date}：{tokens} tokens · {cost}',
      'heatmap.busiest': '峰值 {date}',
      'heatmap.tokens': 'Token',
      'heatmap.cost': '花费',
      'heatmap.range': '近 {days} 天',
      'heatmap.hoverHint': '悬停任意格子查看当天数据',
      'heatmap.exact': '精确 {tokens} tokens',
      'peak.title': '峰谷时段',
      'peak.peak': '高峰时段',
      'peak.off': '空闲时段',
      'peak.beijing': '北京时间',
      'peak.local': '本地时间',
      'peak.next': '距切到{bucket}还有 {time}',
      'peak.window': '高峰 {start}–{end}',
      'peak.holidayOn': '已配置节假日 {count} 个',
      'peak.holidayOff': '未配置节假日',
      'peak.holidayHint': '未配置节假日表时，峰谷按周一至周五判断',
      'periods.title': '用量与花费',
      'periods.period': '周期',
      'periods.tokens': 'Token',
      'periods.cost': '花费',
      'periods.calls': '请求',
      'periods.cacheHit': '缓存命中',
      'periods.day': '今日',
      'periods.week': '本周',
      'periods.month': '本月',
      'periods.year': '本年',
      'periods.vsPrev': '较上期',
      'balance.title': '剩余金额',
      'balance.topUp': '充值余额',
      'balance.bonus': '赠金余额',
      'balance.total': '合计',
      'balance.usable': '余额充足',
      'balance.insufficient': '余额不足',
      'balance.usage': '查看平台用量',
      'balance.topUpLink': '去充值',
      'balance.budgetMode': '预算模式',
      'balance.budgetSpent': '已用 {spent} / {total}',
      'balance.budgetLeft': '剩余',
      'balance.spentMonth': '本月已花费',
      'balance.notSet': '未设置',
      'balance.unavailable': '余额不可用',
      'balance.budgetHint': '想用预算模式：在本插件配置里设置 budgetTotal（预算总额）和 baselineCost（安装前已花费）',
      'balance.reason.signed-out': '未登录，无法读取余额',
      'balance.reason.not-read-yet': '正在读取余额…',
      'balance.reason.balance-failed': '余额读取失败，已回退预算模式',
      'balance.reason.account-service-unavailable': '账户服务不可用，已回退预算模式',
      'reconcile.title': '平台核对',
      'reconcile.platform': '平台侧消耗',
      'reconcile.ledger': '本地账本',
      'reconcile.deviation': '偏差',
      'reconcile.topUps': '本期充值 {count} 次，共 {amount}',
      'reconcile.note': '平台余额差含其他客户端用量与充值，仅作交叉参考',
      'reconcile.pending': '等待余额数据',
      'reconcile.pendingDelta': '等待差值',
      'reconcile.deltaNote': '余额已读到，但平台侧还需要两次采样才能算出花费差值；本地账本金额是准确的',
      'reconcile.waitingNote': '读不到账户余额，无法与平台侧核对；本地账本金额仍然准确',
      'trend.title': '近 30 日成本',
      'trend.max': '峰值 {cost}',
      'models.title': '模型分布（本月）',
      'models.empty': '本月还没有用量',
      'today.title': '今日概览',
      'today.requests': '请求次数',
      'today.avgPrice': '平均单价',
      'today.avgPriceUnit': '{value} / 百万 token',
      'today.forecast': '月末预测',
      'today.since': '数据起始',
      'today.sources': '数据来源',
      'today.pricingLive': '价格：实时',
      'pricing.warn.unreachable': '暂时读不到官方价格页，正在使用内置价格表；联网后会自动更新',
      'pricing.warn.truncated': '官方价格页没有读到完整表格，正在使用内置价格表',
      'pricing.warn.invalid': '官方价格页没有通过校验，正在使用内置价格表',
      'today.pricingBuiltin': '价格：内置表',
      'today.balanceLive': '余额：实时',
      'today.balanceBudget': '余额：预算',
      'today.netOk': '实时通道正常',
      'today.netDown': '实时通道受限',
      'today.unknownModels': '未识别模型：{models}',
      'layout.edit': '编辑布局',
      'layout.done': '完成',
      'layout.reset': '重置布局',
      'layout.export': '导出布局',
      'layout.import': '导入布局',
      'layout.copied': '已复制到剪贴板',
      'layout.apply': '应用',
      'layout.cancel': '取消',
      'layout.invalid': '布局 JSON 无效',
      'layout.hint': '拖动标题移动，拖动右下角缩放；方向键微调，Shift + 方向键缩放',
      'layout.showCards': '显示卡片',
      'layout.hide': '隐藏 {title}',
      'layout.drag': '移动 {title}',
      'layout.resize': '缩放 {title}',
      'common.loading': '正在读取数据…',
      'common.failed': '数据读取失败',
      'common.retry': '重试',
      'common.stale': '数据可能已过期',
      'common.emptyDay': '暂无数据',
      'common.days': '{count} 天',
    };

    const en = {
      panel: 'Usage dashboard',
      'config.summary': 'Greeting, heatmap, peak hours, usage and balance',
      'config.summaryBudget': 'Budget mode, {amount} total',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'config.saved': 'Saved',
      'config.saveFailed': 'Save failed',
      'config.readOnly': 'Configuration is not writable right now',
      'config.unavailable': 'Configuration is not ready yet',
      'config.budgetTotal': 'Total budget',
      'config.budgetTotal.hint': 'In yuan. 0 turns budget mode off',
      'config.baselineCost': 'Spent before install',
      'config.baselineCost.hint': 'In yuan; added to spend in budget mode',
      'config.currencySymbol': 'Currency symbol',
      'config.currencySymbol.hint': 'For example ¥ or $',
      'config.currency': 'Currency code',
      'config.currency.hint': 'Matches the platform wallet',
      'config.balanceRefreshSeconds': 'Balance refresh interval',
      'config.balanceRefreshSeconds.hint': 'Retried on every poll while the balance is unreadable',
      'config.balanceRefreshSeconds.unit': '{value}s',
      'config.fallbackModel': 'Fallback model',
      'config.fallbackModel.hint': 'Priced as this when a log names no known model',
      'config.holidays': 'Statutory holidays',
      'config.holidays.hint': 'Comma-separated YYYY-MM-DD; peak windows then skip these dates',
      'config.refreshHours': 'Pricing refresh interval',
      'config.refreshHours.hint': 'Hours between refetches of the official pricing page',
      'config.refreshHours.unit': '{value}h',
      'config.pricingUrl': 'Pricing page URL',
      'config.pricingUrl.hint': 'The official pricing document',
      'greeting.change': 'Another',
      'greeting.from': '— {from}',
      'greeting.pending': 'Loading…',
      'heatmap.title': 'DSH heatmap',
      'heatmap.less': 'Less',
      'heatmap.more': 'More',
      'heatmap.cell': '{date}: {tokens} tokens · {cost}',
      'heatmap.busiest': 'peak {date}',
      'heatmap.tokens': 'Tokens',
      'heatmap.cost': 'Cost',
      'heatmap.range': 'last {days} days',
      'heatmap.hoverHint': 'Hover a square for that day',
      'heatmap.exact': 'exactly {tokens} tokens',
      'peak.title': 'Peak / off-peak',
      'peak.peak': 'Peak hours',
      'peak.off': 'Off-peak',
      'peak.beijing': 'Beijing time',
      'peak.local': 'Local time',
      'peak.next': '{time} until {bucket}',
      'peak.window': 'Peak {start}–{end}',
      'peak.holidayOn': '{count} holidays configured',
      'peak.holidayOff': 'No holidays configured',
      'peak.holidayHint': 'Without a holiday list, peak hours assume Monday to Friday',
      'periods.title': 'Usage and spend',
      'periods.period': 'Period',
      'periods.tokens': 'Tokens',
      'periods.cost': 'Spend',
      'periods.calls': 'Calls',
      'periods.cacheHit': 'Cache hit',
      'periods.day': 'Today',
      'periods.week': 'This week',
      'periods.month': 'This month',
      'periods.year': 'This year',
      'periods.vsPrev': 'vs previous',
      'balance.title': 'Remaining balance',
      'balance.topUp': 'Topped up',
      'balance.bonus': 'Granted',
      'balance.total': 'Total',
      'balance.usable': 'Balance sufficient',
      'balance.insufficient': 'Insufficient balance',
      'balance.usage': 'View usage on Platform',
      'balance.topUpLink': 'Top up',
      'balance.budgetMode': 'Budget mode',
      'balance.budgetSpent': 'Spent {spent} of {total}',
      'balance.budgetLeft': 'Remaining',
      'balance.spentMonth': 'Spent this month',
      'balance.notSet': 'not set',
      'balance.unavailable': 'Balance unavailable',
      'balance.budgetHint': 'For budget mode, set budgetTotal and baselineCost in this plugin\'s config',
      'balance.reason.signed-out': 'Signed out, no balance available',
      'balance.reason.not-read-yet': 'Reading balance…',
      'balance.reason.balance-failed': 'Balance read failed, using budget mode',
      'balance.reason.account-service-unavailable': 'Account service unavailable, using budget mode',
      'reconcile.title': 'Platform check',
      'reconcile.platform': 'Platform spend',
      'reconcile.ledger': 'Local ledger',
      'reconcile.deviation': 'Deviation',
      'reconcile.topUps': '{count} top-ups this month, {amount} total',
      'reconcile.note': 'Platform deltas include other clients and top-ups; a cross-check only',
      'reconcile.pending': 'waiting for balance',
      'reconcile.pendingDelta': 'waiting for a delta',
      'reconcile.deltaNote': 'The balance was read, but the platform side needs two samples before it can show a spend delta; the local ledger figure is exact',
      'reconcile.waitingNote': 'No account balance available, so the platform side cannot be compared; the local ledger figure is still exact',
      'trend.title': 'Spend, last 30 days',
      'trend.max': 'Peak {cost}',
      'models.title': 'Models this month',
      'models.empty': 'No usage this month yet',
      'today.title': 'Today',
      'today.requests': 'Requests',
      'today.avgPrice': 'Average price',
      'today.avgPriceUnit': '{value} / 1M tokens',
      'today.forecast': 'Month-end forecast',
      'today.since': 'Data since',
      'today.sources': 'Sources',
      'today.pricingLive': 'Pricing: live',
      'pricing.warn.unreachable': 'The official pricing page is unreachable right now, so the built-in table is in use; it updates automatically once the network returns',
      'pricing.warn.truncated': 'The official pricing page did not contain a complete table, so the built-in table is in use',
      'pricing.warn.invalid': 'The official pricing page failed validation, so the built-in table is in use',
      'today.pricingBuiltin': 'Pricing: built-in',
      'today.balanceLive': 'Balance: live',
      'today.balanceBudget': 'Balance: budget',
      'today.netOk': 'Live channels OK',
      'today.netDown': 'Live channels limited',
      'today.unknownModels': 'Unpriced models: {models}',
      'layout.edit': 'Edit layout',
      'layout.done': 'Done',
      'layout.reset': 'Reset layout',
      'layout.export': 'Export layout',
      'layout.import': 'Import layout',
      'layout.copied': 'Copied to clipboard',
      'layout.apply': 'Apply',
      'layout.cancel': 'Cancel',
      'layout.invalid': 'Invalid layout JSON',
      'layout.hint': 'Drag a title to move, drag the corner to resize; arrow keys nudge, Shift + arrows resize',
      'layout.showCards': 'Visible cards',
      'layout.hide': 'Hide {title}',
      'layout.drag': 'Move {title}',
      'layout.resize': 'Resize {title}',
      'common.loading': 'Loading…',
      'common.failed': 'Could not read data',
      'common.retry': 'Retry',
      'common.stale': 'Data may be stale',
      'common.emptyDay': 'No data',
      'common.days': '{count} days',
    };

    /** Fallback translator, replaced by the locale-bound one inside `apply`. */
    let translate = (key) => key;

    /**
     * Interpolate `{name}` placeholders.
     * @param {string} template - the dictionary entry.
     * @param {Record<string, unknown>} [params] - substitution values.
     * @returns {string} the rendered text.
     */
    function interpolate(template, params) {
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    /**
     * Translate a dashboard key.
     * @param {string} key - the dictionary key.
     * @param {Record<string, unknown>} [params] - substitution values.
     * @returns {string} the localized text.
     */
    function t(key, params) {
      const table = translate(key);
      return interpolate(table === key ? (zh[key] ?? key) : table, params);
    }

    /**
     * Report a client-side registration failure.
     *
     * A throw during `apply` is otherwise silent: the browser console is the
     * only witness, and there is no host-side trace at all. This logs it and
     * best-effort posts it to the host so the failure is visible from outside
     * the page.
     *
     * @param {object} ctx - the client plugin context.
     * @param {string} step - which step failed.
     * @param {unknown} error - the thrown value.
     */
    function reportClientFailure(ctx, step, error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        ctx.logger?.error?.(`usage-dashboard: ${step} failed: ${message}`);
      } catch {
        // Logging is optional.
      }
      try {
        console.error(`usage-dashboard: ${step} failed`, error);
      } catch {
        // The console may not exist in every embedding.
      }
      try {
        const detail = encodeURIComponent(`${step}: ${message}`.slice(0, 300));
        void fetch(`${snapshotOrigin}/usage-dashboard/client-report?detail=${detail}`, { mode: 'no-cors' });
      } catch {
        // Reporting is best-effort and must never mask the original failure.
      }
    }

    //#endregion

    //#region formatting

    /**
     * Compact a token count for a headline figure.
     * @param {number} value - the count.
     * @returns {string} the compact text.
     */
    function compactCount(value) {
      if (!Number.isFinite(value)) return '—';
      const abs = Math.abs(value);
      if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
      if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
      if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
      return String(Math.round(value));
    }

    /**
     * Group-separate an exact count.
     * @param {number} value - the count.
     * @returns {string} the formatted text.
     */
    function exactCount(value) {
      if (!Number.isFinite(value)) return '—';
      return Math.round(value).toLocaleString('en-US');
    }

    /**
     * Format money, keeping sub-cent precision visible on small amounts.
     * @param {number} value - the amount.
     * @param {string} symbol - the currency symbol.
     * @returns {string} the formatted amount.
     */
    function formatMoney(value, symbol) {
      if (!Number.isFinite(value)) return '—';
      const digits = Math.abs(value) < 1 ? 4 : 2;
      return `${symbol}${value.toFixed(digits)}`;
    }

    /**
     * Format a duration in milliseconds as a countdown.
     * @param {number} ms - the remaining duration.
     * @returns {string} `H小时M分` / `M分S秒` style text.
     */
    function formatDuration(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
      if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
      return `${seconds}s`;
    }

    /**
     * Format an instant as `HH:MM:SS` in the given offset.
     * @param {number} epochMs - the instant.
     * @param {number} offsetMinutes - minutes east of UTC.
     * @returns {string} the clock text.
     */
    function formatClock(epochMs, offsetMinutes) {
      const shifted = new Date(epochMs + offsetMinutes * 60000);
      const pad = (value) => String(value).padStart(2, '0');
      return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
    }

    /**
     * Format a date key as `M月D日`.
     * @param {string} dateKey - `YYYY-MM-DD`.
     * @returns {string} the short date.
     */
    function shortDate(dateKey) {
      const [, month, day] = dateKey.split('-');
      return `${Number(month)}/${Number(day)}`;
    }

    /**
     * The signed percentage change between two values.
     * @param {number} current - the current value.
     * @param {number} previous - the previous value.
     * @returns {number | null} the change, or `null` when it cannot be expressed.
     */
    function deltaPercent(current, previous) {
      if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
      return ((current - previous) / previous) * 100;
    }

    /**
     * Quartile thresholds separating the heatmap's five intensity levels.
     * @param {Array<{ tokens: number }>} days - the series.
     * @returns {number[]} four ascending thresholds.
     */
    function heatThresholds(days) {
      const positive = days
        .map((day) => day.tokens)
        .filter((value) => value > 0)
        .sort((a, b) => a - b);
      if (positive.length === 0) return [0, 0, 0, 0];
      const at = (fraction) => positive[Math.min(positive.length - 1, Math.floor(fraction * positive.length))];
      return [at(0.25), at(0.5), at(0.75), at(0.95)];
    }

    /**
     * Bucket one day into a heatmap level.
     * @param {number} tokens - the day's tokens.
     * @param {number[]} thresholds - the quartile thresholds.
     * @returns {0 | 1 | 2 | 3 | 4} the intensity level.
     */
    function heatLevel(tokens, thresholds) {
      if (!(tokens > 0)) return 0;
      if (tokens <= thresholds[0]) return 1;
      if (tokens <= thresholds[1]) return 2;
      if (tokens <= thresholds[2]) return 3;
      return 4;
    }

    /**
     * Split `HH:MM` into minutes after midnight.
     * @param {string} value - the boundary.
     * @returns {number} minutes after midnight.
     */
    function minutesOf(value) {
      const [hours, minutes] = String(value).split(':').map(Number);
      return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
    }

    //#endregion

    //#region data

    /**
     * Poll the host snapshot, refreshing on focus and backing off on failure.
     * @returns {{ snapshot: object | null, error: string | null, stale: boolean, reload: () => void }}
     *   the latest snapshot and its fetch state.
     */
    function useSnapshot() {
      const [snapshot, setSnapshot] = useState(null);
      const [error, setError] = useState(null);
      const [stale, setStale] = useState(false);
      const timerRef = useRef(null);
      const delayRef = useRef(POLL_MS);
      const aliveRef = useRef(true);

      const load = useCallback(async (freshGreeting) => {
        const query = freshGreeting === true ? `?fresh=greeting&_=${Date.now()}` : '';
        // Never carry a failed origin forward: try the remembered one first,
        // then the others, and keep whichever answers.
        const candidates = [snapshotOrigin, ...SNAPSHOT_ORIGINS.filter((origin) => origin !== snapshotOrigin)];
        let lastFailure = null;
        for (const origin of candidates) {
          const controller = new AbortController();
          try {
            const response = await fetch(`${origin}${SNAPSHOT_URL}${query}`, {
              signal: controller.signal,
              headers: { accept: 'application/json' },
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            snapshotOrigin = origin;
            if (!aliveRef.current) return;
            setSnapshot(payload);
            setError(null);
            setStale(false);
            delayRef.current = POLL_MS;
            return;
          } catch (failure) {
            lastFailure = failure;
          } finally {
            controller.abort();
          }
        }
        if (!aliveRef.current) return;
        if (lastFailure instanceof Error && lastFailure.name === 'AbortError') return;
        setError(lastFailure instanceof Error ? lastFailure.message : String(lastFailure));
        setStale(true);
        delayRef.current = Math.min(POLL_MAX_MS, Math.max(POLL_MS, delayRef.current * 2));
      }, []);

      useEffect(() => {
        aliveRef.current = true;
        void load(false);
        const schedule = () => {
          timerRef.current = setTimeout(() => {
            if (!aliveRef.current) return;
            void load(false).finally(schedule);
          }, delayRef.current);
        };
        schedule();
        const onFocus = () => {
          delayRef.current = POLL_MS;
          void load(false);
        };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onFocus);
        return () => {
          aliveRef.current = false;
          if (timerRef.current !== null) clearTimeout(timerRef.current);
          window.removeEventListener('focus', onFocus);
          document.removeEventListener('visibilitychange', onFocus);
        };
      }, [load]);

      const reload = useCallback(() => void load(false), [load]);
      return { snapshot, error, stale, reload, changeGreeting: useCallback(() => void load(true), [load]) };
    }

    /**
     * A ticking clock, one second at a time, so the countdown does not need the
     * host polled any faster.
     * @returns {number} the current instant.
     */
    function useNow() {
      const [now, setNow] = useState(() => Date.now());
      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, []);
      return now;
    }

    //#endregion

    //#region primitives

    /**
     * A card shell: title row plus body.
     * @param {{ title?: string, actions?: React.ReactNode, children?: React.ReactNode }} props - the card contents.
     * @returns {React.ReactElement} the card body markup.
     */
    function CardBody({ title, actions, children }) {
      return h(
        React.Fragment,
        null,
        h('div', { className: 'dshd-card-head' }, title === undefined ? null : h('span', { className: 'dshd-card-title' }, title), h('span', { className: 'dshd-card-head-spacer' }, actions)),
        h('div', { className: 'dshd-card-body' }, children),
      );
    }

    /**
     * A labelled figure.
     * @param {{ label: string, value: string, sub?: string, large?: boolean }} props - the figure.
     * @returns {React.ReactElement} the figure markup.
     */
    function Stat({ label, value, sub, large }) {
      return h(
        'div',
        { className: 'dshd-stat' },
        h('span', { className: 'dshd-stat-label' }, label),
        h('span', { className: large === true ? 'dshd-stat-value is-xl' : 'dshd-stat-value' }, value),
        sub === undefined ? null : h('span', { className: 'dshd-stat-sub' }, sub),
      );
    }

    /**
     * A signed change chip.
     * @param {{ value: number | null }} props - the percentage change.
     * @returns {React.ReactElement | null} the chip, or nothing when the change is unknown.
     */
    function Delta({ value }) {
      if (value === null || !Number.isFinite(value)) return null;
      const tone = Math.abs(value) < 0.5 ? 'is-flat' : value > 0 ? 'is-up' : 'is-down';
      const sign = value > 0 ? '+' : '';
      return h('span', { className: `dshd-delta ${tone}` }, `${sign}${value.toFixed(1)}%`);
    }

    /**
     * A progress bar.
     * @param {{ ratio: number, tone?: string }} props - the filled fraction and tone.
     * @returns {React.ReactElement} the bar markup.
     */
    function Bar({ ratio, tone }) {
      const width = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0)) * 100;
      return h('div', { className: 'dshd-bar' }, h('div', { className: `dshd-bar-fill${tone === undefined ? '' : ` ${tone}`}`, style: { width: `${width}%` } }));
    }

    //#endregion

    //#region cards

    /**
     * The greeting card.
     * @param {{ snapshot: object, onChange: () => void }} props - the snapshot and the refresh trigger.
     * @returns {React.ReactElement} the card.
     */
    function GreetingCard({ snapshot, onChange }) {
      const greeting = snapshot.greeting ?? {};
      const from = greeting.fromWho ?? greeting.from;
      // One row: the greeting takes the space it needs and the button keeps its
      // own width on the right. The button never wraps, so a long greeting can
      // no longer push its label onto a second line.
      return h(
        'div',
        { className: 'dshd-greeting-row' },
        h(
          'div',
          { className: 'dshd-greeting-main' },
          h('p', { className: 'dshd-greeting' }, greeting.text === '' || greeting.text === undefined ? t('greeting.pending') : greeting.text),
          from === null || from === undefined || from === '' ? null : h('p', { className: 'dshd-greeting-from' }, t('greeting.from', { from })),
        ),
        h('button', { type: 'button', className: 'dshd-btn dshd-greeting-action', onClick: onChange }, t('greeting.change')),
      );
    }

    /**
     * The GitHub-style contribution heatmap over daily token usage.
     * @param {{ snapshot: object }} props - the snapshot.
     * @returns {React.ReactElement} the card.
     */
    function HeatmapCard({ snapshot }) {
      const days = snapshot.series?.days ?? [];
      const symbol = snapshot.currencySymbol ?? '¥';
      const [hover, setHover] = useState(null);
      const [cell, setCell] = useState(HEAT_CELL);
      const scrollRef = useRef(null);
      const thresholds = useMemo(() => heatThresholds(days), [days]);

      const { cells, totals } = useMemo(() => {
        if (days.length === 0) return { cells: [], totals: { tokens: 0, cost: 0 } };
        // Pad the head so the first column starts on a Monday, matching the
        // Monday-to-Friday working week the pricing page defines.
        const firstWeekday = new Date(`${days[0].date}T00:00:00Z`).getUTCDay();
        const lead = (firstWeekday + 6) % 7;
        const padded = [...Array(lead).fill(null), ...days];
        let tokens = 0;
        let cost = 0;
        for (const day of days) {
          tokens += day.tokens;
          cost += day.cost;
        }
        return { cells: padded, totals: { tokens, cost } };
      }, [days]);

      const weeks = Math.ceil(cells.length / 7);

      // Size the squares from the space actually available, so the grid fills
      // its card instead of sitting at a fixed size with dead space beneath it.
      useEffect(() => {
        const element = scrollRef.current;
        if (element === null) return undefined;
        /** @returns {void} */
        const measure = () => {
          const width = element.clientWidth;
          if (width <= 0 || weeks <= 0) return;
          const gap = HEAT_GAP;
          const next = Math.floor((width - (weeks - 1) * gap) / weeks);
          setCell(Math.max(HEAT_CELL_MIN, Math.min(HEAT_CELL_MAX, next)));
        };
        measure();
        if (typeof ResizeObserver !== 'function') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
      }, [weeks]);

      const busiest = useMemo(() => days.reduce((best, day) => (day.tokens > (best?.tokens ?? -1) ? day : best), null), [days]);

      return h(
        CardBody,
        { title: t('heatmap.title') },
        h(
          'div',
          { className: 'dshd-heat-wrap', onMouseLeave: () => setHover(null) },
          h(
            'div',
            { className: 'dshd-heat-left' },
            h(
              'div',
              { className: 'dshd-heat-scroll', ref: scrollRef },
              h(
                'div',
                {
                  className: 'dshd-heat-grid',
                  style: {
                    gridTemplateRows: `repeat(7, ${cell}px)`,
                    gridAutoColumns: `${cell}px`,
                    gap: `${HEAT_GAP}px`,
                  },
                },
                cells.map((day, index) =>
                  day === null
                    ? h('div', { key: `pad-${index}`, className: 'dshd-heat-cell is-out' })
                    : h('div', {
                        key: day.date,
                        className: `dshd-heat-cell l${heatLevel(day.tokens, thresholds)}${hover?.date === day.date ? ' is-hover' : ''}`,
                        onMouseEnter: () => setHover(day),
                        title: t('heatmap.cell', { date: day.date, tokens: exactCount(day.tokens), cost: formatMoney(day.cost, symbol) }),
                      }),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dshd-heat-legend' },
              h('span', null, t('heatmap.less')),
              h('span', { className: 'dshd-heat-cell l0' }),
              h('span', { className: 'dshd-heat-cell l1' }),
              h('span', { className: 'dshd-heat-cell l2' }),
              h('span', { className: 'dshd-heat-cell l3' }),
              h('span', { className: 'dshd-heat-cell l4' }),
              h('span', null, t('heatmap.more')),
              busiest === null || busiest.tokens === 0 ? null : h('span', { className: 'dshd-note' }, `· ${t('heatmap.busiest', { date: busiest.date })}`),
            ),
          ),
          // The hovered day reports beside the grid, so the figures never move
          // and the grid keeps its own width.
          h(
            'div',
            { className: 'dshd-heat-panel' },
            h('div', { className: 'dshd-heat-panel-date' }, hover === null ? t('heatmap.range', { days: days.length }) : hover.date),
            h(
              'div',
              { className: 'dshd-heat-stat' },
              h('span', { className: 'dshd-heat-stat-label' }, t('heatmap.tokens')),
              h('span', { className: 'dshd-heat-stat-value' }, compactCount(hover === null ? totals.tokens : hover.tokens)),
            ),
            h(
              'div',
              { className: 'dshd-heat-stat' },
              h('span', { className: 'dshd-heat-stat-label' }, t('heatmap.cost')),
              h('span', { className: 'dshd-heat-stat-value' }, formatMoney(hover === null ? totals.cost : hover.cost, symbol)),
            ),
            h('div', { className: 'dshd-note' }, hover === null ? t('heatmap.hoverHint') : t('heatmap.exact', { tokens: exactCount(hover.tokens) })),
          ),
          h('span', { className: 'dshd-sr' }, `${weeks} weeks`),
        ),
      );
    }

    /**
     * The peak/off-peak card: clock, bucket, countdown and the day's windows.
     * @param {{ snapshot: object, now: number }} props - the snapshot and the ticking instant.
     * @returns {React.ReactElement} the card.
     */
    function PeakCard({ snapshot, now }) {
      const peak = snapshot.peak ?? {};
      const windows = peak.windows ?? [];
      // Minutes east of UTC: Beijing is a fixed UTC+8, and `getTimezoneOffset`
      // returns minutes *behind* UTC, so the local one is its negation.
      const beijingOffset = 480;
      const localOffset = -new Date().getTimezoneOffset();
      const showLocal = localOffset !== beijingOffset;
      const isPeak = peak.isPeak === true;
      const nextAt = peak.next?.at ?? now;

      return h(
        CardBody,
        { title: t('peak.title') },
        h(
          'div',
          { className: 'dshd-row' },
          h('span', { className: 'dshd-clock' }, formatClock(now, beijingOffset)),
          h('span', { className: `dshd-badge ${isPeak ? 'is-peak' : 'is-off'}` }, isPeak ? t('peak.peak') : t('peak.off')),
        ),
        h('div', { className: 'dshd-clock-note' }, `${t('peak.beijing')}${showLocal ? ` · ${t('peak.local')} ${formatClock(now, localOffset)}` : ''}`),
        h(
          'div',
          { className: 'dshd-timeline', role: 'img', 'aria-label': windows.map((window) => t('peak.window', window)).join(', ') },
          windows.map((window, index) => {
            const start = (minutesOf(window.start) / 1440) * 100;
            const width = ((minutesOf(window.end) - minutesOf(window.start)) / 1440) * 100;
            return h('div', { key: index, className: 'dshd-timeline-window', style: { left: `${start}%`, width: `${width}%` } });
          }),
          h('div', { className: 'dshd-timeline-now', style: { left: `${(((now + beijingOffset * 60000) % 86400000) / 86400000) * 100}%` } }),
        ),
        // Only the countdown carries information here; the hour scale and the
        // long holiday sentence said nothing the timeline did not already show.
        h(
          'div',
          { className: 'dshd-row' },
          h('span', { className: 'dshd-note' }, t('peak.next', { time: formatDuration(nextAt - now), bucket: peak.next?.bucket === 'peak' ? t('peak.peak') : t('peak.off') })),
          h(
            'span',
            { className: `dshd-chip${peak.holidaysConfigured === true ? ' is-live' : ''}`, title: t('peak.holidayHint') },
            peak.holidaysConfigured === true ? t('peak.holidayOn', { count: peak.holidays?.length ?? 0 }) : t('peak.holidayOff'),
          ),
        ),
      );
    }

    /**
     * The day/week/month/year usage and spend table.
     * @param {{ snapshot: object }} props - the snapshot.
     * @returns {React.ReactElement} the card.
     */
    function PeriodsCard({ snapshot }) {
      const periods = snapshot.periods ?? {};
      const symbol = snapshot.currencySymbol ?? '¥';
      const rows = [
        ['day', periods.day, periods.prev?.day],
        ['week', periods.week, periods.prev?.week],
        ['month', periods.month, periods.prev?.month],
        ['year', periods.year, null],
      ];
      return h(
        CardBody,
        { title: t('periods.title') },
        h(
          'div',
          { className: 'dshd-table' },
          h(
            'div',
            { className: 'dshd-table-row is-head' },
            h('span', { className: 'dshd-table-head' }, t('periods.period')),
            h('span', { className: 'dshd-table-head' }, t('periods.tokens')),
            h('span', { className: 'dshd-table-head' }, t('periods.cost')),
            h('span', { className: 'dshd-table-head' }, t('periods.cacheHit')),
          ),
          rows.map(([key, current, previous]) =>
            h(
              'div',
              { key, className: 'dshd-table-row' },
              h(
                'span',
                { className: 'dshd-cell-dim' },
                t(`periods.${key}`),
                previous === null || previous === undefined ? null : h('div', null, h(Delta, { value: deltaPercent(current?.cost ?? 0, previous?.cost ?? 0) })),
              ),
              h('span', { className: 'dshd-cell-num' }, compactCount(current?.tokens ?? 0)),
              h('span', { className: 'dshd-cell-num' }, formatMoney(current?.cost ?? 0, symbol)),
              h('span', { className: 'dshd-cell-num' }, current?.cacheHitRate === null || current?.cacheHitRate === undefined ? '—' : `${(current.cacheHitRate * 100).toFixed(1)}%`),
            ),
          ),
        ),
      );
    }

    /**
     * The remaining-balance card, with the budget fallback.
     * @param {{ snapshot: object }} props - the snapshot.
     * @returns {React.ReactElement} the card.
     */
    function BalanceCard({ snapshot }) {
      const balance = snapshot.balance ?? {};
      const budget = snapshot.budget ?? {};
      const symbol = snapshot.currencySymbol ?? '¥';
      const live = balance.available === true;
      const total = live ? Number(balance.total) : null;
      const ratio = budget.total > 0 ? budget.spent / budget.total : 0;
      const tone = ratio >= 0.9 ? 'is-danger' : ratio >= 0.7 ? 'is-warn' : 'is-ok';

      const monthSpend = snapshot.periods?.month?.cost ?? 0;

      return h(
        CardBody,
        {
          title: t('balance.title'),
          actions: live
            ? h('span', { className: `dshd-chip ${balance.isAvailable === false ? 'is-warn' : 'is-live'}` }, balance.isAvailable === false ? t('balance.insufficient') : t('balance.usable'))
            : h('span', { className: 'dshd-chip is-warn' }, t('balance.unavailable')),
        },
        // The live figure when there is one; otherwise this card still reports
        // what the ledger knows and says exactly what is missing, instead of
        // showing a dash and leaving the reader to guess.
        h(
          'div',
          { className: 'dshd-stat-grid' },
          live
            ? h(Stat, { label: t('balance.total'), value: formatMoney(total, symbol), large: true })
            : h(Stat, { label: t('balance.budgetLeft'), value: budget.remainingFallback === null ? t('balance.notSet') : formatMoney(budget.remainingFallback, symbol), large: true }),
          h(Stat, { label: t('balance.spentMonth'), value: formatMoney(monthSpend, symbol) }),
          live
            ? h(Stat, { label: t('balance.topUp'), value: formatMoney(Number(balance.topUp), symbol), sub: `${t('balance.bonus')} ${formatMoney(Number(balance.bonus), symbol)}` })
            : h(Stat, {
                label: t('balance.budgetMode'),
                value: budget.total > 0 ? formatMoney(budget.total, symbol) : t('balance.notSet'),
                sub: budget.total > 0 ? t('balance.budgetSpent', { spent: formatMoney(budget.spent, symbol), total: formatMoney(budget.total, symbol) }) : undefined,
              }),
        ),
        budget.total > 0 ? h(Bar, { ratio, tone }) : null,
        live ? null : h('div', { className: 'dshd-note' }, t(`balance.reason.${balance.reason ?? 'balance-failed'}`)),
        live || budget.total > 0 ? null : h('div', { className: 'dshd-note' }, t('balance.budgetHint')),
        h(
          'div',
          { className: 'dshd-row' },
          balance.usageUrl === null || balance.usageUrl === undefined ? null : h('a', { className: 'dshd-link', href: balance.usageUrl, target: '_blank', rel: 'noreferrer' }, t('balance.usage')),
          balance.topUpUrl === null || balance.topUpUrl === undefined ? null : h('a', { className: 'dshd-link', href: balance.topUpUrl, target: '_blank', rel: 'noreferrer' }, t('balance.topUpLink')),
        ),
      );
    }

    /**
     * The platform-versus-ledger cross-check card.
     * @param {{ snapshot: object }} props - the snapshot.
     * @returns {React.ReactElement} the card.
     */
    function ReconcileCard({ snapshot }) {
      const reconcile = snapshot.reconcile ?? {};
      const symbol = snapshot.currencySymbol ?? '¥';
      const platform = reconcile.platformSpend?.month ?? 0;
      const ledger = reconcile.ledgerSpend?.month ?? 0;
      const deviation = reconcile.deviationPct ?? null;
      const topUps = reconcile.topUps ?? [];
      const topUpTotal = topUps.reduce((sum, entry) => sum + (entry.amount ?? 0), 0);
      // Three states, not two. A balance that reads fine but has only one sample
      // so far has no platform-side delta yet, and reporting that as "cannot read
      // the balance" was simply false — the balance had just been read.
      const hasBalance = snapshot.balance?.available === true;
      const comparable = hasBalance && platform > 0;

      return h(
        CardBody,
        { title: t('reconcile.title') },
        comparable
          ? h(
              'div',
              { className: 'dshd-stat-grid' },
              h(Stat, { label: t('reconcile.platform'), value: formatMoney(platform, symbol) }),
              h(Stat, { label: t('reconcile.ledger'), value: formatMoney(ledger, symbol) }),
              h(Stat, { label: t('reconcile.deviation'), value: deviation === null ? '—' : `${deviation > 0 ? '+' : ''}${deviation.toFixed(1)}%` }),
            )
          : h(
              'div',
              { className: 'dshd-stat-grid' },
              h(Stat, { label: t('reconcile.ledger'), value: formatMoney(ledger, symbol), large: true }),
              h(Stat, {
                label: t('reconcile.platform'),
                // A reading with no delta yet is "pending", not "unavailable":
                // the card must not deny a balance that is right there on the
                // card above it.
                value: hasBalance ? t('reconcile.pendingDelta') : t('reconcile.pending'),
              }),
            ),
        comparable && topUps.length > 0 ? h('div', { className: 'dshd-note' }, t('reconcile.topUps', { count: topUps.length, amount: formatMoney(topUpTotal, symbol) })) : null,
        h('div', { className: 'dshd-note' }, comparable ? t('reconcile.note') : hasBalance ? t('reconcile.deltaNote') : t('reconcile.waitingNote')),
      );
    }

    /**
     * A small SVG area chart of the last 30 days of spend.
     * @param {{ snapshot: object }} props - the snapshot.
     * @returns {React.ReactElement} the card.
     */
    function TrendCard({ snapshot }) {
      const days = (snapshot.series?.days ?? []).slice(-30);
      const symbol = snapshot.currencySymbol ?? '¥';
      const width = 320;
      const height = 96;
      const max = days.reduce((best, day) => Math.max(best, day.cost), 0);
      const peak = days.reduce((best, day) => (day.cost > (best?.cost ?? -1) ? day : best), null);

      const geometry = useMemo(() => {
        if (days.length < 2 || max <= 0) return null;
        const step = width / (days.length - 1);
        const points = days.map((day, index) => [index * step, height - 6 - (day.cost / max) * (height - 16)]);
        const line = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
        const area = `${line} L${width},${height} L0,${height} Z`;
        return { line, area };
      }, [days, max]);

      return h(
        CardBody,
        { title: t('trend.title'), actions: peak === null ? null : h('span', { className: 'dshd-chip' }, t('trend.max', { cost: formatMoney(peak.cost, symbol) })) },
        geometry === null
          ? h('div', { className: 'dshd-empty' }, t('common.emptyDay'))
          : h(
              'svg',
              { className: 'dshd-svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': t('trend.title') },
              h(
                'defs',
                null,
                h(
                  'linearGradient',
                  { id: 'dshd-trend-fill', x1: '0', y1: '0', x2: '0', y2: '1' },
                  h('stop', { offset: '0%', stopColor: 'var(--dsw-alias-brand-primary)', stopOpacity: '0.28' }),
                  h('stop', { offset: '100%', stopColor: 'var(--dsw-alias-brand-primary)', stopOpacity: '0' }),
                ),
              ),
              h('path', { d: geometry.area, fill: 'url(#dshd-trend-fill)' }),
              h('path', { d: geometry.line, fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke', strokeLinejoin: 'round', strokeLinecap: 'round' }),
            ),
      );
    }

    /**
     * Per-model share of the month's spend.
     * @param {{ snapshot: object }} props - the snapshot.
     * @returns {React.ReactElement} the card.
     */
    function ModelsCard({ snapshot }) {
      const models = snapshot.models ?? [];
      const symbol = snapshot.currencySymbol ?? '¥';
      const totalCost = models.reduce((sum, model) => sum + model.cost, 0);
      return h(
        CardBody,
        { title: t('models.title') },
        models.length === 0
          ? h('div', { className: 'dshd-empty' }, t('models.empty'))
          : h(
              'div',
              { className: 'dshd-table' },
              models.slice(0, 6).map((model) =>
                h(
                  'div',
                  { key: model.model, className: 'dshd-model-row' },
                  h('span', { className: 'dshd-model-name', title: model.model }, model.model),
                  h('span', { className: 'dshd-model-fig' }, `${compactCount(model.tokens)} · ${formatMoney(model.cost, symbol)}`),
                  h('div', { className: 'dshd-model-bar' }, h(Bar, { ratio: totalCost > 0 ? model.cost / totalCost : 0 })),
                ),
              ),
            ),
      );
    }

    /**
     * Today's headline figures plus every data source in use.
     * @param {{ snapshot: object, stale: boolean }} props - the snapshot and its freshness.
     * @returns {React.ReactElement} the card.
     */
    function TodayCard({ snapshot, stale }) {
      const day = snapshot.periods?.day ?? {};
      const forecast = snapshot.forecast ?? {};
      const pricing = snapshot.pricing ?? {};
      const balance = snapshot.balance ?? {};
      const network = snapshot.network ?? {};
      const symbol = snapshot.currencySymbol ?? '¥';
      const avgPerMillion = day.tokens > 0 ? (day.cost / day.tokens) * 1e6 : 0;
      const unknown = pricing.unknownModels ?? [];
      const live = pricing.source === 'live';
      // Tolerate the older sentence shape: a half-updated generation during HMR
      // would otherwise render `[object Object]` or a raw English sentence.
      const warning = pricing.warning;
      const pricingWarning =
        warning === null || warning === undefined
          ? null
          : typeof warning === 'string'
            ? { kind: 'unreachable', detail: warning }
            : warning;

      return h(
        CardBody,
        { title: t('today.title') },
        h(
          'div',
          { className: 'dshd-stat-grid' },
          h(Stat, { label: t('today.requests'), value: exactCount(day.calls ?? 0), sub: `${exactCount(day.tokens ?? 0)} tokens` }),
          h(Stat, { label: t('today.avgPrice'), value: formatMoney(avgPerMillion, symbol), sub: t('today.avgPriceUnit', { value: formatMoney(avgPerMillion, symbol) }) }),
          h(Stat, { label: t('today.forecast'), value: formatMoney(forecast.monthEnd ?? 0, symbol), sub: `${formatMoney(forecast.avgPerDay ?? 0, symbol)} / day` }),
          h(Stat, {
            label: t('today.since'),
            // The ledger stores instants; the label is a Beijing calendar date.
            value: snapshot.ledger?.since === null || snapshot.ledger?.since === undefined ? '—' : new Date(snapshot.ledger.since + 480 * 60000).toISOString().slice(0, 10),
            sub: t('common.days', { count: Math.round((Date.now() - (snapshot.ledger?.since ?? Date.now())) / 86400000) + 1 }),
          }),
        ),
        h(
          'div',
          { className: 'dshd-row' },
          h('span', { className: 'dshd-note' }, t('today.sources')),
          // The fallback state is already the chip; the reason rides on its
          // tooltip so nothing extra is printed on the card. A failed read is
          // expected on a flaky network and does not deserve a line of its own.
          h(
            'span',
            {
              className: `dshd-chip ${live ? 'is-live' : ''}`,
              title: pricingWarning === null ? undefined : t(`pricing.warn.${pricingWarning.kind}`),
            },
            live ? t('today.pricingLive') : t('today.pricingBuiltin'),
          ),
          h('span', { className: `dshd-chip ${balance.available === true ? 'is-live' : ''}` }, balance.available === true ? t('today.balanceLive') : t('today.balanceBudget')),
          h('span', { className: `dshd-chip ${network.directFetch === 'ok' && network.webService === 'ok' ? 'is-live' : 'is-warn'}` }, network.directFetch === 'ok' && network.webService === 'ok' ? t('today.netOk') : t('today.netDown')),
          stale ? h('span', { className: 'dshd-chip is-warn' }, t('common.stale')) : null,
        ),
        unknown.length === 0 ? null : h('div', { className: 'dshd-note' }, t('today.unknownModels', { models: unknown.join(', ') })),
      );
    }

    //#endregion

    //#region layout

    /**
     * The card registry: order, default span, display title and renderer.
     *
     * Spans are in grid rows, and one row is `GRID.rowHeight` px, so a card's
     * pixel height is `h * rowHeight - cardGap`.
     */
    const CARDS = [
      { id: 'greeting', titleKey: 'panel', span: { x: 0, y: 0, w: 12, h: 14 }, render: (props) => h(GreetingCard, props) },
      { id: 'heatmap', titleKey: 'heatmap.title', span: { x: 0, y: 14, w: 12, h: 34 }, render: (props) => h(HeatmapCard, props) },
      { id: 'peak', titleKey: 'peak.title', span: { x: 0, y: 48, w: 6, h: 26 }, render: (props) => h(PeakCard, props) },
      { id: 'periods', titleKey: 'periods.title', span: { x: 6, y: 48, w: 6, h: 26 }, render: (props) => h(PeriodsCard, props) },
      { id: 'balance', titleKey: 'balance.title', span: { x: 0, y: 74, w: 12, h: 27 }, render: (props) => h(BalanceCard, props) },
      { id: 'reconcile', titleKey: 'reconcile.title', span: { x: 0, y: 101, w: 12, h: 21 }, render: (props) => h(ReconcileCard, props) },
      { id: 'trend', titleKey: 'trend.title', span: { x: 0, y: 122, w: 6, h: 27 }, render: (props) => h(TrendCard, props) },
      { id: 'models', titleKey: 'models.title', span: { x: 6, y: 122, w: 6, h: 27 }, render: (props) => h(ModelsCard, props) },
      { id: 'today', titleKey: 'today.title', span: { x: 0, y: 149, w: 12, h: 28 }, render: (props) => h(TodayCard, props) },
    ];

    /**
     * The display title of a card.
     * @param {{ titleKey: string }} card - the registry entry.
     * @returns {string} the localized title.
     */
    function cardTitle(card) {
      return t(card.titleKey);
    }

    /**
     * The default layout: every card at its default span, visible.
     * @returns {Record<string, { x: number, y: number, w: number, h: number, visible: boolean }>} the layout.
     */
    function defaultLayout() {
      const layout = {};
      for (const card of CARDS) layout[card.id] = { ...card.span, visible: true };
      return layout;
    }

    /**
     * Clamp one card's span into the grid.
     * @param {{ x: number, y: number, w: number, h: number }} span - the requested span.
     * @returns {{ x: number, y: number, w: number, h: number }} the clamped span.
     */
    function clampSpan(span) {
      const w = Math.max(2, Math.min(GRID.columns, Math.round(span.w)));
      return {
        x: Math.max(0, Math.min(GRID.columns - w, Math.round(span.x))),
        y: Math.max(0, Math.round(span.y)),
        w,
        h: Math.max(MIN_CARD_ROWS, Math.round(span.h)),
      };
    }

    /**
     * Read the persisted layout, falling back to the defaults for unknown or
     * missing entries so a stored layout from an older version stays usable.
     * @returns {Record<string, object>} the layout.
     */
    function loadLayout() {
      const base = defaultLayout();
      try {
        const raw = window.localStorage.getItem(LAYOUT_KEY);
        if (raw === null) return base;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || parsed.cards === undefined) return base;
        for (const card of CARDS) {
          const stored = parsed.cards[card.id];
          if (stored === undefined) continue;
          base[card.id] = { ...clampSpan({ ...card.span, ...stored }), visible: stored.visible !== false };
        }
      } catch {
        // A corrupt layout falls back to the defaults rather than blocking the panel.
      }
      return base;
    }

    /**
     * Persist a layout.
     * @param {Record<string, object>} layout - the layout to store.
     */
    function saveLayout(layout) {
      try {
        window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ version: 1, columns: GRID.columns, cards: layout }));
      } catch {
        // Storage may be unavailable; the layout then simply does not survive a reload.
      }
    }

    /**
     * Measure one grid step so pointer deltas can be converted to grid units.
     * @param {HTMLElement | null} element - the grid container.
     * @returns {{ columnStep: number, rowStep: number }} the pixel size of one cell plus its gap.
     */
    function measureGrid(element) {
      const columnStep = 64;
      const rowStep = GRID.rowHeight;
      if (element === null) return { columnStep, rowStep };
      const rect = element.getBoundingClientRect();
      const width = rect.width;
      return { columnStep: (width + GRID.columnGap) / GRID.columns, rowStep };
    }

    //#endregion

    //#region error boundary

    /**
     * The fields this plugin's settings page edits.
     *
     * These mirror the host `Config` schema by name and kind. The page is handed
     * values and a write queue, not a schema, so the field list lives here too,
     * and `test/discipline.test.mjs` fails if the two ever list different fields.
     *
     * `kind`:
     * - `number` — parsed to a Number, so the host schema accepts it.
     * - `list` — split on commas into an array of strings.
     * - `choice` — a segmented control over `options`; nobody should have to
     *   type a currency code or a refresh interval by hand.
     * - `text` — free text.
     */
    const CONFIG_FIELDS = [
      { key: 'budgetTotal', kind: 'number' },
      { key: 'baselineCost', kind: 'number' },
      { key: 'currency', kind: 'choice', options: ['CNY', 'USD'] },
      { key: 'currencySymbol', kind: 'choice', options: ['¥', '$'] },
      { key: 'balanceRefreshSeconds', kind: 'choice', options: ['30', '60', '120', '300'], numeric: true },
      { key: 'fallbackModel', kind: 'text' },
      { key: 'holidays', kind: 'list' },
      { key: 'refreshHours', kind: 'choice', options: ['1', '6', '12', '24'], numeric: true },
      { key: 'pricingUrl', kind: 'text' },
    ];

    /**
     * Turn a settings value into the text an input shows.
     * @param {unknown} value - the value from the form snapshot.
     * @param {string} kind - the field kind.
     * @returns {string} the editable text.
     */
    function fieldText(value, kind) {
      if (value === undefined || value === null) return '';
      if (kind === 'list') return Array.isArray(value) ? value.join(', ') : String(value);
      return String(value);
    }

    /**
     * Turn edited text back into the value the host schema accepts.
     * @param {string} text - the input's text.
     * @param {string} kind - the field kind.
     * @returns {unknown} the value to write.
     */
    function fieldValue(text, kind) {
      if (kind === 'number') {
        const numeric = Number(text.trim());
        // An empty or unparsable box writes nothing rather than NaN, which the
        // host schema would reject and the page would report as a failed save.
        return text.trim() === '' || !Number.isFinite(numeric) ? undefined : numeric;
      }
      if (kind === 'list') {
        return text
          .split(/[\n,]/)
          .map((part) => part.trim())
          .filter((part) => part !== '');
      }
      return text;
    }

    /**
     * The options a segmented control offers for one field.
     *
     * A value that came from the patch layer rather than this page is kept as an
     * extra option: a control that silently showed nothing selected would invite
     * the next save to overwrite a setting the user never touched.
     *
     * @param {object} field - the field spec.
     * @param {unknown} current - the value in the form snapshot.
     * @returns {string[]} the option values.
     */
    function fieldOptions(field, current) {
      const options = [...(field.options ?? [])];
      const text = current === undefined || current === null ? '' : String(current);
      if (text !== '' && !options.includes(text)) options.push(text);
      return options;
    }

    /**
     * The configuration page the Plugins page opens for this bundle's row.
     *
     * dsh renders a form only from a registered `plugins.row.config` occupant:
     * the host schema alone produces a settings namespace but no page. `view` is
     * `summary` for the one-liner beside the row and `page` for the form, and
     * `form` carries the host-owned values and write queue.
     *
     * The controls are the shipped `SettingsForm`, `Input` and `SegmentedControl`
     * rather than hand-rolled elements, so the page matches the Settings pages
     * built into dsh instead of approximating them.
     *
     * @param {{ view: string, form?: { state: object, mutate: Function } }} props - owner props.
     * @returns {React.ReactElement | null} the summary line or the form.
     */
    function ConfigPage({ view, form }) {
      const [draft, setDraft] = useState({});
      const [busy, setBusy] = useState(false);
      const [failed, setFailed] = useState(false);
      const values = form?.state?.value ?? {};
      const writable = form?.state?.writable === true;

      if (view === 'summary') {
        const budget = Number(values.budgetTotal ?? 0);
        return h(
          'span',
          null,
          budget > 0
            ? t('config.summaryBudget', { amount: formatMoney(budget, String(values.currencySymbol ?? '¥')) })
            : t('config.summary'),
        );
      }

      const textOf = (field) => (field.key in draft ? draft[field.key] : fieldText(values[field.key], field.kind));
      const stage = (key, text) => {
        setFailed(false);
        setDraft((previous) => ({ ...previous, [key]: text }));
      };
      const dirty = Object.keys(draft).length > 0;
      const save = () => {
        if (form === undefined || busy || !dirty) return;
        const ops = [];
        for (const field of CONFIG_FIELDS) {
          if (!(field.key in draft)) continue;
          const next = fieldValue(draft[field.key], field.kind);
          if (next === undefined) continue;
          ops.push({ op: 'set', path: [field.key], value: next });
        }
        setBusy(true);
        setFailed(false);
        Promise.resolve(form.mutate(ops, form.state?.revision))
          .then((accepted) => {
            if (accepted === false) setFailed(true);
            else setDraft({});
          })
          .catch(() => setFailed(true))
          .finally(() => setBusy(false));
      };

      return h(
        SettingsForm,
        {
          state: {
            available: form !== undefined,
            dirty,
            invalid: false,
            saving: busy,
            failed,
            writable,
          },
          labels: {
            unavailable: t('config.unavailable'),
            readOnly: t('config.readOnly'),
            saveFailed: t('config.saveFailed'),
            saving: t('config.saving'),
            save: t('config.save'),
          },
          onSave: save,
          // The settings frame discards on unmount; this page keeps no draft
          // outside the component, so there is nothing to write back.
          onDiscard: () => {},
        },
        h('div', { className: 'dshd-config-grid' }, CONFIG_FIELDS.map((field) => {
          const current = values[field.key];
          const text = textOf(field);
          const control =
            field.kind === 'choice'
              ? h(SegmentedControl, {
                  key: field.key,
                  id: `dshd-${field.key}`,
                  value: text,
                  options: fieldOptions(field, current).map((option) => ({
                    value: option,
                    label: field.numeric === true ? t(`config.${field.key}.unit`, { value: option }) : option,
                  })),
                  label: t(`config.${field.key}`),
                  disabled: !writable,
                  onChange: (next) => stage(field.key, String(next)),
                })
              : h(Input, {
                  key: field.key,
                  value: text,
                  type: field.kind === 'number' ? 'number' : 'text',
                  disabled: !writable,
                  'aria-label': t(`config.${field.key}`),
                  onChange: (event) => stage(field.key, event.target.value),
                });
          return h(
            'div',
            { key: field.key, className: 'dshd-config-field' },
            h('span', { className: 'dshd-config-label' }, t(`config.${field.key}`)),
            control,
            h('span', { className: 'dshd-note' }, t(`config.${field.key}.hint`)),
          );
        })),
      );
    }

    /**
     * Keeps one failing card from blanking the whole slot entry: a thrown render
     * is contained here and reported in place.
     *
     * The card's renderer is invoked from inside this component, not by the
     * panel. Calling `card.render()` in the panel's own map would throw during
     * the panel's render, where no boundary can catch it — one bad card would
     * then take the entire dashboard down with it.
     */
    class CardBoundary extends React.Component {
      /** @param {object} props - React props. */
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      /**
       * Capture a descendant render failure.
       * @param {unknown} error - the thrown value.
       * @returns {{ error: string }} the next state.
       */
      static getDerivedStateFromError(error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }

      /** @returns {React.ReactNode} the card body or its error state. */
      render() {
        if (this.state.error !== null) {
          return h('div', { className: 'dshd-error' }, h('span', null, `${t('common.failed')}: ${this.state.error}`));
        }
        return this.props.render();
      }
    }

    //#endregion

    //#region panel

    /**
     * The dashboard panel: the grid, the drag/resize gestures and the editor.
     * @param {{ t?: Function }} props - slot props; `t` arrives from the declared locale namespace.
     * @returns {React.ReactElement} the panel.
     */
    function DashboardPanel(props) {
      if (typeof props?.t === 'function') translate = props.t;
      const { snapshot, error, stale, reload, changeGreeting } = useSnapshot();
      const now = useNow();
      const [layout, setLayout] = useState(() => loadLayout());
      const [editing, setEditing] = useState(false);
      const [importing, setImporting] = useState(false);
      const [importText, setImportText] = useState('');
      const [importError, setImportError] = useState(false);
      const [copied, setCopied] = useState(false);
      const gridRef = useRef(null);
      const dragRef = useRef(null);
      const layoutRef = useRef(layout);

      useEffect(() => {
        layoutRef.current = layout;
      }, [layout]);

      const commit = useCallback((next) => {
        setLayout(next);
        saveLayout(next);
      }, []);

      /**
       * Begin a move or resize gesture on one card.
       * @param {React.PointerEvent} event - the pointer event.
       * @param {string} id - the card id.
       * @param {'move' | 'resize'} mode - the gesture.
       */
      const beginGesture = useCallback(
        (event, id, mode) => {
          if (!editing) return;
          event.preventDefault();
          event.stopPropagation();
          const span = layout[id];
          const metrics = measureGrid(gridRef.current);
          dragRef.current = {
            id,
            mode,
            startX: event.clientX,
            startY: event.clientY,
            origin: { ...span },
            metrics,
            pointerId: event.pointerId,
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          const target = event.currentTarget;

          /**
           * Apply one pointer move as a grid delta.
           * @param {PointerEvent} moveEvent - the move event.
           */
          const onMove = (moveEvent) => {
            const drag = dragRef.current;
            if (drag === null) return;
            const dx = Math.round((moveEvent.clientX - drag.startX) / drag.metrics.columnStep);
            const dy = Math.round((moveEvent.clientY - drag.startY) / drag.metrics.rowStep);
            setLayout((current) => {
              const origin = drag.origin;
              const next = drag.mode === 'move' ? clampSpan({ ...origin, x: origin.x + dx, y: Math.max(0, origin.y + dy) }) : clampSpan({ ...origin, w: origin.w + dx, h: origin.h + dy });
              return { ...current, [drag.id]: { ...current[drag.id], ...next } };
            });
          };

          /** Finish the gesture and persist it. */
          const onUp = () => {
            dragRef.current = null;
            target.releasePointerCapture?.(event.pointerId);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            // Persist the settled geometry once, from the ref: a side effect
            // inside a state updater would run twice under StrictMode.
            saveLayout(layoutRef.current);
          };

          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
          window.addEventListener('pointercancel', onUp);
        },
        [editing, layout],
      );

      /**
       * Nudge or resize a focused card from the keyboard.
       * @param {React.KeyboardEvent} event - the key event.
       * @param {string} id - the card id.
       */
      const onCardKeyDown = useCallback(
        (event, id) => {
          if (!editing) return;
          const span = layout[id];
          const resize = event.shiftKey;
          let next = null;
          if (event.key === 'ArrowLeft') next = resize ? { w: span.w - 1 } : { x: span.x - 1 };
          else if (event.key === 'ArrowRight') next = resize ? { w: span.w + 1 } : { x: span.x + 1 };
          else if (event.key === 'ArrowUp') next = resize ? { h: span.h - 1 } : { y: span.y - 1 };
          else if (event.key === 'ArrowDown') next = resize ? { h: span.h + 1 } : { y: span.y + 1 };
          else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            commit({ ...layout, [id]: { ...span, visible: false } });
            return;
          }
          if (next === null) return;
          event.preventDefault();
          commit({ ...layout, [id]: { ...clampSpan({ ...span, ...next }), visible: span.visible } });
        },
        [commit, editing, layout],
      );

      const onReset = useCallback(() => commit(defaultLayout()), [commit]);

      const onExport = useCallback(() => {
        const text = JSON.stringify({ version: 1, columns: GRID.columns, cards: layout }, null, 2);
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          },
          () => {
            setImportText(text);
            setImporting(true);
          },
        );
      }, [layout]);

      const onImport = useCallback(() => {
        try {
          const parsed = JSON.parse(importText);
          const next = defaultLayout();
          for (const card of CARDS) {
            const stored = parsed?.cards?.[card.id];
            if (stored === undefined) continue;
            next[card.id] = { ...clampSpan({ ...card.span, ...stored }), visible: stored.visible !== false };
          }
          commit(next);
          setImportError(false);
          setImporting(false);
        } catch {
          setImportError(true);
        }
      }, [commit, importText]);

      const visibleCards = CARDS.filter((card) => layout[card.id]?.visible !== false);

      if (snapshot === null) {
        return h(
          'div',
          { className: 'dshd-root' },
          h('div', { className: 'dshd-empty' }, error === null ? t('common.loading') : `${t('common.failed')}: ${error}`),
          error === null ? null : h('button', { type: 'button', className: 'dshd-btn', onClick: reload }, t('common.retry')),
        );
      }

      return h(
        'div',
        { className: 'dshd-root' },
        h(
          'div',
          { className: 'dshd-toolbar' },
          h('h2', { className: 'dshd-toolbar-title' }, t('panel')),
          copied ? h('span', { className: 'dshd-chip is-live' }, t('layout.copied')) : null,
          h('button', { type: 'button', className: editing ? 'dshd-btn dshd-btn-primary' : 'dshd-btn', 'aria-pressed': editing, onClick: () => setEditing((value) => !value) }, editing ? t('layout.done') : t('layout.edit')),
          editing ? h('button', { type: 'button', className: 'dshd-btn', onClick: onReset }, t('layout.reset')) : null,
          editing ? h('button', { type: 'button', className: 'dshd-btn', onClick: onExport }, t('layout.export')) : null,
          editing ? h('button', { type: 'button', className: 'dshd-btn', onClick: () => setImporting((value) => !value) }, t('layout.import')) : null,
        ),
        editing ? h('p', { className: 'dshd-note', style: { margin: '0 0 12px' } }, t('layout.hint')) : null,
        editing
          ? h(
              'div',
              { className: 'dshd-vis-list' },
              h('span', { className: 'dshd-note' }, t('layout.showCards')),
              CARDS.map((card) =>
                h(
                  'label',
                  { key: card.id, className: 'dshd-vis-item' },
                  h('input', {
                    type: 'checkbox',
                    checked: layout[card.id]?.visible !== false,
                    onChange: (event) => commit({ ...layout, [card.id]: { ...layout[card.id], visible: event.target.checked } }),
                  }),
                  cardTitle(card),
                ),
              ),
            )
          : null,
        importing
          ? h(
              'div',
              { className: 'dshd-import' },
              h('textarea', { value: importText, onChange: (event) => setImportText(event.target.value), spellCheck: false, 'aria-label': t('layout.import') }),
              importError ? h('span', { className: 'dshd-note' }, t('layout.invalid')) : null,
              h(
                'div',
                { className: 'dshd-row' },
                h('button', { type: 'button', className: 'dshd-btn dshd-btn-primary', onClick: onImport }, t('layout.apply')),
                h('button', { type: 'button', className: 'dshd-btn', onClick: () => setImporting(false) }, t('layout.cancel')),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dshd-grid', ref: gridRef },
          visibleCards.map((card) => {
            const span = layout[card.id];
            const label = cardTitle(card);
            const style = {
              gridColumn: `${span.x + 1} / span ${span.w}`,
              gridRow: `${span.y + 1} / span ${span.h}`,
            };
            return h(
              'section',
              {
                key: card.id,
                className: `dshd-card${editing ? ' is-editing' : ''}`,
                style,
                tabIndex: editing ? 0 : -1,
                onKeyDown: (event) => onCardKeyDown(event, card.id),
                'aria-label': label,
              },
              editing
                ? h(
                    'span',
                    { className: 'dshd-grip', onPointerDown: (event) => beginGesture(event, card.id, 'move'), title: t('layout.drag', { title: label }), 'aria-hidden': true },
                    h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'currentColor' }, h('circle', { cx: 4, cy: 4, r: 1.2 }), h('circle', { cx: 9, cy: 4, r: 1.2 }), h('circle', { cx: 4, cy: 9, r: 1.2 }), h('circle', { cx: 9, cy: 9, r: 1.2 })),
                  )
                : null,
              h(CardBoundary, { render: () => card.render({ snapshot, now, stale, onChange: changeGreeting }) }),
              editing
                ? h(React.Fragment, null,
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dshd-icon-btn',
                        style: { position: 'absolute', top: 10, right: 10 },
                        title: t('layout.hide', { title: label }),
                        'aria-label': t('layout.hide', { title: label }),
                        onClick: () => commit({ ...layout, [card.id]: { ...span, visible: false } }),
                      },
                      '×',
                    ),
                    h('span', { className: 'dshd-resize', onPointerDown: (event) => beginGesture(event, card.id, 'resize'), title: t('layout.resize', { title: label }), 'aria-hidden': true }),
                  )
                : null,
            );
          }),
        ),
      );
    }

    //#endregion

    //#region entry

    /**
     * The sidebar icon: inherits `currentColor`, so it follows the theme like
     * every shipped panel icon.
     * @param {{ size?: number, active?: boolean }} props - owner props.
     * @returns {React.ReactElement} the icon.
     */
    function DashboardIcon({ size = 16 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3.5 }),
        h('path', { d: 'M7.5 16v-3.5' }),
        h('path', { d: 'M12 16V8' }),
        h('path', { d: 'M16.5 16v-5.5' }),
      );
    }

    return {
      // Every Cordis service this module touches must be injected. Reading an
      // un-injected one throws `cannot get property "locale" without inject`,
      // and because that used to happen on the first line of `apply`, the slot
      // registrations below never ran — a missing sidebar entry with no error
      // reported anywhere.
      inject: ['slots', 'locale', 'configForms'],
      /**
       * Register the stylesheet, the sidebar entry, the main panel and the locale.
       *
       * Each step is guarded and the slot registrations come first, because a
       * throw here is invisible: the host still serves the snapshot, the panel
       * simply never appears in the sidebar, and nothing reports why. Losing the
       * locale dictionary costs a fallback string; losing the registration costs
       * the whole feature, so the registration wins.
       *
       * @param {object} ctx - the client plugin context.
       */
      apply(ctx) {
        try {
          translate = ctx.locale.bind(NS);
        } catch {
          // `t()` already falls back to the built-in dictionary.
        }

        try {
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                // The shipped Plugins panel registers order 0 and Schedule order
                // 10; 1 seats this entry directly beneath Plugins.
                order: 1,
                label: () => t('panel'),
                locale: NS,
              },
              DashboardIcon,
            ),
          );
        } catch (error) {
          reportClientFailure(ctx, 'sidebar entry', error);
        }

        try {
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                locale: NS,
              },
              DashboardPanel,
            ),
          );
        } catch (error) {
          reportClientFailure(ctx, 'main panel', error);
        }

        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'usage-dashboard: dictionaries');
        } catch (error) {
          reportClientFailure(ctx, 'dictionaries', error);
        }

        // The Plugins page renders a row's configuration only from an occupant
        // of `plugins.row.config`: the host schema alone publishes a settings
        // namespace but no page. `whileServed` is the sanctioned way to own a
        // page for a namespace another plugin serves — it registers once the
        // namespace appears, and leaves no trace when it never does.
        try {
          ctx.effect(
            () => ctx.configForms.whileServed([ROW_ID], () => ctx.slots.register({ name: 'plugins.row.config', key: ROW_CONFIG_KEY }, ConfigPage)),
            'usage-dashboard: configuration page',
          );
        } catch (error) {
          reportClientFailure(ctx, 'configuration page', error);
        }

        try {
          installStyles(ctx);
        } catch (error) {
          reportClientFailure(ctx, 'stylesheet', error);
        }
      },
    };
  },
});
