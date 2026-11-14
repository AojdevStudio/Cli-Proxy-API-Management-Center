import { createContext, useContext } from 'react';

export type LayerStatus = 'current' | 'exiting' | 'stacked';

export type PageTransitionLayerContextValue = {
  status: LayerStatus;
  isCurrentLayer: boolean;
  isAnimating: boolean;
};

export const PageTransitionLayerContext = createContext<PageTransitionLayerContextValue | null>(
  null
);

export const PAGE_TRANSITION_LAYER_CONTEXT_VALUES: Record<
  LayerStatus,
  PageTransitionLayerContextValue
> = {
  current: { status: 'current', isCurrentLayer: true, isAnimating: false },
  stacked: { status: 'stacked', isCurrentLayer: false, isAnimating: false },
  exiting: { status: 'exiting', isCurrentLayer: false, isAnimating: false },
};

export function usePageTransitionLayer() {
  return useContext(PageTransitionLayerContext);
}

/**
 * A layer's identity. The router gives every entry it pushes its own key, but a hash change
 * from outside it (back to an entry it did not push, a typed or pasted URL) arrives with the
 * shared key "default". The path keeps those apart, so the screen still changes.
 */
export const layerKeyOf = (location: { key: string; pathname: string }) =>
  `${location.key}:${location.pathname}`;

