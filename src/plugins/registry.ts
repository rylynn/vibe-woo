/** pet://plugin-card 事件载荷（与 Rust plugin/mod.rs 的 CardEvent 契约一致）。 */
export interface PluginCard {
  plugin_id: string;
  /** 渲染器注册表的 key。 */
  kind: string;
  priority: "low" | "normal" | "high";
  ttl_secs: number;
  /** 各插件自定义的展示数据。 */
  payload: unknown;
  /** >1 表示休息期合并补发（「刚才攒了 N 条」），正常路径为 0。 */
  deferred_count: number;
}

/**
 * 渲染器可用的受控操作。渲染器不直接 invoke ——
 * 便于测试，也便于将来换宿主 / 开放给第三方时收口权限。
 */
export interface CardHost {
  /** 打开外部网页（资讯跳转）。 */
  openUrl(url: string): void;
  /** 词卡反馈（P3 接 SRS 命令）。 */
  markTerm(term: string, known: boolean): void;
}

/** 每个前端插件模块导出的三个视图。 */
export interface PluginFrontend {
  /** 气泡里的单卡视图。 */
  renderCard(card: PluginCard, host: CardHost): HTMLElement;
  /** 左键面板里的当日汇总视图（可选）。 */
  renderSection?(data: unknown, host: CardHost): HTMLElement;
  /** 设置表单（可选，P2 起由各插件提供）。 */
  renderSettings?(cfg: unknown, onSave: (cfg: unknown) => void): HTMLElement;
}

const registry = new Map<string, PluginFrontend>();

/** 注册某 kind 的渲染器。重复注册以后者覆盖。 */
export function registerPlugin(kind: string, fe: PluginFrontend): void {
  registry.set(kind, fe);
}

export function getPluginFrontend(kind: string): PluginFrontend | undefined {
  return registry.get(kind);
}

export function listPluginKinds(): string[] {
  return [...registry.keys()];
}
