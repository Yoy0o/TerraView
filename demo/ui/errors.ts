/**
 * Chinese wording for the SDK's errors. The SDK raises `TerraViewError`s with an English message
 * and a stable `code` + `details`; the host decides what users read. Keyed by every code, so a
 * new code without a translation fails the type check.
 */
import { isTerraViewError, type TerraViewError, type TerraViewErrorCode } from 'terra-view';

const ZH: Record<TerraViewErrorCode, (e: TerraViewError) => string> = {
  'imagery-unreachable': (e) => `${e.details.provider} 无法访问（${e.details.reason}）`,
  'terrain-format-unsupported': (e) => `不支持的地形格式 ${e.details.format}`,
  'terrain-projection-unsupported': (e) => `只支持 EPSG:4326 的 quantized-mesh（当前 ${e.details.projection}）`,
  'ion-asset-not-terrain': (e) => `ion 资产 ${e.details.assetId} 不是地形（${e.details.type}）`,
  'building-invalid': (e) => `建筑文件格式错误（${e.message}）`,
  'building-already-loaded': (e) => `建筑 ${e.details.id} 已加载`,
  'points-empty': (e) => (e.message === 'no point features' ? '没有点要素' : `没有点要素（${e.message}）`),
  'geojson-invalid': () => '不是有效的 GeoJSON',
  'option-invalid': (e) => `创建参数 ${e.details.option} 无效（需要 ${e.details.expected}）`,
};

/** What to show for an error: the Chinese text for SDK errors, the message for anything else. */
export function describeError(err: unknown): string {
  if (isTerraViewError(err)) return ZH[err.code](err);
  return err instanceof Error ? err.message : String(err);
}
