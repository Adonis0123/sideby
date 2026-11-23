// Portal `kind: "panel"` entry for the independent Network view. It reuses the Panel's HTTP security and Runtime.
import {
  createPanelHandler as createBasePanelHandler,
  PANEL_VIEW,
  type PanelHandlerOptions,
} from '../panel/handler.ts'

export type NetworkPanelHandlerOptions = PanelHandlerOptions

export function createPanelHandler(options: NetworkPanelHandlerOptions) {
  return createBasePanelHandler({ ...options, [PANEL_VIEW]: 'network' } as PanelHandlerOptions)
}

export { createRuntime } from '../runtime.ts'
export { renderNetworkPage } from './page.ts'
