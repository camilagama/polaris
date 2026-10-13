/**
 * Runs a focus change after React has committed the state that made the target
 * focusable or valid. A timeout (not an animation frame) also fires in tabs the
 * browser throttles.
 */
export function focusLater(focus: () => void): void {
  window.setTimeout(focus, 0);
}
